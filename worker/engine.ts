import { and, desc, eq, gte } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { getCompanyNews, getCryptoNews, getQuote, getQuotesThrottled, type FinnhubQuote } from "./finnhub";
import { getMarketClock, isForceCloseTime, isWithinCollectionWindow, isWithinEntryWindow, type MarketClock } from "./market-hours";
import { COOLDOWN_MINUTES, DAILY_LOSS_LIMIT_PCT, DEFAULT_MAX_OPEN_POSITIONS, computeEntryPlan, executionPrice, manageStagedStop } from "./positions";
import { classifyMarketWeather, CONFIRMATION_ELIGIBILITY_THRESHOLD, scoreCandidate, TRADE_THRESHOLD } from "./scoring";
import { getRecentSecFilings } from "./sec-edgar";
import { collectFreeSourceSnapshot, cryptoQuoteDisagreementPct, yahooBackupQuotes } from "./free-sources";
import { TICKER_UNIVERSE, cryptoTickersForStory, isCryptoTicker, quoteSymbolForTicker } from "./universe";

type Db = DrizzleD1Database<typeof schema>;

// Finnhub's free company-news feed is commonly delivered several hours after
// publication. Six hours matches the scorer's existing freshness hard gate and
// lets Atlas study real delayed stories without pretending they arrived live.
const LOOKBACK_MINUTES = 360;
const COLLECTION_LOOKBACK_DAYS = 1;
const MAX_CANDIDATE_TICKERS = 15;

