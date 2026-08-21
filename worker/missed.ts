// What happened to the trades Atlas did not take.
//
// "Are we missing good trades?" is not answerable by looking at the trades we
// made. It is answerable by following the ones we rejected: if a gate keeps
// blocking candidates that would have worked, the gate is measuring the wrong
// thing. If it keeps blocking candidates that would have lost, it is earning
// its place — and a run of empty days is the system doing its job.
//
// Every rejected candidate above a plausibility floor is followed forward
// through the same stop the position would have used. The measure is the
// standard one: did price reach one stop-distance in favour before it reached
// one against? That is exactly the question the position would have faced, so
// the answer is not a backtest fantasy — it is the trade, replayed on real bars.
//
// Nothing here changes behaviour. It produces the evidence a gate change needs.

import type { FunnelStage } from "./funnel.ts";
import { STAGE_LABELS } from "./funnel.ts";

/**
 * Candidates below this score were never close, and following thousands of them
 * would bury the signal. This matches the confirmation-eligibility threshold:
 * the point at which Atlas already considers a candidate worth a second look.
 */
export const MISSED_TRACKING_MIN_SCORE = 40;

/**
 * Stages worth following. Excluded are the ones no evidence should ever
 * reopen — a wash-sale blackout is a compliance rule, and a halted security
 * cannot be bought at any price, however well it later traded.
 */
export const UNTRACKED_STAGES: ReadonlySet<string> = new Set<FunnelStage>([
  "OPENED", "WASH_SALE", "HALTED", "NO_QUOTE", "PRICE_TOO_LOW",
]);

export function shouldTrackMiss(stage: FunnelStage, score: number, hasQuote: boolean): boolean {
  if (!hasQuote) return false;
  if (UNTRACKED_STAGES.has(stage)) return false;
  return score >= MISSED_TRACKING_MIN_SCORE;
}

export type TimedBar = { t: number; high: number; low: number; close: number };

export type MissOutcome = {
  /** Null until enough bars exist after the block to judge anything. */
  resolved: boolean;
  mfePct: number | null;
  maePct: number | null;
  /** True when price reached one stop-distance in favour before going one against. */
  wouldHaveWon: boolean | null;
  /** How many minutes after the block the decision was reached. */
  decidedAfterMinutes: number | null;
  barsSeen: number;
};

const UNRESOLVED: MissOutcome = {
  resolved: false, mfePct: null, maePct: null,
  wouldHaveWon: null, decidedAfterMinutes: null, barsSeen: 0,
};

/**
 * Replays a blocked candidate against the stop it would have been given.
 *
 * A bar that spans both levels is scored as a loss. Intrabar sequence is
 * unknowable from OHLC, and assuming the favourable one came first is how
 * replays flatter themselves into recommending changes that lose money.
 */
export function evaluateMiss(input: {
  referencePrice: number;
  stopDistancePct: number;
  blockedAtMs: number;
  bars: TimedBar[];
}): MissOutcome {
  if (!(input.referencePrice > 0) || !(input.stopDistancePct > 0)) return UNRESOLVED;

  const forward = input.bars
    .filter((bar) => bar.t * 1000 > input.blockedAtMs)
    .sort((a, b) => a.t - b.t);
  if (forward.length === 0) return UNRESOLVED;

  const target = input.referencePrice * (1 + input.stopDistancePct / 100);
  const stop = input.referencePrice * (1 - input.stopDistancePct / 100);

  let mfePct = -Infinity;
  let maePct = Infinity;
  let wouldHaveWon: boolean | null = null;
  let decidedAfterMinutes: number | null = null;

  for (const bar of forward) {
    mfePct = Math.max(mfePct, ((bar.high - input.referencePrice) / input.referencePrice) * 100);
    maePct = Math.min(maePct, ((bar.low - input.referencePrice) / input.referencePrice) * 100);

    if (wouldHaveWon === null) {
      const hitStop = bar.low <= stop;
      const hitTarget = bar.high >= target;
      if (hitStop || hitTarget) {
        // Both inside one bar: score the loss. See the note above.
        wouldHaveWon = hitTarget && !hitStop;
        decidedAfterMinutes = Math.round((bar.t * 1000 - input.blockedAtMs) / 60000);
      }
    }
  }

  return {
    // A miss is only resolved once it actually reached one level or the other.
    // An unfinished session says nothing yet, and counting it as a loss would
    // quietly argue every gate is working.
    resolved: wouldHaveWon !== null,
    mfePct: Number.isFinite(mfePct) ? mfePct : null,
    maePct: Number.isFinite(maePct) ? maePct : null,
    wouldHaveWon,
    decidedAfterMinutes,
    barsSeen: forward.length,
  };
}

export type MissRow = {
  blockedStage: string;
  resolved: boolean;
  wouldHaveWon: boolean | null;
};

export type GateCost = {
  stage: string;
  label: string;
  kind: string;
  blocked: number;
  resolved: number;
  wouldHaveWon: number;
  /** Share of resolved misses that would have reached target before stop. */
  winRate: number | null;
  /** Whether the sample is large enough to say anything at all. */
  conclusive: boolean;
  verdict: string;
};

/**
 * A gate needs this many resolved misses before its win rate means anything.
 * Below it the honest answer is "not yet known", not a number with a decimal
 * point on it.
 */
export const MIN_MISSES_FOR_VERDICT = 20;

/**
 * Roughly the win rate Atlas needs at one-to-one risk to be worth trading at
 * all. A gate whose rejects beat this is costing money; one whose rejects fall
 * short of it is earning its place.
 */
export const BREAKEVEN_WIN_RATE = 0.5;

export function summariseGateCost(rows: MissRow[]): GateCost[] {
  const byStage = new Map<string, MissRow[]>();
  for (const row of rows) {
    const list = byStage.get(row.blockedStage) ?? [];
    list.push(row);
    byStage.set(row.blockedStage, list);
  }

  return Array.from(byStage.entries())
    .map(([stage, group]) => {
      const resolved = group.filter((row) => row.resolved);
      const wouldHaveWon = resolved.filter((row) => row.wouldHaveWon).length;
      const winRate = resolved.length ? wouldHaveWon / resolved.length : null;
      const conclusive = resolved.length >= MIN_MISSES_FOR_VERDICT;
      const meta = STAGE_LABELS[stage as FunnelStage];

      return {
        stage,
        label: meta?.label ?? stage,
        kind: meta?.kind ?? "market",
        blocked: group.length,
        resolved: resolved.length,
        wouldHaveWon,
        winRate,
        conclusive,
        verdict: !conclusive
          ? `Only ${resolved.length} of ${MIN_MISSES_FOR_VERDICT} resolved rejections — not yet answerable.`
          : winRate! > BREAKEVEN_WIN_RATE
            ? `${(winRate! * 100).toFixed(0)}% of what this gate rejected would have hit target before stop. It is costing trades; worth examining what it actually measures.`
            : `${(winRate! * 100).toFixed(0)}% of what this gate rejected would have won. It is earning its place — the rejections were right.`,
      };
    })
    .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1) || b.resolved - a.resolved);
}
