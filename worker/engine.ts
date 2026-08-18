import { and, desc, eq, gte } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { getCompanyNews, getCryptoNews, getQuote, getQuotesThrottled, type FinnhubQuote } from "./finnhub";
import { getMarketClock, isForceCloseTime, isWithinCollectionWindow, isWithinEntryWindow, type MarketClock } from "./market-hours";
import { COOLDOWN_MINUTES, DAILY_LOSS_LIMIT_PCT, DEFAULT_MAX_OPEN_POSITIONS, computeEntryPlan, executionPrice, manageStagedStop } from "./positions";
import { classifyMarketWeather, CONFIRMATION_ELIGIBILITY_THRESHOLD, scoreCandidate, TRADE_THRESHOLD } from "./scoring";
import { getRecentSecFilings } from "./sec-edgar";
import { assessManipulationRisk } from "./manipulation";
import { reviewTrade, type ReviewBars } from "./trade-review";
import { analyzeBands } from "./band-analysis";
import { collectFreeSourceSnapshot, cryptoQuoteDisagreementPct, yahooNews, yahooQuotes } from "./free-sources";
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
      // News collection pauses outside the window, but open positions must
      // never be left unmanaged: stops and the force-close still have to be
      // evaluated. Skipping this stranded five positions past the closing bell
      // when the window ended before they were flattened.
      const stranded = await db.select().from(schema.positions).where(eq(schema.positions.status, "OPEN"));
      if (stranded.length > 0) {
        const prices = await yahooQuotes(stranded.map((p) => (isCryptoTicker(p.ticker) ? `${p.ticker}-USD` : p.ticker)));
        let account = await getOrCreateAccountState(db, clock.tradingDay);
        for (const position of stranded) {
          const snapshot = prices.get(isCryptoTicker(position.ticker) ? `${position.ticker}-USD` : position.ticker);
          if (!snapshot) continue;
          const closed = await manageOpenPosition(db, position, snapshot.price, now, clock);
          if (closed) {
            positionsClosed++;
            if (!closed.shadow) account = await applyRealizedPnl(db, account, closed.realizedPnl);
          }
        }
      }
      try { await reviewClosedTrades(db, now); } catch { /* never fails a scan */ }
      await db.update(schema.scanRuns).set({ finishedAt: new Date().toISOString(), positionsClosed }).where(eq(schema.scanRuns.id, scanRun.id));
      return;
    }

    const freeSources = await collectFreeSourceSnapshot(now);

    const account = await getOrCreateAccountState(db, clock.tradingDay);

    // A Cloudflare Worker invocation is capped at 50 subrequests. Fetching both
    // Finnhub and Yahoo quotes for 23 symbols, plus 20 company-news calls, put a
    // scan around 81 — so everything past the cap failed silently, and company
    // news (last in the sequence) never ran at all. That is why breadth read
    // 3/20 and no candidates were scored during live market hours.
    //
    // Quotes now come from Yahoo alone: it returned 20/20 in testing where
    // Finnhub returned 4, because Finnhub rate-limits the shared Cloudflare
    // egress IPs. Finnhub's remaining job is news, which Yahoo does not provide.
    const finnhubQuotes = new Map<string, FinnhubQuote | null>();

    // Whatever the primary feed still dropped, ask Yahoo for — a second
    // independent source of real observed prices, never an estimate. This is
    // what lifts breadth out of the "8/20 quotes" starvation that kept market
    // weather permanently incomplete.
    const asQuote = (snapshot: { price: number; prevClose: number | null; changePct: number | null }): FinnhubQuote | null =>
      snapshot.changePct === null
        ? null
        : { c: snapshot.price, d: snapshot.prevClose === null ? null : snapshot.price - snapshot.prevClose, dp: snapshot.changePct, h: snapshot.price, o: snapshot.price, l: snapshot.price, pc: snapshot.prevClose ?? snapshot.price, t: Math.floor(now.getTime() / 1000) };

    // Yahoo covers the whole universe every scan rather than only patching the
    // gaps Finnhub leaves — gap-filling still produced a starved breadth sample
    // (4 of 20 during live market hours) because Finnhub drops most of the
    // burst. Finnhub still wins where it did respond; Yahoo fills everything else.
    const universeQuotes = new Map(finnhubQuotes);
    const yahooAll = await yahooQuotes(["SPY", "QQQ", "VIXY", ...TICKER_UNIVERSE]);
    for (const [symbol, snapshot] of yahooAll) {
      if (universeQuotes.get(symbol)?.dp == null) {
        const quote = asQuote(snapshot);
        if (quote) universeQuotes.set(symbol, quote);
      }
    }

    // Each connection is judged by whether it delivered the thing Atlas actually
    // relies on it for this scan, not by a bare ping. Yahoo is measured on real
    // usable quotes because that is now the price source the engine depends on.
    const yahooLive = Array.from(universeQuotes.values()).filter((quote) => quote?.dp != null).length;
    const probes = new Map<string, { ok: boolean; detail: string }>([
      ["Yahoo Finance", { ok: yahooLive >= 10, detail: `${yahooLive} usable quotes` }],
      ...(["Nasdaq Trading Halts", "Federal Reserve", "BLS", "openFDA", "Coinbase", "Press-release wires"] as const)
        .map((name) => [name, {
          ok: freeSources.health[name] === "LIVE",
          detail: freeSources.health[name] === "LIVE" ? "responding" : "no response",
        }] as [string, { ok: boolean; detail: string }]),
    ]);
    const criticalDown = await recordConnectionHealth(db, probes, now);

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
    // News is rotated in halves across consecutive scans to stay inside the
    // subrequest budget. Every ticker is still checked every 10 minutes, which
    // is well inside the 6-hour freshness window the scorer allows.
    const half = Math.ceil(TICKER_UNIVERSE.length / 2);
    const rotation = Math.floor(now.getTime() / (5 * 60 * 1000)) % 2;
    const newsTickers = TICKER_UNIVERSE.slice(rotation * half, rotation * half + half);

    const pairs: { ticker: string; story: typeof schema.newsStories.$inferSelect }[] = [];
    for (const ticker of newsTickers) {
      const items = await yahooNews(ticker).catch(() => []);
      const newestItems = [...items].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 10);
      for (const item of newestItems) {
        const publishedAt = new Date(item.publishedAt);
        const ageMinutes = (now.getTime() - publishedAt.getTime()) / 60000;

        const existing = await db.select().from(schema.newsStories).where(eq(schema.newsStories.finnhubId, item.id)).limit(1);
        let story = existing[0];
        if (!story) {
          const [inserted] = await db.insert(schema.newsStories).values({
            finnhubId: item.id,
            headline: item.headline,
            summary: item.summary,
            source: item.source,
            url: item.url,
            publishedAt: publishedAt.toISOString(),
            relatedTickers: ticker,
            finnhubCategory: "yahoo-news",
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
        relativeVolume: yahooAll.get(ticker)?.relativeVolume ?? null,
      });
      // Manipulation screen runs before scoring can matter: a pump does not
      // become safe because its headline reads well.
      const manipulation = assessManipulationRisk({
        ticker, relativeVolume: yahooAll.get(ticker)?.relativeVolume ?? null,
        priceChangePct, independentSourceCount,
        traceableSource: Boolean(story.source.trim() && /^https?:\/\//i.test(story.url)),
        halts: freeSources.halts, now,
      });

      const result = manipulation.blocked
        ? { ...scored, score: 0, status: "DISQUALIFIED" as const, reason: `Manipulation screen: ${manipulation.reasons[0]}` }
        : story.finnhubCategory === "sec-filing"
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
        const opened = await tryOpenPosition(db, { candidateRow, storyId: story.id, ticker, priceAtScan, account: currentAccount, weather, now, clock, criticalDown,
          sessionAtrPct: (yahooAll.get(ticker)?.atrPct ?? null) === null ? null : (yahooAll.get(ticker)!.atrPct! * Math.sqrt(6.5 * 12)) });
        if (opened) {
          positionsOpened++;
          await db.update(schema.candidates).set({ observationType: "TRADE" }).where(eq(schema.candidates.id, candidateRow.id));
        }
      }
    }

    const openPositions = await db.select().from(schema.positions).where(eq(schema.positions.status, "OPEN"));

    // Every risk control — stop-loss, breakeven, trailing, and the 3:45
    // force-close — depends on having a price for each open position. This
    // previously fell back to Finnhub, which returns nothing from a Cloudflare
    // Worker because Finnhub rate-limits the shared egress IPs. The result was
    // `continue` on every position: stops never fired and positions were still
    // open after the closing bell. Prices now come from the Yahoo map the rest
    // of the scan already uses, with a direct Yahoo fetch for anything missing
    // (crypto, or a ticker that has left the universe).
    const positionQuotes = new Map<string, number>();
    for (const position of openPositions) {
      const known = universeQuotes.get(position.ticker)?.c ?? quoteMap.get(position.ticker)?.c;
      if (known != null) positionQuotes.set(position.ticker, known);
    }
    const unpriced = openPositions.map((p) => p.ticker).filter((ticker) => !positionQuotes.has(ticker));
    if (unpriced.length > 0) {
      for (const [ticker, snapshot] of await yahooQuotes(unpriced.map((t) => (isCryptoTicker(t) ? `${t}-USD` : t)))) {
        positionQuotes.set(ticker.replace(/-USD$/, ""), snapshot.price);
      }
    }

    for (const position of openPositions) {
      const price = positionQuotes.get(position.ticker);
      // An unpriceable open position is a risk-management failure, not a
      // no-op: record it so it surfaces instead of failing silently.
      if (price == null) {
        await db.insert(schema.positionEvents).values({
          positionId: position.id, at: now.toISOString(), type: "STOP_MOVED", price: position.stopPrice,
          detail: "No live price available this scan — stop and force-close could not be evaluated.",
        });
        continue;
      }
      const closed = await manageOpenPosition(db, position, price, now, clock);
      if (closed) {
        positionsClosed++;
        // Shadow ("did not buy") positions test the sit-out hypothesis and must never
        // move the real simulated account balance or trip its circuit breakers.
        if (!closed.shadow) currentAccount = await applyRealizedPnl(db, currentAccount, closed.realizedPnl);
      }
    }

    // Calibration reads Atlas's own accumulated observations; it must never
    // be able to fail a scan, and it never mutates live scoring config.
    try { await reviewClosedTrades(db, now); } catch { /* never fails a scan */ }
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
  // Band verdict: does a higher confidence score actually produce a better
  // outcome? Recomputed daily so the answer arrives on its own once the sample
  // is large enough, rather than waiting to be asked.
  const reviewRows = await db.select().from(schema.tradeReviews);
  const verdict = analyzeBands(reviewRows.map((row) => ({
    band: row.entryBand, entryScore: row.entryScore, returnPct: row.returnPct, realizedPnl: row.realizedPnl,
  })));
  await db.insert(schema.learningJournal).values({
    kind: "CALIBRATION",
    title: verdict.readyToSizeByConfidence
      ? "Confidence-weighted sizing is now supported by evidence"
      : `Confidence vs outcome — ${verdict.comparableBands} band(s) comparable`,
    detail: verdict.verdict,
    evidence: JSON.stringify({
      correlation: verdict.correlation, sampleSize: verdict.sampleSize,
      comparableBands: verdict.comparableBands, monotonic: verdict.monotonic,
      bands: verdict.bands.filter((band) => band.closed > 0),
    }),
  });

  if (findings.length === 0) return;

  await db.insert(schema.learningJournal).values({
    kind: "CALIBRATION",
    title: `Daily catalyst calibration (${today})`,
    detail: findings.join(" · "),
    evidence: JSON.stringify({ windowDays: 7, storiesMeasured: stories.size, catalystsWithSample: findings.length }),
  });
}

