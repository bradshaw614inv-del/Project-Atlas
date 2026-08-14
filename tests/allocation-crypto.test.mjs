import test from "node:test";
import assert from "node:assert/strict";
import { computeEntryPlan, DEFAULT_MAX_OPEN_POSITIONS, CASH_RESERVE_PCT, executionPrice } from "../worker/positions.ts";
import { cryptoTickersForStory, quoteSymbolForTicker } from "../worker/universe.ts";

test("$10,000 is split into five equal $2,000 slots without increasing risk", () => {
  assert.equal(DEFAULT_MAX_OPEN_POSITIONS, 5);
  assert.equal(CASH_RESERVE_PCT, 0);
  const plan = computeEntryPlan(10_000, 100, 0.25, 5);
  assert.equal(plan.shares, 20);
  assert.equal(plan.shares * 100, 2_000);
  assert.equal(plan.riskDollar, 25);
  assert.equal(plan.initialStopPrice, 98.75);
});

test("execution model applies conservative costs in the adverse direction", () => {
  assert.ok(executionPrice(100, "BUY", false) > 100);
  assert.ok(executionPrice(100, "SELL", false) < 100);
  assert.ok(executionPrice(100, "BUY", true) > executionPrice(100, "BUY", false));
});

test("crypto stories map only to named supported assets", () => {
  assert.deepEqual(cryptoTickersForStory("Bitcoin and Ethereum gain", "SOL is unchanged"), ["BTC", "ETH", "SOL"]);
  assert.deepEqual(cryptoTickersForStory("Digital assets gain", "No named token"), []);
  assert.equal(quoteSymbolForTicker("BTC"), "BINANCE:BTCUSDT");
  assert.equal(quoteSymbolForTicker("AAPL"), "AAPL");
});
