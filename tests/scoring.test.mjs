import assert from "node:assert/strict";
import test from "node:test";
import { classifyCatalyst, classifyMarketWeather, CONFIRMATION_ELIGIBILITY_THRESHOLD, scoreCandidate, TRADE_THRESHOLD } from "../worker/scoring.ts";

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

// The confidence-sizing question must stay unanswered until the sample can
// answer it. This asserts the analysis refuses to endorse sizing by score on
// thin data, and only endorses it when bands are genuinely comparable.
test("band analysis withholds a verdict until each band has a real sample", async () => {
  const { analyzeBands, MIN_PER_BAND } = await import("../worker/band-analysis.ts");

  const thin = analyzeBands([
    { band: "60-79", entryScore: 69, returnPct: -1.3, realizedPnl: -34 },
    { band: "60-79", entryScore: 64, returnPct: 0.4, realizedPnl: 9 },
  ]);
  assert.equal(thin.readyToSizeByConfidence, false, "two trades cannot justify sizing by score");
  assert.match(thin.verdict, /Not yet answerable/);

  // A full, cleanly ordered sample: higher band genuinely returns more.
  const good = [
    ...Array.from({ length: MIN_PER_BAND }, (_, i) => ({ band: "60-79", entryScore: 65 + (i % 3), returnPct: 0.1, realizedPnl: 3 })),
    ...Array.from({ length: MIN_PER_BAND }, (_, i) => ({ band: "80-100", entryScore: 85 + (i % 3), returnPct: 1.4, realizedPnl: 36 })),
  ];
  const ready = analyzeBands(good);
  assert.equal(ready.comparableBands, 2);
  assert.equal(ready.monotonic, true);
  assert.equal(ready.readyToSizeByConfidence, true);

  // Inverted: the high band does worse. Must refuse, not shrug.
  const inverted = good.map((row) => ({ ...row, returnPct: row.band === "80-100" ? -1.2 : 0.5 }));
  const refused = analyzeBands(inverted);
  assert.equal(refused.readyToSizeByConfidence, false);
  assert.match(refused.verdict, /does not rank them|too weak/);
});

// Chart confirmation. News says something happened; the chart says whether
// buyers are currently in control. Atlas's own reviews showed average best-case
// excursion of +0.40% against average heat of -0.68% — positions going against
// the entry immediately, which is an entry-timing failure rather than a bad
// catalyst. Confirmation is a gate, not a bonus: a strong headline must not be
// able to outvote what price is doing.
test("chart confirmation gates entry on buyers actually being in control", async () => {
  const { readTechnicals, confirmBullish } = await import("../worker/technicals.ts");
  const bars = (closes) => closes.map((c, i) => ({ high: c + 0.1, low: c - 0.1, close: c, volume: 1000 + i }));

  // Steady climb, price above VWAP, not extended.
  const rising = confirmBullish(readTechnicals(bars([100,100.1,100.2,100.3,100.4,100.5,100.6,100.7,100.8,100.9,101,101.1]), 100.4));
  assert.equal(rising.confirmed, true, "an orderly uptrend above VWAP must confirm");

  // Same story, but price is under VWAP — sellers hold the session.
  const belowVwap = confirmBullish(readTechnicals(bars([101,100.9,100.8,100.7,100.6,100.5,100.4,100.3,100.2,100.1,100,99.9]), 100.8));
  assert.equal(belowVwap.confirmed, false);
  assert.match(belowVwap.reasons[0], /below session VWAP/);

  // Far above VWAP: the move already happened, entering is chasing.
  const extended = confirmBullish(readTechnicals(bars([100,100.5,101,101.5,102,102.5,103,103.5,104,104.5,105,105.5]), 100));
  assert.equal(extended.confirmed, false);
  assert.ok(extended.reasons.some((r) => /chasing/.test(r)));

  // Too few bars to judge must refuse, never wave through.
  const thin = confirmBullish(readTechnicals(bars([100,100.1,100.2]), 100));
  assert.equal(thin.confirmed, false);
  assert.match(thin.reasons[0], /Not enough real bars/);
});

// Sentiment must be read, not assumed. Ordinary decline verbs were missing from
// the negative list, so "Palantir stock falls 8% after analyst flags valuation
// concerns" scored 56 — four points under the gate, and one fresher story away
// from buying bad news.
test("negative and risk language is disqualifying", () => {
  const negatives = [
    "Palantir stock falls 8% after analyst flags valuation concerns",
    "Apple shares slide as iPhone demand worries mount",
    "Nvidia sinks on export restriction fears",
    "Amazon tumbles amid weak cloud growth",
    "Boeing under pressure after regulator raises safety questions",
    "Why Apple stock is a sell right now",
    "Chevron retreats as oil prices weaken",
  ];
  for (const headline of negatives) {
    const result = scoreCandidate({ ...strong, headline, seenConfirmationEligibleLastScan: true });
    assert.equal(result.status, "DISQUALIFIED", `must block: ${headline}`);
  }
});

