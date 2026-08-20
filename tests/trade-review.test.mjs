import assert from "node:assert/strict";
import test from "node:test";
import { reviewTrade } from "../worker/trade-review.ts";

// The post-mortem for a closed trade: how far it ran in favour, how much heat
// it took, and where price went after Atlas left. Nothing here changes
// behaviour on its own — these findings are the evidence the system reasons
// from, which is exactly why a wrong sign or an off-by-one window would teach
// the wrong lesson quietly. It had no tests.

const bars = (rows) => ({
  t: rows.map((row) => Date.parse(row.at) / 1000),
  high: rows.map((row) => row.high ?? null),
  low: rows.map((row) => row.low ?? null),
  close: rows.map((row) => row.close ?? null),
});

const trade = (over = {}) => ({
  entryPrice: 100,
  exitPrice: 100,
  entryAt: "2026-08-20T14:00:00Z",
  exitAt: "2026-08-20T15:00:00Z",
  initialStopPrice: 98.5,
  realizedPnl: 0,
  exitReason: "MARKET_CLOSE",
  ...over,
});

test("the basic measurements are read off the bars, not modelled", () => {
  const review = reviewTrade(trade({ exitPrice: 101 }), bars([
    { at: "2026-08-20T14:10:00Z", high: 100.8, low: 99.9, close: 100.5 },
    { at: "2026-08-20T14:30:00Z", high: 102.0, low: 100.2, close: 101.5 }, // the high of the trade
    { at: "2026-08-20T14:50:00Z", high: 101.2, low: 99.2, close: 101.0 },  // the low of the trade
  ]));

  assert.equal(review.holdMinutes, 60);
  assert.ok(Math.abs(review.stopDistancePct - 1.5) < 1e-9);
  assert.ok(Math.abs(review.mfePct - 2) < 1e-9, "best excursion is the 102.0 high");
  assert.equal(review.mfeMinutes, 30, "reached 30 minutes after entry");
  assert.ok(Math.abs(review.maePct - -0.8) < 1e-9, "worst excursion is the 99.2 low");
  assert.equal(review.maeMinutes, 50);
});

test("bars outside the holding period are not part of the trade's excursion", () => {
  // A spike an hour before entry, or after the exit, says nothing about how
  // this position behaved while it was actually open.
  const review = reviewTrade(trade({ exitPrice: 100.5 }), bars([
    { at: "2026-08-20T13:00:00Z", high: 130, low: 70, close: 100 },  // before entry
    { at: "2026-08-20T14:30:00Z", high: 101, low: 99.5, close: 100.5 },
    { at: "2026-08-20T16:00:00Z", high: 140, low: 60, close: 100 },  // after exit
  ]));

  assert.ok(Math.abs(review.mfePct - 1) < 1e-9, "only the in-window bar counts");
  assert.ok(Math.abs(review.maePct - -0.5) < 1e-9);
});

test("bars with missing prices are skipped rather than read as zero", () => {
  const review = reviewTrade(trade(), bars([
    { at: "2026-08-20T14:10:00Z", high: null, low: null, close: null },
    { at: "2026-08-20T14:30:00Z", high: 101, low: 99.5, close: 100.5 },
  ]));

  assert.ok(Math.abs(review.mfePct - 1) < 1e-9);
  assert.ok(Math.abs(review.maePct - -0.5) < 1e-9, "a null low must not read as a 100% drawdown");
});

test("with no bars at all, every measurement stays unknown", () => {
  // Refusing to answer is the correct answer here. Filling these with zeros
  // would put "never traded above entry" findings on trades nobody observed.
  const review = reviewTrade(trade(), null);

  assert.equal(review.mfePct, null);
  assert.equal(review.maePct, null);
  assert.equal(review.mfeMinutes, null);
  assert.equal(review.maeMinutes, null);
  assert.equal(review.postExitDriftPct, null);
  assert.equal(review.holdMinutes, 60, "the hold is still known from the timestamps");
  assert.deepEqual(review.findings, []);
});

test("post-exit drift covers the half hour after the exit and stops there", () => {
  const review = reviewTrade(trade({ exitPrice: 100 }), bars([
    { at: "2026-08-20T14:30:00Z", high: 101, low: 99, close: 100 },
    { at: "2026-08-20T15:10:00Z", high: 101, low: 100, close: 101 },   // inside the window
    { at: "2026-08-20T15:29:00Z", high: 102, low: 101, close: 102 },   // last inside the window
    { at: "2026-08-20T15:45:00Z", high: 120, low: 110, close: 115 },   // past it, must be ignored
  ]));

  assert.ok(Math.abs(review.postExitDriftPct - 2) < 1e-9, "measured from the exit price to the last bar inside the window");
});

