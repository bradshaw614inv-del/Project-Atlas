import { isCryptoTicker } from "../../../worker/universe.ts";

const TICKER_PATTERN = /^[A-Z.\-]{1,10}$/;

// Live prices come from Yahoo for the same reason the engine's quotes do:
// Finnhub rate-limits by origin IP and Cloudflare Workers share egress IPs, so
// it returned roughly 4 of 20 requested quotes while Yahoo returned 20 of 20.
// Real observed last price and previous close only — nothing is estimated, and
// a symbol Yahoo cannot price returns 404 rather than a filled-in guess.
export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol")?.trim().toUpperCase() ?? "";
  if (!TICKER_PATTERN.test(symbol)) {
    return Response.json({ error: "Invalid ticker symbol." }, { status: 400 });
  }

  const yahooSymbol = isCryptoTicker(symbol) ? `${symbol}-USD` : symbol;
  const response = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1m&range=1d`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; AtlasPaperSim/1.0)" } },
  );
  if (!response.ok) {
    return Response.json({ error: `Quote request failed (${response.status}).` }, { status: 502 });
  }

  const data = (await response.json()) as {
    chart?: { result?: { meta?: { regularMarketPrice?: number; chartPreviousClose?: number; regularMarketTime?: number } }[] };
  };
  const meta = data.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return Response.json({ error: `No quote available for ${symbol}.` }, { status: 404 });
  }
  const previousClose = Number(meta?.chartPreviousClose);
  const hasPrevClose = Number.isFinite(previousClose) && previousClose > 0;

  return Response.json({
    symbol,
    price,
    change: hasPrevClose ? price - previousClose : null,
    percentChange: hasPrevClose ? ((price - previousClose) / previousClose) * 100 : null,
    previousClose: hasPrevClose ? previousClose : null,
    quotedAt: meta?.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
  });
}
