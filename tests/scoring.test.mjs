import assert from "node:assert/strict";
import test from "node:test";
import { scoreCandidate, TRADE_THRESHOLD } from "../worker/scoring.ts";

const strong = { headline: "Company beats estimates and raises guidance", summary: "Record revenue", priceAtScan: 25, priceChangePct: 2, minutesSincePublished: 20 };

test("keeps the live trade threshold at 60 and requires a confirming scan", () => {
  assert.equal(TRADE_THRESHOLD, 60);
  assert.equal(scoreCandidate({ ...strong, seenQualifyingLastScan: false }).status, "CAUTION");
  assert.equal(scoreCandidate({ ...strong, seenQualifyingLastScan: true }).status, "WATCH");
});

test("returns independent analyst-versus-skeptic confidence signals", () => {
  const result = scoreCandidate({ ...strong, seenQualifyingLastScan: true });
  assert.deepEqual(result.signals.map((signal) => signal.key), ["catalyst", "price_confirmation", "freshness", "persistence"]);
  assert.equal(result.score, result.analystScore - result.skepticPenalty);
});

test("hard disqualifiers cannot be overcome by confidence", () => {
  const result = scoreCandidate({ ...strong, headline: "Company cuts guidance", seenQualifyingLastScan: true });
  assert.equal(result.status, "DISQUALIFIED");
  assert.equal(result.score, 0);
});
