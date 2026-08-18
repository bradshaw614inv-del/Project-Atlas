// Does a higher confidence score actually produce a better outcome?
//
// This is the question that has to be answered before score is ever allowed to
// size a position. Right now it is unanswered: across the first handful of
// closed trades the correlation between entry score and return was negative,
// which is as likely noise as signal at that sample size. The point of this
// module is to keep asking the question mechanically until the sample is large
// enough for the answer to mean something — and to say plainly that it is not
// large enough until it is.
//
// It never changes configuration. It produces a verdict for review.

export type BandOutcome = { band: string; entryScore: number | null; returnPct: number; realizedPnl: number };

export type BandStats = {
  band: string;
  closed: number;
  meanReturnPct: number | null;
  winRate: number | null;
  totalPnl: number;
  sufficient: boolean;
};

export type BandVerdict = {
  bands: BandStats[];
  // Ordered comparison: does mean return rise with band?
  monotonic: boolean | null;
  comparableBands: number;
  correlation: number | null;
  sampleSize: number;
  verdict: string;
  readyToSizeByConfidence: boolean;
};

// A per-band threshold, not a total. Comparing a 40-trade band against a
// 3-trade band is not a comparison. Matches the existing validation policy's
// 30-observation minimum.
export const MIN_PER_BAND = 30;
export const BAND_ORDER = ["0-34", "35-49", "50-59", "60-79", "80-100"];

export function analyzeBands(outcomes: BandOutcome[]): BandVerdict {
  const bands: BandStats[] = BAND_ORDER.map((band) => {
    const rows = outcomes.filter((row) => row.band === band);
    const returns = rows.map((row) => row.returnPct);
    return {
      band,
      closed: rows.length,
      meanReturnPct: returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null,
      winRate: returns.length ? returns.filter((value) => value > 0).length / returns.length : null,
      totalPnl: rows.reduce((sum, row) => sum + row.realizedPnl, 0),
      sufficient: rows.length >= MIN_PER_BAND,
    };
  });

  // Correlation between raw score and return, across every trade that has both.
  const scored = outcomes.filter((row) => row.entryScore !== null);
  let correlation: number | null = null;
  if (scored.length >= 3) {
    const xs = scored.map((row) => row.entryScore as number);
    const ys = scored.map((row) => row.returnPct);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const cov = xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0);
    const sx = Math.sqrt(xs.reduce((sum, x) => sum + (x - mx) ** 2, 0));
    const sy = Math.sqrt(ys.reduce((sum, y) => sum + (y - my) ** 2, 0));
    correlation = sx > 0 && sy > 0 ? cov / (sx * sy) : null;
  }

  const comparable = bands.filter((band) => band.sufficient);
  let monotonic: boolean | null = null;
  if (comparable.length >= 2) {
    monotonic = comparable.every((band, i) =>
      i === 0 || (band.meanReturnPct ?? 0) >= (comparable[i - 1].meanReturnPct ?? 0));
  }

  // The bar for acting is deliberately high: at least two bands each with a
  // real sample, returns rising with band, and a positive score/return
  // relationship. Anything less and confidence-weighted sizing would be
  // amplifying an unmeasured guess.
  const readyToSizeByConfidence = comparable.length >= 2 && monotonic === true && (correlation ?? -1) > 0.2;

  let verdict: string;
  if (comparable.length < 2) {
    const progress = bands.filter((band) => band.closed > 0)
      .map((band) => `${band.band}: ${band.closed}/${MIN_PER_BAND}`).join(" · ") || "no closed trades yet";
    verdict = `Not yet answerable. Two bands need ${MIN_PER_BAND} closed trades each before they can be compared (${progress}).`
      + (correlation !== null ? ` Score/return correlation so far is ${correlation.toFixed(2)} on ${scored.length} trades, which is too small a sample to trust in either direction.` : "");
  } else if (readyToSizeByConfidence) {
    verdict = `Higher bands are producing better returns across ${comparable.length} comparable bands (correlation ${correlation?.toFixed(2)}). Confidence-weighted sizing is now supported by evidence and can be proposed as an experiment.`;
  } else if (monotonic === false) {
    verdict = `Returns do not rise with confidence band across ${comparable.length} comparable bands. The score qualifies trades but does not rank them, so sizing must stay flat.`;
  } else {
    verdict = `Bands are comparable but the score/return relationship (${correlation?.toFixed(2)}) is too weak to justify sizing by confidence.`;
  }

  return {
    bands, monotonic, comparableBands: comparable.length,
    correlation, sampleSize: outcomes.length, verdict, readyToSizeByConfidence,
  };
}
