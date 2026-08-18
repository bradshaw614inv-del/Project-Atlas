// Technical confirmation: does the chart agree with the story?
//
// News alone says something happened. It does not say buyers are currently in
// control, and Atlas's own trade reviews showed the cost of ignoring that —
// average best-case excursion of +0.40% against average heat of -0.68%, meaning
// positions were going against the entry almost immediately. That is an entry
// timing failure, not a catalyst failure.
//
// Every measure here comes from real observed 5-minute bars. Nothing is
// smoothed into existence: if there are too few bars to judge, the reading is
// null and the trade is not confirmed rather than being waved through.

export type Bar = { high: number; low: number; close: number; volume: number };

export type TechnicalRead = {
  // Price against the session's volume-weighted average price. This is the
  // benchmark institutional desks measure execution against; trading above it
  // means buyers have been paying up on volume today.
  aboveVwap: boolean | null;
  vwapDistancePct: number | null;
  // Structure: are recent swing lows rising? An uptrend that keeps making
  // higher lows is buyers repeatedly defending higher prices.
  higherLows: boolean | null;
  // Short-term average above the longer one, both from real closes.
  trendUp: boolean | null;
  // Where price sits inside the session range. Near the high is strength;
  // near the low is a falling knife regardless of the headline.
  rangePosition: number | null;
  // How far above VWAP price has already travelled. Buying far above it is
  // chasing a move that has already happened.
  overextended: boolean | null;
};

export type TechnicalVerdict = TechnicalRead & {
  confirmed: boolean;
  reasons: string[];
};

const MIN_BARS = 12;                 // an hour of 5-minute bars
const OVEREXTENSION_LIMIT_PCT = 2.0; // distance above VWAP that counts as chasing
const SHORT_WINDOW = 6;
const LONG_WINDOW = 18;

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function readTechnicals(bars: Bar[], vwap: number | null): TechnicalRead {
  if (bars.length < MIN_BARS) {
    return { aboveVwap: null, vwapDistancePct: null, higherLows: null, trendUp: null, rangePosition: null, overextended: null };
  }
  const closes = bars.map((bar) => bar.close);
  const price = closes[closes.length - 1];

  const vwapDistancePct = vwap && vwap > 0 ? ((price - vwap) / vwap) * 100 : null;
  const aboveVwap = vwapDistancePct === null ? null : vwapDistancePct >= 0;
  const overextended = vwapDistancePct === null ? null : vwapDistancePct > OVEREXTENSION_LIMIT_PCT;

  // Higher lows across three consecutive thirds of the recent window.
  const recent = bars.slice(-Math.min(bars.length, LONG_WINDOW));
  const third = Math.floor(recent.length / 3);
  let higherLows: boolean | null = null;
  if (third >= 2) {
    const lowOf = (slice: Bar[]) => Math.min(...slice.map((bar) => bar.low));
    const first = lowOf(recent.slice(0, third));
    const middle = lowOf(recent.slice(third, third * 2));
    const last = lowOf(recent.slice(third * 2));
    higherLows = middle >= first && last >= middle;
  }

  const shortAvg = mean(closes.slice(-SHORT_WINDOW));
  const longAvg = mean(closes.slice(-LONG_WINDOW));
  const trendUp = shortAvg !== null && longAvg !== null ? shortAvg > longAvg : null;

  const sessionHigh = Math.max(...bars.map((bar) => bar.high));
  const sessionLow = Math.min(...bars.map((bar) => bar.low));
  const rangePosition = sessionHigh > sessionLow ? (price - sessionLow) / (sessionHigh - sessionLow) : null;

  return { aboveVwap, vwapDistancePct, higherLows, trendUp, rangePosition, overextended };
}

// Confirmation is deliberately a gate, not a bonus. A good story on a chart
// that is breaking down is still a losing trade, and adding points would let a
// strong headline outvote what price is actually doing.
export function confirmBullish(read: TechnicalRead): TechnicalVerdict {
  const reasons: string[] = [];

  if (read.aboveVwap === null) {
    return { ...read, confirmed: false, reasons: ["Not enough real bars to read the chart; no technical confirmation."] };
  }
  if (!read.aboveVwap) reasons.push(`Trading ${Math.abs(read.vwapDistancePct ?? 0).toFixed(2)}% below session VWAP — sellers hold the session.`);
  if (read.overextended) reasons.push(`Already ${read.vwapDistancePct?.toFixed(2)}% above VWAP — the move has happened; entering here is chasing.`);
  if (read.higherLows === false && read.trendUp === false) reasons.push("Neither rising lows nor a rising short-term average — no uptrend structure.");
  if (read.rangePosition !== null && read.rangePosition < 0.35) reasons.push(`Price sits in the bottom ${(read.rangePosition * 100).toFixed(0)}% of the session range.`);

  // Require: buyers in control (above VWAP), not already extended, some
  // structural evidence of an uptrend, and not languishing at the session low.
  const structure = read.higherLows === true || read.trendUp === true;
  const confirmed = read.aboveVwap === true
    && read.overextended !== true
    && structure
    && (read.rangePosition === null || read.rangePosition >= 0.35);

  if (confirmed) {
    reasons.length = 0;
    reasons.push(`Above VWAP by ${read.vwapDistancePct?.toFixed(2)}%, ${read.higherLows ? "rising lows" : "rising short-term average"}, ${((read.rangePosition ?? 0) * 100).toFixed(0)}% up the session range.`);
  }
  return { ...read, confirmed, reasons };
}
