// Post-mortem for a closed position, computed only from real observed intraday
// bars. Nothing here is modelled or estimated: if the bars for a window are
// missing, the corresponding field stays null rather than being filled in.

export type ReviewBars = { t: number[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[] };

export type TradeReviewInput = {
  entryPrice: number;
  exitPrice: number;
  entryAt: string;
  exitAt: string;
  initialStopPrice: number;
  realizedPnl: number;
  exitReason: string;
};

export type TradeReview = {
  holdMinutes: number;
  mfePct: number | null;
  maePct: number | null;
  mfeMinutes: number | null;
  maeMinutes: number | null;
  stopDistancePct: number;
  postExitDriftPct: number | null;
  findings: string[];
};

const POST_EXIT_WINDOW_MINUTES = 30;

export function reviewTrade(input: TradeReviewInput, bars: ReviewBars | null): TradeReview {
  const entryMs = Date.parse(input.entryAt);
  const exitMs = Date.parse(input.exitAt);
  const holdMinutes = Math.max(0, Math.round((exitMs - entryMs) / 60000));
  const stopDistancePct = ((input.entryPrice - input.initialStopPrice) / input.entryPrice) * 100;
  const returnPct = ((input.exitPrice - input.entryPrice) / input.entryPrice) * 100;

  let mfePct: number | null = null, maePct: number | null = null;
  let mfeMinutes: number | null = null, maeMinutes: number | null = null;
  let postExitDriftPct: number | null = null;

  if (bars) {
    for (let i = 0; i < bars.t.length; i++) {
      const seconds = bars.t[i];
      const ms = seconds * 1000;
      const high = bars.high[i], low = bars.low[i];
      if (ms < entryMs || ms > exitMs || high == null || low == null) continue;
      const upPct = ((high - input.entryPrice) / input.entryPrice) * 100;
      const downPct = ((low - input.entryPrice) / input.entryPrice) * 100;
      if (mfePct === null || upPct > mfePct) { mfePct = upPct; mfeMinutes = Math.round((ms - entryMs) / 60000); }
      if (maePct === null || downPct < maePct) { maePct = downPct; maeMinutes = Math.round((ms - entryMs) / 60000); }
    }
    // Where price went in the half hour after the exit. Measured from the exit
    // price, so a positive number always means "it went up after we left".
    const driftDeadline = exitMs + POST_EXIT_WINDOW_MINUTES * 60000;
    let lastAfter: number | null = null;
    for (let i = 0; i < bars.t.length; i++) {
      const ms = bars.t[i] * 1000;
      const close = bars.close[i];
      if (ms > exitMs && ms <= driftDeadline && close != null) lastAfter = close;
    }
    if (lastAfter !== null) postExitDriftPct = ((lastAfter - input.exitPrice) / input.exitPrice) * 100;
  }

  const findings: string[] = [];
  // Each finding is a factual comparison between two measured numbers. None of
  // them change behaviour on their own — they are evidence for review.
  if (maePct !== null && stopDistancePct > 0) {
    const heatUsed = Math.abs(maePct) / stopDistancePct;
    if (input.exitReason !== "STOP_LOSS" && heatUsed >= 0.8) {
      findings.push(`Came within ${((1 - heatUsed) * 100).toFixed(0)}% of the stop (${maePct.toFixed(2)}% vs ${(-stopDistancePct).toFixed(2)}%) before finishing at ${returnPct.toFixed(2)}%.`);
    }
    if (input.exitReason === "STOP_LOSS" && postExitDriftPct !== null && postExitDriftPct > Math.abs(stopDistancePct)) {
      findings.push(`Stopped out, then recovered ${postExitDriftPct.toFixed(2)}% within ${POST_EXIT_WINDOW_MINUTES} minutes — the stop may sit inside normal noise for this ticker.`);
    }
    if (input.exitReason === "STOP_LOSS" && postExitDriftPct !== null && postExitDriftPct <= 0) {
      findings.push(`Stopped out and kept falling ${postExitDriftPct.toFixed(2)}% over the next ${POST_EXIT_WINDOW_MINUTES} minutes — the stop did its job.`);
    }
  }
  if (mfePct !== null && mfePct > 0.5 && returnPct < 0) {
    findings.push(`Was up ${mfePct.toFixed(2)}% at ${mfeMinutes} minutes in, then closed at ${returnPct.toFixed(2)}% — gave back the entire move.`);
  }
  if (mfePct !== null && returnPct > 0 && mfePct - returnPct > 0.5) {
    findings.push(`Peaked at +${mfePct.toFixed(2)}% but exited at +${returnPct.toFixed(2)}%, leaving ${(mfePct - returnPct).toFixed(2)}% on the table.`);
  }
  if (mfePct !== null && mfePct < 0.1) {
    findings.push("Never traded meaningfully above the entry price — the catalyst produced no follow-through at all.");
  }
  if (input.exitReason === "MARKET_CLOSE" && returnPct < 0) {
    findings.push("Closed at the bell still underwater; the thesis had not played out within the session.");
  }
  return { holdMinutes, mfePct, maePct, mfeMinutes, maeMinutes, stopDistancePct, postExitDriftPct, findings };
}