export async function runScan(db: Db, apiKey: string, now: Date, secUserAgent?: string) {
  const startedAt = now.toISOString();
  const [scanRun] = await db.insert(schema.scanRuns).values({ startedAt }).returning();
  let storiesFetched = 0, candidatesEvaluated = 0, positionsOpened = 0, positionsClosed = 0;

  try {
    const clock = getMarketClock(now);

    // Outside the collection window every quote is frozen at the last close.
    // Re-fetching and re-scoring them every five minutes burns free-tier quota,
    // writes duplicate weather rows, and pollutes the history calibration reads
    // from — while producing a red "SIT OUT" verdict that only reflects
    // whichever way the tape happened to close. Record an honest no-op instead.
    if (!isWithinCollectionWindow(clock)) {
      await db.update(schema.scanRuns).set({ finishedAt: new Date().toISOString() }).where(eq(schema.scanRuns.id, scanRun.id));
      return;
    }

    const freeSources = await collectFreeSourceSnapshot(now);

    const account = await getOrCreateAccountState(db, clock.tradingDay);

    // One throttled pass covers the index trio and the whole universe; the same
    // map is reused for candidate scoring below so nothing is fetched twice.
    const finnhubQuotes = await getQuotesThrottled(apiKey, ["SPY", "QQQ", "VIXY", ...TICKER_UNIVERSE]);

    // Whatever the primary feed still dropped, ask Yahoo for — a second
    // independent source of real observed prices, never an estimate. This is
    // what lifts breadth out of the "8/20 quotes" starvation that kept market
    // weather permanently incomplete.
    const asQuote = (snapshot: { price: number; prevClose: number | null; changePct: number | null }): FinnhubQuote | null =>
      snapshot.changePct === null
        ? null
        : { c: snapshot.price, d: snapshot.prevClose === null ? null : snapshot.price - snapshot.prevClose, dp: snapshot.changePct, h: snapshot.price, o: snapshot.price, l: snapshot.price, pc: snapshot.prevClose ?? snapshot.price, t: Math.floor(now.getTime() / 1000) };

    const universeQuotes = new Map(finnhubQuotes);
    for (const [symbol, snapshot] of freeSources.indexes) {
      if (universeQuotes.get(symbol)?.dp == null) universeQuotes.set(symbol, asQuote(snapshot) ?? universeQuotes.get(symbol) ?? null);
    }
    const gapSymbols = TICKER_UNIVERSE.filter((ticker) => universeQuotes.get(ticker)?.dp == null);
    if (gapSymbols.length > 0) {
      for (const [symbol, snapshot] of await yahooBackupQuotes(gapSymbols)) {
        const quote = asQuote(snapshot);
        if (quote) universeQuotes.set(symbol, quote);
      }
    }

    const spy = universeQuotes.get("SPY") ?? null;
    const qqq = universeQuotes.get("QQQ") ?? null;
    const volatilityProxy = universeQuotes.get("VIXY") ?? null;
    const breadth = TICKER_UNIVERSE
      .map((ticker) => universeQuotes.get(ticker))
      .filter((quote): quote is FinnhubQuote => !!quote && quote.dp !== null);
    const weather = classifyMarketWeather({
      spy, qqq, spyVwap: freeSources.indexes.get("SPY")?.vwap ?? null,
      advancers: breadth.filter((quote) => (quote.dp ?? 0) > 0).length,
      decliners: breadth.filter((quote) => (quote.dp ?? 0) < 0).length,
      breadthSample: breadth.length, volatilityProxy,
    });
    if (freeSources.macroEventRisk) {
      weather.flags.push(`Federal Reserve event risk: ${freeSources.macroEvidence[0]}`);
      if (weather.classification === "TRADE_ELIGIBLE") weather.classification = "CAUTION";
    }
    await db.insert(schema.marketWeatherLog).values({
      scanAt: startedAt,
      classification: weather.classification,
      spyPrice: spy?.c ?? null,
      spyChangePct: spy?.dp ?? null,
      qqqChangePct: qqq?.dp ?? null,
      reasonFlags: JSON.stringify(weather.flags),
    });

    const todayIso = clock.tradingDay;
    const collectionStart = new Date(now);
    collectionStart.setUTCDate(collectionStart.getUTCDate() - COLLECTION_LOOKBACK_DAYS);
    const collectionStartIso = collectionStart.toISOString().slice(0, 10);
    const pairs: { ticker: string; story: typeof schema.newsStories.$inferSelect }[] = [];
    for (const ticker of TICKER_UNIVERSE) {
      const items = await getCompanyNews(apiKey, ticker, collectionStartIso, todayIso).catch(() => []);
      const newestItems = [...items].sort((a, b) => b.datetime - a.datetime).slice(0, 10);
      for (const item of newestItems) {
        const publishedAt = new Date(item.datetime * 1000);
        const ageMinutes = (now.getTime() - publishedAt.getTime()) / 60000;

        const existing = await db.select().from(schema.newsStories).where(eq(schema.newsStories.finnhubId, String(item.id))).limit(1);
        let story = existing[0];
        if (!story) {
          const [inserted] = await db.insert(schema.newsStories).values({
            finnhubId: String(item.id),
            headline: item.headline,
            summary: item.summary || "",
            source: item.source || "",
            url: item.url || "",
            publishedAt: publishedAt.toISOString(),
            relatedTickers: ticker,
            finnhubCategory: item.category || "",
            firstSeenAt: startedAt,
          }).returning();
          story = inserted;
          storiesFetched++;
        }
        // Keep real historical observations for research, but only let news
        // observed within the action window enter live scoring.
        if (ageMinutes <= LOOKBACK_MINUTES) pairs.push({ ticker, story });
      }
    }

    // EDGAR is a primary-source confirmation feed. It is deliberately
    // rate-limited and never turns a filing into a bullish signal by itself.
    // A filing can only strengthen provenance when a separately sourced story
    // about the same ticker appears in the same 90-minute event window.
    const secFilings = secUserAgent
      ? await getRecentSecFilings(secUserAgent, TICKER_UNIVERSE, collectionStart).catch(() => [])
      : [];
    for (const filing of secFilings) {
      const storyKey = `sec:${filing.accessionNumber}`;
      const existing = await db.select().from(schema.newsStories).where(eq(schema.newsStories.finnhubId, storyKey)).limit(1);
      let story = existing[0];
      if (!story) {
        const [inserted] = await db.insert(schema.newsStories).values({
          finnhubId: storyKey,
          headline: `${filing.ticker} files ${filing.form} with the SEC`,
          summary: filing.description,
          source: "SEC EDGAR",
          url: filing.url,
          publishedAt: filing.filedAt,
          relatedTickers: filing.ticker,
          finnhubCategory: "sec-filing",
          firstSeenAt: startedAt,
        }).returning();
        story = inserted;
        storiesFetched++;
      }
      const ageMinutes = (now.getTime() - new Date(story.publishedAt).getTime()) / 60000;
      if (ageMinutes <= LOOKBACK_MINUTES) pairs.push({ ticker: filing.ticker, story });
    }

    const cryptoItems = await getCryptoNews(apiKey).catch(() => []);
    for (const item of cryptoItems.slice(0, 50)) {
      const publishedAt = new Date(item.datetime * 1000);
      const ageMinutes = (now.getTime() - publishedAt.getTime()) / 60000;
      const matchedTickers = cryptoTickersForStory(item.headline, item.summary || "");
      if (matchedTickers.length === 0) continue;
      const existing = await db.select().from(schema.newsStories).where(eq(schema.newsStories.finnhubId, String(item.id))).limit(1);
      let story = existing[0];
      if (!story) {
        const [inserted] = await db.insert(schema.newsStories).values({
          finnhubId: String(item.id), headline: item.headline, summary: item.summary || "",
          source: item.source || "", url: item.url || "", publishedAt: publishedAt.toISOString(),
          relatedTickers: matchedTickers.join(","), finnhubCategory: item.category || "crypto", firstSeenAt: startedAt,
        }).returning();
        story = inserted;
        storiesFetched++;
      }
      if (ageMinutes <= LOOKBACK_MINUTES) {
        for (const ticker of matchedTickers) pairs.push({ ticker, story });
      }
    }

    const uniqueTickers = Array.from(new Set(pairs.map((p) => p.ticker))).slice(0, MAX_CANDIDATE_TICKERS);
    // Stocks reuse the universe quotes fetched above; only symbols not already
    // in that map (crypto pairs) cost additional throttled calls.
    const quoteMap = new Map<string, FinnhubQuote | null>();
    const missingQuoteTickers = uniqueTickers.filter((ticker) => !universeQuotes.has(ticker));
    const missingQuotes = await getQuotesThrottled(apiKey, missingQuoteTickers.map((ticker) => quoteSymbolForTicker(ticker)));
    for (const ticker of uniqueTickers) {
      quoteMap.set(ticker, universeQuotes.get(ticker) ?? missingQuotes.get(quoteSymbolForTicker(ticker)) ?? null);
    }

    let currentAccount = account;

    for (const { ticker, story } of pairs) {
      if (!uniqueTickers.includes(ticker)) continue;
      const quote = quoteMap.get(ticker) ?? null;
      const priceAtScan = quote?.c ?? null;

      const priorCandidates = await db.select().from(schema.candidates)
        .where(and(eq(schema.candidates.storyId, story.id), eq(schema.candidates.ticker, ticker)))
        .orderBy(schema.candidates.scanAt);
      const baseline = priorCandidates[0]?.priceAtScan ?? priceAtScan;
      const priceChangePct = priceAtScan !== null && baseline ? ((priceAtScan - baseline) / baseline) * 100 : null;
      const lastCandidate = priorCandidates.at(-1);
      // A promising first observation may earn persistence on the next scan.
      // Requiring the prior observation to have already reached the 60-point
      // trade threshold made persistence circular and prevented valid trades.
      const seenConfirmationEligibleLastScan = !!lastCandidate
        && lastCandidate.score >= CONFIRMATION_ELIGIBILITY_THRESHOLD
        && lastCandidate.status !== "DISQUALIFIED";
      const minutesSincePublished = (now.getTime() - new Date(story.publishedAt).getTime()) / 60000;
      const storyTime = new Date(story.publishedAt).getTime();
      const corroboratingOutlets = new Set(pairs
        .filter((pair) => pair.ticker === ticker
          && pair.story.source.trim()
          && /^https?:\/\//i.test(pair.story.url)
          && Math.abs(new Date(pair.story.publishedAt).getTime() - storyTime) <= 90 * 60 * 1000)
        .map((pair) => pair.story.source.trim().toLowerCase()));
      // A same-window press release naming this ticker is the issuer speaking
      // for itself — the strongest corroboration a free feed can offer.
      for (const release of freeSources.pressReleases) {
        if (release.tickers.includes(ticker) && Math.abs(new Date(release.publishedAt).getTime() - storyTime) <= 90 * 60 * 1000) {
          corroboratingOutlets.add(release.source.toLowerCase());
        }
      }
      const independentSourceCount = corroboratingOutlets.size;

      const scored = scoreCandidate({
        ticker, now, headline: story.headline, summary: story.summary, priceAtScan, priceChangePct,
        minutesSincePublished, seenConfirmationEligibleLastScan, source: story.source, sourceUrl: story.url,
        independentSourceCount,
      });
      const result = story.finnhubCategory === "sec-filing"
        ? { ...scored, status: "CAUTION" as const, reason: `Primary-source ${story.headline} recorded for corroboration; an SEC filing alone never triggers a trade.` }
        : freeSources.haltedSymbols.has(ticker)
          ? { ...scored, score: 0, status: "DISQUALIFIED" as const, reason: "Nasdaq reports this security halted or paused; no entry is permitted." }
          : (() => {
              const disagreement = isCryptoTicker(ticker) && priceAtScan !== null
                ? cryptoQuoteDisagreementPct(priceAtScan, freeSources.cryptoPrices.get(ticker)) : null;
              return disagreement !== null && disagreement > 1
                ? { ...scored, score: 0, status: "DISQUALIFIED" as const, reason: `Crypto quote conflict: independent Coinbase price differs by ${disagreement.toFixed(2)}%; no entry is permitted.` }
                : scored;
            })();

      const [candidateRow] = await db.insert(schema.candidates).values({
        storyId: story.id,
        ticker,
        scanAt: startedAt,
        score: result.score,
        status: result.status,
        reason: result.reason,
        priceAtScan,
        priceChangePct,
        marketWeather: weather.classification,
        scoreBand: scoreBand(result.score),
        signalBreakdown: JSON.stringify(result.signals),
        analystScore: result.analystScore,
        skepticPenalty: result.skepticPenalty,
        nearMiss: result.score >= 50 && result.score < TRADE_THRESHOLD ? 1 : 0,
        observationType: "NON_TRADE",
      }).returning();
      candidatesEvaluated++;

      await rememberKnowledge(db, ticker, weather.classification, result.signals.find((s) => s.key === "catalyst")?.evidence ?? "Unknown catalyst");

      if (result.status === "WATCH" && priceAtScan !== null) {
        const opened = await tryOpenPosition(db, { candidateRow, storyId: story.id, ticker, priceAtScan, account: currentAccount, weather, now, clock });
        if (opened) {
          positionsOpened++;
          await db.update(schema.candidates).set({ observationType: "TRADE" }).where(eq(schema.candidates.id, candidateRow.id));
        }
      }
    }

    const openPositions = await db.select().from(schema.positions).where(eq(schema.positions.status, "OPEN"));
    for (const position of openPositions) {
      const quote = quoteMap.get(position.ticker) ?? await getQuote(apiKey, quoteSymbolForTicker(position.ticker)).catch(() => null);
      if (!quote) continue;
      const closed = await manageOpenPosition(db, position, quote.c, now, clock);
      if (closed) {
        positionsClosed++;
        // Shadow ("did not buy") positions test the sit-out hypothesis and must never
        // move the real simulated account balance or trip its circuit breakers.
        if (!closed.shadow) currentAccount = await applyRealizedPnl(db, currentAccount, closed.realizedPnl);
      }
    }

    // Calibration reads Atlas's own accumulated observations; it must never
    // be able to fail a scan, and it never mutates live scoring config.
    try { await calibrateFromHistory(db, now); } catch { /* logged next scan */ }

    await db.update(schema.scanRuns).set({
      finishedAt: new Date().toISOString(),
      storiesFetched, candidatesEvaluated, positionsOpened, positionsClosed,
    }).where(eq(schema.scanRuns.id, scanRun.id));
  } catch (error) {
    await db.update(schema.scanRuns).set({
      finishedAt: new Date().toISOString(),
      storiesFetched, candidatesEvaluated, positionsOpened, positionsClosed,
      error: error instanceof Error ? error.message : "Unknown error",
    }).where(eq(schema.scanRuns.id, scanRun.id));
    throw error;
  }
}

