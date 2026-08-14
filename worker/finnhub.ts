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

export type FinnhubCandles = {
  c: number[];
  h: number[];
  l: number[];
  o: number[];
  t: number[];
  v: number[];
  s: "ok" | "no_data";
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

export async function getCompanyNews(apiKey: string, symbol: string, from: string, to: string): Promise<FinnhubNewsItem[]> {
  return finnhubGet<FinnhubNewsItem[]>(apiKey, `/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`);
}

export async function getCryptoNews(apiKey: string): Promise<FinnhubNewsItem[]> {
  return finnhubGet<FinnhubNewsItem[]>(apiKey, "/news?category=crypto");
}

export async function getCandles(apiKey: string, symbol: string, from: number, to: number, resolution = "5"): Promise<FinnhubCandles | null> {
  const data = await finnhubGet<FinnhubCandles>(apiKey, `/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}`);
  return data.s === "ok" && data.c?.length ? data : null;
}

export function candleVwap(candles: FinnhubCandles | null): number | null {
  if (!candles) return null;
  let valueVolume = 0;
  let totalVolume = 0;
  for (let i = 0; i < candles.c.length; i++) {
    const volume = Number(candles.v[i]);
    const high = Number(candles.h[i]);
    const low = Number(candles.l[i]);
    const close = Number(candles.c[i]);
    if (![volume, high, low, close].every(Number.isFinite) || volume <= 0) continue;
    valueVolume += ((high + low + close) / 3) * volume;
    totalVolume += volume;
  }
  return totalVolume > 0 ? valueVolume / totalVolume : null;
}
