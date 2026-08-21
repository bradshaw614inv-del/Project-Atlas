import assert from "node:assert/strict";
import test from "node:test";
import {
  BREAKEVEN_WIN_RATE, MIN_MISSES_FOR_VERDICT, MISSED_TRACKING_MIN_SCORE,
  evaluateMiss, shouldTrackMiss, summariseGateCost,
} from "../worker/missed.ts";

// "Are we missing good trades?" cannot be answered from the trades we took.
// This follows the rejected ones forward through the stop they would have been
// given, so a gate can be judged on what it actually turned down.

const BASE = Date.parse("2026-08-21T14:00:00Z");
const bar = (minutesAfter, { high, low, close = high }) => ({
  t: Math.floor((BASE + minutesAfter * 60_000) / 1000), high, low, close,
});

const replay = (bars, over = {}) => evaluateMiss({
  referencePrice: 100, stopDistancePct: 1.5, blockedAtMs: BASE, bars, ...over,
});

test("a rejection that ran to target is recorded as one Atlas gave up", () => {
  const outcome = replay([
    bar(5, { high: 100.4, low: 99.8 }),
    bar(10, { high: 101.6, low: 100.2 }), // clears +1.5%
    bar(15, { high: 101.2, low: 100.9 }),
  ]);

  assert.equal(outcome.resolved, true);
  assert.equal(outcome.wouldHaveWon, true);
  assert.equal(outcome.decidedAfterMinutes, 10);
  assert.ok(outcome.mfePct > 1.5);
});

test("a rejection that ran to the stop is a rejection that was right", () => {
  const outcome = replay([
    bar(5, { high: 100.2, low: 99.6 }),
    bar(10, { high: 99.8, low: 98.4 }), // through -1.5%
  ]);

  assert.equal(outcome.resolved, true);
  assert.equal(outcome.wouldHaveWon, false);
  assert.equal(outcome.decidedAfterMinutes, 10);
  assert.ok(outcome.maePct < -1.5);
});

test("a bar spanning both levels is scored as a loss", () => {
  // OHLC does not say which extreme came first. Assuming the favourable one is
  // how a replay flatters itself into recommending a change that loses money.
  const outcome = replay([bar(5, { high: 102, low: 98, close: 100 })]);

  assert.equal(outcome.resolved, true);
  assert.equal(outcome.wouldHaveWon, false, "an ambiguous bar must never be counted as a win");
});

test("a miss that reached neither level stays unresolved rather than counting as a loss", () => {
  // Scoring an unfinished session as a loss would quietly argue that every gate
  // is working and no gate ever costs anything.
  const drifting = replay([
    bar(5, { high: 100.4, low: 99.8 }),
    bar(10, { high: 100.6, low: 99.9 }),
  ]);

  assert.equal(drifting.resolved, false);
  assert.equal(drifting.wouldHaveWon, null);
  assert.equal(drifting.decidedAfterMinutes, null);
  assert.equal(drifting.barsSeen, 2, "the bars were read, they just did not decide anything");
  assert.ok(drifting.mfePct !== null, "excursions are still reported");
});

test("only bars after the block count", () => {
  // A spike before Atlas rejected the candidate says nothing about the trade it
  // declined to take.
  const outcome = replay([
    { t: Math.floor((BASE - 600_000) / 1000), high: 130, low: 70, close: 100 },
    bar(5, { high: 100.5, low: 100.1 }),
  ]);

  assert.equal(outcome.resolved, false, "the earlier bar must not decide the outcome");
  assert.ok(outcome.mfePct < 1);
  assert.equal(outcome.barsSeen, 1);
});

test("bars are read in time order however they arrive", () => {
  const shuffled = replay([
    bar(15, { high: 99.9, low: 98.2 }), // the stop, later
    bar(5, { high: 101.7, low: 100.1 }), // the target, earlier
  ]);
  assert.equal(shuffled.wouldHaveWon, true, "the target came first in time");
  assert.equal(shuffled.decidedAfterMinutes, 5);
});

test("a miss with no forward bars or a nonsense stop says nothing", () => {
  assert.equal(replay([]).resolved, false);
  assert.equal(replay([bar(5, { high: 102, low: 98 })], { stopDistancePct: 0 }).resolved, false);
  assert.equal(replay([bar(5, { high: 102, low: 98 })], { referencePrice: 0 }).resolved, false);
});

