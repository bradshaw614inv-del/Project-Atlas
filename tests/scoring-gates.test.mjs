import assert from "node:assert/strict";
import test from "node:test";
import { classifyMarketWeather, scoreCandidate, TRADE_THRESHOLD } from "../worker/scoring.ts";

// The existing suite asserts thoroughly on when Atlas refuses to trade and
// almost never on when it permits it. TRADE_ELIGIBLE — the only weather verdict
// that lets capital move — was never once reached, and neither were the three
// hard disqualifiers. This file covers the permitting side of every gate.

const quote = (dp, c = 100) => ({ c, d: 0, dp, h: c, o: c, l: c, pc: c, t: 1 });

// A tape with every reading positive: both indexes up more than 0.1%, SPY above
// its VWAP, breadth two-to-one advancing, volatility easing. Five of five
// readings present, so completeness is 100%.
const greenTape = {
  spy: quote(0.5, 100),
  qqq: quote(0.6),
  spyVwap: 99,
  advancers: 13,
  decliners: 7,
  breadthSample: 20,
  volatilityProxy: quote(-0.4),
};

test("a green tape is the one verdict that permits trading", () => {
  const result = classifyMarketWeather(greenTape);
  assert.equal(result.classification, "TRADE_ELIGIBLE");
  assert.equal(result.negativeFlags, 0);
  assert.equal(result.completenessPct, 100);
});

test("each condition of the green tape is load-bearing on its own", () => {
  // Every one of these takes the green tape and spoils exactly one reading. If
  // any of them still returns TRADE_ELIGIBLE, that condition has stopped
  // mattering and the gate is weaker than it reads.
  const spoiled = {
    "S&P barely up": { spy: quote(0.05, 100) },
    "Nasdaq barely up": { qqq: quote(0.05) },
    "no VWAP to compare against": { spyVwap: null },
    "SPY trading below its VWAP": { spy: quote(0.5, 98) },
    "breadth positive but not decisively": { advancers: 10, decliners: 10 },
  };

  for (const [description, override] of Object.entries(spoiled)) {
    const result = classifyMarketWeather({ ...greenTape, ...override });
    assert.equal(result.classification, "CAUTION", `${description} must downgrade the verdict`);
  }
});

test("incomplete weather is never traded on, however positive it looks", () => {
  // Nothing here is negative — breadth and volatility are simply missing. Under
  // 80% completeness Atlas must decline to call the weather rather than read
  // the readings it happens to have.
  const partial = classifyMarketWeather({
    ...greenTape, breadthSample: 5, advancers: 4, decliners: 1, volatilityProxy: null,
  });
  assert.equal(partial.completenessPct, 60);
  assert.equal(partial.negativeFlags, 0, "nothing is actually negative — only absent");
  assert.equal(partial.classification, "CAUTION");

  // 80% is the boundary and must still be usable: four readings present, and
  // the verdict then turns on the readings themselves rather than the gate.
  const eightyPct = classifyMarketWeather({ ...greenTape, spyVwap: null });
  assert.equal(eightyPct.completenessPct, 80, "the completeness gate must not fire at exactly 80%");
  assert.equal(eightyPct.classification, "CAUTION", "but a missing VWAP still blocks TRADE_ELIGIBLE on its own");
});

test("three negative flags outrank an otherwise complete and readable tape", () => {
  // SIT_OUT is checked before completeness, so a tape that is both negative and
  // incomplete must report the negativity — the more serious of the two.
  const bad = classifyMarketWeather({
    spy: quote(-0.3, 98), qqq: quote(-0.4), spyVwap: 99,
    advancers: 4, decliners: 16, breadthSample: 20, volatilityProxy: null,
  });
  assert.equal(bad.classification, "SIT_OUT");
  assert.ok(bad.negativeFlags >= 3);
  assert.ok(bad.completenessPct < 100, "and it reports SIT_OUT rather than the completeness downgrade");
});

test("the strongest possible tape still cannot accumulate more than one negative flag", () => {
  // Documents a real property of the classifier: when all five positive
  // conditions hold, only the volatility proxy can still raise a flag, so the
  // trailing `negativeFlags <= 1` guard can never be what rejects a candidate.
  // Worth pinning — if a future flag makes that guard reachable, this fails and
  // says so rather than silently changing which condition does the work.
  const volatilitySpiking = classifyMarketWeather({ ...greenTape, volatilityProxy: quote(2.0) });
  assert.equal(volatilitySpiking.negativeFlags, 1);
  assert.equal(volatilitySpiking.classification, "TRADE_ELIGIBLE");
});