// Connections Atlas depends on. `critical` marks the ones whose loss should
// stop trading rather than merely be noted. Robinhood is intentionally absent:
// no broker is connected yet, and listing one that doesn't exist would be a
// fabricated status. Adding it later means adding a probe here, nothing more.
const CONNECTION_REGISTRY: { name: string; kind: string; critical: boolean }[] = [
  // Yahoo is now the sole source of prices and news, so losing it means Atlas
  // cannot value a position or see a catalyst — genuinely critical. Finnhub is
  // deliberately absent: its only remaining use is crypto news, and monitoring
  // a connection Atlas no longer depends on produced a permanent false alarm.
  { name: "Yahoo Finance", kind: "DATA", critical: true },
  { name: "Nasdaq Trading Halts", kind: "DATA", critical: true },
  { name: "Federal Reserve", kind: "DATA", critical: false },
  { name: "BLS", kind: "DATA", critical: false },
  { name: "openFDA", kind: "DATA", critical: false },
  { name: "Coinbase", kind: "DATA", critical: false },
  { name: "Press-release wires", kind: "DATA", critical: false },
];

// A connection has to fail twice in a row before it is called DOWN. A single
// timeout on a free endpoint is normal noise; alerting on it would train the
// user to ignore alerts.
const FAILURES_BEFORE_DOWN = 2;

