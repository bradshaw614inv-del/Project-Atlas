"use client";

import { useEffect, useMemo, useState } from "react";
import {
  COOLDOWN_MINUTES, DAILY_LOSS_LIMIT_PCT,
  DEFAULT_MAX_OPEN_POSITIONS, DEFAULT_RISK_PER_TRADE_PCT, STOP_DISTANCE_PCT, TRAILING_DISTANCE_PCT,
} from "../worker/positions";

const STATE_POLL_MS = 15000;
const CANDIDATES_POLL_MS = 30000;
const MIN_VALIDATED_SAMPLE = 100;
const CRYPTO_TICKERS = new Set(["BTC", "ETH", "SOL", "XRP"]);

function assetClass(ticker: string) {
  return CRYPTO_TICKERS.has(ticker) ? `crypto crypto-${ticker.toLowerCase()}` : "stock";
}

type Account = {
  startingCapital: number; maxOpenPositions: number; riskPerTradePct: number;
  realizedPnl: number; dailyRealizedPnl: number;
  dailyLossShutdown: number; consecutiveLosses: number; tradingDay: string;
};
type Weather = { classification: "TRADE_ELIGIBLE" | "CAUTION" | "SIT_OUT"; flags: string[]; spyPrice: number | null; spyChangePct: number | null; qqqChangePct: number | null; scanAt: string };
type ScanRun = { startedAt: string; finishedAt: string | null; storiesFetched: number; candidatesEvaluated: number; positionsOpened: number; positionsClosed: number; error: string | null };
type CollectionHealth = { healthy: boolean; totalRecentStories: number; totalRecentCandidates: number; recentScans: ScanRun[] };
type AccountTransaction = { id: number; type: "CONTRIBUTION"; amount: number; balanceAfter: number; createdAt: string };
type Position = {
  id: number; ticker: string; status: "OPEN" | "CLOSED"; shadow: number; entryPrice: number; entryAt: string;
  shares: number; stopPrice: number; highWaterMark: number; trailingActivated: number;
  exitPrice: number | null; exitAt: string | null; exitReason: string | null; realizedPnl: number | null;
  headline: string | null; sourceUrl: string | null;
};
type Candidate = {
  id: number; ticker: string; scanAt: string; score: number; status: "WATCH" | "CAUTION" | "DISQUALIFIED";
  reason: string; priceAtScan: number | null; priceChangePct: number | null; marketWeather: string;
  headline: string | null; sourceUrl: string | null; source: string | null;
  scoreBand: string; nearMiss: number; analystScore: number; skepticPenalty: number;
  signals: { key: string; label: string; score: number; max: number; evidence: string }[];
};
type Insights = { threshold: number; provenance: { providerCount: number; providers: string[]; outletCount: number; outlets: string[]; traceableStories: number; storiesChecked: number; sourceRoles?: { name: string; role: string; status: string }[] }; bands: { band: string; count: number; closed: number; winRate: number | null }[]; nearMisses: Candidate[]; confidenceTimeline: { id: number; ticker: string; scanAt: string; score: number; band: string }[]; memory: { tradeObservations: number; nonTradeObservations: number }; performance: { closedTrades: number; runningPnl: number; shadowClosed: number; shadowPnl: number; atlasEdge: number | null }; validationPolicy: { minSampleSize: number; holdoutSampleSize: number; requiresBacktest: boolean; liveConfigMutationAllowed: boolean }; readiness: { status: "NOT_READY" | "PILOT_REVIEW"; gates: { label: string; passed: boolean; value: string }[] }; journal: { id: number; title: string; detail: string }[]; experiments: unknown[]; knowledgeGraph: { nodes: unknown[]; edges: unknown[] } };

