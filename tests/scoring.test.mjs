import assert from "node:assert/strict";
import test from "node:test";
import { classifyMarketWeather, CONFIRMATION_ELIGIBILITY_THRESHOLD, scoreCandidate, TRADE_THRESHOLD } from "../worker/scoring.ts";

const strong = { headline: "Company beats estimates and raises guidance", summary: "Record revenue", priceAtScan: 25, priceChangePct: 2, minutesSincePublished: 20 };

test("keeps the live trade threshold at 60 and requires a confirming scan", () => {
  assert.equal(TRADE_THRESHOLD, 60);
  assert.equal(CONFIRMATION_ELIGIBILITY_THRESHOLD, 40);
  assert.equal(scoreCandidate({ ...strong, seenConfirmationEligibleLastScan: false }).status, "CAUTION");
  assert.equal(scoreCandidate({ ...strong, seenConfirmationEligibleLastScan: true }).status, "WATCH");
});

test("returns independent analyst-versus-skeptic confidence signals", () => {
  const result = scoreCandidate({ ...strong, seenConfirmationEligibleLastScan: true });
  assert.deepEqual(result.signals.map((signal) => signal.key), ["catalyst", "price_confirmation", "freshness", "persistence", "source_verification"]);
  assert.equal(result.score, result.analystScore - result.skepticPenalty);
});

test("hard disqualifiers cannot be overcome by confidence", () => {
  const result = scoreCandidate({ ...strong, headline: "Company cuts guidance", seenConfirmationEligibleLastScan: true });
  assert.equal(result.status, "DISQUALIFIED");
  assert.equal(result.score, 0);
});

test("single-outlet evidence receives a skeptic penalty until independently corroborated", () => {
  const single = scoreCandidate({ ...strong, seenConfirmationEligibleLastScan: true, source: "Reuters", sourceUrl: "https://example.com/story", independentSourceCount: 1 });
  const corroborated = scoreCandidate({ ...strong, seenConfirmationEligibleLastScan: true, source: "Reuters", sourceUrl: "https://example.com/story", independentSourceCount: 2 });
  assert.equal(single.skepticPenalty - corroborated.skepticPenalty, 5);
  assert.ok(corroborated.score > single.score);
});

test("wash-sale guard blocks a loss ticker without changing the threshold", () => {
  const result = scoreCandidate({ ...strong, ticker: "GME", now: new Date("2026-08-20T14:00:00Z"), seenConfirmationEligibleLastScan: true });
  assert.equal(result.status, "DISQUALIFIED");
  assert.match(result.reason, /Wash-sale guard/);
  assert.equal(TRADE_THRESHOLD, 60);
});

test("three independent negative weather flags force SIT_OUT", () => {
  const quote = (dp, c = 100) => ({ c, d: 0, dp, h: c, o: c, l: c, pc: c, t: 1 });
  const result = classifyMarketWeather({ spy: quote(-0.2, 99), qqq: quote(-0.3), spyVwap: 100, advancers: 5, decliners: 15, breadthSample: 20, volatilityProxy: quote(1.2) });
  assert.equal(result.classification, "SIT_OUT");
  assert.ok(result.negativeFlags >= 3);
});

test("a persisted candidate still cannot trade without positive quote confirmation", () => {
  const result = scoreCandidate({ ...strong, priceChangePct: 0, seenConfirmationEligibleLastScan: true });
  assert.ok(result.score >= TRADE_THRESHOLD);
  assert.equal(result.status, "CAUTION");
  assert.match(result.reason, /quote has not confirmed/i);
});
