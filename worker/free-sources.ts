import { ROBINHOOD_CRYPTO_UNIVERSE } from "./universe";

export type FreeSourceSnapshot = {
  haltedSymbols: Set<string>;
  macroEventRisk: boolean;
  macroEvidence: string[];
  cryptoPrices: Map<string, number>;
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
  return new Set(xmlValues(xml, "ndaq:IssueSymbol").map((value) => value.toUpperCase()));
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

export async function collectFreeSourceSnapshot(now: Date): Promise<FreeSourceSnapshot> {
  const health: FreeSourceSnapshot["health"] = {
    "Nasdaq Trading Halts": "UNAVAILABLE", "Federal Reserve": "UNAVAILABLE", BLS: "UNAVAILABLE",
    openFDA: "UNAVAILABLE", Coinbase: "UNAVAILABLE", "Company IR / agency releases": "LIVE", "X discovery": "DISABLED",
  };
  const [halts, fed, bls, fda, coinbase] = await Promise.allSettled([
    nasdaqHalts(), federalReserveRisk(now), checkBls(), checkOpenFda(), coinbasePrices(),
  ]);
  if (halts.status === "fulfilled") health["Nasdaq Trading Halts"] = "LIVE";
  if (fed.status === "fulfilled") health["Federal Reserve"] = "LIVE";
  if (bls.status === "fulfilled") health.BLS = "LIVE";
  if (fda.status === "fulfilled") health.openFDA = "LIVE";
  if (coinbase.status === "fulfilled") health.Coinbase = "LIVE";
  return {
    haltedSymbols: halts.status === "fulfilled" ? halts.value : new Set(),
    macroEventRisk: fed.status === "fulfilled" && fed.value.length > 0,
    macroEvidence: fed.status === "fulfilled" ? fed.value : [],
    cryptoPrices: coinbase.status === "fulfilled" ? coinbase.value : new Map(), health,
  };
}

export function cryptoQuoteDisagreementPct(primary: number, corroborating: number | undefined) {
  if (!corroborating || primary <= 0) return null;
  return Math.abs(primary - corroborating) / ((primary + corroborating) / 2) * 100;
}