function money(n: number, digits = 2) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}
function displayDate(value: string) {
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function timeAgo(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  return res.json() as Promise<T>;
}

export default function Home() {
  const [account, setAccount] = useState<Account | null>(null);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [lastScan, setLastScan] = useState<ScanRun | null>(null);
  const [collectionHealth, setCollectionHealth] = useState<CollectionHealth | null>(null);
  const [openPositions, setOpenPositions] = useState<Position[]>([]);
  const [closedPositions, setClosedPositions] = useState<Position[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [fundsDraft, setFundsDraft] = useState("");
  const [riskPctDraft, setRiskPctDraft] = useState("");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [addingFunds, setAddingFunds] = useState(false);
  const [recentTransactions, setRecentTransactions] = useState<AccountTransaction[]>([]);
  const [scanning, setScanning] = useState(false);
  const [insights, setInsights] = useState<Insights | null>(null);

  async function refreshState() {
    const data = await getJson<{ account: Account | null; weather: Weather | null; lastScan: ScanRun | null; collectionHealth: CollectionHealth; recentTransactions: AccountTransaction[] }>("/api/state");
    setAccount(data.account);
    setWeather(data.weather);
    setLastScan(data.lastScan);
    setCollectionHealth(data.collectionHealth);
    setRecentTransactions(data.recentTransactions ?? []);
    if (data.account && !settingsLoaded) {
      setRiskPctDraft(String(data.account.riskPerTradePct));
      setSettingsLoaded(true);
    }
  }

  async function refreshPositions() {
    const data = await getJson<{ open: Position[]; closed: Position[] }>("/api/positions");
    setOpenPositions(data.open);
    setClosedPositions(data.closed);
  }

  async function refreshCandidates() {
    const data = await getJson<{ candidates: Candidate[] }>("/api/candidates");
    setCandidates(data.candidates);
  }
  async function refreshInsights() { setInsights(await getJson<Insights>("/api/insights")); }

  useEffect(() => {
    refreshState(); refreshPositions(); refreshCandidates(); refreshInsights();
    const stateInterval = setInterval(() => { refreshState(); refreshPositions(); }, STATE_POLL_MS);
    const candidateInterval = setInterval(refreshCandidates, CANDIDATES_POLL_MS);
    return () => { clearInterval(stateInterval); clearInterval(candidateInterval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const tickers = Array.from(new Set(openPositions.map((p) => p.ticker)));
    if (tickers.length === 0) return;
    let cancelled = false;
    async function loadPrices() {
      const entries = await Promise.all(tickers.map(async (ticker) => {
        try {
          const res = await fetch(`/api/quote?symbol=${ticker}`);
          const data = (await res.json()) as { price?: number };
          return [ticker, data.price ?? null] as const;
        } catch { return [ticker, null] as const; }
      }));
      if (!cancelled) setLivePrices(Object.fromEntries(entries.filter(([, p]) => p !== null)) as Record<string, number>);
    }
    loadPrices();
    const interval = setInterval(loadPrices, STATE_POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [openPositions.map((p) => p.ticker).join(",")]);

  async function saveSettings() {
    const riskPerTradePct = Number(riskPctDraft);
    if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0) return;
    setSavingSettings(true);
    await fetch("/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ riskPerTradePct }) });
    await refreshState();
    setSavingSettings(false);
  }

  async function addFunds(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const amount = Number(fundsDraft);
    if (!Number.isFinite(amount) || amount <= 0) return;
    setAddingFunds(true);
    const response = await fetch("/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ADD_FUNDS", amount }) });
    if (response.ok) {
      setFundsDraft("");
      await refreshState();
    }
    setAddingFunds(false);
  }

  async function runScanNow() {
    setScanning(true);
    try {
      await fetch("/api/scan-now", { method: "POST" });
      await Promise.all([refreshState(), refreshPositions(), refreshCandidates()]);
    } finally {
      setScanning(false);
    }
  }

  const closedStats = useMemo(() => {
    const real = closedPositions.filter((p) => !p.shadow);
    const wins = real.filter((p) => (p.realizedPnl ?? 0) > 0).length;
    return { count: real.length, wins, winRate: real.length ? Math.round((wins / real.length) * 100) : null };
  }, [closedPositions]);
  const unrealizedPnl = openPositions.filter((p) => !p.shadow).reduce((sum, p) => {
    const live = livePrices[p.ticker];
    return sum + (live == null ? 0 : (live - p.entryPrice) * p.shares);
  }, 0);
  const portfolioValue = account ? account.startingCapital + account.realizedPnl + unrealizedPnl : null;

  const highestScoreFirst = (a: Candidate, b: Candidate) =>
    b.score - a.score || new Date(b.scanAt).getTime() - new Date(a.scanAt).getTime();
  const activeCandidates = candidates.filter((c) => c.status !== "DISQUALIFIED").sort(highestScoreFirst);
  const rejectedCandidates = candidates.filter((c) => c.status === "DISQUALIFIED").sort(highestScoreFirst);

  const maxOpenPositions = account?.maxOpenPositions ?? DEFAULT_MAX_OPEN_POSITIONS;
  const riskPerTradePct = account?.riskPerTradePct ?? DEFAULT_RISK_PER_TRADE_PCT;
  const weatherClass = weather?.classification === "TRADE_ELIGIBLE" ? "eligible" : weather?.classification === "SIT_OUT" ? "sitout" : "caution";

  return (
    <main>
      <header className="topbar">
        <div className="brand"><span className="brandmark">A</span><div><strong>ATLAS</strong><small>AUTOMATED NEWS-DRIVEN SIMULATOR</small></div></div>
        <div className="mode"><span className="pulse" /> INFORMATION COLLECTION PHASE</div>
      </header>

      <section className="truth-banner"><strong>REAL INPUTS · PAPER OUTCOMES</strong><span>Stocks, Robinhood-supported crypto assets, news, timestamps, and market quotes must be real and source-traceable. Crypto scanning is restricted to BTC, ETH, SOL, and XRP. Only the paper execution and its calculated return or loss are simulated.</span></section>
      <section className={`collection-health ${collectionHealth?.healthy ? "healthy" : "stale"}`}><strong>{collectionHealth?.healthy ? "COLLECTOR HEALTHY" : "COLLECTOR NEEDS ATTENTION"}</strong><span>{lastScan ? `Last scan ${timeAgo(lastScan.startedAt)} · ${collectionHealth?.totalRecentStories ?? 0} new stories and ${collectionHealth?.totalRecentCandidates ?? 0} scored observations across the last ${collectionHealth?.recentScans.length ?? 0} scans.` : "Waiting for the first verified collection scan."}</span><small>Each scan checks one day of real company news and permanently builds history forward. Because the verified free feed arrives hours late, Atlas may score stories up to six hours old, but still requires 60+, a consecutive scan, and no price chasing.</small></section>

      <section className="hero forward-hero">
        <div><p className="eyebrow">OBSERVATION MODE · PAPER TRADES ONLY</p><h1>Atlas watches.<br /><em>Atlas learns from evidence.</em></h1><p className="lede">Every 5 minutes Atlas collects real stock and crypto news with real observed quotes. It records every observation, then simulates only the resulting paper profit or loss—never the facts behind it.</p></div>
        <div className="atlas-core" aria-hidden="true"><i/><i/><i/><b>A</b><span>SYSTEM ONLINE</span></div>
        <button className="secondary" onClick={runScanNow} disabled={scanning}>{scanning ? "SCANNING…" : "INITIATE SCAN"}</button>
      </section>

      <section className="howto">
        <h2>How to read this page</h2>
        <div className="howto-grid">
          <div><b>1. Market weather</b><p>A quick read of overall conditions. Atlas only opens new trades when this isn't "Sit out."</p></div>
          <div><b>2. Allocation</b><p>The model account is divided into five equal slots. Only qualifying assets receive a slot; the rest stays cash.</p></div>
          <div><b>3. Open &amp; closed positions</b><p>Every simulated trade Atlas has made, win or loss. Nothing is hidden.</p></div>
          <div><b>4. Scoring feed</b><p>Every news story Atlas looked at. Most days most stories don't qualify — that's intentional, not a bug.</p></div>
        </div>
      </section>

      <section className={`weather-banner ${weatherClass}`}>
        <div className="weather-badge">{weather?.classification.replace("_", " ") ?? "NO DATA YET"}</div>
        <div className="weather-flags">{weather?.flags.map((flag, i) => <span key={i}>{flag}</span>) ?? <span>Waiting for the first scan.</span>}</div>
        <div className="weather-meta">{lastScan && <>Last scan {timeAgo(lastScan.startedAt)} · {lastScan.storiesFetched} stories · {lastScan.candidatesEvaluated} candidates evaluated{lastScan.error && <span className="field-error"> · {lastScan.error}</span>}</>}</div>
      </section>

      <section className="account-strip settings-strip">
        <form className="capital-control" onSubmit={addFunds}>
          <label htmlFor="account-amount">ADD PAPER CASH</label>
          <span className="money-input"><i>$</i><input id="account-amount" aria-label="Amount of paper cash to add" inputMode="decimal" type="number" min="1" step="1" placeholder="Amount" value={fundsDraft} onChange={(e) => setFundsDraft(e.target.value)} /></span>
          <button type="submit" className="live-btn" disabled={addingFunds}>{addingFunds ? "ADDING…" : "ADD FUNDS"}</button>
          <div className="settings-row">
            <label>Allocation slots<input type="number" value={DEFAULT_MAX_OPEN_POSITIONS} disabled /></label>
            <label>Risk per trade %<input type="number" min="0.05" max="5" step="0.05" value={riskPctDraft} onChange={(e) => setRiskPctDraft(e.target.value)} /></label>
            <button type="button" className="live-btn" onClick={saveSettings} disabled={savingSettings}>{savingSettings ? "SAVING…" : "SAVE SETTINGS"}</button>
          </div>
          <small>{account ? `${money(account.startingCapital, 0)} contributed · ${maxOpenPositions} equal slots of ${money(account.startingCapital / maxOpenPositions, 0)} · unused slots remain cash${recentTransactions[0] ? ` · last added ${money(recentTransactions[0].amount, 0)}` : ""}` : ""}</small>
        </form>
        <div><span>PORTFOLIO VALUE</span><strong className={(portfolioValue ?? 0) >= (account?.startingCapital ?? 0) ? "positive" : "negative"}>{portfolioValue === null ? "—" : money(portfolioValue)}</strong><small>Contributed cash + closed P&amp;L + live open-position P&amp;L</small></div>
        <div><span>REALIZED P&L</span><strong className={(account?.realizedPnl ?? 0) >= 0 ? "positive" : "negative"}>{account ? `${account.realizedPnl >= 0 ? "+" : ""}${money(account.realizedPnl)}` : "—"}</strong><small>All-time, simulated</small></div>
        <div><span>TODAY'S P&L</span><strong className={(account?.dailyRealizedPnl ?? 0) >= 0 ? "positive" : "negative"}>{account ? `${account.dailyRealizedPnl >= 0 ? "+" : ""}${money(account.dailyRealizedPnl)}` : "—"}</strong><small>{account?.dailyLossShutdown ? "Circuit breaker tripped — no new entries today" : "Circuit breaker armed"}</small></div>
        <div><span>OPEN POSITIONS</span><strong>{openPositions.filter((p) => !p.shadow).length}/{maxOpenPositions}</strong><small>{closedStats.count >= MIN_VALIDATED_SAMPLE ? `${closedStats.winRate}% observed win rate over ${closedStats.count} closed` : `${closedStats.count}/${MIN_VALIDATED_SAMPLE} closed trades collected before reporting a win rate`}</small></div>
      </section>

      <section className="tracker">
        <div className="tracker-head"><div><span>SIMULATED POSITIONS</span><h2>Open now</h2><p>Managed automatically: staged stop-loss, breakeven, and trailing rules — no manual exits.</p></div></div>
        {openPositions.length === 0 ? <div className="empty"><p>No open positions. Atlas opens one automatically when a story clears every gate.</p></div> : <div className="event-grid">{openPositions.map((p) => {
          const live = livePrices[p.ticker];
          const unrealized = live ? (live - p.entryPrice) * p.shares : null;
          return <article className="event-card" key={p.id}>
            <div className={`event-top ${assetClass(p.ticker)}`}><div><span className="category">{CRYPTO_TICKERS.has(p.ticker) ? "CRYPTO" : p.shadow ? "SHADOW (SIT-OUT DAY)" : "STOCK"}</span><strong>{p.ticker}</strong></div><time>{displayDate(p.entryAt)}</time></div>
            <h3>{p.headline || "—"}</h3>
            <div className="event-numbers">
              <div><span>ENTRY</span><b>{money(p.entryPrice)}</b></div>
              <div><span>CURRENT STOP</span><b>{money(p.stopPrice)}</b></div>
              <div><span>UNREALIZED</span><b className={unrealized !== null ? (unrealized >= 0 ? "positive" : "negative") : ""}>{unrealized !== null ? `${unrealized >= 0 ? "+" : ""}${money(unrealized)}` : "—"}</b></div>
            </div>
            <div className="event-actions">
              <small>{p.shares.toFixed(2)} shares · {p.trailingActivated ? "trailing stop active" : "fixed stop"}</small>
              {p.sourceUrl && <a href={p.sourceUrl} target="_blank" rel="noreferrer">VIEW SOURCE ↗</a>}
            </div>
          </article>;
        })}</div>}
      </section>

      <section className="tracker">
        <div className="tracker-head"><div><span>TRADE HISTORY</span><h2>Closed positions</h2><p>Every closed trade, win or loss — nothing is hidden or removed.</p></div></div>
        {closedPositions.length === 0 ? <div className="empty"><p>No closed trades yet.</p></div> : <div className="event-grid">{closedPositions.map((p) => (
          <article className="event-card" key={p.id}>
            <div className={`event-top ${assetClass(p.ticker)}`}><div><span className="category">{CRYPTO_TICKERS.has(p.ticker) ? `CRYPTO · ${p.shadow ? "SHADOW" : p.exitReason}` : p.shadow ? "SHADOW" : p.exitReason}</span><strong>{p.ticker}</strong></div><time>{p.exitAt ? displayDate(p.exitAt) : ""}</time></div>
            <h3>{p.headline || "—"}</h3>
            <div className="event-numbers">
              <div><span>ENTRY → EXIT</span><b>{money(p.entryPrice)} → {p.exitPrice ? money(p.exitPrice) : "—"}</b></div>
              <div><span>SHARES</span><b>{p.shares.toFixed(2)}</b></div>
              <div><span>REALIZED</span><b className={(p.realizedPnl ?? 0) >= 0 ? "positive" : "negative"}>{p.realizedPnl !== null ? `${p.realizedPnl >= 0 ? "+" : ""}${money(p.realizedPnl)}` : "—"}</b></div>
            </div>
          </article>
        ))}</div>}
      </section>

      <section className="watchlist-panel">
        <div className="watchlist-head"><div><span>LIVE SCORING FEED · HIGHEST SCORE FIRST</span><h2>Recent candidates</h2><p>{candidates.length > 0 ? `Atlas evaluated ${candidates.length} stories this session. ${activeCandidates.length === 0 ? "None cleared the bar yet — that's normal, it only acts when something clearly qualifies." : `${activeCandidates.length} worth watching right now.`}` : "Every story Atlas evaluates shows up here, accepted and rejected, with the exact reason."}</p></div></div>

        {activeCandidates.length === 0 ? <p className="watchlist-empty">Nothing is currently worth watching. Atlas doesn't force trades — no qualifying story means no trade.</p> : <div className="candidate-list">{activeCandidates.map((c) => (
          <CandidateRow key={c.id} c={c} />
        ))}</div>}

        {rejectedCandidates.length > 0 && <section className="evidence-stream" aria-labelledby="evidence-stream-title">
          <div className="evidence-stream-head"><div><span>OBSERVATION STREAM</span><h3 id="evidence-stream-title">Highest-scoring real evidence</h3></div><strong>{rejectedCandidates.length} shown</strong></div>
          <p>These real stories were evaluated and rejected. A rejection is useful evidence—not inactivity—and never creates a paper trade.</p>
          <div className="candidate-list">{rejectedCandidates.slice(0, 30).map((c) => <CandidateRow key={c.id} c={c} />)}</div>
        </section>}
      </section>

      <section className="intelligence-panel">
        <div className="tracker-head"><div><span>ATLAS INTELLIGENCE</span><h2>Evidence collection &amp; calibration</h2><p>No performance claim is validated until it has at least {insights?.validationPolicy.minSampleSize ?? 30} real closed observations and passes an out-of-sample test. The live threshold remains 60.</p></div></div>
        <div className="intelligence-grid">
          <article><span>ATLAS EDGE</span><strong>{insights?.performance.atlasEdge == null ? "Collecting data" : insights.performance.atlasEdge.toFixed(3)}</strong><small>Average actual outcome minus predicted win probability</small></article>
          <article><span>MEMORY</span><strong>{insights ? `${insights.memory.tradeObservations} / ${insights.memory.nonTradeObservations}` : "—"}</strong><small>Trade / non-trade observations retained</small></article>
          <article><span>NEAR MISSES</span><strong>{insights?.nearMisses.length ?? "—"}</strong><small>Recent scores from 50–59, logged but never traded</small></article>
          <article><span>KNOWLEDGE GRAPH</span><strong>{insights ? `${insights.knowledgeGraph.nodes.length} nodes` : "—"}</strong><small>Ticker, catalyst, and market-regime relationships</small></article>
        </div>
        <div className="calibration-bands">{insights?.bands.map((band) => <div key={band.band}><b>{band.band}</b><span>{band.count} observations</span><small>{band.winRate !== null ? `${Math.round(band.winRate * 100)}% observed wins / ${band.closed} closed` : `${band.closed}/30 closed outcomes collected`}</small></div>)}</div>
        <div className="confidence-timeline" aria-label="Recent confidence timeline">{insights?.confidenceTimeline.slice(-24).map((point) => <div className={assetClass(point.ticker)} key={point.id} title={`${point.ticker} · ${point.score.toFixed(0)} · ${displayDate(point.scanAt)}`}><i style={{ height: `${Math.max(4, point.score)}%` }} /><small>{point.ticker}</small></div>)}</div>
      </section>

      <section className="source-panel" aria-labelledby="source-title">
        <div><span>EVIDENCE COVERAGE</span><h2 id="source-title">Every score shows its sourcing limits</h2><p>Atlas combines traceable news with official SEC, Nasdaq, Federal Reserve, BLS, FDA, Coinbase, issuer, and agency evidence. Each feed has a narrow role; no feed earns points for facts it cannot prove. X remains disabled because its read API is paid and social activity is never verification.</p></div>
        <div className="source-stats"><article><strong>{insights?.provenance.providerCount ?? "—"}</strong><span>upstream provider</span></article><article><strong>{insights?.provenance.outletCount ?? "—"}</strong><span>distinct outlets</span></article><article><strong>{insights ? `${insights.provenance.traceableStories}/${insights.provenance.storiesChecked}` : "—"}</strong><span>traceable stories</span></article></div>
        <p className="source-list">{insights?.provenance.outlets.slice(0, 18).join(" · ") || "Waiting for verified outlets"}</p>
        <div className="source-roles">{insights?.provenance.sourceRoles?.map((source) => <article key={source.name}><b>{source.name}</b><span>{source.role}</span><em className={source.status.startsWith("LIVE") ? "live" : "off"}>{source.status}</em></article>)}</div>
      </section>

      <section className="readiness-panel" aria-labelledby="readiness-title">
        <div className="readiness-head"><div><span>LIVE-CAPITAL READINESS</span><h2 id="readiness-title">Evidence before confidence</h2><p>Historical replay can accelerate learning, but only prospective paper trades and a frozen-rule holdout can unlock a pilot review.</p></div><strong className={insights?.readiness.status === "PILOT_REVIEW" ? "ready" : "not-ready"}>{insights?.readiness.status === "PILOT_REVIEW" ? "PILOT REVIEW" : "NOT READY"}</strong></div>
        <div className="readiness-gates">{insights?.readiness.gates.map((gate) => <article key={gate.label} className={gate.passed ? "passed" : "pending"}><i>{gate.passed ? "✓" : "·"}</i><div><b>{gate.label}</b><small>{gate.value}</small></div></article>)}</div>
        <div className="readiness-note"><b>Current policy</b><span>60-point threshold remains fixed</span><span>100 prospective closed trades</span><span>30-trade frozen holdout</span><span>80%+ weather completeness</span><span>zero forced trades</span></div>
      </section>

      <section className="safety-panel" aria-labelledby="safety-title">
        <div className="safety-heading">
          <div><span>ENGINE RULES · ROBINHOOD CASH MODEL</span><h2 id="safety-title">What Atlas will never do</h2><p>Atlas is paper-only and models a conservative cash account. The current $13,000 balance is divided into five equal $2,600 slots; no broker is connected.</p></div>
          <strong>ROBINHOOD MODE</strong>
        </div>
        <div className="safety-grid">
          <SafetyRule value={`${DAILY_LOSS_LIMIT_PCT}%`} label="Daily circuit breaker" detail="New entries stop for the day at this loss, or after two consecutive losing trades." />
          <SafetyRule value="5 equal slots" label="Capital allocation" detail="Each qualifying asset can use one equal slot. Unused slots remain cash; Atlas never forces a trade to fill them." />
          <SafetyRule value="100% cash" label="No margin or leverage" detail="Every simulated stock and crypto purchase must be fully backed by available paper cash. Crypto is never treated as collateral." />
          <SafetyRule value="T+1 safe" label="No same-day stock cash reuse" detail="Atlas caps total new purchase notional to current equity each trading day, so proceeds from a stock sold today are not recycled before settlement." />
          <SafetyRule value="Long only" label="No shorting or options" detail="Atlas only simulates buying supported stocks and crypto. It does not short, borrow shares, or trade options." />
          <SafetyRule value="Preflight required" label="No automatic real-money launch" detail="Before any future brokerage connection, Atlas must verify live account type, buying power, restrictions, asset availability, and current Robinhood rules for every order." />
          <SafetyRule value={`${STOP_DISTANCE_PCT}%`} label="Initial stop distance" detail="Simplified fixed distance — real intraday volatility (ATR) isn't available on the free data tier." />
          <SafetyRule value={`${TRAILING_DISTANCE_PCT}%`} label="Trailing stop" detail="Activates at +3% and only ever ratchets the stop upward, never down." />
          <SafetyRule value={`${COOLDOWN_MINUTES} min`} label="Stop-out cooldown" detail="No immediate re-entry into a ticker after a loss — a genuinely new signal is required." />
          <SafetyRule value="10:00–3:45 ET" label="Entry window" detail="Stock and crypto entries use the same U.S. trading-day window. No new positions in the first 30 or final 15 minutes." />
          <SafetyRule value="Flat by 3:45" label="No overnight risk" detail="Every open position force-closes before the close — Robinhood stops don't execute after hours." />
          <SafetyRule value="20 / 50 bps" label="Simulated round-trip costs" detail="Stocks / crypto use conservative, predeclared spread-and-slippage assumptions. These are simulated execution costs, never presented as observed quotes." />
        </div>
        <div className="hard-gates"><strong>Every candidate must also pass:</strong><span>real, dated news only</span><span>two consecutive qualifying scans</span><span>market not "Sit out"</span><span>price confirmed, not extended</span><span>wash-sale blacklist clear</span><span>no negative-sentiment keywords</span><span>no duplicate open position</span><span>no forced trade quota</span></div>
      </section>

      <footer><span>ATLAS AUTOMATED SIMULATOR</span><span>Fully simulated — never places a real order on Robinhood or any brokerage.</span></footer>
    </main>
  );
}

