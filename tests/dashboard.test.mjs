import assert from "node:assert/strict";
import test from "node:test";
import {
  assetClass, flagTone, money, portfolioTotals, timeAgo,
} from "../app/dashboard-format.ts";
import { getMarketClock, isMarketOpen } from "../worker/market-hours.ts";

// This replaces a test that read app/page.tsx as a string and regex-matched the
// source. It asserted that certain words appeared in the file, so it passed if
// they sat in a comment and failed on an innocuous rewording — unable to catch
// a broken dashboard, able to fail on a copy edit. The logic those words
// described now lives in app/dashboard-format.ts and is tested by calling it.

test("portfolio totals ignore shadow positions entirely", () => {
  // Shadow positions were recorded during SIT_OUT weather and risk no capital.
  // Counting them would overstate exposure and flatter the win rate.
  const totals = portfolioTotals(
    [
      { ticker: "AAPL", shadow: 0, entryPrice: 100, shares: 10, realizedPnl: null },
      { ticker: "TSLA", shadow: 1, entryPrice: 200, shares: 50, realizedPnl: null },
    ],
    [
      { ticker: "MSFT", shadow: 0, entryPrice: 50, shares: 4, realizedPnl: 25 },
      { ticker: "NVDA", shadow: 0, entryPrice: 50, shares: 4, realizedPnl: -10 },
      { ticker: "AMD", shadow: 1, entryPrice: 50, shares: 4, realizedPnl: 900 },
    ],
    { AAPL: 110, TSLA: 400 },
    { startingCapital: 10_000, realizedPnl: 15 },
  );

  assert.equal(totals.realOpenCount, 1, "the shadow position is not open exposure");
  assert.equal(totals.investedCost, 1_000, "and contributes nothing to capital at risk");
  assert.equal(totals.closedCount, 2);
  assert.equal(totals.wins, 1);
  assert.equal(totals.winRate, 50, "the shadow winner does not count towards the record");
  assert.equal(totals.unrealizedPnl, 100, "only the real position's move is unrealised P&L");
});

test("a position with no live quote holds its entry cost rather than inventing a value", () => {
  const totals = portfolioTotals(
    [
      { ticker: "AAPL", shadow: 0, entryPrice: 100, shares: 10, realizedPnl: null },
      { ticker: "MSFT", shadow: 0, entryPrice: 200, shares: 5, realizedPnl: null },
    ],
    [],
    { AAPL: 110 }, // MSFT has no quote this poll
    { startingCapital: 10_000, realizedPnl: 0 },
  );

  assert.equal(totals.quotedCount, 1);
  assert.equal(totals.realOpenCount, 2);
  assert.equal(totals.investedCost, 2_000);
  assert.equal(totals.investedValue, 1_100 + 1_000, "the unquoted position carries at cost");
  assert.equal(totals.unrealizedPnl, 100, "and contributes no unrealised gain or loss");
});

test("the invested percentage divides by equity, not by contributed capital", () => {
  // Slots are sized from equity, so dividing by contributed capital alone once
  // reported a fully-invested account as 100.1%.
  const fullyInvested = portfolioTotals(
    [{ ticker: "AAPL", shadow: 0, entryPrice: 100, shares: 101, realizedPnl: null }],
    [], {}, { startingCapital: 10_000, realizedPnl: 200 },
  );

  assert.ok(fullyInvested.investedPct <= 100, `reported ${fullyInvested.investedPct}% of the account`);
  assert.ok(Math.abs(fullyInvested.investedPct - (10_100 / 10_200) * 100) < 1e-9);
});

test("an empty account reports nothing rather than dividing by zero", () => {
  const empty = portfolioTotals([], [], {}, null);

  assert.equal(empty.winRate, null, "no closed trades means no win rate, not 0%");
  assert.equal(empty.portfolioValue, null);
  assert.equal(empty.investedPct, 0);
  assert.equal(empty.unrealizedPct, 0);
  assert.ok(Number.isFinite(empty.unrealizedPnl));
});

test("the portfolio value is capital plus what has been made and is riding", () => {
  const totals = portfolioTotals(
    [{ ticker: "AAPL", shadow: 0, entryPrice: 100, shares: 10, realizedPnl: null }],
    [], { AAPL: 105 }, { startingCapital: 10_000, realizedPnl: 250 },
  );

  assert.equal(totals.unrealizedPnl, 50);
  assert.equal(totals.portfolioValue, 10_300);
  assert.ok(Math.abs(totals.unrealizedPct - 5) < 1e-9, "up 5% on the capital actually at risk");
});

test("crypto positions are labelled as crypto from the shared universe", () => {
  // The dashboard used to carry its own hardcoded set of crypto tickers, which
  // could drift from the one the engine trades.
  assert.equal(assetClass("BTC"), "crypto crypto-btc");
  assert.equal(assetClass("ETH"), "crypto crypto-eth");
  assert.equal(assetClass("AAPL"), "stock");
});

test("weather flags are toned by what they measure, not by keyword luck", () => {
  assert.equal(flagTone("SPY above VWAP ($512.40)"), "positive");
  assert.equal(flagTone("SPY below VWAP ($512.40)"), "negative");
  assert.equal(flagTone("Tracked breadth 13 advancing / 7 declining"), "positive");
  assert.equal(flagTone("Tracked breadth 5 advancing / 15 declining"), "negative");
  assert.equal(flagTone("S&P 500 +0.42%"), "positive");
  assert.equal(flagTone("S&P 500 -0.42%"), "negative");

  // A rising volatility proxy is bad news even though it carries a plus sign.
  assert.equal(flagTone("VIXY volatility proxy +1.20%"), "negative");
  assert.equal(flagTone("VIXY volatility proxy +0.20%"), "positive");

  // Absent readings are neutral: they are not evidence in either direction.
  assert.equal(flagTone("S&P 500 direction unavailable"), "neutral");
  assert.equal(flagTone("Weather data completeness 60%"), "neutral");
  assert.equal(flagTone("Scheduled macro-event feed unavailable; Atlas will not infer it."), "neutral");
});

test("relative timestamps step through seconds, minutes and hours", () => {
  const now = Date.parse("2026-08-20T15:00:00Z");
  const ago = (seconds) => timeAgo(new Date(now - seconds * 1000).toISOString(), now);

  assert.equal(ago(0), "0s ago");
  assert.equal(ago(59), "59s ago");
  assert.equal(ago(60), "1m ago");
  assert.equal(ago(3599), "59m ago");
  assert.equal(ago(3600), "1h ago");
  assert.equal(ago(7200), "2h ago");

  // A timestamp in the future clamps to zero rather than reading "-5s ago".
  assert.equal(timeAgo(new Date(now + 5000).toISOString(), now), "0s ago");
});

test("money is always rendered with an explicit sign and currency", () => {
  assert.equal(money(1234.5), "$1,234.50");
  assert.equal(money(-1234.5), "-$1,234.50");
  assert.equal(money(0), "$0.00");
  assert.equal(money(1234.5, 0), "$1,235");
});

test("the dashboard reads market hours from the same rule the engine trades on", () => {
  // These were two separate implementations of the same session rule, so the
  // banner could say the market was open while the engine refused to trade.
  const open = getMarketClock(new Date("2026-08-20T15:00:00Z"));   // 11:00 ET Thu
  const closed = getMarketClock(new Date("2026-08-20T21:00:00Z")); // 17:00 ET Thu
  const weekend = getMarketClock(new Date("2026-08-22T15:00:00Z"));

  assert.equal(isMarketOpen(open), true);
  assert.equal(isMarketOpen(closed), false);
  assert.equal(isMarketOpen(weekend), false);
});
