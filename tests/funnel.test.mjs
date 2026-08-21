import assert from "node:assert/strict";
import test from "node:test";
import { analyseDay, mergeStageCounts, parseStageCounts, resolveStage } from "../worker/funnel.ts";
import { isNoteRequestError, parseNoteRequest, MAX_NOTE_LENGTH } from "../worker/note-requests.ts";

// A candidate clears eleven gates in a row or it does not trade. Nothing
// recorded which gate stopped it, so a day of zero trades was unexplainable
// without reading every rejection string by hand.

const cleared = {
  hasQuote: true,
  negativeFiling: false,
  isSubject: true,
  manipulationBlocked: false,
  filingOnly: false,
  halted: false,
  cryptoDisagreement: false,
  scoreBlocker: null,
  chartConfirmed: true,
  entryGuardBlocked: false,
  opened: true,
};

test("a candidate that cleared everything is attributed to the trade", () => {
  assert.equal(resolveStage(cleared), "OPENED");
});

test("each gate claims the candidate it stopped", () => {
  const cases = [
    ["NO_QUOTE", { hasQuote: false, opened: false }],
    ["NEGATIVE_FILING", { negativeFiling: true, opened: false }],
    ["NOT_SUBJECT", { isSubject: false, opened: false }],
    ["MANIPULATION", { manipulationBlocked: true, opened: false }],
    ["FILING_ONLY", { filingOnly: true, opened: false }],
    ["HALTED", { halted: true, opened: false }],
    ["CRYPTO_DISAGREEMENT", { cryptoDisagreement: true, opened: false }],
    ["NO_CATALYST", { scoreBlocker: "NO_CATALYST", opened: false }],
    ["CHART_UNCONFIRMED", { chartConfirmed: false, opened: false }],
    ["ENTRY_GUARD", { entryGuardBlocked: true, opened: false }],
  ];

  for (const [expected, override] of cases) {
    assert.equal(resolveStage({ ...cleared, ...override }), expected);
  }
});

test("attribution follows the engine's own precedence, outermost first", () => {
  // A candidate can fail several gates at once. It must be counted once, under
  // the same reason the operator sees on the row — otherwise the funnel totals
  // and the dashboard disagree about what happened.
  const everything = {
    ...cleared, opened: false,
    negativeFiling: true, isSubject: false, manipulationBlocked: true,
    halted: true, scoreBlocker: "SCORE_TOO_LOW", chartConfirmed: false, entryGuardBlocked: true,
  };
  assert.equal(resolveStage(everything), "NEGATIVE_FILING");
  assert.equal(resolveStage({ ...everything, negativeFiling: false }), "NOT_SUBJECT");
  assert.equal(resolveStage({ ...everything, negativeFiling: false, isSubject: true }), "MANIPULATION");

  // A missing quote outranks everything except having actually traded: without
  // a price nothing downstream was evaluated on real data.
  assert.equal(resolveStage({ ...everything, hasQuote: false }), "NO_QUOTE");
});

test("an unknown chart is not treated as a failed chart", () => {
  // confirmBullish returns null when there is no snapshot at all. Counting that
  // as CHART_UNCONFIRMED would blame the chart for a data gap.
  const noSnapshot = { ...cleared, opened: false, chartConfirmed: null, entryGuardBlocked: true };
  assert.equal(resolveStage(noSnapshot), "ENTRY_GUARD");
});

// ---------------------------------------------------------------------------

const day = (over = {}) => ({
  tradingDay: "2026-08-21", scans: 78, storiesFetched: 140, candidatesScored: 96,
  positionsOpened: 0, positionsClosed: 0, blindScans: 0, stages: {}, ...over,
});

test("a day that traded says so and asks for nothing", () => {
  const analysis = analyseDay(day({ positionsOpened: 2, stages: { OPENED: 2, SCORE_TOO_LOW: 40 } }));
  assert.equal(analysis.verdict, "TRADED");
  assert.equal(analysis.actionable, false);
  assert.match(analysis.headline, /2 positions opened/);
});

test("a closed day is not counted as a day that failed to trade", () => {
  const analysis = analyseDay(day({ scans: 0, storiesFetched: 0, candidatesScored: 0 }), false);
  assert.equal(analysis.verdict, "NOT_A_TRADING_DAY");
  assert.equal(analysis.actionable, false);
  assert.match(analysis.detail, /excluded from the trade-rate denominator/);
});

test("the two kinds of zero are told apart", () => {
  // This is the distinction the whole record exists for. Both days opened no
  // positions; only one of them is a defect.
  const nothingQualified = analyseDay(day({
    stages: { SCORE_TOO_LOW: 60, PRICE_UNCONFIRMED: 20, NO_CATALYST: 16 },
  }));
  assert.equal(nothingQualified.verdict, "NO_QUALIFYING_SETUP");
  assert.equal(nothingQualified.actionable, false, "the market saying no is not a bug to fix");
  assert.match(nothingQualified.detail, /forcing one is how a system starts buying attention/);

  const sawNothing = analyseDay(day({ storiesFetched: 0, candidatesScored: 0, stages: {} }));
  assert.equal(sawNothing.verdict, "PIPELINE_STARVED");
  assert.equal(sawNothing.actionable, true);
  assert.match(sawNothing.detail, /This zero is Atlas's, not the market's/);
});

