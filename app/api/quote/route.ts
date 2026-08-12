const TICKER_PATTERN = /^[A-Z.\-]{1,10}$/;

export async function GET(request: Request) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Live prices are not configured. Add FINNHUB_API_KEY to .env.local (local) or the site's environment variables (hosted), then restart." },
      { status: 501 }
    );
  }

  const symbol = new URL(request.url).searchParams.get("symbol")?.trim().toUpperCase() ?? "";
  if (!TICKER_PATTERN.test(symbol)) {
    return Response.json({ error: "Invalid ticker symbol." }, { status: 400 });
  }

  const finnhubUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
  const response = await fetch(finnhubUrl);
  if (!response.ok) {
    return Response.json({ error: `Finnhub request failed (${response.status}).` }, { status: 502 });
  }

  const data = (await response.json()) as { c?: number; d?: number; dp?: number; h?: number; l?: number; o?: number; pc?: number; t?: number };
  if (!data.c) {
    return Response.json({ error: `No quote available for ${symbol}.` }, { status: 404 });
  }

  return Response.json({
    symbol,
    price: data.c,
    change: data.d ?? null,
    percentChange: data.dp ?? null,
    high: data.h ?? null,
    low: data.l ?? null,
    open: data.o ?? null,
    previousClose: data.pc ?? null,
    quotedAt: data.t ? new Date(data.t * 1000).toISOString() : new Date().toISOString(),
  });
}
