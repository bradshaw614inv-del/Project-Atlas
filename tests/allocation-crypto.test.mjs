import test from "node:test";
import assert from "node:assert/strict";
import { computeEntryPlan, DEFAULT_MAX_OPEN_POSITIONS, CASH_RESERVE_PCT, executionPrice } from "../worker/positions.ts";
import { cryptoTickersForStory, quoteSymbolForTicker } from "../worker/universe.ts";

// The equal slot is now a ceiling rather than a target. Under volatility
// targeting the stop is placed where the security's range says it belongs and
// size follows from the fixed risk budget, so a position fills a full slot only
// when that happens to cost exactly the risk budget. This deliberately deploys
// less capital: it is the honest price of giving stops room to work, and the
// dollar at risk is unchanged either way.
test("the equal slot caps exposure; risk budget sets the actual size", () => {
  assert.equal(DEFAULT_MAX_OPEN_POSITIONS, 5);
  assert.equal(CASH_RESERVE_PCT, 0);
  const plan = computeEntryPlan(10_000, 100, 0.25, 5);

  assert.equal(plan.riskDollar, 25);
  assert.equal(plan.stopDistancePct, 1.5, "no ATR supplied falls back to the fixed distance");
  assert.equal(plan.initialStopPrice, 98.5, "stop sits at the full 1.5%, not squeezed to fit a full slot");

  // Size is whatever makes that stop cost exactly the risk budget.
  assert.ok(Math.abs((100 - plan.initialStopPrice) * plan.shares - 25) < 1e-9);
  assert.ok(plan.shares * 100 <= 2_000, "never exceeds an equal slot");
});

test("execution model applies conservative costs in the adverse direction", () => {
  assert.ok(executionPrice(100, "BUY", false) > 100);
  assert.ok(executionPrice(100, "SELL", false) < 100);
  assert.ok(executionPrice(100, "BUY", true) > executionPrice(100, "BUY", false));
});

test("cash-backed sizing never exceeds settled cash", () => {
  const plan = computeEntryPlan(13_000, 100, 0.25, 5, 1_100);
  assert.equal(plan.shares, 11);
  assert.equal(plan.shares * 100, 1_100);
  assert.equal(plan.riskDollar, 32.5);
});

test("crypto stories map only to named supported assets", () => {
  assert.deepEqual(cryptoTickersForStory("Bitcoin and Ethereum gain", "SOL is unchanged"), ["BTC", "ETH", "SOL"]);
  assert.deepEqual(cryptoTickersForStory("Digital assets gain", "No named token"), []);
  assert.equal(quoteSymbolForTicker("BTC"), "BINANCE:BTCUSDT");
  assert.equal(quoteSymbolForTicker("AAPL"), "AAPL");
  assert.deepEqual(cryptoTickersForStory("Dogecoin surges", "DOGE gains"), []);
});

// Volatility targeting, standard institutional practice: place the stop where
// the security's own range says it belongs, then size so that distance costs
// exactly the fixed risk budget. Risk per trade is held constant; size is what
// varies. Measured session ranges differ hugely (BAC ~1.3%, TSLA ~2.6%), so a
// single fixed stop is inside the noise for the volatile names — which is what
// Atlas's own trade reviews caught.
test("volatility targeting holds dollar risk constant while size varies", async () => {
  const { computeEntryPlan, stopDistancePctFor, MIN_STOP_DISTANCE_PCT, MAX_STOP_DISTANCE_PCT } =
    await import("../worker/positions.ts");

  const calm = computeEntryPlan(13000, 100, 0.25, 5, 13000, 1.3);
  const wild = computeEntryPlan(13000, 100, 0.25, 5, 13000, 2.6);

  assert.ok(wild.stopDistancePct > calm.stopDistancePct, "a volatile name must get a wider stop");
  assert.ok(wild.shares < calm.shares, "and correspondingly fewer shares");

  // The point of the exercise: identical dollar risk either way.
  const riskOf = (p) => (100 - p.initialStopPrice) * p.shares;
  assert.ok(Math.abs(riskOf(calm) - riskOf(wild)) < 0.01, "dollar risk must be identical");

  // Bounds hold, and an unknown ATR falls back rather than guessing.
  assert.equal(stopDistancePctFor(0.1), MIN_STOP_DISTANCE_PCT);
  assert.equal(stopDistancePctFor(99), MAX_STOP_DISTANCE_PCT);
  assert.equal(stopDistancePctFor(null), 1.5);

  // Volatility sizing may reduce exposure below an equal slot, never lever past it.
  assert.ok(calm.shares <= 13000 / 5 / 100 + 1e-9, "slot cap still binds");
});
