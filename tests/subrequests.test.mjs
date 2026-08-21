import assert from "node:assert/strict";
import test from "node:test";
import {
  SUBREQUEST_LIMIT, SUBREQUEST_RESERVE, canAfford, countSubrequest,
  resetSubrequests, subrequestReport, subrequestsRemaining, subrequestsUsed,
} from "../worker/subrequests.ts";
import { getRecentSecFilings } from "../worker/sec-edgar.ts";

// A Worker invocation is capped at fifty outbound requests. Past the cap every
// further fetch fails, and because each caller swallows its own errors the scan
// reports success having silently skipped whatever came last. The cap used to
// be respected by arithmetic in a comment; this counts.

test("the counter tracks usage by source and reports what is left", () => {
  resetSubrequests();
  assert.equal(subrequestsUsed(), 0);

  countSubrequest("query1.finance.yahoo.com");
  countSubrequest("query1.finance.yahoo.com");
  countSubrequest("sec.gov");

  assert.equal(subrequestsUsed(), 3);
  assert.deepEqual(subrequestReport().bySource, { "query1.finance.yahoo.com": 2, "sec.gov": 1 });
  assert.equal(subrequestsRemaining(), SUBREQUEST_LIMIT - SUBREQUEST_RESERVE - 3);
});

test("the budget reserves headroom rather than running to the exact limit", () => {
  // A scan that finishes on the last permitted request has no room for a
  // redirect or a retry, either of which counts again.
  resetSubrequests();
  for (let i = 0; i < SUBREQUEST_LIMIT - SUBREQUEST_RESERVE; i++) countSubrequest("x");

  assert.equal(canAfford(1), false, "the reserve is not spendable");
  assert.equal(subrequestReport().overBudget, false, "but sitting on the reserve is not yet over budget");

  countSubrequest("x");
  assert.equal(subrequestReport().overBudget, true);
  assert.ok(subrequestReport().total < SUBREQUEST_LIMIT, "flagged before the runtime starts failing requests");
});

test("the SEC walk stops cleanly instead of being cut off mid-sequence", async () => {
  // Fetches: one CIK map, then one per ticker. With only a few requests left it
  // must stop at a ticker boundary so the filings it did gather are complete.
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = String(url).includes("company_tickers")
      ? { 0: { cik_str: 1, ticker: "AAPL", title: "Apple" }, 1: { cik_str: 2, ticker: "MSFT", title: "Microsoft" } }
      : { cik: "1", filings: { recent: {} } };
    return new Response(JSON.stringify(body), { status: 200 });
  };

  try {
    resetSubrequests();
    // Spend the budget down to room for the map plus one ticker.
    while (subrequestsRemaining() > 2) countSubrequest("spent");

    await getRecentSecFilings("atlas test@example.com", ["AAPL", "MSFT"], new Date("2026-01-01T00:00:00Z"));

    assert.equal(calls.length, 2, "the CIK map and exactly one ticker");
    assert.match(calls[0], /company_tickers/);
    assert.match(calls[1], /submissions/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the SEC walk does not start at all when it cannot finish a single ticker", async () => {
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return new Response("{}", { status: 200 }); };

  try {
    resetSubrequests();
    while (subrequestsRemaining() > 1) countSubrequest("spent");
    const filings = await getRecentSecFilings("atlas test@example.com", ["AAPL"], new Date("2026-01-01T00:00:00Z"));

    assert.deepEqual(filings, []);
    assert.equal(called, false, "spending the CIK map with no budget for a submission buys nothing");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an empty ticker list costs nothing", async () => {
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return new Response("{}", { status: 200 }); };

  try {
    resetSubrequests();
    assert.deepEqual(await getRecentSecFilings("atlas test@example.com", [], new Date()), []);
    assert.equal(called, false);
    assert.equal(subrequestsUsed(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a full scan's request plan fits inside the cap", () => {
  // The arithmetic that used to live in a comment, made executable. If a change
  // pushes the plan past the cap, this fails here rather than silently dropping
  // whichever feed happens to run last in production.
  const UNIVERSE = 20;
  const NEWS_ROTATION = Math.ceil(UNIVERSE / 2);

  const plan = {
    "nasdaq halts": 1,
    "federal reserve": 1,
    // One batched exchange-rates call, not one request per asset.
    coinbase: 1,
    "yahoo index snapshots": 3,
    "press-release wires": 2,
    "yahoo universe quotes": UNIVERSE,
    "yahoo news": NEWS_ROTATION,
    // Scoped to tickers that actually have a story: the CIK map plus a handful.
    "sec edgar": 1 + 5,
    "finnhub crypto news": 1,
  };

  const usable = SUBREQUEST_LIMIT - SUBREQUEST_RESERVE;
  const total = Object.values(plan).reduce((sum, count) => sum + count, 0);
  assert.ok(total <= usable,
    `the scan plans ${total} subrequests against a usable budget of ${usable}`);

  // Each saving that bought the headroom, asserted so none can regress
  // unnoticed. Every one of these alone would put the scan back over.
  assert.ok(total + 3 > usable, "re-fetching the index snapshots would break the budget");
  assert.ok(total + 3 > usable, "un-batching the Coinbase calls would break the budget");
  assert.ok(total + (UNIVERSE - 5) > SUBREQUEST_LIMIT,
    "asking EDGAR about every ticker would exceed the hard cap on its own");

  // The two liveness-only probes are what the remaining slack is for.
  assert.ok(total + 2 <= SUBREQUEST_LIMIT, "a probe scan still fits under the hard cap");
});
