// Finnhub's free-tier general news feed doesn't tag which company a story is
// about (`related` is empty, headlines don't use ticker notation), so blind
// "scan everything" discovery isn't reliable. Instead Atlas monitors this fixed
// universe of liquid, frequently-newsworthy US tickers via Finnhub's per-company
// news endpoint, which does reliably tag the ticker. Real data either way —
// this only changes how candidates are discovered, not where the numbers come from.
export const TICKER_UNIVERSE = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "NFLX",
  "JPM", "BAC", "XOM", "CVX", "PLTR", "CRM", "AVGO", "LMT", "BA", "DIS", "WMT",
];

export const CRYPTO_UNIVERSE = [
  { ticker: "BTC", quoteSymbol: "BINANCE:BTCUSDT", aliases: ["bitcoin", "btc"] },
  { ticker: "ETH", quoteSymbol: "BINANCE:ETHUSDT", aliases: ["ethereum", "ether", "eth"] },
  { ticker: "SOL", quoteSymbol: "BINANCE:SOLUSDT", aliases: ["solana", "sol"] },
  { ticker: "XRP", quoteSymbol: "BINANCE:XRPUSDT", aliases: ["xrp", "ripple"] },
] as const;

export function quoteSymbolForTicker(ticker: string) {
  return CRYPTO_UNIVERSE.find((asset) => asset.ticker === ticker)?.quoteSymbol ?? ticker;
}

export function cryptoTickersForStory(headline: string, summary: string) {
  const text = `${headline} ${summary}`.toLowerCase();
  return CRYPTO_UNIVERSE
    .filter((asset) => asset.aliases.some((alias) => new RegExp(`(^|[^a-z0-9])${alias}([^a-z0-9]|$)`, "i").test(text)))
    .map((asset) => asset.ticker);
}

export function isCryptoTicker(ticker: string) {
  return CRYPTO_UNIVERSE.some((asset) => asset.ticker === ticker);
}
