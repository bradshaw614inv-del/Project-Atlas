import { and, desc, eq, gte } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { candleVwap, getCandles, getCompanyNews, getCryptoNews, getQuote, type FinnhubQuote } from "./finnhub";
import { getMarketClock, isForceCloseTime, isWithinEntryWindow, type MarketClock } from "./market-hours";
import { COOLDOWN_MINUTES, DAILY_LOSS_LIMIT_PCT, DEFAULT_MAX_OPEN_POSITIONS, computeEntryPlan, executionPrice, manageStagedStop } from "./positions";
import { classifyMarketWeather, CONFIRMATION_ELIGIBILITY_THRESHOLD, scoreCandidate, TRADE_THRESHOLD } from "./scoring";
import { TICKER_UNIVERSE, cryptoTickersForStory, isCryptoTicker, quoteSymbolForTicker } from "./universe";

type Db = DrizzleD1Database<typeof schema>;

// Finnhub's free company-news feed is commonly delivered several hours after
// publication. Six hours matches the scorer's existing freshness hard gate and
// lets Atlas study real delayed stories without pretending they arrived live.
const LOOKBACK_MINUTES = 360;
const COLLECTION_LOOKBACK_DAYS = 1;
const MAX_CANDIDATE_TICKERS = 15;

export async function runScan(db: Db, apiKey: string, now: Date) {
  const startedAt = now.toISOString();
  const [scanRun] = await db.insert(schema.scanRuns).values({ startedAt }).returning();
  let storiesFetched = 0, candidatesEvaluated = 0, positionsOpened = 0, positionsClosed = 0;

  try {
    const clock = getMarketClock(now);

    const account = await getOrCreateAccountState(db, clock.tradingDay);

    const sessionFrom = Math.floor((now.getTime() - 8 * 60 * 60 * 1000) / 1000);
    const [spy, qqq, volatilityProxy, spyCandles, ...breadthQuotes] = await Promise.all([
      getQuote(apiKey, "SPY").catch(() => null),
      getQuote(apiKey, "QQQ").catch(() => null),
      getQuote(apiKey, "VIXY").catch(() => null),
      getCandles(apiKey, "SPY", sessionFrom, Math.floor(now.getTime() / 1000)).catch(() => null),
      ...TICKER_UNIVERSE.map((ticker) => getQuote(apiKey, ticker).catch(() => null)),
    ]);
    const breadth = breadthQuotes.filter((quote): quote is FinnhubQuote => !!quote && quote.dp !== null);
    const weather = classifyMarketWeather({
      spy, qqq, spyVwap: candleVwap(spyCandles),
      advancers: breadth.filter((quote) => (quote.dp ?? 0) > 0).length,
      decliners: breadth.filter((quote) => (quote.dp ?? 0) < 0).length,
      breadthSample: breadth.length, volatilityProxy,
    });
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
    const independentSourcesByTicker = new Map<string, number>();
    for (const ticker of uniqueTickers) {
      const sources = new Set(pairs
        .filter((pair) => pair.ticker === ticker && pair.story.source.trim() && /^https?:\/\//i.test(pair.story.url))
        .map((pair) => pair.story.source.trim().toLowerCase()));
      independentSourcesByTicker.set(ticker, sources.size);
    }
    const quoteMap = new Map<string, FinnhubQuote | null>();
    for (const ticker of uniqueTickers) {
      quoteMap.set(ticker, await getQuote(apiKey, quoteSymbolForTicker(ticker)).catch(() => null));
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

      const result = scoreCandidate({
        ticker, now, headline: story.headline, summary: story.summary, priceAtScan, priceChangePct,
        minutesSincePublished, seenConfirmationEligibleLastScan, source: story.source, sourceUrl: story.url,
        independentSourceCount: independentSourcesByTicker.get(ticker) ?? 0,
      });

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
  for (const edge of [
    { fromKey: tickerKey, toKey: regimeKey, relation: "OBSERVED_IN" },
    { fromKey: tickerKey, toKey: catalystKey, relation: "RESPONDED_TO" },
  ]) await db.insert(schema.knowledgeEdges).values(edge);
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
