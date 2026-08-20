// The decisions Atlas makes about capital, separated from the database work
// that surrounds them. Everything here is a pure function of a snapshot: no
// queries, no writes, no clock reads. The engine gathers the state, asks these
// functions what to do, and performs the resulting I/O.
//
// The split exists so these can be tested. They previously lived as private
// helpers inside engine.ts, each taking a live Db handle, which left the eight
// entry guards, the exit-reason selection and the daily circuit breaker with no
// seam to test through and no coverage at all.

import {
  COOLDOWN_MINUTES, DAILY_LOSS_LIMIT_PCT, computeEntryPlan, executionPrice,
  manageStagedStop, type StopEvent,
} from "./positions.ts";
import { isCryptoTicker } from "./universe.ts";

export type OpenPositionSummary = { ticker: string; storyId: number | null };
export type PurchaseSummary = { entryPrice: number; shares: number };

export type AccountSnapshot = {
  startingCapital: number;
  realizedPnl: number;
  maxOpenPositions: number;
  riskPerTradePct: number;
  dailyLossShutdown: number | boolean;
};

export type EntryGuardInput = {
  ticker: string;
  storyId: number;
  priceAtScan: number;
  now: Date;
  account: AccountSnapshot;
  /** Sources Atlas cannot trade safely without, that are currently unreachable. */
  criticalDown: string[];
  withinEntryWindow: boolean;
  /** Shadow positions are recorded during SIT_OUT weather but risk no capital. */
  isShadow: boolean;
  /** Already filtered to the same shadow mode as this candidate. */
  openPositions: OpenPositionSummary[];
  /** Every position opened today in this shadow mode, for the cash-backed budget. */
  todaysPositions: PurchaseSummary[];
  /** When this ticker was last closed, or null if it has never been traded. */
  lastClosedExitAt: string | null;
  sessionAtrPct: number | null;
};

export type EntryPlan = ReturnType<typeof computeEntryPlan>;
export type EntryDecision =
  | { allowed: false; reason: string }
  | { allowed: true; entryPrice: number; plan: EntryPlan };

const declined = (reason: string): EntryDecision => ({ allowed: false, reason: `Qualifies but not taken: ${reason}` });

/**
 * The three guards that depend on nothing but the current scan. They are split
 * out so the engine can reject a candidate before spending D1 reads on the
 * position queries the remaining guards need — this runs per candidate, per
 * scan, against a subrequest budget. Returns null when nothing blocks.
 */
export function preflightEntryGuards(input: Pick<EntryGuardInput, "criticalDown" | "withinEntryWindow" | "account">): EntryDecision | null {
  // A source marked critical is one Atlas cannot trade safely without: the
  // price feed it values positions from, or the halt feed that stops it buying
  // a suspended security. If one is down, entries stop.
  if (input.criticalDown.length > 0) {
    return declined(`${input.criticalDown.join(", ")} unreachable — entries are blocked until critical feeds recover.`);
  }
  if (!input.withinEntryWindow) {
    return declined("outside the 10:00-3:45 ET entry window.");
  }
  if (input.account.dailyLossShutdown) {
    return declined("daily circuit breaker already tripped.");
  }
  return null;
}

/**
 * The eight guards between a qualifying candidate and an open position, in the
 * order they are checked. Order is user-visible: a candidate that trips several
 * guards reports the first, and that string is what the dashboard shows.
 */
export function evaluateEntryGuards(input: EntryGuardInput): EntryDecision {
  const preflight = preflightEntryGuards(input);
  if (preflight) return preflight;

  const maxOpenPositions = input.account.maxOpenPositions;
  if (!input.isShadow && input.openPositions.length >= maxOpenPositions) {
    return declined(`max open positions reached (${maxOpenPositions}/${maxOpenPositions}).`);
  }
  if (input.openPositions.some((position) => position.ticker === input.ticker)) {
    return declined("a position on this ticker is already open.");
  }

  // One story, one position. News feeds tag a single article to many tickers —
  // a single "Nvidia strikes deal with OpenAI" piece opened GOOGL, AMZN and
  // MSFT simultaneously, putting ~60% of the account behind one headline. Those
  // are not independent bets: if the story is wrong, every position built on it
  // is wrong together, which defeats the diversification the equal-slot design
  // assumes. The first ticker to qualify on a story takes the slot.
  const sameStory = input.openPositions.find((position) => position.storyId !== null && position.storyId === input.storyId);
  if (sameStory) {
    return declined(`${sameStory.ticker} already holds the slot for this same story — one story, one position.`);
  }

  if (input.lastClosedExitAt) {
    const minutesSinceClose = (input.now.getTime() - new Date(input.lastClosedExitAt).getTime()) / 60000;
    if (minutesSinceClose < COOLDOWN_MINUTES) {
      return declined(`in its ${COOLDOWN_MINUTES}-minute stop-out cooldown.`);
    }
  }

  // Conservative Robinhood cash-account model: every buy is fully cash-backed,
  // and intraday sale proceeds are not recycled into new entries. Crypto proceeds
  // settle instantly at Robinhood, but the shared daily cap intentionally applies
  // the stricter stock-cash rule to the mixed portfolio.
  const equity = Math.max(0, input.account.startingCapital + input.account.realizedPnl);
  const grossPurchasesToday = input.todaysPositions.reduce((sum, position) => sum + position.entryPrice * position.shares, 0);
  const availableCash = Math.max(0, equity - grossPurchasesToday);
  const entryPrice = executionPrice(input.priceAtScan, "BUY", isCryptoTicker(input.ticker));
  const plan = computeEntryPlan(
    equity, entryPrice, input.account.riskPerTradePct, maxOpenPositions, availableCash, input.sessionAtrPct,
  );
  if (plan.shares <= 0) {
    return declined("no settled paper cash remains in today's cash-backed purchase budget.");
  }

  return { allowed: true, entryPrice, plan };
}

