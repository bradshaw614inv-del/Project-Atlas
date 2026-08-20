// Presentation logic for the dashboard, separated from the component that
// renders it. These are the numbers and labels a reader takes at face value —
// what fraction of the account is deployed, whether a position is up, whether a
// weather flag reads as good news — so they are worth asserting on directly.
//
// page.tsx is a client component; testing it end to end needs a JSX toolchain
// the test runner does not have. Its derived values do not, and they are the
// part that can be wrong in a way a reader would not notice.

import { isCryptoTicker } from "../worker/universe.ts";

export function assetClass(ticker: string) {
  return isCryptoTicker(ticker) ? `crypto crypto-${ticker.toLowerCase()}` : "stock";
}

export function money(n: number, digits = 2) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

export function displayDate(value: string) {
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function timeAgo(value: string, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function flagTone(flag: string): "positive" | "negative" | "neutral" {
  if (/unavailable|completeness|will not infer/i.test(flag)) return "neutral";
  const breadth = flag.match(/(\d+) advancing \/ (\d+) declining/i);
  if (breadth) return Number(breadth[1]) >= Number(breadth[2]) ? "positive" : "negative";
  if (/above vwap/i.test(flag)) return "positive";
  if (/below vwap/i.test(flag)) return "negative";
  if (/event risk|halted/i.test(flag)) return "negative";
  const volatility = flag.match(/volatility proxy ([+-][\d.]+)%/i);
  if (volatility) return Number(volatility[1]) > 0.5 ? "negative" : "positive";
  const pct = flag.match(/([+-][\d.]+)%/);
  if (pct) return Number(pct[1]) >= 0 ? "positive" : "negative";
  return "neutral";
}

export type PositionView = {
  ticker: string; shadow: number; entryPrice: number; shares: number; realizedPnl: number | null;
};
export type AccountView = { startingCapital: number; realizedPnl: number } | null;

export type PortfolioTotals = {
  closedCount: number; wins: number; winRate: number | null;
  unrealizedPnl: number; portfolioValue: number | null;
  investedCost: number; investedValue: number;
  investedPct: number; unrealizedPct: number;
  quotedCount: number; realOpenCount: number;
};

/**
 * The headline figures on the dashboard. Shadow positions are excluded
 * throughout: they were recorded during SIT_OUT weather and risk no capital, so
 * counting them would overstate both exposure and the win rate.
 */
export function portfolioTotals(
  openPositions: PositionView[],
  closedPositions: PositionView[],
  livePrices: Record<string, number | undefined>,
  account: AccountView,
): PortfolioTotals {
  const realClosed = closedPositions.filter((position) => !position.shadow);
  const wins = realClosed.filter((position) => (position.realizedPnl ?? 0) > 0).length;
  const realOpen = openPositions.filter((position) => !position.shadow);

  const unrealizedPnl = realOpen.reduce((sum, position) => {
    const live = livePrices[position.ticker];
    return sum + (live == null ? 0 : (live - position.entryPrice) * position.shares);
  }, 0);

  const investedCost = realOpen.reduce((sum, position) => sum + position.entryPrice * position.shares, 0);

  // A position with no live quote contributes its entry cost rather than an
  // invented current value.
  const investedValue = realOpen.reduce((sum, position) => {
    const live = livePrices[position.ticker];
    return sum + (live == null ? position.entryPrice * position.shares : live * position.shares);
  }, 0);

  // Slots are sized from equity (contributed capital plus realized P&L), so the
  // percentage has to divide by the same basis. Dividing by contributed capital
  // alone reported a fully-invested account as 100.1%.
  const equityBasis = account ? account.startingCapital + account.realizedPnl : 0;

  return {
    closedCount: realClosed.length,
    wins,
    winRate: realClosed.length ? Math.round((wins / realClosed.length) * 100) : null,
    unrealizedPnl,
    portfolioValue: account ? account.startingCapital + account.realizedPnl + unrealizedPnl : null,
    investedCost,
    investedValue,
    investedPct: equityBasis > 0 ? (investedCost / equityBasis) * 100 : 0,
    unrealizedPct: investedCost > 0 ? (unrealizedPnl / investedCost) * 100 : 0,
    quotedCount: realOpen.filter((position) => livePrices[position.ticker] != null).length,
    realOpenCount: realOpen.length,
  };
}