async function recordConnectionHealth(db: Db, observed: Map<string, { ok: boolean; detail: string }>, now: Date) {
  const nowIso = now.toISOString();
  const criticalDown: string[] = [];
  for (const connection of CONNECTION_REGISTRY) {
    const probe = observed.get(connection.name);
    if (!probe) continue;

    const [existing] = await db.select().from(schema.connectionStatus).where(eq(schema.connectionStatus.name, connection.name)).limit(1);
    const previousStatus = existing?.status ?? "LIVE";
    const consecutiveFailures = probe.ok ? 0 : (existing?.consecutiveFailures ?? 0) + 1;
    const status = probe.ok ? "LIVE" : consecutiveFailures >= FAILURES_BEFORE_DOWN ? "DOWN" : "DEGRADED";

    const row = {
      name: connection.name, kind: connection.kind, status,
      critical: connection.critical ? 1 : 0,
      detail: probe.detail, consecutiveFailures,
      lastOkAt: probe.ok ? nowIso : existing?.lastOkAt ?? null,
      lastCheckedAt: nowIso,
    };
    if (existing) await db.update(schema.connectionStatus).set(row).where(eq(schema.connectionStatus.name, connection.name));
    else await db.insert(schema.connectionStatus).values(row);
    if (connection.critical && status === "DOWN") criticalDown.push(connection.name);

    // Only a real transition is an event. Steady state writes nothing.
    if (existing && previousStatus !== status) {
      const recovered = status === "LIVE";
      await db.insert(schema.connectionEvents).values({
        at: nowIso, name: connection.name, fromStatus: previousStatus, toStatus: status,
        severity: recovered ? "INFO" : status === "DOWN" && connection.critical ? "CRITICAL" : "WARNING",
        detail: recovered
          ? `${connection.name} is responding again.`
          : `${connection.name} ${status === "DOWN" ? "is not responding" : "failed a check"}: ${probe.detail}`,
      });
    }
  }
  return criticalDown;
}

