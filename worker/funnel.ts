// Why a trading day produced the trades it did — or produced none.
//
// A candidate has to clear eleven gates in a row to become a position. When the
// day ends with nothing, the only record was a pile of free-text reasons on
// individual candidate rows, so "why zero trades?" could not be answered
// without reading them one by one. This turns each rejection into one named
// stage, counts them per day, and says where the funnel actually died.
//
// The distinction that matters most is the last one below: a day with no trades
// because nothing qualified is the system working. A day with no trades because
// the pipeline delivered nothing is the system broken. They look identical on a
// dashboard that only reports the number zero.

import type { ScoreBlocker } from "./scoring.ts";

/**
 * Ordered outermost-first, matching the order the engine actually applies them.
 * A candidate is attributed to the first stage that stopped it, so the stage and
 * the human-readable reason on the same row always agree.
 */
export const FUNNEL_STAGES = [
  "OPENED",
  "ENTRY_GUARD",
  "CHART_UNCONFIRMED",
  "NEGATIVE_FILING",
  "NOT_SUBJECT",
  "MANIPULATION",
  "FILING_ONLY",
  "HALTED",
  "CRYPTO_DISAGREEMENT",
  "WASH_SALE",
  "NEGATIVE_NEWS",
  "TOO_EXTENDED",
  "PRICE_TOO_LOW",
  "STALE",
  "HEADLINE_ONLY",
  "NO_CATALYST",
  "NOT_PERSISTED",
  "PRICE_UNCONFIRMED",
  "SCORE_TOO_LOW",
  "NO_QUOTE",
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

// What each stage means in the operator's language, and — the useful part —
// whether it points at the market or at Atlas.
export const STAGE_LABELS: Record<FunnelStage, { label: string; kind: "traded" | "market" | "risk" | "data" }> = {
  OPENED: { label: "Opened a position", kind: "traded" },
  ENTRY_GUARD: { label: "Qualified but an entry guard blocked it", kind: "risk" },
  CHART_UNCONFIRMED: { label: "Qualified but the chart did not confirm", kind: "market" },
  NEGATIVE_FILING: { label: "SEC filing disclosed something bad", kind: "risk" },
  NOT_SUBJECT: { label: "Story only mentioned the ticker", kind: "data" },
  MANIPULATION: { label: "Manipulation screen blocked it", kind: "risk" },
  FILING_ONLY: { label: "SEC filing alone, no press corroboration", kind: "data" },
  HALTED: { label: "Security halted", kind: "risk" },
  CRYPTO_DISAGREEMENT: { label: "Crypto feeds disagreed on price", kind: "data" },
  WASH_SALE: { label: "Wash-sale blackout", kind: "risk" },
  NEGATIVE_NEWS: { label: "Negative catalyst", kind: "market" },
  TOO_EXTENDED: { label: "Move already too extended to chase", kind: "market" },
  PRICE_TOO_LOW: { label: "Below the $5 liquidity floor", kind: "risk" },
  STALE: { label: "Story older than six hours", kind: "data" },
  HEADLINE_ONLY: { label: "No article text to read", kind: "data" },
  NO_CATALYST: { label: "No identifiable catalyst", kind: "market" },
  NOT_PERSISTED: { label: "Scored well but seen only once", kind: "data" },
  PRICE_UNCONFIRMED: { label: "Scored well but price did not confirm", kind: "market" },
  SCORE_TOO_LOW: { label: "Scored below the gate", kind: "market" },
  NO_QUOTE: { label: "No usable quote for the ticker", kind: "data" },
};

export type BlockerInput = {
  hasQuote: boolean;
  negativeFiling: boolean;
  isSubject: boolean;
  manipulationBlocked: boolean;
  filingOnly: boolean;
  halted: boolean;
  cryptoDisagreement: boolean;
  scoreBlocker: ScoreBlocker | null;
  chartConfirmed: boolean | null;
  entryGuardBlocked: boolean;
  opened: boolean;
};

/**
 * The one stage to attribute this candidate to. Precedence mirrors engine.ts:
 * the overrides it applies after scoring outrank the score's own verdict,
 * because that is the reason the operator sees on the row.
 */
export function resolveStage(input: BlockerInput): FunnelStage {
  if (input.opened) return "OPENED";
  if (!input.hasQuote) return "NO_QUOTE";
  if (input.negativeFiling) return "NEGATIVE_FILING";
  if (!input.isSubject) return "NOT_SUBJECT";
  if (input.manipulationBlocked) return "MANIPULATION";
  if (input.filingOnly) return "FILING_ONLY";
  if (input.halted) return "HALTED";
  if (input.cryptoDisagreement) return "CRYPTO_DISAGREEMENT";
  if (input.scoreBlocker) return input.scoreBlocker;
  // Everything the score allows; only the chart and the entry guards are left.
  if (input.chartConfirmed === false) return "CHART_UNCONFIRMED";
  if (input.entryGuardBlocked) return "ENTRY_GUARD";
  return "SCORE_TOO_LOW";
}

export type DayCounts = {
  tradingDay: string;
  scans: number;
  storiesFetched: number;
  candidatesScored: number;
  positionsOpened: number;
  positionsClosed: number;
  /** Scans during market hours where data sufficiency said Atlas was blind. */
  blindScans: number;
  /** Scans that exhausted the subrequest budget, so later fetches never ran. */
  overBudgetScans?: number;
  stages: Partial<Record<FunnelStage, number>>;
};

export type DayVerdict =
  | "TRADED"
  | "NO_QUALIFYING_SETUP"
  | "BLOCKED_BY_RISK"
  | "PIPELINE_STARVED"
  | "NOT_A_TRADING_DAY";

export type DayAnalysis = {
  verdict: DayVerdict;
  headline: string;
  detail: string;
  /** Stages that stopped the most candidates, largest first. */
  topBlockers: { stage: FunnelStage; label: string; count: number; kind: string }[];
  /** True when the day's zero is Atlas's fault rather than the market's. */
  actionable: boolean;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Turns a day's funnel counts into a verdict a person can act on.
 *
 * The whole point is the difference between the two kinds of zero. If the
 * pipeline delivered nothing to judge, that is a bug and the day is actionable.
 * If it delivered plenty and nothing cleared the gates, the market simply did
 * not offer a setup, and lowering the gates to manufacture one is how a system
 * starts buying attention instead of catalysts.
 */
export function analyseDay(counts: DayCounts, isTradingDay = true): DayAnalysis {
  const ranked = Object.entries(counts.stages)
    .filter(([stage]) => stage !== "OPENED")
    .map(([stage, count]) => ({
      stage: stage as FunnelStage,
      count: count ?? 0,
      label: STAGE_LABELS[stage as FunnelStage]?.label ?? stage,
      kind: STAGE_LABELS[stage as FunnelStage]?.kind ?? "market",
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.stage.localeCompare(b.stage));

  const topBlockers = ranked.slice(0, 5);

  if (!isTradingDay) {
    return {
      verdict: "NOT_A_TRADING_DAY", actionable: false, topBlockers,
      headline: "Market closed",
      detail: "No session, so no trades were possible. This day is excluded from the trade-rate denominator.",
    };
  }

  if (counts.positionsOpened > 0) {
    return {
      verdict: "TRADED", actionable: false, topBlockers,
      headline: `Traded — ${plural(counts.positionsOpened, "position")} opened`,
      detail: `${plural(counts.candidatesScored, "candidate")} scored across ${plural(counts.scans, "scan")}; ${plural(counts.positionsOpened, "cleared every gate", "cleared every gate")}.`,
    };
  }

  // A day where Atlas could not see is not a day where nothing happened.
  const overBudget = counts.overBudgetScans ?? 0;
  const starved = counts.candidatesScored === 0 || counts.blindScans > 0 || counts.storiesFetched === 0 || overBudget > 0;
  if (starved) {
    const causes = [
      counts.storiesFetched === 0 ? "no stories were fetched" : null,
      counts.candidatesScored === 0 ? "nothing reached the scorer" : null,
      counts.blindScans > 0 ? `${plural(counts.blindScans, "scan")} reported insufficient data` : null,
      overBudget > 0 ? `${plural(overBudget, "scan")} ran out of subrequest budget, so later feeds never ran` : null,
    ].filter(Boolean);
    return {
      verdict: "PIPELINE_STARVED", actionable: true, topBlockers,
      headline: "No trades — but Atlas was not seeing the market",
      detail: `This zero is Atlas's, not the market's: ${causes.join(", ")}. Fix the feed before drawing any conclusion about the day's opportunities.`,
    };
  }

  // Risk controls firing is a deliberate refusal, not a missed opportunity.
  const riskCount = ranked.filter((row) => row.kind === "risk").reduce((sum, row) => sum + row.count, 0);
  const dataCount = ranked.filter((row) => row.kind === "data").reduce((sum, row) => sum + row.count, 0);
  const total = ranked.reduce((sum, row) => sum + row.count, 0);

  if (total > 0 && riskCount / total >= 0.5) {
    return {
      verdict: "BLOCKED_BY_RISK", actionable: false, topBlockers,
      headline: "No trades — risk controls held the line",
      detail: `${riskCount} of ${total} candidates were stopped by a deliberate safety rule (${topBlockers[0]?.label.toLowerCase() ?? "a guard"}). Working as designed.`,
    };
  }

  const dominant = topBlockers[0];
  const dataHeavy = total > 0 && dataCount / total >= 0.5;
  return {
    verdict: "NO_QUALIFYING_SETUP",
    actionable: dataHeavy,
    topBlockers,
    headline: dataHeavy ? "No trades — mostly for want of usable evidence" : "No trades — nothing qualified",
    detail: dataHeavy
      ? `${dataCount} of ${total} rejections were about the evidence Atlas had rather than the setup itself; the largest was "${dominant?.label}". That is worth fixing — it is not the market saying no.`
      : `${plural(counts.candidatesScored, "candidate")} scored and none cleared the gates. The largest single reason was "${dominant?.label}" (${dominant?.count ?? 0}). The market did not offer a setup; forcing one is how a system starts buying attention instead of catalysts.`,
  };
}

/** Merges one scan's stage counts into a day's running totals. */
export function mergeStageCounts(
  existing: Partial<Record<FunnelStage, number>>,
  incoming: Partial<Record<FunnelStage, number>>,
): Partial<Record<FunnelStage, number>> {
  const merged: Partial<Record<FunnelStage, number>> = { ...existing };
  for (const [stage, count] of Object.entries(incoming)) {
    merged[stage as FunnelStage] = (merged[stage as FunnelStage] ?? 0) + (count ?? 0);
  }
  return merged;
}

export function parseStageCounts(json: string | null | undefined): Partial<Record<FunnelStage, number>> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const out: Partial<Record<FunnelStage, number>> = {};
    for (const stage of FUNNEL_STAGES) {
      const value = Number(parsed[stage]);
      if (Number.isFinite(value) && value > 0) out[stage] = value;
    }
    return out;
  } catch {
    return {};
  }
}
