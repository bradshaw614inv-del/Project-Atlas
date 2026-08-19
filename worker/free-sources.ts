import { ROBINHOOD_CRYPTO_UNIVERSE, TICKER_UNIVERSE } from "./universe";
import { parseHaltRecords, type HaltRecord } from "./manipulation";
import { readTechnicals, type Bar, type TechnicalRead } from "./technicals";

// Real observed values from Yahoo's public chart API: last price, previous
// close, and a session VWAP computed from its real 5-minute OHLCV bars.
// Nothing here is estimated — if a field is missing it stays null.
export type IndexSnapshot = {
  price: number; prevClose: number | null; changePct: number | null; vwap: number | null;
  // Today's volume so far divided by the typical volume by this time of day
  // over the prior sessions. 1.0 is a normal day; 3.0 means three times the
  // usual crowd. Null when there is not enough real history to compare against.
  relativeVolume: number | null;
  // Average true range over the session, as a percent of price. This is what
  // institutional desks size stops from: a stop must sit outside a security's
  // ordinary noise, and ordinary noise differs enormously between names.
  atrPct: number | null;
  // Chart read from today's real bars — buyers-in-control evidence, so a story
  // can be checked against what price is actually doing before acting on it.
  technicals: TechnicalRead;
};

export type PressRelease = { source: string; title: string; url: string; publishedAt: string; tickers: string[] };

export type FreeSourceSnapshot = {
  haltedSymbols: Set<string>;
  halts: HaltRecord[];
  macroEventRisk: boolean;
  macroEvidence: string[];
  cryptoPrices: Map<string, number>;
  indexes: Map<string, IndexSnapshot>;
  pressReleases: PressRelease[];
  health: Record<string, "LIVE" | "UNAVAILABLE" | "DISABLED">;
};

const text = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`${new URL(url).hostname} ${response.status}`);
  return response.text();
};
const json = async <T>(url: string, init?: RequestInit) => JSON.parse(await text(url, init)) as T;

function xmlValues(xml: string, tag: string) {
  return Array.from(xml.matchAll(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "gi")))
    .map((match) => match[1].replace(/<[^>]+>/g, "").trim());
}

async function nasdaqHalts() {
  const xml = await text("https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts");
  // Keep the full records: the reason code distinguishes a routine news pause
  // from the exchange stepping in on disorderly trading, and Atlas previously
  // discarded it. Symbols are still exposed as a set for the existing gate.
  const records = parseHaltRecords(xml);
  return { symbols: new Set(records.filter((r) => !r.resumedAt).map((r) => r.symbol)), records };
}

async function federalReserveRisk(now: Date) {
  const xml = await text("https://www.federalreserve.gov/feeds/press_all.xml");
  const titles = xmlValues(xml, "title");
  const dates = xmlValues(xml, "updated");
  return titles.filter((title, index) => {
    const ageHours = (now.getTime() - new Date(dates[index] ?? 0).getTime()) / 3_600_000;
    return ageHours >= 0 && ageHours <= 2 && /federal funds|monetary policy|fomc|emergency|financial stability/i.test(title);
  });
}

async function checkBls() {
  await json("https://api.bls.gov/publicAPI/v2/timeseries/data/CUSR0000SA0?latest=true");
}
async function checkOpenFda() {
  await json("https://api.fda.gov/drug/enforcement.json?limit=1");
}
async function coinbasePrices() {
  const prices = new Map<string, number>();
  await Promise.all(ROBINHOOD_CRYPTO_UNIVERSE.map(async ({ ticker }) => {
    const result = await json<{ data?: { amount?: string } }>(`https://api.coinbase.com/v2/prices/${ticker}-USD/spot`);
    const price = Number(result.data?.amount);
    if (Number.isFinite(price) && price > 0) prices.set(ticker, price);
  }));
  return prices;
}

type YahooChart = {
  chart?: { result?: { meta?: { regularMarketPrice?: number; chartPreviousClose?: number };
    timestamp?: number[];
    indicators?: { quote?: { high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] } }[] };
};