// Every closed position gets exactly one post-mortem, built from real intraday
// bars once the trade is finished. Runs a few at a time so it never competes
// with the scan for the Worker's subrequest budget, and never throws into it.
async function reviewClosedTrades(db: Db, now: Date, limit = 3) {
  const reviewed = await db.select({ positionId: schema.tradeReviews.positionId }).from(schema.tradeReviews);
  const done = new Set(reviewed.map((r) => r.positionId));
  const closed = await db.select().from(schema.positions)
    .where(eq(schema.positions.status, "CLOSED")).orderBy(desc(schema.positions.id)).limit(60);
  const pending = closed.filter((p) => !done.has(p.id) && p.exitAt && p.exitPrice !== null).slice(0, limit);

  for (const position of pending) {
    let bars: ReviewBars | null = null;
    try {
      const symbol = isCryptoTicker(position.ticker) ? `${position.ticker}-USD` : position.ticker;
      const response = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=5d`,
        { headers: { "User-Agent": "Mozilla/5.0 (compatible; AtlasPaperSim/1.0)" }, signal: AbortSignal.timeout(8000) },
      );
      if (response.ok) {
        const data = await response.json() as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[] }[] } }[] } };
        const result = data.chart?.result?.[0];
        const quote = result?.indicators?.quote?.[0];
        if (result?.timestamp && quote) bars = { t: result.timestamp, high: quote.high ?? [], low: quote.low ?? [], close: quote.close ?? [] };
      }
    } catch { /* review still records what it can without bars */ }

    const review = reviewTrade({
      entryPrice: position.entryPrice, exitPrice: position.exitPrice!, entryAt: position.entryAt,
      exitAt: position.exitAt!, initialStopPrice: position.initialStopPrice,
      realizedPnl: position.realizedPnl ?? 0, exitReason: position.exitReason ?? "",
    }, bars);

    const candidate = position.candidateId
      ? (await db.select().from(schema.candidates).where(eq(schema.candidates.id, position.candidateId)).limit(1))[0]
      : null;
    let catalystLabel = "";
    try {
      const signals = JSON.parse(candidate?.signalBreakdown || "[]") as { key: string; evidence: string }[];
      catalystLabel = signals.find((signal) => signal.key === "catalyst")?.evidence ?? "";
    } catch { /* left blank rather than guessed */ }

    const entryHourEt = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false })
      .format(new Date(position.entryAt)).replace(/\D/g, "")) || null;

    await db.insert(schema.tradeReviews).values({
      positionId: position.id, reviewedAt: now.toISOString(), ticker: position.ticker,
      entryScore: candidate?.score ?? null, entryBand: candidate?.scoreBand ?? "",
      catalystLabel, marketWeather: candidate?.marketWeather ?? "", entryHourEt,
      independentSources: 0,
      realizedPnl: position.realizedPnl ?? 0,
      returnPct: ((position.exitPrice! - position.entryPrice) / position.entryPrice) * 100,
      exitReason: position.exitReason ?? "", holdMinutes: review.holdMinutes,
      mfePct: review.mfePct, maePct: review.maePct, mfeMinutes: review.mfeMinutes, maeMinutes: review.maeMinutes,
      stopDistancePct: review.stopDistancePct, postExitDriftPct: review.postExitDriftPct,
      findings: JSON.stringify(review.findings),
    });

    if (review.findings.length > 0) {
      await db.insert(schema.learningJournal).values({
        kind: "ATTRIBUTION",
        title: `${position.ticker} post-mortem (${(position.realizedPnl ?? 0) >= 0 ? "+" : ""}$${(position.realizedPnl ?? 0).toFixed(2)})`,
        detail: review.findings.join(" "),
        evidence: JSON.stringify({ mfePct: review.mfePct, maePct: review.maePct, postExitDriftPct: review.postExitDriftPct, holdMinutes: review.holdMinutes, exitReason: position.exitReason }),
      });
    }
  }
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
  criticalDown: string[];
  sessionAtrPct: number | null;
}): Promise<boolean> {
  // A source marked critical is one Atlas cannot trade safely without: the
  // price feed it values positions from, or the halt feed that stops it buying
  // a suspended security. If one is down, entries stop — the dashboard says so,
  // and this is what makes that claim true rather than decorative.
  if (input.criticalDown.length > 0) {
    await annotateCandidate(db, input.candidateRow.id, `Qualifies but not taken: ${input.criticalDown.join(", ")} unreachable — entries are blocked until critical feeds recover.`);
    return false;
  }
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
  // One story, one position. News feeds tag a single article to many tickers —
  // a single "Nvidia strikes deal with OpenAI" piece opened GOOGL, AMZN and
  // MSFT simultaneously, putting ~60% of the account behind one headline. Those
  // are not independent bets: if the story is wrong, every position built on it
  // is wrong together, which defeats the diversification the equal-slot design
  // assumes. The first ticker to qualify on a story takes the slot; the rest are
  // recorded as observations with the reason stated.
  const sameStory = openPositions.find((p) => p.storyId !== null && p.storyId === input.storyId);
  if (sameStory) {
    await annotateCandidate(db, input.candidateRow.id, `Qualifies but not taken: ${sameStory.ticker} already holds the slot for this same story — one story, one position.`);
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
  const plan = computeEntryPlan(equity, simulatedEntryPrice, input.account.riskPerTradePct, input.account.maxOpenPositions, availableCash, input.sessionAtrPct);
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
