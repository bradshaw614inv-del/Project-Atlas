import assert from "node:assert/strict";
import test from "node:test";
import { applyRealizedPnl, decideExit, evaluateEntryGuards, preflightEntryGuards } from "../worker/decisions.ts";
import { COOLDOWN_MINUTES } from "../worker/positions.ts";

// These three functions decide whether Atlas opens a position, whether it
// closes one, and whether the account is allowed to keep trading. They used to
// be private helpers inside engine.ts, each holding a live database handle,
// which is why 930 lines of engine had no coverage: there was nothing to call.

const account = {
  startingCapital: 10_000,
  realizedPnl: 0,
  maxOpenPositions: 5,
  riskPerTradePct: 0.25,
  dailyLossShutdown: 0,
};

// A candidate with nothing standing in its way.
const clean = {
  ticker: "AAPL",
  storyId: 1,
  priceAtScan: 100,
  now: new Date("2026-06-10T15:00:00Z"),
  account,
  criticalDown: [],
  withinEntryWindow: true,
  isShadow: false,
  openPositions: [],
  todaysPositions: [],
  lastClosedExitAt: null,
  sessionAtrPct: null,
};

test("a candidate with nothing in its way gets a sized plan", () => {
  const decision = evaluateEntryGuards(clean);
  assert.equal(decision.allowed, true);
  assert.ok(decision.entryPrice > 100, "the entry fills worse than the observed price");
  assert.ok(decision.plan.shares > 0);
  assert.equal(decision.plan.riskDollar, 25, "0.25% of a $10,000 account");
  assert.ok(decision.plan.initialStopPrice < decision.entryPrice);
});

test("every guard blocks on its own and says why", () => {
  const blocked = [
    ["a critical feed is down", { criticalDown: ["Yahoo quotes"] }, /Yahoo quotes unreachable/],
    ["outside the entry window", { withinEntryWindow: false }, /entry window/],
    ["the circuit breaker has tripped", { account: { ...account, dailyLossShutdown: 1 } }, /circuit breaker/],
    ["every slot is full", {
      openPositions: [
        { ticker: "A", storyId: 10 }, { ticker: "B", storyId: 11 }, { ticker: "C", storyId: 12 },
        { ticker: "D", storyId: 13 }, { ticker: "E", storyId: 14 },
      ],
    }, /max open positions reached \(5\/5\)/],
    ["this ticker is already held", { openPositions: [{ ticker: "AAPL", storyId: 99 }] }, /already open/],
    ["another ticker holds this story's slot", { openPositions: [{ ticker: "MSFT", storyId: 1 }] }, /MSFT already holds the slot/],
    ["it is still in its cooldown", { lastClosedExitAt: "2026-06-10T14:45:00Z" }, /30-minute stop-out cooldown/],
    ["today's cash is spent", { todaysPositions: [{ entryPrice: 100, shares: 100 }] }, /no settled paper cash/],
  ];

  for (const [description, override, expected] of blocked) {
    const decision = evaluateEntryGuards({ ...clean, ...override });
    assert.equal(decision.allowed, false, `${description} must block the entry`);
    assert.match(decision.reason, expected, description);
    assert.match(decision.reason, /^Qualifies but not taken: /, "the candidate is recorded, not discarded");
  }
});

test("a candidate that trips several guards reports the first one", () => {
  // The reason is what the dashboard shows, so guard order is user-visible.
  // Everything is wrong with this candidate at once; it must report the
  // outermost cause rather than whichever check happens to run last.
  const everything = evaluateEntryGuards({
    ...clean,
    criticalDown: ["Yahoo quotes"],
    withinEntryWindow: false,
    account: { ...account, dailyLossShutdown: 1 },
    openPositions: [{ ticker: "AAPL", storyId: 1 }],
  });
  assert.match(everything.reason, /Yahoo quotes unreachable/);

  // Remove the outermost and the next one surfaces, in order.
  const noFeeds = evaluateEntryGuards({
    ...clean, withinEntryWindow: false,
    account: { ...account, dailyLossShutdown: 1 },
    openPositions: [{ ticker: "AAPL", storyId: 1 }],
  });
  assert.match(noFeeds.reason, /entry window/);

  const inWindow = evaluateEntryGuards({
    ...clean, account: { ...account, dailyLossShutdown: 1 },
    openPositions: [{ ticker: "AAPL", storyId: 1 }],
  });
  assert.match(inWindow.reason, /circuit breaker/);
});

