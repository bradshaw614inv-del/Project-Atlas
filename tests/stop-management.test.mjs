import assert from "node:assert/strict";
import test from "node:test";
import { manageStagedStop, TRAILING_DISTANCE_PCT } from "../worker/positions.ts";

// manageStagedStop decides where the stop sits for every open position on every
// five-minute scan, which makes it the function that sets the exit price of
// every trade Atlas ever closes. It had no tests at all: positions.ts read
// 70.7% line coverage and every single uncovered line was this function.

const ENTRY = 100;
// A fresh position: stop at the 1.5% default, nothing staged yet.
const fresh = (currentPrice, over = {}) => ({
  entryPrice: ENTRY,
  currentPrice,
  highWaterMark: ENTRY,
  stopPrice: 98.5,
  trailingActivated: false,
  ...over,
});

test("the stop never moves down, whatever the price does", () => {
  // The one invariant that matters: a stop that can fall is not a stop. Walk a
  // deliberately hostile path — spikes, collapses, a new high after a slump —
  // and assert the stop is non-decreasing at every single step.
  const path = [100, 101, 100.2, 103, 99, 104.5, 101, 98, 106, 95, 107, 90];
  let state = { stopPrice: 98.5, highWaterMark: ENTRY, trailingActivated: false };

  for (const currentPrice of path) {
    const previousStop = state.stopPrice;
    const next = manageStagedStop({ entryPrice: ENTRY, currentPrice, ...state });
    assert.ok(next.stopPrice >= previousStop, `stop fell from ${previousStop} to ${next.stopPrice} at price ${currentPrice}`);
    assert.ok(next.highWaterMark >= state.highWaterMark, "the high-water mark must never fall either");
    state = { stopPrice: next.stopPrice, highWaterMark: next.highWaterMark, trailingActivated: next.trailingActivated };
  }

  // Having been to +7%, the stop must be locked well into profit even though
  // the walk ended 10% underwater.
  assert.ok(state.stopPrice > ENTRY, "after reaching +7% the stop must be above the entry price");
  assert.equal(state.trailingActivated, true);
});

test("each stage triggers at its exact threshold and not a hair below", () => {
  // Breakeven at +1%: the stop moves to the entry price.
  assert.equal(manageStagedStop(fresh(101)).stopPrice, ENTRY, "+1.00% must move the stop to breakeven");
  assert.equal(manageStagedStop(fresh(100.99)).stopPrice, 98.5, "+0.99% must leave the stop alone");
  assert.deepEqual(manageStagedStop(fresh(100.99)).events, [], "a stage that did not trigger emits no event");

  // Profit lock at +2%: the stop moves to entry +0.5%.
  const locked = manageStagedStop(fresh(102));
  assert.ok(Math.abs(locked.stopPrice - 100.5) < 1e-9, "+2.00% must lock in half a percent");
  assert.equal(manageStagedStop(fresh(101.99)).stopPrice, ENTRY, "+1.99% is still only the breakeven stage");

  // Trailing at +3%.
  assert.equal(manageStagedStop(fresh(103)).trailingActivated, true, "+3.00% must activate trailing");
  assert.equal(manageStagedStop(fresh(102.99)).trailingActivated, false, "+2.99% must not");
});

test("a gap straight past every stage lands on the trailing stop, not the first one", () => {
  // Price gapping from entry to +4% in one scan runs all three stages in the
  // same call. The last one must win: leaving the stop at breakeven here would
  // give back the entire move on the next tick down.
  const jumped = manageStagedStop(fresh(104));

  assert.equal(jumped.trailingActivated, true);
  assert.equal(jumped.highWaterMark, 104);
  assert.ok(Math.abs(jumped.stopPrice - 104 * (1 - TRAILING_DISTANCE_PCT / 100)) < 1e-9,
    "the trailing stop must supersede the breakeven and profit-lock stops");
  assert.ok(jumped.stopPrice > 100.5, "and must sit above the profit-lock level it replaced");
  assert.equal(jumped.events.length, 3, "all three stages report, in order");
  assert.deepEqual(jumped.events.map((e) => e.type), ["STOP_MOVED", "STOP_MOVED", "TRAILING_ACTIVATED"]);
});

test("re-running on an unchanged price emits nothing", () => {
  // Atlas rescans every five minutes. Without this, a position held for an hour
  // would write a dozen identical STOP_MOVED rows to its event log and the
  // dashboard timeline would be unreadable.
  const first = manageStagedStop(fresh(104));
  const second = manageStagedStop({
    entryPrice: ENTRY,
    currentPrice: 104,
    highWaterMark: first.highWaterMark,
    stopPrice: first.stopPrice,
    trailingActivated: first.trailingActivated,
  });

  assert.deepEqual(second.events, [], "a scan that changes nothing must record nothing");
  assert.equal(second.stopPrice, first.stopPrice);
  assert.equal(second.trailingActivated, true, "trailing stays on once activated");
});

test("the trailing stop follows the high-water mark, never the current price", () => {
  // The point of a trailing stop is that it ratchets against the best price
  // seen, so a pullback cannot loosen it. Peaked at +6%, now back to +4.5%.
  const pulledBack = manageStagedStop({
    entryPrice: ENTRY,
    currentPrice: 104.5,
    highWaterMark: 106,
    stopPrice: 106 * (1 - TRAILING_DISTANCE_PCT / 100),
    trailingActivated: true,
  });

  assert.ok(Math.abs(pulledBack.stopPrice - 106 * 0.985) < 1e-9, "the stop stays anchored to the 106 high");
  assert.notEqual(pulledBack.stopPrice, 104.5 * 0.985, "it must not re-derive from the pulled-back price");
  assert.equal(pulledBack.highWaterMark, 106, "a lower price does not lower the high-water mark");
  assert.deepEqual(pulledBack.events, []);

  // A new high does move it, and reports doing so.
  const newHigh = manageStagedStop({
    entryPrice: ENTRY, currentPrice: 108, highWaterMark: 106,
    stopPrice: 106 * 0.985, trailingActivated: true,
  });
  assert.equal(newHigh.highWaterMark, 108);
  assert.ok(Math.abs(newHigh.stopPrice - 108 * 0.985) < 1e-9);
  assert.equal(newHigh.events.length, 1);
  assert.equal(newHigh.events[0].type, "TRAILING_ACTIVATED");
});

test("a losing position keeps the stop it was opened with", () => {
  const losing = manageStagedStop(fresh(97));
  assert.equal(losing.stopPrice, 98.5, "no stage reached, nothing moves");
  assert.equal(losing.highWaterMark, ENTRY, "the entry price remains the high");
  assert.equal(losing.trailingActivated, false);
  assert.deepEqual(losing.events, []);
});