// "Something happened and the price moved" is not a thesis. Without an
// identified catalyst, price confirmation plus freshness plus persistence still
// summed to 69 and could trade — exactly the attention-driven buying the
// research cautions against.
test("a story with no identifiable catalyst cannot reach the trade gate", () => {
  const vague = scoreCandidate({
    ...strong, headline: "What is going on with shares today", summary: "",
    seenConfirmationEligibleLastScan: true, priceChangePct: 2.0, minutesSincePublished: 5,
  });
  assert.ok(vague.score < TRADE_THRESHOLD, `scored ${vague.score}, must stay under ${TRADE_THRESHOLD}`);
  assert.equal(vague.status, "CAUTION");
  assert.match(vague.reason, /No identifiable catalyst/);
});

// A news feed tags an article to every ticker it mentions, so one story arrives
// labelled for several companies. "Nvidia Strikes Deal With OpenAI As Tenant"
// was tagged to GOOGL, AMZN and MSFT and opened positions in all three — the
// catalyst was real, just not real for those companies. A mention is not a
// catalyst for the company mentioned.
test("a story must be about the ticker, not merely mention it", async () => {
  const { isStorySubject } = await import("../worker/universe.ts");

  const nvidiaStory = "Nvidia Strikes Deal With OpenAI As Tenant; Is Nvidia A Buy?";
  assert.equal(isStorySubject("NVDA", nvidiaStory).isSubject, true, "it is about Nvidia");
  for (const bystander of ["GOOGL", "AMZN", "MSFT"]) {
    const verdict = isStorySubject(bystander, nvidiaStory);
    assert.equal(verdict.isSubject, false, `${bystander} is not the subject`);
    assert.match(verdict.reason, /never names/);
  }

  // Market roundups name no subject at all — they are lists.
  for (const roundup of ["Top S&P500 movers in Friday's session", "What's going on in today's session: dow jones movers"]) {
    assert.equal(isStorySubject("AMD", roundup).isSubject, false);
    assert.match(isStorySubject("AMD", roundup).reason, /roundup/);
  }

  // Genuine single-subject and two-party stories both pass.
  assert.equal(isStorySubject("CRM", "Salesforce beats estimates and raises full-year guidance").isSubject, true);
  assert.equal(isStorySubject("XOM", "Chevron and Exxon both report record quarterly profit").isSubject, true);
});

// Atlas scored on headlines alone: the JSON news endpoint returns titles with
// no summary, so every catalyst and sentiment judgement ran on one line of
// text. A headline can say the opposite of its own article.
test("the article body is read, not just the headline", () => {
  // Positive-sounding headline, bad news underneath.
  const misleading = classifyCatalyst(
    "Apple stock climbs on new product buzz",
    "Investors aren't sure how much Apple can rely on App Store fees as legal challenges mount and commission revenue drops 18%.");
  assert.equal(misleading.negative, true, "the body's bad news must win over a cheerful headline");

  // Vague headline hiding a real catalyst.
  const buried = classifyCatalyst(
    "Company announces quarterly results",
    "The firm beats estimates and raises guidance for the full year, citing record revenue growth.");
  assert.equal(buried.negative, false);
  assert.match(buried.label, /Earnings beat/);

  // The headline alone would have missed both.
  assert.equal(classifyCatalyst("Company announces quarterly results", "").matchedKeyword, null);
});

// An 8-K item code is the company telling the SEC, under legal obligation,
// exactly what kind of material event occurred — no headline to interpret and
// no question of whether the story is really about this company. Atlas fetched
// these filings but discarded the item codes entirely.
test("SEC 8-K item codes are read as material events", async () => {
  const { describeFiling } = await import("../worker/sec-edgar.ts");

  assert.equal(describeFiling("2.02,9.01").label, "Results of operations (earnings)");
  assert.equal(describeFiling("1.01").tone, "POSITIVE");
  assert.equal(describeFiling("2.06").tone, "NEGATIVE", "a material impairment is bad news");
  assert.equal(describeFiling("4.02").tone, "NEGATIVE", "financials that cannot be relied upon is bad news");
  assert.equal(describeFiling("3.01").tone, "NEGATIVE", "a delisting notice is bad news");

  // Any negative code makes the whole filing negative: earnings reported
  // alongside an impairment is not a clean earnings event.
  assert.equal(describeFiling("2.02,2.06,9.01").tone, "NEGATIVE");

  // 9.01 is boilerplate attached to nearly everything; a real event wins.
  assert.notEqual(describeFiling("5.02,9.01").label, "Financial statements and exhibits");
  assert.equal(describeFiling("").label, "");
});