function scoreBand(score: number) {
  if (score >= 80) return "80-100";
  if (score >= 60) return "60-79";
  if (score >= 50) return "50-59";
  if (score >= 35) return "35-49";
  return "0-34";
}

async function rememberKnowledge(db: Db, ticker: string, regime: string, catalyst: string) {
  const tickerKey = `ticker:${ticker}`;
  const regimeKey = `regime:${regime}`;
  const catalystKey = `catalyst:${catalyst.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  for (const node of [
    { key: tickerKey, type: "TICKER", label: ticker },
    { key: regimeKey, type: "REGIME", label: regime },
    { key: catalystKey, type: "CATALYST", label: catalyst },
  ]) await db.insert(schema.knowledgeNodes).values(node).onConflictDoNothing();
  // An edge is one relationship observed many times, not many rows. Repeat
  // observations increment evidence_count so edge strength genuinely
  // accumulates; weight mirrors that (capped) for the graph rendering.
  for (const edge of [
    { fromKey: tickerKey, toKey: regimeKey, relation: "OBSERVED_IN" },
    { fromKey: tickerKey, toKey: catalystKey, relation: "RESPONDED_TO" },
  ]) {
    const [existing] = await db.select().from(schema.knowledgeEdges).where(and(
      eq(schema.knowledgeEdges.fromKey, edge.fromKey),
      eq(schema.knowledgeEdges.toKey, edge.toKey),
      eq(schema.knowledgeEdges.relation, edge.relation),
    )).limit(1);
    if (existing) {
      await db.update(schema.knowledgeEdges).set({
        evidenceCount: existing.evidenceCount + 1,
        weight: Math.min(5, 1 + Math.log2(existing.evidenceCount + 1)),
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.knowledgeEdges.id, existing.id));
    } else {
      await db.insert(schema.knowledgeEdges).values(edge);
    }
  }
}

// Once a day, measure what actually happened after each catalyst type: for
// every story observed at least twice in the last 7 days, take the real price
// change from first observation to the latest one, grouped by catalyst label.
// Findings land in the learning journal and as DRAFT experiment sample sizes —
// evidence for review. The live 60-point gate and signal weights never change
// here (validation policy: no live config mutation).
async function calibrateFromHistory(db: Db, now: Date) {
  const today = now.toISOString().slice(0, 10);
  const [alreadyRan] = await db.select().from(schema.learningJournal).where(and(
    eq(schema.learningJournal.kind, "CALIBRATION"),
    gte(schema.learningJournal.createdAt, today),
  )).limit(1);
  if (alreadyRan) return;

  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db.select({
    storyId: schema.candidates.storyId, ticker: schema.candidates.ticker,
    priceChangePct: schema.candidates.priceChangePct, signalBreakdown: schema.candidates.signalBreakdown,
  }).from(schema.candidates).where(gte(schema.candidates.scanAt, since)).orderBy(schema.candidates.scanAt).limit(4000);

  const stories = new Map<string, { label: string; lastChangePct: number | null; observations: number }>();
  for (const row of rows) {
    // Rows written before the signal_breakdown column existed carry no catalyst
    // label. They are skipped outright — folding them into an "Unclassified"
    // bucket would report a measurement of missing data as if it were a real
    // finding about catalyst performance.
    let label: string | null = null;
    try {
      const signals = JSON.parse(row.signalBreakdown || "[]") as { key: string; evidence: string }[];
      label = signals.find((signal) => signal.key === "catalyst")?.evidence ?? null;
    } catch { label = null; }
    if (!label) continue;

    const key = `${row.storyId}:${row.ticker}`;
    const story = stories.get(key);
    if (!story) stories.set(key, { label, lastChangePct: row.priceChangePct, observations: 1 });
    else {
      story.lastChangePct = row.priceChangePct ?? story.lastChangePct;
      story.observations++;
    }
  }

  const followThroughByCatalyst = new Map<string, number[]>();
  for (const story of stories.values()) {
    if (story.observations < 2 || story.lastChangePct === null) continue;
    const list = followThroughByCatalyst.get(story.label) ?? [];
    list.push(story.lastChangePct);
    followThroughByCatalyst.set(story.label, list);
  }

  const findings: string[] = [];
  for (const [label, changes] of followThroughByCatalyst) {
    if (changes.length < 5) continue;
    const sorted = [...changes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const positiveShare = changes.filter((change) => change > 0).length / changes.length;
    findings.push(`${label}: median ${median >= 0 ? "+" : ""}${median.toFixed(2)}% follow-through, ${(positiveShare * 100).toFixed(0)}% positive, n=${changes.length}`);

    const experimentName = `calibration:${label}`;
    const [experiment] = await db.select().from(schema.experiments).where(eq(schema.experiments.name, experimentName)).limit(1);
    if (experiment) {
      await db.update(schema.experiments).set({ sampleSize: changes.length, updatedAt: new Date().toISOString() }).where(eq(schema.experiments.id, experiment.id));
    } else {
      await db.insert(schema.experiments).values({
        name: experimentName,
        hypothesis: `"${label}" stories show real positive price follow-through after first observation.`,
        status: "DRAFT", minSampleSize: 30, sampleSize: changes.length,
      });
    }
  }
  if (findings.length === 0) return;

  await db.insert(schema.learningJournal).values({
    kind: "CALIBRATION",
    title: `Daily catalyst calibration (${today})`,
    detail: findings.join(" · "),
    evidence: JSON.stringify({ windowDays: 7, storiesMeasured: stories.size, catalystsWithSample: findings.length }),
  });
}

async function getOrCreateAccountState(db: Db, tradingDay: string) {
  const rows = await db.select().from(schema.accountState).where(eq(schema.accountState.id, 1)).limit(1);
  if (rows.length === 0) {
    const [created] = await db.insert(schema.accountState).values({ id: 1, tradingDay }).returning();
    return created;
  }
  const account = rows[0];
  if (account.tradingDay !== tradingDay || account.maxOpenPositions !== DEFAULT_MAX_OPEN_POSITIONS) {
    const [updated] = await db.update(schema.accountState).set({
      tradingDay,
      maxOpenPositions: DEFAULT_MAX_OPEN_POSITIONS,
      ...(account.tradingDay !== tradingDay ? { dailyRealizedPnl: 0, dailyLossShutdown: 0, consecutiveLosses: 0 } : {}),
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.accountState.id, 1)).returning();
    return updated;
  }
  return account;
}

async function annotateCandidate(db: Db, candidateId: number, extra: string) {
  const [row] = await db.select({ reason: schema.candidates.reason }).from(schema.candidates).where(eq(schema.candidates.id, candidateId)).limit(1);
  await db.update(schema.candidates).set({ reason: `${row?.reason ?? ""} ${extra}`.trim() }).where(eq(schema.candidates.id, candidateId));
}

async function tryOpenPosition(db: Db, input: {
  candidateRow: typeof schema.candidates.$inferSelect;
  storyId: number; ticker: string; priceAtScan: number;
  account: typeof schema.accountState.$inferSelect;
  weather: { classification: string };
  now: Date; clock: MarketClock;
}): Promise<boolean> {
  if (!isWithinEntryWindow(input.clock)) {
    await annotateCandidate(db, input.candidateRow.id, "Qualifies but not taken: outside the 10:00-3:45 ET entry window.");
    return false;
  }
  if (input.account.dailyLossShutdown) {
    await annotateCandidate(db, input.candidateRow.id, "Qualifies but not taken: daily circuit breaker already tripped.");
    return false;
  }

  const isShadow = input.weather.classification === "SIT_OUT";
  const openPositions = await db.select().from(schema.positions).where(and(eq(schema.positions.status, "OPEN"), eq(schema.positions.shadow, isShadow ? 1 : 0)));

  const maxOpenPositions = input.account.maxOpenPositions;
  if (!isShadow && openPositions.length >= maxOpenPositions) {
    await annotateCandidate(db, input.candidateRow.id, `Qualifies but not taken: max open positions reached (${maxOpenPositions}/${maxOpenPositions}).`);
    return false;
  }
  if (openPositions.some((p) => p.ticker === input.ticker)) {
    await annotateCandidate(db, input.candidateRow.id, "Qualifies but not taken: a position on this ticker is already open.");
    return false;
  }

  const lastClosed = await db.select().from(schema.positions)
    .where(and(eq(schema.positions.ticker, input.ticker), eq(schema.positions.status, "CLOSED")))
    .orderBy(desc(schema.positions.exitAt)).limit(1);
  if (lastClosed[0]?.exitAt) {
    const minsSinceClose = (input.now.getTime() - new Date(lastClosed[0].exitAt).getTime()) / 60000;
    if (minsSinceClose < COOLDOWN_MINUTES) {
      await annotateCandidate(db, input.candidateRow.id, `Qualifies but not taken: in its ${COOLDOWN_MINUTES}-minute stop-out cooldown.`);
      return false;
    }
  }

  // Conservative Robinhood cash-account model: every buy is fully cash-backed,
  // and intraday sale proceeds are not recycled into new entries. Crypto proceeds
  // settle instantly at Robinhood, but the shared daily cap intentionally applies
  // the stricter stock-cash rule to the mixed portfolio.
  const equity = Math.max(0, input.account.startingCapital + input.account.realizedPnl);
  const dayStart = `${input.clock.tradingDay}T00:00:00.000Z`;
  const todaysPositions = await db.select().from(schema.positions).where(and(
    eq(schema.positions.shadow, isShadow ? 1 : 0),
    gte(schema.positions.entryAt, dayStart),
  ));
  const grossPurchasesToday = todaysPositions.reduce((sum, position) => sum + position.entryPrice * position.shares, 0);
  const availableCash = Math.max(0, equity - grossPurchasesToday);
  const simulatedEntryPrice = executionPrice(input.priceAtScan, "BUY", isCryptoTicker(input.ticker));
  const plan = computeEntryPlan(equity, simulatedEntryPrice, input.account.riskPerTradePct, input.account.maxOpenPositions, availableCash);
  if (plan.shares <= 0) {
    await annotateCandidate(db, input.candidateRow.id, "Qualifies but not taken: no settled paper cash remains in today's cash-backed purchase budget.");
    return false;
  }

  const [openedPosition] = await db.insert(schema.positions).values({
    ticker: input.ticker,
    storyId: input.storyId,
    candidateId: input.candidateRow.id,
    status: "OPEN",
    shadow: isShadow ? 1 : 0,
    entryPrice: simulatedEntryPrice,
    entryAt: input.now.toISOString(),
    shares: plan.shares,
    initialStopPrice: plan.initialStopPrice,
    stopPrice: plan.initialStopPrice,
    highWaterMark: simulatedEntryPrice,
    trailingActivated: 0,
    updatedAt: input.now.toISOString(),
  }).returning();

  await db.insert(schema.positionEvents).values({ positionId: openedPosition.id, at: input.now.toISOString(), type: "OPENED", price: simulatedEntryPrice, detail: `Decision ${input.candidateRow.id}: score ${input.candidateRow.score.toFixed(1)}, regime ${input.weather.classification}. Observed $${input.priceAtScan.toFixed(4)}; conservative spread/slippage assumption applied.` });

  return true;
}

async function manageOpenPosition(db: Db, position: typeof schema.positions.$inferSelect, currentPrice: number, now: Date, clock: MarketClock) {
  const forceClose = isForceCloseTime(clock);
  const staged = manageStagedStop({
    entryPrice: position.entryPrice,
    currentPrice,
    highWaterMark: position.highWaterMark,
    stopPrice: position.stopPrice,
    trailingActivated: !!position.trailingActivated,
  });

  for (const event of staged.events) {
    await db.insert(schema.positionEvents).values({ positionId: position.id, at: now.toISOString(), type: event.type, price: currentPrice, detail: event.detail });
  }

  const hitStop = currentPrice <= staged.stopPrice;
  if (!forceClose && !hitStop) {
    await db.update(schema.positions).set({
      stopPrice: staged.stopPrice, highWaterMark: staged.highWaterMark, trailingActivated: staged.trailingActivated ? 1 : 0, updatedAt: now.toISOString(),
    }).where(eq(schema.positions.id, position.id));
    return null;
  }

  const observedExit = hitStop ? staged.stopPrice : currentPrice;
  const exitPrice = executionPrice(observedExit, "SELL", isCryptoTicker(position.ticker));
  const realizedPnl = (exitPrice - position.entryPrice) * position.shares;
  const exitReason = forceClose && !hitStop ? "MARKET_CLOSE" : staged.trailingActivated ? "TRAILING_STOP" : "STOP_LOSS";
  const returnPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
  const candidate = position.candidateId ? (await db.select().from(schema.candidates).where(eq(schema.candidates.id, position.candidateId)).limit(1))[0] : null;
  const expectedWinProbability = candidate ? Math.min(0.95, Math.max(0.05, candidate.score / 100)) : 0.5;
  const actualOutcome = realizedPnl > 0 ? 1 : 0;
  const atlasEdge = actualOutcome - expectedWinProbability;
  const attribution = JSON.stringify({ exitReason, returnPct, entryConfidence: candidate?.score ?? null, marketRegime: candidate?.marketWeather ?? null, thesisConfirmed: realizedPnl > 0 });

  await db.update(schema.positions).set({
    status: "CLOSED", exitPrice, exitAt: now.toISOString(), exitReason, realizedPnl, attribution, atlasEdge,
    stopPrice: staged.stopPrice, highWaterMark: staged.highWaterMark, trailingActivated: staged.trailingActivated ? 1 : 0, updatedAt: now.toISOString(),
  }).where(eq(schema.positions.id, position.id));

  await db.insert(schema.positionEvents).values({ positionId: position.id, at: now.toISOString(), type: "CLOSED", price: exitPrice, detail: `${exitReason}: realized ${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)}` });
  await db.insert(schema.learningJournal).values({ kind: "ATTRIBUTION", title: `${position.ticker} ${realizedPnl > 0 ? "win" : "loss"} attribution`, detail: `Closed via ${exitReason}; return ${returnPct.toFixed(2)}%; Atlas Edge ${atlasEdge.toFixed(3)}.`, evidence: attribution });

  return { realizedPnl, shadow: !!position.shadow };
}

async function applyRealizedPnl(db: Db, account: typeof schema.accountState.$inferSelect, realizedPnl: number) {
  const dailyRealizedPnl = account.dailyRealizedPnl + realizedPnl;
  const consecutiveLosses = realizedPnl < 0 ? account.consecutiveLosses + 1 : 0;
  const dailyLossDollarLimit = (account.startingCapital * DAILY_LOSS_LIMIT_PCT) / 100;
  const dailyLossShutdown = dailyRealizedPnl <= -dailyLossDollarLimit || consecutiveLosses >= 2 ? 1 : 0;

  const [updated] = await db.update(schema.accountState).set({
    realizedPnl: account.realizedPnl + realizedPnl,
    dailyRealizedPnl, consecutiveLosses, dailyLossShutdown,
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.accountState.id, 1)).returning();

  return updated;
}