test("a stop-out that immediately recovered is flagged as a stop set too tight", () => {
  // The failure Atlas's own reviews found: stopped at -1.35% on a security
  // whose ordinary session range is wider than that, then straight back up.
  const review = reviewTrade(trade({
    exitPrice: 98.5, exitReason: "STOP_LOSS", realizedPnl: -15,
  }), bars([
    { at: "2026-08-20T14:30:00Z", high: 100.2, low: 98.4, close: 98.6 },
    { at: "2026-08-20T15:20:00Z", high: 101, low: 100, close: 100.5 },
  ]));

  assert.ok(review.postExitDriftPct > 1.5);
  assert.equal(review.findings.length, 1);
  assert.match(review.findings[0], /Stopped out, then recovered/);
  assert.match(review.findings[0], /inside normal noise/);
});

test("a stop-out that kept falling is credited as the stop doing its job", () => {
  const review = reviewTrade(trade({
    exitPrice: 98.5, exitReason: "STOP_LOSS", realizedPnl: -15,
  }), bars([
    { at: "2026-08-20T14:30:00Z", high: 100.1, low: 98.4, close: 98.6 },
    { at: "2026-08-20T15:20:00Z", high: 98, low: 96, close: 96.5 },
  ]));

  assert.ok(review.postExitDriftPct < 0);
  assert.ok(review.findings.some((finding) => /the stop did its job/.test(finding)));
});

test("a trade that nearly touched its stop before recovering is called out", () => {
  // Not stopped out, but it used most of the room it was given. Worth knowing:
  // the position was closer to failing than the result suggests.
  const review = reviewTrade(trade({ exitPrice: 100.6, realizedPnl: 6 }), bars([
    { at: "2026-08-20T14:20:00Z", high: 100.1, low: 98.7, close: 98.8 }, // -1.3% against a 1.5% stop
    { at: "2026-08-20T14:50:00Z", high: 100.7, low: 100.2, close: 100.6 },
  ]));

  assert.ok(review.findings.some((finding) => /Came within \d+% of the stop/.test(finding)));
});

test("giving back a winning move and leaving profit on the table read differently", () => {
  // Ran to +2%, closed negative: the whole move was handed back.
  const gaveBack = reviewTrade(trade({ exitPrice: 99.6, realizedPnl: -4 }), bars([
    { at: "2026-08-20T14:20:00Z", high: 102, low: 99.5, close: 99.6 },
  ]));
  assert.ok(gaveBack.findings.some((finding) => /gave back the entire move/.test(finding)));

  // Ran to +2%, closed at +0.4%: still a winner, but it peaked well above.
  const leftSome = reviewTrade(trade({ exitPrice: 100.4, realizedPnl: 4 }), bars([
    { at: "2026-08-20T14:20:00Z", high: 102, low: 99.9, close: 100.4 },
  ]));
  assert.ok(leftSome.findings.some((finding) => /leaving 1\.60% on the table/.test(finding)));
  assert.ok(!leftSome.findings.some((finding) => /gave back/.test(finding)));

  // Exited near the high: nothing to say.
  const clean = reviewTrade(trade({ exitPrice: 101.9, realizedPnl: 19 }), bars([
    { at: "2026-08-20T14:20:00Z", high: 102, low: 99.9, close: 101.9 },
  ]));
  assert.ok(!clean.findings.some((finding) => /on the table/.test(finding)));
});

test("a catalyst with no follow-through at all is named as such", () => {
  const review = reviewTrade(trade({ exitPrice: 99.8, realizedPnl: -2 }), bars([
    { at: "2026-08-20T14:20:00Z", high: 100.05, low: 99.7, close: 99.8 },
  ]));

  assert.ok(review.mfePct < 0.1);
  assert.ok(review.findings.some((finding) => /no follow-through at all/.test(finding)));
});

test("closing at the bell underwater is recorded as a thesis that never played out", () => {
  const review = reviewTrade(trade({ exitPrice: 99.5, exitReason: "MARKET_CLOSE", realizedPnl: -5 }), bars([
    { at: "2026-08-20T14:20:00Z", high: 100.9, low: 99.4, close: 99.5 },
  ]));

  assert.ok(review.findings.some((finding) => /still underwater/.test(finding)));

  // A profitable close at the bell earns no such finding.
  const winner = reviewTrade(trade({ exitPrice: 101, exitReason: "MARKET_CLOSE", realizedPnl: 10 }), bars([
    { at: "2026-08-20T14:20:00Z", high: 101.2, low: 99.9, close: 101 },
  ]));
  assert.ok(!winner.findings.some((finding) => /still underwater/.test(finding)));
});

test("a same-instant exit reports a zero hold rather than a negative one", () => {
  const instant = reviewTrade(trade({ exitAt: "2026-08-20T14:00:00Z" }), null);
  assert.equal(instant.holdMinutes, 0);

  const reversed = reviewTrade(trade({ entryAt: "2026-08-20T15:00:00Z", exitAt: "2026-08-20T14:00:00Z" }), null);
  assert.equal(reversed.holdMinutes, 0, "clock skew must never produce a negative hold");
});