test("the preflight guards agree with the full evaluation", () => {
  // The engine runs these three before spending database reads. If the two ever
  // disagreed, a candidate would be rejected for one reason and logged with
  // another.
  const cases = [
    { criticalDown: ["Yahoo quotes"] },
    { withinEntryWindow: false },
    { account: { ...account, dailyLossShutdown: 1 } },
  ];
  for (const override of cases) {
    const input = { ...clean, ...override };
    assert.equal(preflightEntryGuards(input).reason, evaluateEntryGuards(input).reason);
  }
  assert.equal(preflightEntryGuards(clean), null, "a clean candidate passes preflight");
});

test("the cooldown expires exactly on the minute it should", () => {
  const closedAt = (minutesAgo) =>
    new Date(clean.now.getTime() - minutesAgo * 60_000).toISOString();

  assert.equal(evaluateEntryGuards({ ...clean, lastClosedExitAt: closedAt(COOLDOWN_MINUTES - 1) }).allowed, false);
  assert.equal(evaluateEntryGuards({ ...clean, lastClosedExitAt: closedAt(COOLDOWN_MINUTES) }).allowed, true,
    "the cooldown is over at exactly 30 minutes, not 31");
  assert.equal(evaluateEntryGuards({ ...clean, lastClosedExitAt: closedAt(120) }).allowed, true);
});

test("shadow positions ignore the slot cap but not the duplication rules", () => {
  // During SIT_OUT weather Atlas records what it would have done. Those cost no
  // capital, so the five-slot limit does not apply — but recording the same
  // ticker or the same story twice would corrupt the record it is keeping.
  const fullBook = [
    { ticker: "A", storyId: 10 }, { ticker: "B", storyId: 11 }, { ticker: "C", storyId: 12 },
    { ticker: "D", storyId: 13 }, { ticker: "E", storyId: 14 },
  ];

  assert.equal(evaluateEntryGuards({ ...clean, isShadow: true, openPositions: fullBook }).allowed, true);
  assert.equal(evaluateEntryGuards({ ...clean, isShadow: false, openPositions: fullBook }).allowed, false);

  const duplicateTicker = evaluateEntryGuards({ ...clean, isShadow: true, openPositions: [{ ticker: "AAPL", storyId: 7 }] });
  assert.equal(duplicateTicker.allowed, false);
  assert.match(duplicateTicker.reason, /already open/);

  const duplicateStory = evaluateEntryGuards({ ...clean, isShadow: true, openPositions: [{ ticker: "MSFT", storyId: 1 }] });
  assert.equal(duplicateStory.allowed, false);
});

test("a position with a null story never blocks another candidate", () => {
  // storyId is nullable. A naive equality check treats two nulls as the same
  // story and lets one untagged position block every later candidate.
  const untagged = evaluateEntryGuards({ ...clean, storyId: 1, openPositions: [{ ticker: "MSFT", storyId: null }] });
  assert.equal(untagged.allowed, true);
});

test("the cash-backed budget shrinks as the day's purchases accumulate", () => {
  // Sale proceeds are not recycled, so each entry permanently reduces what is
  // left to spend today.
  const spent = (gross) => evaluateEntryGuards({ ...clean, todaysPositions: [{ entryPrice: gross, shares: 1 }] });

  const early = spent(1_000);
  const late = spent(9_500);
  assert.equal(early.allowed, true);
  assert.equal(late.allowed, true);
  assert.ok(late.plan.shares < early.plan.shares, "less cash left must mean a smaller position");

  assert.equal(spent(10_000).allowed, false, "no cash left means no entry");
});

// ---------------------------------------------------------------------------

const position = {
  ticker: "AAPL", entryPrice: 100, shares: 10,
  highWaterMark: 100, stopPrice: 98.5, trailingActivated: false,
};

test("a position in profit stays open and carries its raised stop", () => {
  const decision = decideExit(position, 101, false);
  assert.equal(decision.close, false);
  assert.equal(decision.stopPrice, 100, "the breakeven stage still applies on a scan that does not exit");
  assert.equal(decision.events.length, 1);
});

