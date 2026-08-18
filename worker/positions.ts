// Position sizing and stop management. These formulas mechanically implement the
// guardrails from the original spec: fixed 0.25% account risk per trade, a stop that
// only ever moves in the trader's favor, and staged profit protection instead of a
// single all-or-nothing exit. No discretionary override exists anywhere in this file —
// that's the point: remove the moments where fear or excitement would normally decide.

// Atlas uses five equal capital slots. The account can fill fewer than five when
// evidence is weak; an unused slot remains cash and never creates a forced trade.
export const DEFAULT_RISK_PER_TRADE_PCT = 0.25;
export const DEFAULT_MAX_OPEN_POSITIONS = 5;
export const STOP_DISTANCE_PCT = 1.5; // maximum initial stop distance
export const CASH_RESERVE_PCT = 0;
export const DAILY_LOSS_LIMIT_PCT = 1;
export const COOLDOWN_MINUTES = 30;
export const TRAILING_DISTANCE_PCT = 1.5;
export const STOCK_ROUND_TRIP_COST_BPS = 20;
export const CRYPTO_ROUND_TRIP_COST_BPS = 50;

export function executionPrice(observedPrice: number, side: "BUY" | "SELL", isCrypto: boolean) {
  const halfCost = (isCrypto ? CRYPTO_ROUND_TRIP_COST_BPS : STOCK_ROUND_TRIP_COST_BPS) / 2 / 10_000;
  return side === "BUY" ? observedPrice * (1 + halfCost) : observedPrice * (1 - halfCost);
}

// A stop must sit outside a security's ordinary noise or it is not a stop, it
// is a coin flip. Measured session range differs enormously by name — around
// 1.3% for BAC against 2.6% for TSLA — so a single fixed percentage is either
// too tight for the volatile names or needlessly wide for the calm ones.
// Atlas's own trade reviews showed the failure mode directly: a position
// stopped out at -1.35% and recovered minutes later, on a security whose
// ordinary session range is 1.68%.
export const ATR_STOP_MULTIPLIER = 1.2;
export const MIN_STOP_DISTANCE_PCT = 1.0;
export const MAX_STOP_DISTANCE_PCT = 3.0;

export function stopDistancePctFor(sessionAtrPct: number | null) {
  if (sessionAtrPct === null || !Number.isFinite(sessionAtrPct) || sessionAtrPct <= 0) return STOP_DISTANCE_PCT;
  return Math.min(MAX_STOP_DISTANCE_PCT, Math.max(MIN_STOP_DISTANCE_PCT, sessionAtrPct * ATR_STOP_MULTIPLIER));
}

export function computeEntryPlan(
  startingCapital: number, entryPrice: number, riskPerTradePct: number, maxOpenPositions: number,
  availableCash = startingCapital, sessionAtrPct: number | null = null,
) {
  const riskDollar = (startingCapital * riskPerTradePct) / 100;
  const slotCap = Math.min((startingCapital * (1 - CASH_RESERVE_PCT / 100)) / maxOpenPositions, Math.max(0, availableCash));

  // Volatility targeting: the stop is placed where this security's own range
  // says it belongs, and size is then set so that distance costs exactly the
  // fixed risk budget. A volatile name gets fewer shares and a wider stop; a
  // calm name gets more shares and a tighter one. Dollar risk is identical
  // either way, which is the whole point — risk is held constant, not size.
  const stopPct = stopDistancePctFor(sessionAtrPct);
  const stopDistance = entryPrice * (stopPct / 100);
  const sharesByRisk = stopDistance > 0 ? riskDollar / stopDistance : 0;
  const sharesBySlot = slotCap / entryPrice;
  // The slot cap still binds: volatility sizing may only ever reduce exposure
  // below an equal slot, never lever it up beyond one.
  const shares = Math.max(0, Math.min(sharesByRisk, sharesBySlot));

  return {
    shares,
    initialStopPrice: entryPrice - stopDistance,
    stopDistancePct: stopPct,
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
