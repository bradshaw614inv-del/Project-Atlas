import assert from "node:assert/strict";
import test from "node:test";
import { GET as quoteRoute } from "../app/api/quote/route.ts";
import {
  MAX_CONTRIBUTION, MAX_RISK_PER_TRADE_PCT, isAccountRequestError, parseAccountRequest,
} from "../worker/account-requests.ts";

// The API surface had no coverage at all. These are the contracts the dashboard
// and the user act on: what a bad ticker returns, what happens when Yahoo is
// down, and the bounds on the two values that feed position sizing.

// --- /api/quote -------------------------------------------------------------

const quoteRequest = (symbol) => new Request(`https://atlas.test/api/quote?symbol=${symbol}`);

const chartResponse = (meta) => new Response(JSON.stringify({ chart: { result: [{ meta }] } }), {
  status: 200, headers: { "content-type": "application/json" },
});

function withFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return run(); } finally { globalThis.fetch = original; }
}

test("a quote reports the price and its change against the previous close", async () => {
  const calls = [];
  const response = await withFetch(async (url) => {
    calls.push(String(url));
    return chartResponse({ regularMarketPrice: 102.5, chartPreviousClose: 100, regularMarketTime: 1_780_000_000 });
  }, () => quoteRoute(quoteRequest("AAPL")));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.symbol, "AAPL");
  assert.equal(body.price, 102.5);
  assert.equal(body.previousClose, 100);
  assert.ok(Math.abs(body.change - 2.5) < 1e-9);
  assert.ok(Math.abs(body.percentChange - 2.5) < 1e-9);
  assert.equal(body.quotedAt, new Date(1_780_000_000 * 1000).toISOString());
  assert.match(calls[0], /chart\/AAPL\?/, "stock symbols are requested as-is");
});

test("crypto symbols are requested in Yahoo's pair form", async () => {
  const calls = [];
  await withFetch(async (url) => {
    calls.push(String(url));
    return chartResponse({ regularMarketPrice: 65000, chartPreviousClose: 64000 });
  }, () => quoteRoute(quoteRequest("BTC")));

  assert.match(calls[0], /chart\/BTC-USD\?/, "BTC alone is not a Yahoo symbol");
});

test("a symbol that is not a ticker is rejected before any request is made", async () => {
  const rejected = ["", "TOOLONGSYMBOL", "AA PL", "aapl'; DROP TABLE", "<script>", "%20"];

  for (const symbol of rejected) {
    let called = false;
    const response = await withFetch(async () => { called = true; return chartResponse({ regularMarketPrice: 1 }); },
      () => quoteRoute(quoteRequest(symbol)));

    assert.equal(response.status, 400, `${symbol || "(empty)"} must be rejected`);
    assert.match((await response.json()).error, /Invalid ticker symbol/);
    assert.equal(called, false, "an invalid symbol must never reach the upstream feed");
  }

  // Lower case is accepted and normalised rather than rejected.
  const normalised = await withFetch(async () => chartResponse({ regularMarketPrice: 10, chartPreviousClose: 9 }),
    () => quoteRoute(quoteRequest("aapl")));
  assert.equal((await normalised.json()).symbol, "AAPL");
});

test("an upstream failure is reported as a gateway error, not a missing quote", async () => {
  const response = await withFetch(async () => new Response("upstream is unwell", { status: 503 }),
    () => quoteRoute(quoteRequest("AAPL")));

  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /Quote request failed \(503\)/);
});

test("a symbol the feed cannot price returns 404 rather than an invented number", async () => {
  const unpriceable = [
    ["no price field", {}],
    ["a zero price", { regularMarketPrice: 0 }],
    ["a nonsense price", { regularMarketPrice: "unavailable" }],
  ];

  for (const [description, meta] of unpriceable) {
    const response = await withFetch(async () => chartResponse(meta), () => quoteRoute(quoteRequest("AAPL")));
    assert.equal(response.status, 404, description);
    assert.match((await response.json()).error, /No quote available for AAPL/);
  }
});

test("a missing previous close leaves change null rather than reporting no movement", async () => {
  const response = await withFetch(async () => chartResponse({ regularMarketPrice: 102.5 }),
    () => quoteRoute(quoteRequest("AAPL")));

  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.price, 102.5);
  assert.equal(body.change, null, "an unknown change must not read as flat");
  assert.equal(body.percentChange, null);
  assert.equal(body.previousClose, null);
  assert.ok(Date.parse(body.quotedAt) > 0, "a quote with no timestamp is stamped as now");
});

// --- /api/state account changes --------------------------------------------

test("a contribution must be a positive amount inside the ceiling", () => {
  const rejected = [
    ["zero", 0], ["negative", -100], ["not a number", "lots"],
    ["NaN", Number.NaN], ["infinite", Number.POSITIVE_INFINITY],
    ["over the ceiling", MAX_CONTRIBUTION + 1], ["missing", undefined],
  ];

  for (const [description, amount] of rejected) {
    const result = parseAccountRequest({ action: "ADD_FUNDS", amount });
    assert.ok(isAccountRequestError(result), `${description} must be rejected`);
    assert.equal(result.status, 400);
    assert.match(result.error, /amount must be a positive number/);
  }

  const accepted = parseAccountRequest({ action: "ADD_FUNDS", amount: 500 });
  assert.deepEqual(accepted, { kind: "ADD_FUNDS", amount: 500 });

  // The ceiling itself is allowed; only past it is refused.
  assert.deepEqual(parseAccountRequest({ action: "ADD_FUNDS", amount: MAX_CONTRIBUTION }),
    { kind: "ADD_FUNDS", amount: MAX_CONTRIBUTION });

  // A numeric string is coerced, matching what a form actually submits.
  assert.deepEqual(parseAccountRequest({ action: "ADD_FUNDS", amount: "250" }), { kind: "ADD_FUNDS", amount: 250 });
});

test("risk per trade is bounded, because position sizing reads it directly", () => {
  const rejected = [
    ["zero", 0], ["negative", -1], ["over the cap", MAX_RISK_PER_TRADE_PCT + 0.01],
    ["absurd", 100], ["not a number", "aggressive"], ["missing", undefined],
  ];

  for (const [description, riskPerTradePct] of rejected) {
    const result = parseAccountRequest({ riskPerTradePct });
    assert.ok(isAccountRequestError(result), `${description} must be rejected`);
    assert.equal(result.status, 400);
    assert.match(result.error, /riskPerTradePct must be between 0 and 5/);
  }

  assert.deepEqual(parseAccountRequest({ riskPerTradePct: 0.25 }), { kind: "SET_RISK", riskPerTradePct: 0.25 });
  assert.deepEqual(parseAccountRequest({ riskPerTradePct: MAX_RISK_PER_TRADE_PCT }),
    { kind: "SET_RISK", riskPerTradePct: MAX_RISK_PER_TRADE_PCT });
});

test("an empty or unrecognised request body is rejected, never treated as a default", () => {
  for (const body of [null, undefined, {}, { action: "SOMETHING_ELSE" }]) {
    const result = parseAccountRequest(body);
    assert.ok(isAccountRequestError(result), `${JSON.stringify(body)} must be rejected`);
    assert.equal(result.status, 400);
  }
});