test("a scan that reported itself blind makes the day actionable even with candidates", () => {
  // A source can respond perfectly and deliver almost nothing. Scoring a
  // handful of candidates is not evidence the day was seen properly.
  const partiallyBlind = analyseDay(day({ candidatesScored: 4, blindScans: 12, stages: { SCORE_TOO_LOW: 4 } }));
  assert.equal(partiallyBlind.verdict, "PIPELINE_STARVED");
  assert.equal(partiallyBlind.actionable, true);
  assert.match(partiallyBlind.detail, /12 scans reported insufficient data/);
});

test("risk controls firing is reported as a decision, not a failure", () => {
  const heldBack = analyseDay(day({
    stages: { HALTED: 30, WASH_SALE: 25, MANIPULATION: 10, SCORE_TOO_LOW: 20 },
  }));
  assert.equal(heldBack.verdict, "BLOCKED_BY_RISK");
  assert.equal(heldBack.actionable, false);
  assert.match(heldBack.detail, /Working as designed/);
});

test("a day lost to missing evidence is flagged even though something scored", () => {
  // Rejections about the evidence Atlas had, rather than about the setup, mean
  // the pipeline is the constraint. That is worth fixing; a thin tape is not.
  const evidenceStarved = analyseDay(day({
    stages: { HEADLINE_ONLY: 40, NOT_SUBJECT: 25, STALE: 10, SCORE_TOO_LOW: 15 },
  }));
  assert.equal(evidenceStarved.verdict, "NO_QUALIFYING_SETUP");
  assert.equal(evidenceStarved.actionable, true);
  assert.match(evidenceStarved.detail, /not the market saying no/);
});

test("the top blockers are ranked and exclude the trades themselves", () => {
  const analysis = analyseDay(day({
    positionsOpened: 1,
    stages: { OPENED: 1, SCORE_TOO_LOW: 40, HEADLINE_ONLY: 12, STALE: 30 },
  }));

  assert.deepEqual(analysis.topBlockers.map((row) => row.stage), ["SCORE_TOO_LOW", "STALE", "HEADLINE_ONLY"]);
  assert.ok(!analysis.topBlockers.some((row) => row.stage === "OPENED"));
  assert.equal(analysis.topBlockers[0].label, "Scored below the gate");
});

test("stage counts accumulate across a day's scans and survive a round trip", () => {
  let running = {};
  running = mergeStageCounts(running, { SCORE_TOO_LOW: 3, STALE: 1 });
  running = mergeStageCounts(running, { SCORE_TOO_LOW: 2, OPENED: 1 });
  assert.deepEqual(running, { SCORE_TOO_LOW: 5, STALE: 1, OPENED: 1 });

  assert.deepEqual(parseStageCounts(JSON.stringify(running)), running);

  // A corrupt or absent column must not take the scan down with it.
  assert.deepEqual(parseStageCounts(null), {});
  assert.deepEqual(parseStageCounts("not json"), {});
  assert.deepEqual(parseStageCounts('{"NONSENSE":4,"STALE":2}'), { STALE: 2 }, "unknown stages are dropped");
});

// ---------------------------------------------------------------------------

test("a note needs a real day and something to say", () => {
  const rejected = [
    ["no day", { body: "something" }],
    ["a malformed day", { tradingDay: "21/08/2026", body: "something" }],
    ["an empty body", { tradingDay: "2026-08-21", body: "   " }],
    ["no body", { tradingDay: "2026-08-21" }],
    ["an unknown kind", { tradingDay: "2026-08-21", body: "x", kind: "RANT" }],
    ["an over-long body", { tradingDay: "2026-08-21", body: "x".repeat(MAX_NOTE_LENGTH + 1) }],
  ];

  for (const [description, body] of rejected) {
    const result = parseNoteRequest(body);
    assert.ok(isNoteRequestError(result), `${description} must be rejected`);
    assert.equal(result.status, 400);
  }

  assert.deepEqual(parseNoteRequest({ tradingDay: "2026-08-21", body: "  ran thin  " }),
    { kind: "CREATE", tradingDay: "2026-08-21", noteKind: "OBSERVATION", body: "ran thin" });

  assert.deepEqual(parseNoteRequest({ tradingDay: "2026-08-21", body: "widen the window", kind: "CHANGE_REQUEST" }),
    { kind: "CREATE", tradingDay: "2026-08-21", noteKind: "CHANGE_REQUEST", body: "widen the window" });
});

test("resolving a note needs a real id", () => {
  assert.deepEqual(parseNoteRequest({ action: "RESOLVE", id: 7 }), { kind: "RESOLVE", id: 7 });

  for (const id of [0, -1, 1.5, "abc", undefined]) {
    const result = parseNoteRequest({ action: "RESOLVE", id });
    assert.ok(isNoteRequestError(result), `id ${id} must be rejected`);
  }
});

test("an empty request body is rejected rather than defaulted", () => {
  for (const body of [null, undefined, {}]) {
    assert.ok(isNoteRequestError(parseNoteRequest(body)));
  }
});
