import type { FinnhubQuote } from "./finnhub";
import { washSaleBlockedUntil } from "./wash-sale.ts";

// Deterministic, rules-based scoring only. Every signal here comes from a real,
// verifiable field (headline text, a live quote, elapsed time) — nothing is inferred
// or invented. If a signal isn't available on Finnhub's free tier (spread, volume,
// breadth, VWAP), it is left out rather than faked.

// Negative and risk language. This list was previously narrow enough that
// "Palantir stock falls 8% after analyst flags valuation concerns" and "Apple
// shares slide as iPhone demand worries mount" both classified as neutral and
// scored 56 — four points under the trade gate. Ordinary decline verbs were
// simply absent. Sentiment is checked before anything else, so a headline
// carrying both good and bad language is treated as bad: refusing a real
// opportunity costs nothing, buying into bad news costs money.
const NEGATIVE_KEYWORDS = [
  // Decline verbs — the most common way a bad day is reported.
  "falls", "fall ", "fell", "slides", "slide", "slid", "drops", "drop ", "dropped",
  "sinks", "sink ", "sank", "tumbles", "tumble", "tumbled", "declines", "decline",
  "declined", "slips", "slip ", "slipped", "retreats", "retreat", "plunges", "plunge",
  "plunged", "slumps", "slump", "sags", "dips", "dive", "dives", "craters", "collapse",
  "collapses", "sell-off", "selloff", "sells off", "loses ground", "gives back",
  "pulls back", "pullback", "worst performer", "laggard", "lags",
  // Analyst and rating pressure.
  "downgraded", "downgrades", "downgrade", "cut to sell", "cut to underperform",
  "underperform", "underweight", "price target cut", "lowers price target",
  "cuts price target", "sell rating", "bearish", "overvalued", "valuation concerns",
  "is a sell", "short seller", "short position",
  // Concern, risk and uncertainty language.
  "concerns", "concern over", "worries", "worry", "fears", "headwinds", "under pressure",
  "uncertainty", "doubts", "skeptical", "caution", "warns", "warning", "red flag",
  "risk of", "threatens", "struggles", "struggling", "troubles", "woes",
  // Weak fundamentals.
  "misses estimates", "miss estimates", "missed estimates", "misses revenue",
  "misses expectations", "falls short", "shortfall", "disappoints", "disappointing",
  "weak", "weakness", "weaker", "softness", "slowdown", "slowing", "decelerat",
  "cuts guidance", "guidance cut", "lowers forecast", "lowers guidance", "lowers outlook",
  "cuts outlook", "trims forecast", "scales back", "profit warning", "widens loss",
  "posts loss", "net loss", "writedown", "write-down", "impairment",
  // Legal, regulatory and governance.
  "lawsuit", "sues", "sued", "investigation", "investigated", "probe", "subpoena",
  "sec probe", "sec charges", "fined", "penalty", "settlement", "recall", "recalls",
  "resigns", "resignation", "steps down", "ousted", "fraud", "accounting",
  "restated", "restatement", "bankruptcy", "delisted", "delisting", "sanctions",
  "halted", "halts trading", "suspension", "layoffs", "job cuts", "cuts jobs",
  "restructuring", "delays", "delayed", "postpones", "cancels", "scrapped",
];

// Broad, real-world financial-journalism phrasing. Weighted by how strong a genuine
// price-moving catalyst the phrase typically signals — not exhaustive, but wide enough
// that real news reliably matches something instead of falling through to "unclassified."
const CATALYST_GROUPS: { weight: number; label: string; keywords: string[] }[] = [
  { weight: 35, label: "Earnings beat / raised guidance", keywords: [
    "beats estimates", "beat estimates", "beats expectations", "beat expectations", "tops estimates",
    "top estimates", "raises guidance", "raises forecast", "raises outlook", "record revenue",
    "record profit", "record quarter", "record sales", "earnings beat", "profit beat", "revenue beat",
    "strong earnings", "better-than-expected", "exceeds expectations", "exceeded expectations",
  ] },
  { weight: 32, label: "Merger or acquisition", keywords: [
    "to acquire", "acquisition of", "merger with", "to merge", "to be acquired", "buyout",
    "agrees to buy", "agrees to acquire", "acquires", "takeover bid", "deal to buy", "strategic acquisition",
  ] },
  { weight: 32, label: "FDA / regulatory approval", keywords: [
    "fda approves", "fda approval", "fda clears", "fda clearance", "granted approval",
    "breakthrough therapy", "receives approval", "wins approval", "regulatory approval",
  ] },
  { weight: 26, label: "Contract or deal win", keywords: [
    "awarded contract", "wins contract", "contract win", "awarded a contract", "signs deal",
    "multi-year deal", "strikes deal", "lands deal", "secures deal", "wins order", "receives order",
  ] },
  { weight: 24, label: "Buyback or dividend increase", keywords: [
    "share buyback", "stock buyback", "buyback program", "increases dividend", "raises dividend",
    "dividend hike", "special dividend",
  ] },
  { weight: 20, label: "Analyst upgrade", keywords: [
    "upgraded to", "upgrades to", "price target raised", "raises price target", "initiates buy",
    "initiates outperform", "initiated with buy", "top pick",
  ] },
  { weight: 16, label: "Product or partnership news", keywords: [
    "unveils", "launches", "partnership with", "partners with", "teams up with", "new product",
    "expands into", "strategic partnership",
  ] },
];

