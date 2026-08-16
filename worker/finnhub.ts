export type FinnhubQuote = {
  c: number; // current price
  d: number | null; // change
  dp: number | null; // percent change
  h: number; o: number; l: number; pc: number;
  t: number; // unix seconds
};

export type FinnhubNewsItem = {
  category: string;
  datetime: number; // unix seconds
  headline: string;
  id: number;
  related: string;
  source: string;
  summary: string;
  url: string;
};

async function finnhubGet<T>(apiKey: string, path: string): Promise<T> {
  const res = await fetch(`https://finnhub.io/api/v1${path}${path.includes("?") ? "&" : "?"}token=${apiKey}`);
  if (!res.ok) throw new Error(`Finnhub ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

export async function getQuote(apiKey: string, symbol: string): Promise<FinnhubQuote | null> {
  const data = await finnhubGet<FinnhubQuote>(apiKey, `/quote?symbol=${encodeURIComponent(symbol)}`);
  if (!data.c) return null;
  return data;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The free tier enforces a per-minute quota plus a burst limit, and a scan
// needs ~25 quotes. Firing them in one Promise.all burst gets a chunk of them
// rate-limited and silently lost, which starves market weather and breadth of
// real data. Fetch in small chunks with a gap and retry each failure once
// after a pause — slower by ~2s per scan, but the data actually arrives.
export async function getQuotesThrottled(apiKey: string, symbols: string[], chunkSize = 6, gapMs = 350): Promise<Map<string, FinnhubQuote | null>> {
  const quotes = new Map<string, FinnhubQuote | null>();
  const unique = Array.from(new Set(symbols));
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const results = await Promise.all(chunk.map(async (symbol) => {
      try {
        return [symbol, await getQuote(apiKey, symbol)] as const;
      } catch {
        await sleep(700);
        try {
          return [symbol, await getQuote(apiKey, symbol)] as const;
        } catch {
          return [symbol, null] as const;
        }
      }
    }));
    for (const [symbol, quote] of results) quotes.set(symbol, quote);
    if (i + chunkSize < unique.length) await sleep(gapMs);
  }
  return quotes;
}

export async function getCompanyNews(apiKey: string, symbol: string, from: string, to: string): Promise<FinnhubNewsItem[]> {
  return finnhubGet<FinnhubNewsItem[]>(apiKey, `/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`);
}

export async function getCryptoNews(apiKey: string): Promise<FinnhubNewsItem[]> {
  return finnhubGet<FinnhubNewsItem[]>(apiKey, "/news?category=crypto");
}

