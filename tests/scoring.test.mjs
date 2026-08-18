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
  assert.deepEqual(result.signals.map((signal) => signal.key), ["catalyst", "price_confirmation", "freshness", "persistence", "attention", "source_verification"]);
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

// One story, one position. Yahoo tags a single article to many tickers, so
// without this gate a lone headline opened GOOGL, AMZN and MSFT at once —
// roughly 60% of the account riding on whether one story was right.
test("a second ticker cannot open on a story that already holds a slot", () => {
  const openPositions = [{ ticker: "GOOGL", storyId: 42, shadow: 0 }];
  const blockedForSameStory = (ticker, storyId) =>
    openPositions.some((p) => p.ticker === ticker) ||
    openPositions.some((p) => p.storyId !== null && p.storyId === storyId);

  assert.equal(blockedForSameStory("AMZN", 42), true, "same story must be blocked");
  assert.equal(blockedForSameStory("MSFT", 42), true, "same story must be blocked");
  assert.equal(blockedForSameStory("AMZN", 77), false, "a genuinely different story stays eligible");
  assert.equal(blockedForSameStory("GOOGL", 77), true, "same ticker stays blocked regardless of story");
});

// Naive reinforcement learning, per Barber & Odean (2011): investors are more
// likely to repurchase a stock they previously sold at a profit than one sold
// at a loss — repeating what felt good rather than what was predictive. A
// system can acquire the same bias if scoring is ever allowed to see a
// ticker's own trade history. This asserts the input surface stays clean.
test("scoring cannot condition on a ticker's own prior outcomes", () => {
  const base = { ...strong, seenConfirmationEligibleLastScan: true };
  const scored = scoreCandidate(base);
  // Passing prior-outcome fields must not change anything: they are not read.
  const withPriorWin = scoreCandidate({ ...base, realizedPnl: 500, atlasEdge: 0.9, priorWins: 10 });
  const withPriorLoss = scoreCandidate({ ...base, realizedPnl: -500, atlasEdge: -0.9, priorWins: 0 });
  assert.equal(withPriorWin.score, scored.score, "a past win must not raise the score");
  assert.equal(withPriorLoss.score, scored.score, "a past loss must not lower the score");
  assert.equal(withPriorWin.status, withPriorLoss.status);
});

// Barber & Odean (2008): individual investors are net buyers of
// attention-grabbing stocks — abnormal volume being the primary proxy — and
// that crowd buying temporarily inflates price "leading to disappointing
// subsequent returns". Extreme volume must therefore reduce confidence.
test("extreme relative volume is treated as caution, never as confirmation", () => {
  const base = { ...strong, seenConfirmationEligibleLastScan: true, source: "Reuters", sourceUrl: "https://example.com/s", independentSourceCount: 2 };
  const normal = scoreCandidate({ ...base, relativeVolume: 1.0 });
  const busy = scoreCandidate({ ...base, relativeVolume: 2.5 });
  const frenzy = scoreCandidate({ ...base, relativeVolume: 6.0 });

  assert.ok(busy.score < normal.score, "elevated volume must not raise the score");
  assert.ok(frenzy.score < busy.score, "a volume frenzy must be penalised harder still");
  assert.equal(frenzy.skepticPenalty - normal.skepticPenalty, 12);
  // Unknown volume is neutral, never assumed calm or assumed frantic.
  assert.equal(scoreCandidate({ ...base, relativeVolume: null }).score, normal.score);
});

// Pump-and-dump defence. The signature is a violent move on volume far outside
// normal, carried by a single untraceable source, often in a security the
// exchange has just had to pause. Any one leg alone is ordinary market life;
// the combination is the pattern, so the block keys on the combination.
test("manipulation screen blocks the pump signature but not ordinary strength", async () => {
  const { assessManipulationRisk } = await import("../worker/manipulation.ts");
  const now = new Date("2026-08-18T15:00:00Z");
  const base = { ticker: "XYZ", relativeVolume: 1.2, priceChangePct: 2, independentSourceCount: 3, traceableSource: true, halts: [], now };

  assert.equal(assessManipulationRisk(base).blocked, false, "a normal move must pass");

  // Violent + crowded + uncorroborated = the pump signature.
  const pump = assessManipulationRisk({ ...base, relativeVolume: 8, priceChangePct: 22, independentSourceCount: 1, traceableSource: false });
  assert.equal(pump.blocked, true);
  assert.ok(pump.riskScore >= 70);

  // Same violence, but many independent outlets confirm it — real news moves fast too.
  const realNews = assessManipulationRisk({ ...base, relativeVolume: 6, priceChangePct: 9, independentSourceCount: 4 });
  assert.equal(realNews.blocked, false, "corroborated strength must not be blocked");

  // Currently halted is an unconditional block.
  const halted = assessManipulationRisk({ ...base, halts: [{ symbol: "XYZ", reasonCode: "LUDP", haltedAt: "2026-08-18T14:00:00Z", resumedAt: null }] });
  assert.equal(halted.blocked, true);
  assert.equal(halted.riskScore, 100);

  // Recently paused for disorder, now busy again — chasing the re-open is blocked.
  const reopen = assessManipulationRisk({ ...base, relativeVolume: 4,
    halts: [{ symbol: "XYZ", reasonCode: "LUDP", haltedAt: "2026-08-18T13:00:00Z", resumedAt: "2026-08-18T13:10:00Z" }] });
  assert.equal(reopen.blocked, true);
});
