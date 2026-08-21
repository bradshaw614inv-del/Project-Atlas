// How many outbound requests a scan has spent, and how many it has left.
//
// A Cloudflare Worker invocation is capped at 50 subrequests. Past the cap
// every further fetch simply fails, and because each caller here already
// swallows its own errors, the scan reports success having silently skipped
// whatever was last in the sequence. That is the failure mode that once left
// news fetching entirely dead while every scan looked healthy.
//
// The cap was previously respected by arithmetic in a comment. This counts.

export const SUBREQUEST_LIMIT = 50;

// Leave headroom: D1 queries do not count against the subrequest cap, but a
// retry or a redirect does, and a scan that ends exactly on the limit has no
// room for either.
export const SUBREQUEST_RESERVE = 4;

let counts: Record<string, number> = {};

export function resetSubrequests(): void {
  counts = {};
}

export function countSubrequest(source: string): void {
  counts[source] = (counts[source] ?? 0) + 1;
}

export function subrequestsUsed(): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export function subrequestsRemaining(): number {
  return SUBREQUEST_LIMIT - SUBREQUEST_RESERVE - subrequestsUsed();
}

/**
 * Whether `count` more requests fit inside the budget. Callers that fan out —
 * the SEC walk especially — check before each one so they stop cleanly instead
 * of having the runtime cut them off mid-sequence.
 */
export function canAfford(count = 1): boolean {
  return subrequestsRemaining() >= count;
}

export type SubrequestReport = {
  total: number;
  bySource: Record<string, number>;
  limit: number;
  overBudget: boolean;
};

export function subrequestReport(): SubrequestReport {
  const total = subrequestsUsed();
  return {
    total,
    bySource: { ...counts },
    limit: SUBREQUEST_LIMIT,
    overBudget: total > SUBREQUEST_LIMIT - SUBREQUEST_RESERVE,
  };
}