const POSITIVE_MOVE_WORDS = [
  "surges", "surge", "soars", "soar", "jumps", "jump", "rallies", "rally", "spikes", "spike",
  "climbs", "climb", "rises", "rise", "gains", "gain", "higher", "pops", "pop",
];

export type Catalyst = { weight: number; label: string; negative: boolean; matchedKeyword: string | null };

export function classifyCatalyst(headline: string, summary: string): Catalyst {
  const text = `${headline} ${summary}`.toLowerCase();
  for (const keyword of NEGATIVE_KEYWORDS) {
    if (text.includes(keyword)) return { weight: 0, label: "Negative or conflicting signal", negative: true, matchedKeyword: keyword };
  }
  for (const group of CATALYST_GROUPS) {
    const match = group.keywords.find((keyword) => text.includes(keyword));
    if (match) return { weight: group.weight, label: group.label, negative: false, matchedKeyword: match };
  }
  const moveWord = POSITIVE_MOVE_WORDS.find((word) => text.includes(word));
  if (moveWord) return { weight: 14, label: "Reported price move, no specific catalyst matched", negative: false, matchedKeyword: moveWord };
  return { weight: 4, label: "Unclassified — no catalyst or move language found", negative: false, matchedKeyword: null };
}

function moveConfirmationScore(priceChangePct: number | null): number {
  if (priceChangePct === null) return 0;
  const pct = priceChangePct;
  if (pct < 0) return 0;
  if (pct < 0.4) return (pct / 0.4) * 8;
  if (pct <= 4) return 8 + ((pct - 0.4) / 3.6) * 17;
  if (pct < 8) return 25 - ((pct - 4) / 4) * 17;
  return 0;
}

// Finnhub's free company-news endpoint returns a day's list, not a live stream, so most
// stories are already 30+ minutes old by the time a 5-minute scan sees them. Decaying
// over minutes (like a real breaking-news feed) would zero out almost everything — decay
// over hours instead, matching what this data source can actually deliver.
function freshnessScore(minutesSincePublished: number): number {
  const hours = minutesSincePublished / 60;
  if (hours <= 0.5) return 20;
  if (hours >= 6) return 0;
  return 20 * (1 - (hours - 0.5) / 5.5);
}

export const TRADE_THRESHOLD = 60;
// A candidate may earn persistence on the next scan before it is trade-ready.
// Keeping this below TRADE_THRESHOLD avoids the circular requirement where a
// candidate had to reach 60 before it could receive the persistence points
// needed to reach 60. This is a confirmation gate, not a trade threshold.
export const CONFIRMATION_ELIGIBILITY_THRESHOLD = 40;
export type SignalScore = { key: string; label: string; score: number; max: number; evidence: string };
export type ScoreResult = {
  score: number; status: "WATCH" | "CAUTION" | "DISQUALIFIED"; reason: string;
  signals: SignalScore[]; analystScore: number; skepticPenalty: number;
};

function disqualified(reason: string, signals: SignalScore[] = []): ScoreResult {
  return { score: 0, status: "DISQUALIFIED", reason, signals, analystScore: 0, skepticPenalty: 100 };
}

