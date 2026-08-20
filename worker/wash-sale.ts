import { getMarketClock } from "./market-hours.ts";

// Loss positions closed in the user's Robinhood account on 2026-08-14.
// These are an external compliance guardrail, not simulated evidence. Atlas may
// continue observing them, but it cannot open a paper or future live position
// before the safe re-entry date. Winners are intentionally not included.
export const WASH_SALE_BLOCKS: Record<string, string> = {
  PSQ: "2026-09-14", SSG: "2026-09-14", MUD: "2026-09-14", NVDD: "2026-09-14",
  TLRY: "2026-09-14", GME: "2026-09-14", AMC: "2026-09-14", LCID: "2026-09-14",
  RUN: "2026-09-14", PLUG: "2026-09-14", AGIG: "2026-09-14", WKHS: "2026-09-14",
  ACB: "2026-09-14", CHPT: "2026-09-14", CGC: "2026-09-14", DQ: "2026-09-14",
};

// The safe dates above are calendar dates in the market's own timezone, so the
// comparison has to be made there too. Reading the UTC date instead released
// the block at 20:00 ET the evening before — still the prior trading day in New
// York, and still inside the wash-sale window.
export function washSaleBlockedUntil(ticker: string, now: Date): string | null {
  const safeDate = WASH_SALE_BLOCKS[ticker];
  if (!safeDate) return null;
  return getMarketClock(now).tradingDay < safeDate ? safeDate : null;
}
