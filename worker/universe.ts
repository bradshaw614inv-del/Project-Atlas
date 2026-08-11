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