async function yahooIndexSnapshot(symbol: string): Promise<IndexSnapshot> {
  // Five days of 5-minute bars in a single request: today's session drives
  // price and VWAP, and the prior sessions provide the baseline for relative
  // volume. Same subrequest cost as one day.
  const data = await json<YahooChart>(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=5d`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; AtlasPaperSim/1.0)" } },
  );
  const result = data.chart?.result?.[0];
  const price = Number(result?.meta?.regularMarketPrice);
  const prevClose = Number(result?.meta?.chartPreviousClose);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`yahoo ${symbol}: no price`);
  const bars = result?.indicators?.quote?.[0];
  const stamps = result?.timestamp ?? [];

  // Group bars by calendar day in Eastern time, and track seconds-since-midnight
  // so today can be compared against the same point in prior sessions.
  const dayFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
  const sessions = new Map<string, { seconds: number; volume: number }[]>();
  let valueVolume = 0, totalVolume = 0;
  let latestDay = "";

  for (let i = 0; i < (bars?.close?.length ?? 0); i++) {
    const [high, low, close, volume] = [bars?.high?.[i], bars?.low?.[i], bars?.close?.[i], bars?.volume?.[i]].map(Number);
    const stamp = stamps[i];
    if (![high, low, close, volume].every(Number.isFinite) || volume <= 0 || !Number.isFinite(stamp)) continue;
    const at = new Date(stamp * 1000);
    const day = dayFormat.format(at);
    const [hh, mm] = timeFormat.format(at).split(":").map(Number);
    const seconds = hh * 3600 + mm * 60;
    if (day > latestDay) latestDay = day;
    const list = sessions.get(day) ?? [];
    list.push({ seconds, volume });
    sessions.set(day, list);
  }

  // VWAP uses today's session only.
  for (let i = 0; i < (bars?.close?.length ?? 0); i++) {
    const [high, low, close, volume] = [bars?.high?.[i], bars?.low?.[i], bars?.close?.[i], bars?.volume?.[i]].map(Number);
    const stamp = stamps[i];
    if (![high, low, close, volume].every(Number.isFinite) || volume <= 0 || !Number.isFinite(stamp)) continue;
    if (dayFormat.format(new Date(stamp * 1000)) !== latestDay) continue;
    valueVolume += ((high + low + close) / 3) * volume;
    totalVolume += volume;
  }

  const today = sessions.get(latestDay) ?? [];
  const cutoff = today.length ? Math.max(...today.map((bar) => bar.seconds)) : 0;
  const todayVolume = today.reduce((sum, bar) => sum + bar.volume, 0);
  const priorTotals = Array.from(sessions.entries())
    .filter(([day]) => day !== latestDay)
    .map(([, list]) => list.filter((bar) => bar.seconds <= cutoff).reduce((sum, bar) => sum + bar.volume, 0))
    .filter((total) => total > 0)
    .sort((a, b) => a - b);
  // Median of prior sessions, so one unusual day cannot set the baseline.
  const baseline = priorTotals.length ? priorTotals[Math.floor(priorTotals.length / 2)] : 0;

  // True range per 5-minute bar across everything available, expressed as a
  // percent of price so it is comparable across securities.
  const ranges: number[] = [];
  let previousClose: number | null = null;
  for (let i = 0; i < (bars?.close?.length ?? 0); i++) {
    const [high, low, close] = [bars?.high?.[i], bars?.low?.[i], bars?.close?.[i]].map(Number);
    if (![high, low, close].every(Number.isFinite)) continue;
    const trueRange = previousClose === null
      ? high - low
      : Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
    if (Number.isFinite(trueRange) && close > 0) ranges.push((trueRange / close) * 100);
    previousClose = close;
  }
  const atrPct = ranges.length >= 20
    ? ranges.reduce((sum, value) => sum + value, 0) / ranges.length
    : null;

  // Today's bars only: the chart read must describe this session, not a
  // five-day blur.
  const todayBars: Bar[] = [];
  for (let i = 0; i < (bars?.close?.length ?? 0); i++) {
    const [high, low, close, volume] = [bars?.high?.[i], bars?.low?.[i], bars?.close?.[i], bars?.volume?.[i]].map(Number);
    const stamp = stamps[i];
    if (![high, low, close].every(Number.isFinite) || !Number.isFinite(stamp)) continue;
    if (dayFormat.format(new Date(stamp * 1000)) !== latestDay) continue;
    todayBars.push({ high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  const sessionVwap = totalVolume > 0 ? valueVolume / totalVolume : null;

  return {
    price,
    prevClose: Number.isFinite(prevClose) && prevClose > 0 ? prevClose : null,
    changePct: Number.isFinite(prevClose) && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null,
    vwap: sessionVwap,
    relativeVolume: baseline > 0 && todayVolume > 0 ? todayVolume / baseline : null,
    atrPct,
    technicals: readTechnicals(todayBars, sessionVwap),
  };
}

// Finnhub rate-limits by origin IP, and Cloudflare Workers share egress IPs
// across many customers — so the worker reliably gets only a handful of the ~23
// quotes it asks for even though the same key returns all of them from a normal
// machine. Yahoo has no such limit here, so it carries the whole universe and
// Finnhub becomes the supplement rather than the other way round.
export async function yahooQuotes(symbols: string[]) {
  const snapshots = new Map<string, IndexSnapshot>();
  const chunkSize = 5;
  for (let i = 0; i < symbols.length; i += chunkSize) {
    const results = await Promise.allSettled(symbols.slice(i, i + chunkSize).map(async (symbol) =>
      [symbol, await yahooIndexSnapshot(symbol)] as const));
    for (const result of results) {
      if (result.status === "fulfilled") snapshots.set(result.value[0], result.value[1]);
    }
    if (i + chunkSize < symbols.length) await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return snapshots;
}

export type WireStory = { id: string; headline: string; summary: string; source: string; url: string; publishedAt: string };

// Yahoo's search endpoint returns real, dated, attributed articles per ticker.
// It exists because Finnhub's free company-news is effectively empty (one AAPL
// story in two days, already 5 hours old) while Yahoo returns ten items all
// under six hours. Freshness is worth 20 of the 100 scoring points and decays
// over exactly that window, so the difference is the gap between a catalyst
// that can qualify and one that has already aged out before Atlas sees it.
export async function yahooNews(ticker: string): Promise<WireStory[]> {
  // Yahoo's RSS headline feed carries a real article summary in <description>,
  // which the JSON search endpoint does not — it returns titles only. Atlas was
  // therefore judging every story on its headline alone, matching keywords
  // against a single line of text. The summary is usually the article's lede:
  // the sentence that says what actually happened and to whom.
  const xml = await text(
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; AtlasPaperSim/1.0)" } },
  );

  const stories: WireStory[] = [];
  for (const block of xml.split(/<item>/i).slice(1)) {
    const field = (tag: string) => {
      const match = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, "i"));
      return match ? match[1].replace(/<[^>]+>/g, "").trim() : "";
    };
    const headline = field("title");
    const url = field("link");
    const published = field("pubDate");
    const guid = field("guid") || url;
    const publishedAt = new Date(published);
    // Every field must be real; anything missing an id, title, link or a
    // parseable timestamp is dropped rather than backfilled with a guess.
    if (!headline || !url || !guid || Number.isNaN(publishedAt.getTime())) continue;
    stories.push({
      id: `yahoo:${guid}`,
      headline,
      summary: field("description"),
      source: "Yahoo Finance",
      url,
      publishedAt: publishedAt.toISOString(),
    });
  }
  return stories;
}

async function yahooIndexes() {
  const indexes = await yahooQuotes(["SPY", "QQQ", "VIXY"]);
  if (indexes.size === 0) throw new Error("yahoo: all index snapshots failed");
  return indexes;
}

// Per-ticker backup quotes for symbols the primary feed dropped this scan —
// real Yahoo last price and previous close, fetched only for the gaps.
export async function yahooBackupQuotes(symbols: string[]): Promise<Map<string, IndexSnapshot>> {
  const quotes = new Map<string, IndexSnapshot>();
  for (const symbol of symbols) {
    try { quotes.set(symbol, await yahooIndexSnapshot(symbol)); } catch { /* stays absent */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return quotes;
}

// Company press releases are primary-source material: the issuer speaking for
// itself. A wire item only counts when it names a universe ticker via a real
// exchange tag like "(NASDAQ: AAPL)" — never by fuzzy company-name matching.
// Press releases corroborate news-feed stories; alone they never create candidates.
const EXCHANGE_TAG = /\((?:NYSE|NASDAQ|Nasdaq|NYSE American|NYSEAMERICAN|CBOE|OTCQX|OTCQB)\s*:\s*([A-Z]{1,5})\)/g;

function pressReleasesFromRss(xml: string, sourceName: string): PressRelease[] {
  const items = xml.split(/<item[\s>]/i).slice(1);
  const releases: PressRelease[] = [];
  for (const item of items) {
    const title = xmlValues(`<item>${item}</item>`, "title")[0] ?? "";
    const link = xmlValues(`<item>${item}</item>`, "link")[0] ?? "";
    const pubDate = xmlValues(`<item>${item}</item>`, "pubDate")[0] ?? "";
    const description = xmlValues(`<item>${item}</item>`, "description")[0] ?? "";
    const text = `${title} ${description}`;
    const tickers = Array.from(new Set(Array.from(text.matchAll(EXCHANGE_TAG))
      .map((match) => match[1].toUpperCase())
      .filter((ticker) => TICKER_UNIVERSE.includes(ticker))));
    const publishedAt = new Date(pubDate);
    if (tickers.length > 0 && title && !Number.isNaN(publishedAt.getTime())) {
      releases.push({ source: sourceName, title, url: link, publishedAt: publishedAt.toISOString(), tickers });
    }
  }
  return releases;
}

async function pressReleaseWires() {
  const results = await Promise.allSettled([
    text("https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEFpRWQ==", { headers: { "User-Agent": "Mozilla/5.0 (compatible; AtlasPaperSim/1.0)" } })
      .then((xml) => pressReleasesFromRss(xml, "Business Wire")),
    text("https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss", { headers: { "User-Agent": "Mozilla/5.0 (compatible; AtlasPaperSim/1.0)" } })
      .then((xml) => pressReleasesFromRss(xml, "PR Newswire")),
  ]);
  if (results.every((result) => result.status === "rejected")) throw new Error("all press-release wires failed");
  return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}

export async function collectFreeSourceSnapshot(now: Date): Promise<FreeSourceSnapshot> {
  const health: FreeSourceSnapshot["health"] = {
    "Nasdaq Trading Halts": "UNAVAILABLE", "Federal Reserve": "UNAVAILABLE", BLS: "UNAVAILABLE",
    openFDA: "UNAVAILABLE", Coinbase: "UNAVAILABLE", "Yahoo Finance": "UNAVAILABLE", "Press-release wires": "UNAVAILABLE",
    "Company IR / agency releases": "LIVE", "X discovery": "DISABLED",
  };
  const [halts, fed, bls, fda, coinbase, indexes, wires] = await Promise.allSettled([
    nasdaqHalts(), federalReserveRisk(now), checkBls(), checkOpenFda(), coinbasePrices(), yahooIndexes(), pressReleaseWires(),
  ]);
  if (halts.status === "fulfilled") health["Nasdaq Trading Halts"] = "LIVE";
  if (fed.status === "fulfilled") health["Federal Reserve"] = "LIVE";
  if (bls.status === "fulfilled") health.BLS = "LIVE";
  if (fda.status === "fulfilled") health.openFDA = "LIVE";
  if (coinbase.status === "fulfilled") health.Coinbase = "LIVE";
  if (indexes.status === "fulfilled") health["Yahoo Finance"] = "LIVE";
  if (wires.status === "fulfilled") health["Press-release wires"] = "LIVE";
  return {
    haltedSymbols: halts.status === "fulfilled" ? halts.value.symbols : new Set(),
    halts: halts.status === "fulfilled" ? halts.value.records : [],
    macroEventRisk: fed.status === "fulfilled" && fed.value.length > 0,
    macroEvidence: fed.status === "fulfilled" ? fed.value : [],
    cryptoPrices: coinbase.status === "fulfilled" ? coinbase.value : new Map(),
    indexes: indexes.status === "fulfilled" ? indexes.value : new Map(),
    pressReleases: wires.status === "fulfilled" ? wires.value : [],
    health,
  };
}

export function cryptoQuoteDisagreementPct(primary: number, corroborating: number | undefined) {
  if (!corroborating || primary <= 0) return null;
  return Math.abs(primary - corroborating) / ((primary + corroborating) / 2) * 100;
}