// ---------------------------------------------------------------------------

test("only plausible candidates are followed, and never the unbuyable ones", () => {
  assert.equal(shouldTrackMiss("PRICE_UNCONFIRMED", MISSED_TRACKING_MIN_SCORE, true), true);
  assert.equal(shouldTrackMiss("PRICE_UNCONFIRMED", MISSED_TRACKING_MIN_SCORE - 1, true), false,
    "candidates that were never close would bury the signal");

  // No evidence should ever reopen these: a blackout is a compliance rule and a
  // halted security could not have been bought at any price.
  for (const stage of ["WASH_SALE", "HALTED", "PRICE_TOO_LOW", "NO_QUOTE", "OPENED"]) {
    assert.equal(shouldTrackMiss(stage, 90, true), false, `${stage} must not be followed`);
  }

  assert.equal(shouldTrackMiss("CHART_UNCONFIRMED", 90, false), false, "no quote, nothing to replay from");
});

// ---------------------------------------------------------------------------

const misses = (stage, { won, lost, pending = 0 }) => [
  ...Array.from({ length: won }, () => ({ blockedStage: stage, resolved: true, wouldHaveWon: true })),
  ...Array.from({ length: lost }, () => ({ blockedStage: stage, resolved: true, wouldHaveWon: false })),
  ...Array.from({ length: pending }, () => ({ blockedStage: stage, resolved: false, wouldHaveWon: null })),
];

test("a gate whose rejections keep winning is named as costing trades", () => {
  const cost = summariseGateCost(misses("PRICE_UNCONFIRMED", { won: 30, lost: 10 }));

  assert.equal(cost.length, 1);
  assert.equal(cost[0].conclusive, true);
  assert.ok(cost[0].winRate > BREAKEVEN_WIN_RATE);
  assert.match(cost[0].verdict, /costing trades/);
  assert.equal(cost[0].label, "Scored well but price did not confirm");
});

test("a gate whose rejections keep losing is credited, not blamed", () => {
  const cost = summariseGateCost(misses("NEGATIVE_NEWS", { won: 5, lost: 35 }));
  assert.equal(cost[0].conclusive, true);
  assert.match(cost[0].verdict, /earning its place/);
});

test("a thin sample refuses to give a verdict rather than guessing", () => {
  // The whole point of the exercise is to make gate changes evidence-led. A
  // win rate off five trades is not evidence.
  const cost = summariseGateCost(misses("CHART_UNCONFIRMED", { won: 4, lost: 1, pending: 40 }));

  assert.equal(cost[0].resolved, 5);
  assert.equal(cost[0].blocked, 45);
  assert.equal(cost[0].conclusive, false);
  assert.match(cost[0].verdict, /not yet answerable/);
  assert.ok(cost[0].winRate > BREAKEVEN_WIN_RATE, "the ratio exists, it just does not count yet");
});

test("the threshold for a verdict is exact", () => {
  const justUnder = summariseGateCost(misses("STALE", { won: MIN_MISSES_FOR_VERDICT - 1, lost: 0 }));
  const exactly = summariseGateCost(misses("STALE", { won: MIN_MISSES_FOR_VERDICT, lost: 0 }));

  assert.equal(justUnder[0].conclusive, false);
  assert.equal(exactly[0].conclusive, true);
});

test("gates are ranked by how much they are costing, unresolved ones last", () => {
  const cost = summariseGateCost([
    ...misses("PRICE_UNCONFIRMED", { won: 30, lost: 10 }),  // 75%
    ...misses("SCORE_TOO_LOW", { won: 10, lost: 30 }),      // 25%
    ...misses("NOT_PERSISTED", { won: 22, lost: 18 }),      // 55%
    ...misses("HEADLINE_ONLY", { won: 0, lost: 0, pending: 9 }),
  ]);

  assert.deepEqual(cost.map((row) => row.stage),
    ["PRICE_UNCONFIRMED", "NOT_PERSISTED", "SCORE_TOO_LOW", "HEADLINE_ONLY"]);
  assert.equal(cost.at(-1).winRate, null, "a gate with nothing resolved yet has no rate at all");
});

test("an empty history produces an empty report, not a zero-filled one", () => {
  assert.deepEqual(summariseGateCost([]), []);
});
