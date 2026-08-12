import type { FinnhubQuote } from "./finnhub";

// Deterministic, rules-based scoring only. Every signal here comes from a real,
// verifiable field (headline text, a live quote, elapsed time) — nothing is inferred
// or invented. If a signal isn't available on Finnhub's free tier (spread, volume,
// breadth, VWAP), it is left out rather than faked.

const NEGATIVE_KEYWORDS = [
  "misses estimates", "miss estimates", "cuts guidance", "lowers forecast", "lowers guidance",
  "downgraded", "downgrades", "lawsuit", "sues", "sued", "investigation", "investigated",
  "recall", "recalls", "resigns", "resignation", "fraud", "bankruptcy", "delisted", "delisting",
  "guidance cut", "warns", "warning", "plunges", "plunge", "sec probe", "restated", "restatement",
  "halted", "halts trading", "layoffs", "job cuts", "cuts jobs", "misses revenue", "profit warning",
  "falls short", "disappoints", "disappointing", "slashes", "widens loss", "posts loss",
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
  headline: string;
  summary: string;
  priceAtScan: number | null;
  priceChangePct: number | null;
  minutesSincePublished: number;
  seenConfirmationEligibleLastScan: boolean;
}): ScoreResult {
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
  const signals: SignalScore[] = [
    { key: "catalyst", label: "Catalyst quality", score: catalyst.weight, max: 35, evidence: catalyst.label },
    { key: "price_confirmation", label: "Price confirmation", score: moveScore, max: 25, evidence: input.priceChangePct === null ? "Quote change unavailable" : `${input.priceChangePct.toFixed(2)}% from first observation` },
    { key: "freshness", label: "News freshness", score: freshness, max: 20, evidence: `${Math.max(0, input.minutesSincePublished).toFixed(0)} minutes old` },
    { key: "persistence", label: "Independent rescan confirmation", score: persistence, max: 20, evidence: input.seenConfirmationEligibleLastScan ? "Confirmed on consecutive scan" : "Awaiting consecutive scan" },
  ];
  const analystScore = signals.reduce((sum, signal) => sum + signal.score, 0);
  const skepticPenalty = input.priceChangePct === null ? 5 : input.priceChangePct > 6 ? 8 : 0;
  const score = Math.max(0, analystScore - skepticPenalty);

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

export type WeatherResult = { classification: "TRADE_ELIGIBLE" | "CAUTION" | "SIT_OUT"; flags: string[] };

export function classifyMarketWeather(spy: FinnhubQuote | null, qqq: FinnhubQuote | null): WeatherResult {
  const flags = ["Breadth, VWAP and volatility aren't available on the free data tier — this reads index direction only."];
  if (!spy || !qqq || spy.dp === null || qqq.dp === null) {
    return { classification: "CAUTION", flags: [...flags, "Index quote unavailable this scan."] };
  }
  const spyPct = spy.dp, qqqPct = qqq.dp;
  if (spyPct > 0.1 && qqqPct > 0.1) return { classification: "TRADE_ELIGIBLE", flags: [...flags, `S&P 500 +${spyPct.toFixed(2)}%`, `Nasdaq 100 +${qqqPct.toFixed(2)}%`] };
  if (spyPct < -0.5 && qqqPct < -0.5) return { classification: "SIT_OUT", flags: [...flags, `S&P 500 ${spyPct.toFixed(2)}%`, `Nasdaq 100 ${qqqPct.toFixed(2)}%`, "Broad index weakness on both benchmarks."] };
  return { classification: "CAUTION", flags: [...flags, `S&P 500 ${spyPct.toFixed(2)}%`, `Nasdaq 100 ${qqqPct.toFixed(2)}%`, "Mixed or weak signal."] };
}
