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

export async function getCompanyNews(apiKey: string, symbol: string, from: string, to: string): Promise<FinnhubNewsItem[]> {
  return finnhubGet<FinnhubNewsItem[]>(apiKey, `/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`);
}
