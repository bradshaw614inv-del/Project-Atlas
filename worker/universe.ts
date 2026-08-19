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

// Explicit Robinhood-tradable allowlist. General crypto news may mention any
// asset, but Atlas only creates candidates for assets listed here.
export const ROBINHOOD_CRYPTO_UNIVERSE = [
  { ticker: "BTC", quoteSymbol: "BINANCE:BTCUSDT", aliases: ["bitcoin", "btc"] },
  { ticker: "ETH", quoteSymbol: "BINANCE:ETHUSDT", aliases: ["ethereum", "ether", "eth"] },
  { ticker: "SOL", quoteSymbol: "BINANCE:SOLUSDT", aliases: ["solana", "sol"] },
  { ticker: "XRP", quoteSymbol: "BINANCE:XRPUSDT", aliases: ["xrp", "ripple"] },
] as const;

// Company names as they actually appear in headlines. Needed because a news
// feed tags an article to every ticker it mentions, so a story about one
// company arrives labelled for several — "Nvidia Strikes Deal With OpenAI As
// Tenant" was tagged to GOOGL, AMZN and MSFT and opened positions in all three.
// The catalyst was real; it was simply not real for those companies.
export const COMPANY_ALIASES: Record<string, string[]> = {
  AAPL: ["apple"],
  MSFT: ["microsoft"],
  NVDA: ["nvidia"],
  AMZN: ["amazon"],
  GOOGL: ["alphabet", "google"],
  META: ["meta platforms", "meta", "facebook", "instagram"],
  TSLA: ["tesla"],
  AMD: ["advanced micro", "amd"],
  NFLX: ["netflix"],
  JPM: ["jpmorgan", "jp morgan", "j.p. morgan"],
  BAC: ["bank of america", "bofa"],
  XOM: ["exxon"],
  CVX: ["chevron"],
  PLTR: ["palantir"],
  CRM: ["salesforce"],
  AVGO: ["broadcom"],
  LMT: ["lockheed"],
  BA: ["boeing"],
  DIS: ["disney"],
  WMT: ["walmart"],
  BTC: ["bitcoin"],
  ETH: ["ethereum", "ether"],
  SOL: ["solana"],
  XRP: ["xrp", "ripple"],
};

// Headlines that are market summaries rather than company news. These name no
// subject at all — they are lists — and were the single largest source of
// low-quality candidates.
const ROUNDUP_PATTERNS = [
  /top .*movers/i, /movers/i, /most active/i, /session:/i, /market wrap/i,
  /stocks to watch/i, /what'?s going on/i, /today'?s session/i, /biggest (gainers|losers)/i,
  /premarket/i, /after hours/i, /trending tickers/i, /stocks moving/i, /week ahead/i,
];

export type SubjectVerdict = { isSubject: boolean; reason: string };

// Is this story about the ticker, or does it merely mention it? A story is
// about a company when that company is named in the headline and no other
// company is named ahead of it. Anything else is a mention, and a mention is
// not a catalyst for the company mentioned.
export function isStorySubject(ticker: string, headline: string, summary = ""): SubjectVerdict {
  const text = headline.toLowerCase();
  // The summary is consulted only to rescue a story whose headline is vague;
  // it can never override a headline that clearly leads with another company.
  const body = `${headline} ${summary}`.toLowerCase();

  if (ROUNDUP_PATTERNS.some((pattern) => pattern.test(headline))) {
    return { isSubject: false, reason: "Market roundup, not company news — it lists tickers rather than reporting on one." };
  }

  const positionOf = (symbol: string) => {
    const aliases = COMPANY_ALIASES[symbol] ?? [symbol.toLowerCase()];
    const hits = aliases.map((alias) => text.indexOf(alias)).filter((index) => index >= 0);
    return hits.length ? Math.min(...hits) : -1;
  };

  const own = positionOf(ticker);
  if (own < 0) {
    // A vague headline over a lede that names this company and no other is
    // still about it — "Company announces quarterly results" followed by a
    // summary naming Salesforce is a Salesforce story.
    const aliases = COMPANY_ALIASES[ticker] ?? [ticker.toLowerCase()];
    const namedInBody = aliases.some((alias) => body.includes(alias));
    const othersInBody = Object.keys(COMPANY_ALIASES).filter((symbol) => symbol !== ticker)
      .filter((symbol) => (COMPANY_ALIASES[symbol] ?? []).some((alias) => body.includes(alias)));
    if (namedInBody && othersInBody.length === 0) {
      return { isSubject: true, reason: `${ticker} is named in the article body and no other company is.` };
    }
    return { isSubject: false, reason: `Headline never names ${ticker} — the feed tagged it, the story is not about it.` };
  }

  // Another company named earlier means the story is about them, and this
  // ticker is context. Equal-footing mentions near the start are allowed:
  // genuine two-party news ("X agrees to buy Y") is about both.
  const others = Object.keys(COMPANY_ALIASES)
    .filter((symbol) => symbol !== ticker)
    .map((symbol) => ({ symbol, at: positionOf(symbol) }))
    .filter((entry) => entry.at >= 0);
  const leader = others.find((entry) => entry.at < own && own - entry.at > 12);
  if (leader) {
    return { isSubject: false, reason: `Headline leads with ${leader.symbol}; ${ticker} appears only as context.` };
  }

  return { isSubject: true, reason: `${ticker} is the subject of the headline.` };
}

export function quoteSymbolForTicker(ticker: string) {
  return ROBINHOOD_CRYPTO_UNIVERSE.find((asset) => asset.ticker === ticker)?.quoteSymbol ?? ticker;
}

export function cryptoTickersForStory(headline: string, summary: string) {
  const text = `${headline} ${summary}`.toLowerCase();
  return ROBINHOOD_CRYPTO_UNIVERSE
    .filter((asset) => asset.aliases.some((alias) => new RegExp(`(^|[^a-z0-9])${alias}([^a-z0-9]|$)`, "i").test(text)))
    .map((asset) => asset.ticker);
}

export function isCryptoTicker(ticker: string) {
  return ROBINHOOD_CRYPTO_UNIVERSE.some((asset) => asset.ticker === ticker);
}
