"use client";

import { useMemo, useState } from "react";

const CATEGORIES = [
  "Defense Contracts",
  "FDA Approvals",
  "Earnings Beats",
  "Mergers & Acquisitions",
  "Commodity Disruptions",
  "CEO Changes",
] as const;

const TICKERS = ["LMT", "MRNA", "NVDA", "AVGO", "XOM", "SBUX", "NOC", "LLY", "AMD", "CVX", "BA", "PFE"];
const COLORS = ["#c5ff49", "#67e8f9", "#fbbf24", "#fb7185", "#a78bfa", "#94a3b8"];

type Strategy = {
  entryDelay: number;
  trailingStop: number;
  profitTarget: number;
  holdHours: number;
  costs: number;
};

type Trade = {
  id: number;
  category: string;
  ticker: string;
  date: string;
  entry: number;
  exit: number;
  returnPct: number;
  hold: number;
  exitReason: string;
};

function rng(seed: number) {
  const x = Math.sin(seed * 999.91) * 43758.5453;
  return x - Math.floor(x);
}

function buildTrades(strategy: Strategy, enabled: boolean[]): Trade[] {
  const trades: Trade[] = [];
  for (let i = 0; i < 1248; i++) {
    const catIndex = i % CATEGORIES.length;
    if (!enabled[catIndex]) continue;
    const baseEdge = [1.15, 1.85, 0.72, 1.42, 0.48, -0.2][catIndex];
    const delayEffect = strategy.entryDelay === 15 ? 0.32 : strategy.entryDelay === 5 ? 0.18 : strategy.entryDelay === 30 ? 0.08 : strategy.entryDelay === 60 ? -0.28 : 0;
    const stopEffect = strategy.trailingStop === 4 ? 0.22 : strategy.trailingStop === 6 ? 0.12 : strategy.trailingStop === 2 ? -0.16 : -0.04;
    const holdEffect = strategy.holdHours === 24 ? 0.18 : strategy.holdHours === 8 ? 0.09 : strategy.holdHours === 72 ? -0.08 : 0;
    const noise = (rng(i + 43) + rng(i * 3 + 9) - 1) * 8.4;
    const rawReturn = baseEdge + delayEffect + stopEffect + holdEffect + noise - strategy.costs;
    const clipped = Math.max(-strategy.trailingStop - strategy.costs, Math.min(strategy.profitTarget - strategy.costs, rawReturn));
    const entry = 28 + rng(i + 7) * 365;
    const date = new Date(Date.UTC(2026, 0, 2 + Math.floor(i / 7)));
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const hitTarget = clipped >= strategy.profitTarget - strategy.costs - 0.01;
    const hitStop = clipped <= -strategy.trailingStop - strategy.costs + 0.01;
    trades.push({
      id: i + 1,
      category: CATEGORIES[catIndex],
      ticker: TICKERS[i % TICKERS.length],
      date: `${months[date.getUTCMonth()]} ${date.getUTCDate()}`,
      entry,
      exit: entry * (1 + clipped / 100),
      returnPct: clipped,
      hold: hitTarget || hitStop ? Math.max(1, Math.round(strategy.holdHours * (0.15 + rng(i + 88) * 0.65))) : strategy.holdHours,
      exitReason: hitTarget ? "Profit target" : hitStop ? "Trailing stop" : "Time limit",
    });
  }
  return trades;
}

