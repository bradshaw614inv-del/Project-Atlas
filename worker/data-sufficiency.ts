// Is Atlas actually receiving enough information to decide anything?
//
// Connection monitoring answers a different and easier question: did the source
// respond. A source can respond perfectly and deliver nothing useful, and that
// failure is silent. Every scan yesterday reported success with no error while
// fetching zero stories, because the Cloudflare subrequest cap had killed the
// news calls after the budget ran out. Health said LIVE. The pipeline was dead.
//
// This measures yield rather than availability, and compares each scan against
// what Atlas itself normally receives, so a collapse is detected without anyone
// having to guess the right absolute threshold in advance.

export type ScanYield = {
  quotesUsable: number;
  quotesRequested: number;
  storiesFetched: number;
  storiesWithBody: number;
  candidatesScored: number;
  breadthSample: number;
  filingsFound: number;
  newsTickersQueried: number;
};

export type SufficiencyFinding = {
  metric: string;
  severity: "CRITICAL" | "WARNING";
  detail: string;
};

export type SufficiencyVerdict = {
  sufficient: boolean;
  findings: SufficiencyFinding[];
  // True when Atlas cannot see enough to judge anything, in which case it
  // should not be opening positions at all.
  blindToMarket: boolean;
};

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// A metric that collapses to a fraction of its own recent normal is the signal,
// regardless of what that normal happens to be for this deployment.
const COLLAPSE_RATIO = 0.4;
const MIN_HISTORY = 5;

export function assessSufficiency(
  current: ScanYield,
  history: ScanYield[],
  marketOpen: boolean,
): SufficiencyVerdict {
  const findings: SufficiencyFinding[] = [];

  // Absolute floors: below these, specific decisions become impossible no
  // matter what history says.
  const quoteRate = current.quotesRequested > 0 ? current.quotesUsable / current.quotesRequested : 0;
  if (current.quotesRequested > 0 && quoteRate < 0.5) {
    findings.push({
      metric: "quotes", severity: "CRITICAL",
      detail: `Only ${current.quotesUsable} of ${current.quotesRequested} quotes usable — positions cannot be valued or stopped reliably.`,
    });
  }
  if (current.breadthSample < 10) {
    findings.push({
      metric: "breadth", severity: "WARNING",
      detail: `Breadth sample is ${current.breadthSample} of 20 — market weather cannot be measured, only guessed at.`,
    });
  }
  if (marketOpen && current.newsTickersQueried > 0 && current.storiesFetched === 0) {
    findings.push({
      metric: "news", severity: "CRITICAL",
      detail: `Queried ${current.newsTickersQueried} tickers during market hours and received no stories at all — the news pipeline is not delivering.`,
    });
  }
  // Reading headlines with no article text is how Atlas ended up judging
  // stories on a single line. Worth knowing, not worth halting for.
  if (current.storiesFetched >= 5) {
    const bodyRate = current.storiesWithBody / current.storiesFetched;
    if (bodyRate < 0.5) {
      findings.push({
        metric: "article text", severity: "WARNING",
        detail: `Only ${Math.round(bodyRate * 100)}% of stories carry article text — the rest are being judged on the headline alone.`,
      });
    }
  }

  // Relative collapse against Atlas's own recent normal.
  if (history.length >= MIN_HISTORY) {
    const checks: [keyof ScanYield, string][] = [
      ["storiesFetched", "story volume"],
      ["quotesUsable", "usable quotes"],
      ["candidatesScored", "candidates scored"],
    ];
    for (const [key, label] of checks) {
      const baseline = median(history.map((scan) => scan[key]));
      if (baseline === null || baseline < 3) continue;
      const value = current[key];
      if (value < baseline * COLLAPSE_RATIO) {
        findings.push({
          metric: label, severity: "WARNING",
          detail: `${label} dropped to ${value} against a recent normal of ${baseline} — something upstream changed.`,
        });
      }
    }
  }

  const blindToMarket = findings.some((finding) => finding.severity === "CRITICAL");
  return { sufficient: findings.length === 0, findings, blindToMarket };
}