// ---------------------------------------------------------------------------

const strong = {
  headline: "Company beats estimates and raises guidance",
  summary: "Record revenue",
  priceAtScan: 25,
  priceChangePct: 2,
  minutesSincePublished: 20,
  seenConfirmationEligibleLastScan: true,
};

test("each hard disqualifier fires at its exact boundary", () => {
  // Already extended: chasing a move that has mostly happened.
  assert.equal(scoreCandidate({ ...strong, priceChangePct: 8 }).status, "DISQUALIFIED");
  assert.match(scoreCandidate({ ...strong, priceChangePct: 8 }).reason, /too extended/);
  assert.notEqual(scoreCandidate({ ...strong, priceChangePct: 7.9 }).status, "DISQUALIFIED");

  // Low-priced names are excluded outright on this data tier.
  assert.equal(scoreCandidate({ ...strong, priceAtScan: 4.99 }).status, "DISQUALIFIED");
  assert.match(scoreCandidate({ ...strong, priceAtScan: 4.99 }).reason, /below \$5/);
  assert.notEqual(scoreCandidate({ ...strong, priceAtScan: 5 }).status, "DISQUALIFIED");

  // Six hours is the freshness horizon; past it the story is history.
  assert.equal(scoreCandidate({ ...strong, minutesSincePublished: 361 }).status, "DISQUALIFIED");
  assert.match(scoreCandidate({ ...strong, minutesSincePublished: 361 }).reason, /more than 6 hours old/);
  assert.notEqual(scoreCandidate({ ...strong, minutesSincePublished: 360 }).status, "DISQUALIFIED");

  // Every disqualifier zeroes the score rather than merely lowering it.
  assert.equal(scoreCandidate({ ...strong, priceChangePct: 9 }).score, 0);
});

test("a disqualified candidate reports the first reason it failed", () => {
  // The reason string is what the dashboard shows the user, so the order the
  // guards run in is user-visible and worth pinning. A $3 stock already up 12%
  // fails both tests; extension is checked first.
  const both = scoreCandidate({ ...strong, priceChangePct: 12, priceAtScan: 3 });
  assert.equal(both.status, "DISQUALIFIED");
  assert.match(both.reason, /too extended/);

  // Bad news outranks everything, including extension.
  const negative = scoreCandidate({ ...strong, headline: "Company cuts guidance", priceChangePct: 12 });
  assert.match(negative.reason, /Negative\/conflicting keyword/);
});

test("price confirmation peaks at a 4% move and falls away on either side", () => {
  // The inverted-U is the counterintuitive part of the model and the part most
  // likely to be "simplified" into a straight line by accident. A small move is
  // weak evidence; a huge move means the opportunity is gone. Peak in between.
  const at = (priceChangePct) => scoreCandidate({ ...strong, priceChangePct }).score;

  assert.ok(at(0.2) < at(0.4), "the ramp up from zero is monotonic");
  assert.ok(at(0.4) < at(2), "and keeps rising through the middle");
  assert.ok(at(2) < at(3));
  assert.ok(at(3) < at(4), "peaking at a 4% move");

  assert.ok(at(4) > at(5), "past the peak, a bigger move is worth less, not more");
  assert.ok(at(5) > at(6));
  assert.ok(at(6) > at(7));

  // A flat or falling quote is no confirmation at all.
  assert.equal(at(0), at(-1), "a negative move scores the same zero as a flat one");
  assert.ok(at(0) < at(0.2));
});

test("an unknown quote is penalised rather than assumed favourable", () => {
  const known = scoreCandidate({ ...strong, priceChangePct: 2 });
  const unknown = scoreCandidate({ ...strong, priceChangePct: null });

  assert.ok(unknown.score < known.score, "a missing quote must never score like a confirming one");
  assert.equal(unknown.skepticPenalty - known.skepticPenalty, 5);
  assert.notEqual(unknown.status, "WATCH", "and it can never reach the trade gate");
  assert.ok(unknown.score < TRADE_THRESHOLD || unknown.status !== "WATCH");
});