function CandidateRow({ c }: { c: Candidate }) {
  return <article className={`candidate-row status-${c.status.toLowerCase()} ${assetClass(c.ticker)}`}>
    <div className="candidate-badge">{c.status}</div>
    <div className="candidate-main">
      <div className="candidate-top"><strong>{c.ticker}</strong>{CRYPTO_TICKERS.has(c.ticker) && <em>CRYPTO</em>}<span>{c.score.toFixed(0)}/100</span><time>{timeAgo(c.scanAt)}</time></div>
      <p className="candidate-headline">{c.headline}{c.source && <span className="candidate-source"> — {c.source}</span>}{c.sourceUrl && <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="candidate-link">↗</a>}</p>
      <p className="candidate-reason">{c.reason}</p>
      {c.signals?.length > 0 && <details className="score-breakdown"><summary>Confidence breakdown · analyst {c.analystScore.toFixed(0)} − skeptic {c.skepticPenalty.toFixed(0)}</summary>{c.signals.map((signal) => <div key={signal.key}><b>{signal.label}</b><span>{signal.score.toFixed(1)}/{signal.max}</span><small>{signal.evidence}</small></div>)}</details>}
    </div>
  </article>;
}

function SafetyRule({ value, label, detail }: { value: string; label: string; detail: string }) {
  return <article className="safety-rule"><div><b>{value}</b><span>{label}</span></div><Info text={detail} /></article>;
}

function Info({ text }: { text: string }) {
  return <details className="info"><summary aria-label="More information">?</summary><div>{text}</div></details>;
}