test("touching the stop closes at the stop, not at the last observed price", () => {
  // Price gapped to 98 but the stop was at 98.5. Filling at 98 would book a
  // loss the stop was there to prevent; filling at 98.5 less costs is honest.
  const decision = decideExit(position, 98, false);
  assert.equal(decision.close, true);
  assert.equal(decision.exitReason, "STOP_LOSS");
  assert.ok(decision.exitPrice < 98.5, "costs are applied against us on the way out");
  assert.ok(decision.exitPrice > 98, "but the fill is the stop price, not the gapped price");
  assert.ok(Math.abs(decision.realizedPnl - (decision.exitPrice - 100) * 10) < 1e-9);
  assert.ok(decision.returnPct < 0);
});

test("the bell closes a position that never hit its stop", () => {
  const decision = decideExit(position, 100.5, true);
  assert.equal(decision.close, true);
  assert.equal(decision.exitReason, "MARKET_CLOSE");
  assert.ok(decision.exitPrice < 100.5, "sold into the close with costs applied");
});

test("a stop that was reached outranks the closing bell", () => {
  // Both conditions are true in the same scan. Reporting MARKET_CLOSE here
  // would file a stop-out as an orderly end-of-day exit and quietly corrupt
  // every exit-reason statistic the trade reviews are built on.
  const decision = decideExit(position, 98, true);
  assert.equal(decision.close, true);
  assert.equal(decision.exitReason, "STOP_LOSS");
});

test("a trailing stop reports as a trailing stop, not a stop-loss", () => {
  const trailing = { ...position, highWaterMark: 106, stopPrice: 104, trailingActivated: true };
  const decision = decideExit(trailing, 103, false);

  assert.equal(decision.close, true);
  assert.equal(decision.exitReason, "TRAILING_STOP");
  assert.ok(decision.realizedPnl > 0, "a trailing stop exits in profit");
});

test("crypto exits pay the wider crypto spread", () => {
  const stock = decideExit(position, 98, false);
  const crypto = decideExit({ ...position, ticker: "BTC" }, 98, false);

  assert.equal(crypto.exitReason, "STOP_LOSS");
  assert.ok(crypto.exitPrice < stock.exitPrice, "50bps round-trip costs more than 20bps");
  assert.ok(crypto.realizedPnl < stock.realizedPnl);
});

// ---------------------------------------------------------------------------

const ledger = { startingCapital: 10_000, realizedPnl: 0, dailyRealizedPnl: 0, consecutiveLosses: 0 };

test("a winning trade books through and clears the losing streak", () => {
  const afterWin = applyRealizedPnl({ ...ledger, consecutiveLosses: 1 }, 50);
  assert.equal(afterWin.realizedPnl, 50);
  assert.equal(afterWin.dailyRealizedPnl, 50);
  assert.equal(afterWin.consecutiveLosses, 0, "one win resets the streak");
  assert.equal(afterWin.dailyLossShutdown, 0);
});

test("two consecutive losses trip the breaker regardless of size", () => {
  // Size deliberately does not matter here: two losses in a row is evidence the
  // read on the day is wrong, not that the account is in trouble.
  const first = applyRealizedPnl(ledger, -5);
  assert.equal(first.consecutiveLosses, 1);
  assert.equal(first.dailyLossShutdown, 0, "one small loss is not a shutdown");

  const second = applyRealizedPnl({ ...ledger, realizedPnl: -5, dailyRealizedPnl: -5, consecutiveLosses: 1 }, -5);
  assert.equal(second.consecutiveLosses, 2);
  assert.equal(second.dailyLossShutdown, 1);
  assert.equal(second.dailyRealizedPnl, -10, "and $10 down on a $10,000 account, nowhere near the drawdown limit");
});

test("the drawdown limit trips at exactly one percent", () => {
  assert.equal(applyRealizedPnl(ledger, -99.99).dailyLossShutdown, 0);
  assert.equal(applyRealizedPnl(ledger, -100).dailyLossShutdown, 1, "1% of $10,000 is the limit, inclusive");
  assert.equal(applyRealizedPnl(ledger, -250).dailyLossShutdown, 1);

  // The limit follows the account: a larger account gets a larger allowance.
  assert.equal(applyRealizedPnl({ ...ledger, startingCapital: 50_000 }, -100).dailyLossShutdown, 0);
});

test("a single large loss trips the breaker without needing a second", () => {
  const wipeout = applyRealizedPnl(ledger, -400);
  assert.equal(wipeout.consecutiveLosses, 1, "only one loss so far");
  assert.equal(wipeout.dailyLossShutdown, 1, "but the drawdown limit stops the day on its own");
});