export type ExitReason = "STOP_LOSS" | "TRAILING_STOP" | "MARKET_CLOSE";
export type OpenPositionState = {
  ticker: string;
  entryPrice: number;
  shares: number;
  highWaterMark: number;
  stopPrice: number;
  trailingActivated: boolean;
};

export type ExitDecision = {
  /** The staged stop for this scan, whether or not the position closes. */
  stopPrice: number;
  highWaterMark: number;
  trailingActivated: boolean;
  events: StopEvent[];
} & (
  | { close: false }
  | { close: true; exitReason: ExitReason; exitPrice: number; realizedPnl: number; returnPct: number }
);

/**
 * Advances the stop and decides whether this scan closes the position. A stop
 * that price has reached always wins over the clock: a position that hit its
 * stop at 15:46 exited on the stop, not on the bell.
 */
export function decideExit(position: OpenPositionState, currentPrice: number, forceClose: boolean): ExitDecision {
  const staged = manageStagedStop({
    entryPrice: position.entryPrice,
    currentPrice,
    highWaterMark: position.highWaterMark,
    stopPrice: position.stopPrice,
    trailingActivated: position.trailingActivated,
  });
  const carried = {
    stopPrice: staged.stopPrice,
    highWaterMark: staged.highWaterMark,
    trailingActivated: staged.trailingActivated,
    events: staged.events,
  };

  const hitStop = currentPrice <= staged.stopPrice;
  if (!forceClose && !hitStop) return { ...carried, close: false };

  // A stop that was reached fills at the stop, not at the last observed price.
  const observedExit = hitStop ? staged.stopPrice : currentPrice;
  const exitPrice = executionPrice(observedExit, "SELL", isCryptoTicker(position.ticker));
  const exitReason: ExitReason = forceClose && !hitStop ? "MARKET_CLOSE"
    : staged.trailingActivated ? "TRAILING_STOP"
    : "STOP_LOSS";

  return {
    ...carried,
    close: true,
    exitReason,
    exitPrice,
    realizedPnl: (exitPrice - position.entryPrice) * position.shares,
    returnPct: ((exitPrice - position.entryPrice) / position.entryPrice) * 100,
  };
}

export type AccountLedger = {
  startingCapital: number;
  realizedPnl: number;
  dailyRealizedPnl: number;
  consecutiveLosses: number;
};

export type AccountDelta = {
  realizedPnl: number;
  dailyRealizedPnl: number;
  consecutiveLosses: number;
  dailyLossShutdown: number;
};

/**
 * Books a closed trade against the account and decides whether the daily
 * circuit breaker trips. Two independent triggers: the drawdown limit, and two
 * consecutive losses regardless of size.
 */
export function applyRealizedPnl(account: AccountLedger, realizedPnl: number): AccountDelta {
  const dailyRealizedPnl = account.dailyRealizedPnl + realizedPnl;
  const consecutiveLosses = realizedPnl < 0 ? account.consecutiveLosses + 1 : 0;
  const dailyLossDollarLimit = (account.startingCapital * DAILY_LOSS_LIMIT_PCT) / 100;
  const dailyLossShutdown = dailyRealizedPnl <= -dailyLossDollarLimit || consecutiveLosses >= 2 ? 1 : 0;

  return {
    realizedPnl: account.realizedPnl + realizedPnl,
    dailyRealizedPnl,
    consecutiveLosses,
    dailyLossShutdown,
  };
}