function pct(n: number, signed = false) {
  return `${signed && n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export default function Home() {
  const [strategy, setStrategy] = useState<Strategy>({ entryDelay: 15, trailingStop: 4, profitTarget: 8, holdHours: 24, costs: 0.18 });
  const [enabled, setEnabled] = useState(CATEGORIES.map(() => true));
  const [page, setPage] = useState(0);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState("Baseline · Aug 3, 10:42 PM");

  const trades = useMemo(() => buildTrades(strategy, enabled), [strategy, enabled, lastRun]);
  const wins = trades.filter((t) => t.returnPct > 0);
  const avg = trades.reduce((s, t) => s + t.returnPct, 0) / Math.max(1, trades.length);
  const sorted = [...trades].sort((a, b) => a.returnPct - b.returnPct);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)].returnPct : 0;
  const winRate = (wins.length / Math.max(1, trades.length)) * 100;
  const totalReturn = trades.length ? ((1 + avg / 100) ** Math.min(30, trades.length / 40) - 1) * 100 : 0;
  const benchmark = 8.7;
  const drawdown = Math.min(18, 5.8 + strategy.trailingStop * 0.76 + strategy.entryDelay / 30);

  const categoryStats = CATEGORIES.map((category, i) => {
    const subset = trades.filter((t) => t.category === category);
    return { category, color: COLORS[i], count: subset.length, avg: subset.reduce((s, t) => s + t.returnPct, 0) / Math.max(1, subset.length), wins: subset.filter((t) => t.returnPct > 0).length / Math.max(1, subset.length) * 100 };
  });

  function update<K extends keyof Strategy>(key: K, value: Strategy[K]) {
    setStrategy((s) => ({ ...s, [key]: value }));
    setPage(0);
  }

  function runSimulation() {
    setRunning(true);
    window.setTimeout(() => {
      setLastRun(`Custom run · ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
      setRunning(false);
    }, 650);
  }

  const visible = trades.slice(page * 8, page * 8 + 8);

  return (
    <main>
      <header className="topbar">
        <div className="brand"><span className="brandmark">A</span><div><strong>ATLAS</strong><small>NEWS REPLAY ENGINE</small></div></div>
        <div className="period"><span>DATA WINDOW</span><strong>Jan 02 — Jun 30, 2026</strong><i>6 months</i></div>
        <div className="status"><span className="pulse" /> HISTORICAL MODE</div>
      </header>

      <section className="hero">
        <div><p className="eyebrow">SIMULATION / RUN 0047</p><h1>Replay the news.<br /><em>Measure the edge.</em></h1><p className="lede">Test how event-driven strategies would have performed using only information available at the moment each story broke.</p></div>
        <div className="runbox">
          <div><span>LAST RUN</span><strong>{lastRun}</strong></div>
          <button onClick={runSimulation} disabled={running}>{running ? "REPLAYING…" : "▶  RUN SIMULATION"}</button>
        </div>
      </section>

      <section className="workspace">
        <aside className="controls">
          <div className="section-title"><span>01</span><div><strong>STRATEGY PARAMETERS</strong><small>Configure the replay rules</small></div></div>

          <Control label="ENTRY DELAY" value={`${strategy.entryDelay} min`}>
            <div className="segmented">{[0, 5, 15, 30, 60].map((v) => <button className={strategy.entryDelay === v ? "active" : ""} onClick={() => update("entryDelay", v)} key={v}>{v === 0 ? "NOW" : v}</button>)}</div>
          </Control>
          <Control label="TRAILING STOP" value={`${strategy.trailingStop}%`}>
            <input aria-label="Trailing stop" type="range" min="2" max="10" step="2" value={strategy.trailingStop} onChange={(e) => update("trailingStop", +e.target.value)} />
            <div className="ticks"><span>2%</span><span>6%</span><span>10%</span></div>
          </Control>
          <Control label="PROFIT TARGET" value={`${strategy.profitTarget}%`}>
            <input aria-label="Profit target" type="range" min="4" max="20" step="2" value={strategy.profitTarget} onChange={(e) => update("profitTarget", +e.target.value)} />
            <div className="ticks"><span>4%</span><span>12%</span><span>20%</span></div>
          </Control>
          <Control label="MAXIMUM HOLD" value={`${strategy.holdHours} hr`}>
            <div className="segmented four">{[4, 8, 24, 72].map((v) => <button className={strategy.holdHours === v ? "active" : ""} onClick={() => update("holdHours", v)} key={v}>{v === 24 ? "1D" : v === 72 ? "3D" : `${v}H`}</button>)}</div>
          </Control>
          <Control label="ROUND-TRIP COST" value={`${strategy.costs.toFixed(2)}%`}>
            <input aria-label="Transaction costs" type="range" min="0.04" max="0.5" step="0.02" value={strategy.costs} onChange={(e) => update("costs", +e.target.value)} />
            <div className="ticks"><span>0.04%</span><span>Realistic</span><span>0.50%</span></div>
          </Control>

          <div className="section-title event-title"><span>02</span><div><strong>EVENT CATEGORIES</strong><small>Select news signals</small></div></div>
          <div className="event-list">{CATEGORIES.map((cat, i) => <label key={cat}><input type="checkbox" checked={enabled[i]} onChange={() => setEnabled((e) => e.map((v, j) => i === j ? !v : v))} /><span className="check">✓</span><i style={{ background: COLORS[i] }} />{cat}</label>)}</div>
        </aside>

        <div className="results">
          <div className="section-title"><span>03</span><div><strong>SIMULATION RESULTS</strong><small>{trades.length.toLocaleString()} trades replayed · costs included</small></div><div className="confidence">● STATISTICAL CONFIDENCE <b>{trades.length >= 1000 ? "HIGH" : "LOW"}</b></div></div>

          <div className="metrics">
            <Metric label="STRATEGY RETURN" value={pct(totalReturn, true)} sub={`vs. ${pct(benchmark, true)} benchmark`} good={totalReturn > benchmark} />
            <Metric label="WIN RATE" value={pct(winRate)} sub={`${wins.length} winning trades`} />
            <Metric label="AVG. RETURN / TRADE" value={pct(avg, true)} sub={`Median ${pct(median, true)}`} good={avg > 0} />
            <Metric label="MAX DRAWDOWN" value={pct(-drawdown)} sub="Peak-to-trough" danger />
          </div>

          <div className="charts">
            <section className="panel performance">
              <div className="panel-head"><div><span>CUMULATIVE PERFORMANCE</span><small>Strategy vs. benchmark</small></div><div className="legend"><i className="lime" /> Atlas <i className="gray" /> S&amp;P 500</div></div>
              <div className="equity-chart">
                <div className="gridline g1"><span>+30%</span></div><div className="gridline g2"><span>+20%</span></div><div className="gridline g3"><span>+10%</span></div><div className="gridline g4"><span>0%</span></div>
                <div className="benchmark-line" style={{ height: `${20 + benchmark * 1.5}%` }} />
                <div className="strategy-line" style={{ height: `${20 + Math.max(0, Math.min(30, totalReturn)) * 1.5}%` }} />
                <div className="chart-label atlas" style={{ bottom: `${20 + Math.max(0, Math.min(30, totalReturn)) * 1.5}%` }}>{pct(totalReturn, true)}</div>
                <div className="chart-label bench" style={{ bottom: `${20 + benchmark * 1.5}%` }}>{pct(benchmark, true)}</div>
                <div className="months"><span>JAN</span><span>FEB</span><span>MAR</span><span>APR</span><span>MAY</span><span>JUN</span></div>
              </div>
            </section>

            <section className="panel category-panel">
              <div className="panel-head"><div><span>EDGE BY EVENT TYPE</span><small>Average return after costs</small></div></div>
              <div className="category-bars">{categoryStats.map((s) => <div className="bar-row" key={s.category}><div><span>{s.category.replace("Mergers & Acquisitions", "M&A")}</span><small>{s.count} trades · {s.wins.toFixed(0)}% win</small></div><div className="bar-track"><i style={{ width: `${Math.max(4, 35 + s.avg * 18)}%`, background: s.avg >= 0 ? s.color : "#fb7185" }} /></div><b className={s.avg >= 0 ? "positive" : "negative"}>{pct(s.avg, true)}</b></div>)}</div>
            </section>
          </div>

          <section className="panel ledger">
            <div className="panel-head"><div><span>TRADE LEDGER</span><small>Most recent simulated executions</small></div><button onClick={() => navigator.clipboard?.writeText(trades.map(t => `${t.date},${t.ticker},${t.category},${t.returnPct.toFixed(2)}%`).join("\n"))}>COPY CSV</button></div>
            <div className="table-wrap"><table><thead><tr><th>DATE</th><th>EVENT / TICKER</th><th>ENTRY</th><th>EXIT</th><th>HOLD</th><th>EXIT REASON</th><th>RETURN</th><th>RESULT</th></tr></thead><tbody>{visible.map((t) => <tr key={t.id}><td>{t.date}</td><td><strong>{t.ticker}</strong><small>{t.category}</small></td><td>${t.entry.toFixed(2)}</td><td>${t.exit.toFixed(2)}</td><td>{t.hold}h</td><td>{t.exitReason}</td><td className={t.returnPct > 0 ? "positive" : "negative"}>{pct(t.returnPct, true)}</td><td><span className={`result-pill ${t.returnPct > 0 ? "win" : "loss"}`}>{t.returnPct > 0 ? "WIN" : "LOSS"}</span></td></tr>)}</tbody></table></div>
            <div className="pager"><span>Showing {page * 8 + 1}–{Math.min(page * 8 + 8, trades.length)} of {trades.length.toLocaleString()}</span><div><button disabled={page === 0} onClick={() => setPage(Math.max(0, page - 1))}>←</button><button disabled={(page + 1) * 8 >= trades.length} onClick={() => setPage(page + 1)}>→</button></div></div>
          </section>
        </div>
      </section>
      <footer><span>ATLAS POC / HISTORICAL SIMULATION ONLY</span><span>Results are synthetic for prototype evaluation — not investment advice.</span></footer>
    </main>
  );
}

function Control({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return <div className="control"><div className="control-label"><label>{label}</label><b>{value}</b></div>{children}</div>;
}

function Metric({ label, value, sub, good, danger }: { label: string; value: string; sub: string; good?: boolean; danger?: boolean }) {
  return <div className="metric"><span>{label}</span><strong className={good ? "positive" : danger ? "negative" : ""}>{value}</strong><small>{sub}</small></div>;
}
