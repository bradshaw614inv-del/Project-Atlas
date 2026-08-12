// Position sizing and stop management. These formulas mechanically implement the
// guardrails from the original spec: fixed 0.25% account risk per trade, a stop that
// only ever moves in the trader's favor, and staged profit protection instead of a
// single all-or-nothing exit. No discretionary override exists anywhere in this file —
// that's the point: remove the moments where fear or excitement would normally decide.

// Defaults only — maxOpenPositions and riskPerTradePct are user-adjustable and read
// from account_state at runtime. Everything else below is a fixed system rule.
export const DEFAULT_RISK_PER_TRADE_PCT = 0.25;
export const DEFAULT_MAX_OPEN_POSITIONS = 6;
export const STOP_DISTANCE_PCT = 1.5; // simplified fixed distance — no real intraday ATR on the free data tier
export const CASH_RESERVE_PCT = 70;
export const DAILY_LOSS_LIMIT_PCT = 1;
export const COOLDOWN_MINUTES = 30;
export const TRAILING_DISTANCE_PCT = 1.5;

export function computeEntryPlan(startingCapital: number, entryPrice: number, riskPerTradePct: number, maxOpenPositions: number) {
  const riskDollar = (startingCapital * riskPerTradePct) / 100;
  const stopDistance = entryPrice * (STOP_DISTANCE_PCT / 100);
  const riskBasedShares = riskDollar / stopDistance;
  const slotCap = (startingCapital * (1 - CASH_RESERVE_PCT / 100)) / maxOpenPositions;
  const cashBasedShares = slotCap / entryPrice;
  const shares = Math.max(0, Math.min(riskBasedShares, cashBasedShares));
  return {
    shares,
    initialStopPrice: entryPrice - stopDistance,
    riskDollar,
  };
}

export type StopEvent = { type: "STOP_MOVED" | "TRAILING_ACTIVATED"; detail: string };

export function manageStagedStop(input: {
  entryPrice: number;
  currentPrice: number;
  highWaterMark: number;
  stopPrice: number;
  trailingActivated: boolean;
}): { stopPrice: number; highWaterMark: number; trailingActivated: boolean; events: StopEvent[] } {
  const events: StopEvent[] = [];
  let stopPrice = input.stopPrice;
  let trailingActivated = input.trailingActivated;
  const highWaterMark = Math.max(input.highWaterMark, input.currentPrice);

  const raiseStop = (candidate: number, event: StopEvent) => {
    if (candidate > stopPrice) { stopPrice = candidate; events.push(event); }
  };

  if (input.currentPrice >= input.entryPrice * 1.01) {
    raiseStop(input.entryPrice, { type: "STOP_MOVED", detail: "Breakeven stage (+1%): stop moved to entry price." });
  }
  if (input.currentPrice >= input.entryPrice * 1.02) {
    raiseStop(input.entryPrice * 1.005, { type: "STOP_MOVED", detail: "Profit-lock stage (+2%): stop moved to entry +0.5%." });
  }
  if (input.currentPrice >= input.entryPrice * 1.03) {
    trailingActivated = true;
    const trailStop = highWaterMark * (1 - TRAILING_DISTANCE_PCT / 100);
    raiseStop(trailStop, { type: "TRAILING_ACTIVATED", detail: `Trailing stage (+3%): stop trails ${TRAILING_DISTANCE_PCT}% below the high of $${highWaterMark.toFixed(2)}.` });
  }

  return { stopPrice, highWaterMark, trailingActivated, events };
}
