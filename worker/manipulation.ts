// Pump-and-dump and manipulation defence.
//
// This module never predicts manipulation. It recognises the observable
// signature that regulators and exchanges themselves react to, and refuses to
// buy into it. Every input is a real observed fact: an exchange halt with its
// published reason code, a measured volume ratio, a measured price move, and
// whether independent outlets corroborate the story.
//
// The classic pump signature is a violent price move on volume far above
// normal, carried by a single untraceable source, in a security the exchange
// has recently had to pause. Any one of those alone is ordinary; together they
// are the pattern. Atlas treats the combination as disqualifying rather than
// scoring it, because by the time a pump is obvious the dump is what remains.

export type HaltRecord = { symbol: string; reasonCode: string; haltedAt: string; resumedAt: string | null };

// Exchange reason codes that indicate disorder rather than routine news.
// LUDP is the limit up/limit down circuit breaker: price moved so violently
// the exchange stopped it. T12 and H11 mean the exchange or regulator wanted
// answers before trading continued.
export const DISORDERLY_HALT_CODES = new Set(["LUDP", "T12", "H11", "H10", "D"]);

// A security the exchange had to pause stays elevated-risk after it resumes —
// chasing the re-open is precisely the behaviour a pump relies on.
const HALT_SHADOW_HOURS = 24;

export type ManipulationInput = {
  ticker: string;
  relativeVolume: number | null;
  priceChangePct: number | null;
  independentSourceCount: number;
  traceableSource: boolean;
  halts: HaltRecord[];
  now: Date;
};

export type ManipulationVerdict = {
  blocked: boolean;
  riskScore: number; // 0-100, evidence weight only — never a trade signal
  reasons: string[];
};

export function assessManipulationRisk(input: ManipulationInput): ManipulationVerdict {
  const reasons: string[] = [];
  let risk = 0;

  // 1. Currently halted for a disorderly reason — hard block regardless of anything else.
  const active = input.halts.find((halt) => halt.symbol === input.ticker.toUpperCase() && !halt.resumedAt);
  if (active) {
    return {
      blocked: true, riskScore: 100,
      reasons: [`${input.ticker} is halted right now (${active.reasonCode}); no entry while the exchange has it stopped.`],
    };
  }

  // 2. Recently halted for disorder. The halt lifting is not an all-clear.
  const recentDisorder = input.halts.find((halt) =>
    halt.symbol === input.ticker.toUpperCase()
    && DISORDERLY_HALT_CODES.has(halt.reasonCode.toUpperCase())
    && (input.now.getTime() - Date.parse(halt.haltedAt)) / 3_600_000 <= HALT_SHADOW_HOURS);
  if (recentDisorder) {
    risk += 45;
    reasons.push(`Exchange paused ${input.ticker} within the last ${HALT_SHADOW_HOURS}h (${recentDisorder.reasonCode}) — buying the re-open is the pump's exit.`);
  }

  // 3. Volume far beyond normal. Real catalysts move volume; pumps move it further.
  const relVol = input.relativeVolume;
  if (relVol !== null) {
    if (relVol >= 10) { risk += 40; reasons.push(`Volume is ${relVol.toFixed(1)}x normal — a crowd this far outside the usual range is not ordinary interest.`); }
    else if (relVol >= 5) { risk += 25; reasons.push(`Volume is ${relVol.toFixed(1)}x normal.`); }
    else if (relVol >= 3) { risk += 12; reasons.push(`Volume is ${relVol.toFixed(1)}x normal.`); }
  }

  // 4. Violent price move. Combined with volume this is the pump itself.
  const move = input.priceChangePct;
  if (move !== null && move >= 15) { risk += 30; reasons.push(`Up ${move.toFixed(1)}% since first observation — a move this size without settling is the part that reverses.`); }
  else if (move !== null && move >= 8) { risk += 15; reasons.push(`Up ${move.toFixed(1)}% since first observation.`); }

  // 5. Nobody independent is carrying the story. Pumps are single-source by design.
  if (!input.traceableSource) { risk += 20; reasons.push("No traceable source URL for the claim driving this move."); }
  else if (input.independentSourceCount < 2) { risk += 10; reasons.push("Only one outlet carries this story — no independent corroboration."); }

  // The block is deliberately the *combination*: a big move on huge volume that
  // no independent outlet can confirm. Any single leg is normal market life.
  const violentAndCrowded = (relVol ?? 0) >= 5 && (move ?? 0) >= 8;
  const uncorroborated = !input.traceableSource || input.independentSourceCount < 2;
  const blocked = risk >= 70 || (violentAndCrowded && uncorroborated) || !!recentDisorder && (relVol ?? 0) >= 3;

  return { blocked, riskScore: Math.min(100, risk), reasons };
}

// Nasdaq publishes reason codes in its halt feed; Atlas previously read only
// the symbol and discarded why. The reason is the part that distinguishes a
// routine news pause from the exchange stepping in on disorderly trading.
function nextDay(isoDate: string): string {
  const next = new Date(`${isoDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function parseHaltRecords(xml: string): HaltRecord[] {
  const records: HaltRecord[] = [];
  for (const block of xml.split(/<item[\s>]/i).slice(1)) {
    const field = (tag: string) => {
      const match = block.match(new RegExp(`<ndaq:${tag}>([\\s\\S]*?)</ndaq:${tag}>`, "i"));
      return match ? match[1].trim() : "";
    };
    const symbol = field("IssueSymbol").toUpperCase();
    if (!symbol) continue;
    const haltDate = field("HaltDate") || new Date().toISOString().slice(0, 10);
    const haltTime = field("HaltTime") || "00:00:00";
    const resumed = field("ResumptionTradeTime");
    const haltedAt = `${haltDate}T${haltTime.slice(0, 8)}Z`;
    // The feed publishes a resumption time without a date, so it has to borrow
    // the halt's. A resumption clock-time earlier than the halt's means the
    // session rolled past midnight; dating it from the halt day would place the
    // resumption before the halt and make the pause look negative-length.
    const resumedAt = resumed
      ? `${resumed.slice(0, 8) < haltTime.slice(0, 8) ? nextDay(haltDate) : haltDate}T${resumed.slice(0, 8)}Z`
      : null;
    records.push({
      symbol,
      reasonCode: field("ReasonCode") || "UNKNOWN",
      haltedAt,
      resumedAt,
    });
  }
  return records;
}
