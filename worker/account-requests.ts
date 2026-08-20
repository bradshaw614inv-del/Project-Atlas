// Validation for the two things a user can change about the account: adding
// paper capital, and setting the per-trade risk budget. Both write to the
// account the sizing math reads from, so the bounds here are the only thing
// between a typo and a position sized from a nonsense number.
//
// Separated from the route so it can be tested without a D1 binding — and so
// the route rejects bad input before acquiring one.

export type AccountRequest =
  | { kind: "ADD_FUNDS"; amount: number }
  | { kind: "SET_RISK"; riskPerTradePct: number };

export type AccountRequestError = { error: string; status: number };

export const MAX_CONTRIBUTION = 10_000_000;
export const MAX_RISK_PER_TRADE_PCT = 5;

export function isAccountRequestError(result: AccountRequest | AccountRequestError): result is AccountRequestError {
  return "error" in result;
}

export function parseAccountRequest(
  body: { action?: string; amount?: number; maxOpenPositions?: number; riskPerTradePct?: number } | null | undefined,
): AccountRequest | AccountRequestError {
  if (body?.action === "ADD_FUNDS") {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_CONTRIBUTION) {
      return { error: `amount must be a positive number no greater than $${MAX_CONTRIBUTION.toLocaleString("en-US")}.`, status: 400 };
    }
    return { kind: "ADD_FUNDS", amount };
  }

  const riskPerTradePct = Number(body?.riskPerTradePct);
  if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > MAX_RISK_PER_TRADE_PCT) {
    return { error: `riskPerTradePct must be between 0 and ${MAX_RISK_PER_TRADE_PCT}.`, status: 400 };
  }
  return { kind: "SET_RISK", riskPerTradePct };
}