export function scoreCandidate(input: {
  ticker?: string;
  now?: Date;
  headline: string;
  summary: string;
  priceAtScan: number | null;
  priceChangePct: number | null;
  minutesSincePublished: number;
  seenConfirmationEligibleLastScan: boolean;
  source?: string;
  sourceUrl?: string;
  independentSourceCount?: number;
  relativeVolume?: number | null;
}): ScoreResult {
  const blockedUntil = input.ticker && input.now ? washSaleBlockedUntil(input.ticker, input.now) : null;
  if (blockedUntil) {
    return disqualified(`Wash-sale guard: ${input.ticker} cannot re-enter before ${blockedUntil}. Observation retained; no trade allowed.`);
  }
  const catalyst = classifyCatalyst(input.headline, input.summary);
  const LIQUIDITY_NOTE = "Spread and volume can't be verified on the free data tier.";

  if (catalyst.negative) {
    return disqualified(`Negative/conflicting keyword matched ("${catalyst.matchedKeyword}") — never buy on unverified bad news.`);
  }
  if (input.priceChangePct !== null && input.priceChangePct >= 8) {
    return disqualified(`Already up ${input.priceChangePct.toFixed(1)}% since the story broke — too extended, no chasing.`);
  }
  if (input.priceAtScan !== null && input.priceAtScan < 5) {
    return disqualified("Price is below $5 — excluded as a low-liquidity candidate in this free-tier experiment.");
  }
  if (input.minutesSincePublished > 360) {
    return disqualified("Story is more than 6 hours old with no fresh confirmation.");
  }

  const moveScore = moveConfirmationScore(input.priceChangePct);
  const freshness = freshnessScore(input.minutesSincePublished);
  const persistence = input.seenConfirmationEligibleLastScan ? 20 : 0;
  // Attention penalty. Barber & Odean (2008) find individual investors are net
  // buyers of attention-grabbing stocks — abnormal volume being the primary
  // proxy — and that this crowd buying "could temporarily inflate a stock's
  // price, leading to disappointing subsequent returns". Extreme relative
  // volume is therefore treated as a reason for caution, never as confirmation.
  // Normal or mildly elevated volume is not penalised: a real catalyst should
  // bring some volume with it.
  const relativeVolume = input.relativeVolume ?? null;
  const attentionPenalty = relativeVolume === null ? 0
    : relativeVolume >= 5 ? 12
    : relativeVolume >= 3 ? 7
    : relativeVolume >= 2 ? 3
    : 0;

  const traceable = Boolean(input.source?.trim() && /^https?:\/\//i.test(input.sourceUrl ?? ""));
  const independentSourceCount = Math.max(0, input.independentSourceCount ?? (traceable ? 1 : 0));
  const provenancePenalty = !traceable ? 15 : independentSourceCount < 2 ? 5 : 0;
  const signals: SignalScore[] = [
    { key: "catalyst", label: "Catalyst quality", score: catalyst.weight, max: 35, evidence: catalyst.label },
    { key: "price_confirmation", label: "Price confirmation", score: moveScore, max: 25, evidence: input.priceChangePct === null ? "Quote change unavailable" : `${input.priceChangePct.toFixed(2)}% from first observation` },
    { key: "freshness", label: "News freshness", score: freshness, max: 20, evidence: `${Math.max(0, input.minutesSincePublished).toFixed(0)} minutes old` },
    { key: "persistence", label: "Independent rescan confirmation", score: persistence, max: 20, evidence: input.seenConfirmationEligibleLastScan ? "Confirmed on consecutive scan" : "Awaiting consecutive scan" },
    { key: "attention", label: "Crowd attention", score: -attentionPenalty, max: 0, evidence:
      relativeVolume === null ? "Relative volume unavailable"
      : attentionPenalty === 0 ? `${relativeVolume.toFixed(2)}x normal volume — not an attention spike`
      : `${relativeVolume.toFixed(2)}x normal volume — crowded; attention-driven buying inflates price before it disappoints` },
    { key: "source_verification", label: "Source verification", score: 0, max: 0, evidence: !traceable ? "Missing source name or traceable URL" : independentSourceCount >= 2 ? `${independentSourceCount} independent outlets corroborate this ticker's fresh catalyst set` : `One traceable outlet (${input.source}) — awaiting independent corroboration` },
  ];
  const analystScore = signals.filter((signal) => signal.score > 0).reduce((sum, signal) => sum + signal.score, 0);
  const skepticPenalty = (input.priceChangePct === null ? 5 : input.priceChangePct > 6 ? 8 : 0) + provenancePenalty + attentionPenalty;
  const score = Math.max(0, analystScore - skepticPenalty);

  // A story Atlas could not identify a catalyst in must never trade. Price
  // confirmation, freshness and persistence alone summed to 69 — enough to
  // clear the gate on "something happened and the price moved", which is
  // precisely the attention-driven buying the research warns against. An
  // unidentified story stays an observation.
  if (catalyst.matchedKeyword === null) {
    return {
      score: Math.min(score, TRADE_THRESHOLD - 1), status: "CAUTION",
      reason: `No identifiable catalyst in this story — price moved but nothing explains why, so Atlas records it without acting. ${LIQUIDITY_NOTE}`,
      signals, analystScore, skepticPenalty,
    };
  }

  if (score >= TRADE_THRESHOLD && input.seenConfirmationEligibleLastScan && moveScore > 0) {
    return { score, status: "WATCH", reason: `${catalyst.label}, price confirmed, seen on a second consecutive scan. ${LIQUIDITY_NOTE}`, signals, analystScore, skepticPenalty };
  }
  if (score >= TRADE_THRESHOLD && !input.seenConfirmationEligibleLastScan) {
    return { score, status: "CAUTION", reason: `${catalyst.label} scores high but only appeared once — needs to reappear on the next 5-minute scan before Atlas will act (no first-tick chasing).`, signals, analystScore, skepticPenalty };
  }
  if (score >= TRADE_THRESHOLD && moveScore === 0) {
    return { score, status: "CAUTION", reason: `${catalyst.label} persisted and reached ${score.toFixed(0)}/100, but the real quote has not confirmed a positive move. Atlas will keep observing rather than trade.`, signals, analystScore, skepticPenalty };
  }
  if (score >= 35) {
    return { score, status: "CAUTION", reason: `${catalyst.label}, but below the action threshold (${score.toFixed(0)}/100, needs ${TRADE_THRESHOLD}). Tracking.`, signals, analystScore, skepticPenalty };
  }
  return { score, status: "DISQUALIFIED", reason: `Score too low (${score.toFixed(0)}/100) — no clear, fresh, price-confirmed catalyst.`, signals, analystScore, skepticPenalty };
}

export type WeatherResult = { classification: "TRADE_ELIGIBLE" | "CAUTION" | "SIT_OUT"; flags: string[]; negativeFlags: number; completenessPct: number };
export type WeatherInputs = {
  spy: FinnhubQuote | null; qqq: FinnhubQuote | null; spyVwap: number | null;
  advancers: number; decliners: number; breadthSample: number;
  volatilityProxy: FinnhubQuote | null;
};

export function classifyMarketWeather(input: WeatherInputs): WeatherResult {
  const { spy, qqq, spyVwap, advancers, decliners, breadthSample, volatilityProxy } = input;
  const flags: string[] = [];
  const measurable = [spy?.dp, qqq?.dp, spyVwap, breadthSample >= 10 ? 1 : null, volatilityProxy?.dp].filter((v) => v !== null && v !== undefined).length;
  const completenessPct = Math.round((measurable / 5) * 100);
  let negativeFlags = 0;

  if (spy?.dp == null) flags.push("S&P 500 direction unavailable");
  else { flags.push(`S&P 500 ${spy.dp >= 0 ? "+" : ""}${spy.dp.toFixed(2)}%`); if (spy.dp < 0) negativeFlags++; }
  if (qqq?.dp == null) flags.push("Nasdaq 100 direction unavailable");
  else { flags.push(`Nasdaq 100 ${qqq.dp >= 0 ? "+" : ""}${qqq.dp.toFixed(2)}%`); if (qqq.dp < 0) negativeFlags++; }
  if (spyVwap == null || spy == null) flags.push("SPY intraday VWAP unavailable — never estimated");
  else { const above = spy.c >= spyVwap; flags.push(`SPY ${above ? "above" : "below"} VWAP ($${spyVwap.toFixed(2)})`); if (!above) negativeFlags++; }
  if (breadthSample < 10) flags.push(`Tracked-universe breadth unavailable (${breadthSample}/20 quotes)`);
  else { const ratio = advancers / breadthSample; flags.push(`Tracked breadth ${advancers} advancing / ${decliners} declining`); if (ratio < 0.45) negativeFlags++; }
  if (volatilityProxy?.dp == null) flags.push("Volatility direction unavailable");
  else { flags.push(`VIXY volatility proxy ${volatilityProxy.dp >= 0 ? "+" : ""}${volatilityProxy.dp.toFixed(2)}%`); if (volatilityProxy.dp > 0.5) negativeFlags++; }
  flags.push(`Weather data completeness ${completenessPct}%`);
  flags.push("Scheduled macro-event feed unavailable; Atlas will not infer it.");

  if (negativeFlags >= 3) return { classification: "SIT_OUT", flags, negativeFlags, completenessPct };
  if (completenessPct < 80) return { classification: "CAUTION", flags, negativeFlags, completenessPct };
  const breadthPositive = breadthSample >= 10 && advancers / breadthSample >= 0.55;
  if ((spy?.dp ?? 0) > 0.1 && (qqq?.dp ?? 0) > 0.1 && spyVwap !== null && spy !== null && spy.c >= spyVwap && breadthPositive && negativeFlags <= 1) {
    return { classification: "TRADE_ELIGIBLE", flags, negativeFlags, completenessPct };
  }
  return { classification: "CAUTION", flags, negativeFlags, completenessPct };
}
