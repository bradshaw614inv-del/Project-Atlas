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

function money(n: number, signed = false) {
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)}`;
}

export default function Home() {
  const [strategy, setStrategy] = useState<Strategy>({ entryDelay: 15, trailingStop: 4, profitTarget: 8, holdHours: 24, costs: 0.18 });
  const [enabled, setEnabled] = useState(CATEGORIES.map(() => true));
  const [capital, setCapital] = useState(1000);
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
  const endingBalance = capital * (1 + totalReturn / 100);
  const dollarProfit = endingBalance - capital;
  const positionSize = capital * 0.1;

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
        <div><p className="eyebrow">TRY A HISTORICAL WHAT-IF</p><h1>Replay the news.<br /><em>See what might happen.</em></h1><p className="lede">Choose simple trading rules, then Atlas rewinds six months and shows how those choices could have performed. No trading experience needed.</p></div>
        <div className="runbox">
          <div><span>LAST RUN</span><strong>{lastRun}</strong></div>
          <button onClick={runSimulation} disabled={running}>{running ? "REPLAYING…" : "▶  RUN SIMULATION"}</button>
        </div>
      </section>

      <section className="starter-guide">
        <div className="guide-icon">1</div><div><strong>Choose your rules</strong><span>Set when to buy and when to sell. The <b>?</b> buttons explain every choice.</span></div>
        <div className="guide-line" />
        <div className="guide-icon">2</div><div><strong>Run the replay</strong><span>Atlas tests those rules on more than 1,000 example trades.</span></div>
        <div className="guide-line" />
        <div className="guide-icon">3</div><div><strong>Read the results</strong><span>Green is generally better; red shows losses or risk.</span></div>
      </section>

      <section className="money-plan">
        <div><span>YOUR STARTING MONEY</span><strong>{money(capital)}</strong></div>
        <p>Atlas divides it into <b>10 equal parts</b>. Each example trade uses up to <b>{money(positionSize)}</b>, so one bad trade cannot use the whole account.</p>
        <Info text={`With ${money(capital)}, Atlas allows up to 10 positions of about ${money(positionSize)} each. This prototype applies the strategy's simulated percentage result to the account; it does not place real Robinhood orders.`} />
      </section>

      <section className="workspace">
        <aside className="controls">
          <div className="section-title"><span>01</span><div><strong>CHOOSE YOUR RULES</strong><small>How should each example trade work?</small></div></div>

          <Control label="MONEY TO START WITH" value={money(capital)} help="This is the starting account value for the historical test. Atlas does not move real money. It only shows what the simulated percentage results mean in dollars.">
            <div className="segmented four">{[500, 1000, 2500, 5000].map((v) => <button className={capital === v ? "active" : ""} onClick={() => setCapital(v)} key={v}>${v >= 1000 ? `${v / 1000}K` : v}</button>)}</div>
          </Control>

          <Control label="WHEN TO BUY" value={`${strategy.entryDelay} min`} help="How long Atlas waits after a news story appears before buying. ‘Now’ means immediately; 15 means waiting 15 minutes to see how the market reacts.">
            <div className="segmented">{[0, 5, 15, 30, 60].map((v) => <button className={strategy.entryDelay === v ? "active" : ""} onClick={() => update("entryDelay", v)} key={v}>{v === 0 ? "NOW" : v}</button>)}</div>
          </Control>
          <Control label="LIMIT A LOSS" value={`${strategy.trailingStop}%`} help="A trailing stop sells when the price falls this percentage from its highest point after you buy. A smaller number exits sooner; a larger number gives the trade more room to move.">
            <input aria-label="Trailing stop" type="range" min="2" max="10" step="2" value={strategy.trailingStop} onChange={(e) => update("trailingStop", +e.target.value)} />
            <div className="ticks"><span>2%</span><span>6%</span><span>10%</span></div>
          </Control>
          <Control label="TAKE A PROFIT" value={`${strategy.profitTarget}%`} help="Atlas sells automatically when the trade gains this much. For example, an 8% target sells a $100 investment when it reaches about $108, before costs.">
            <input aria-label="Profit target" type="range" min="4" max="20" step="2" value={strategy.profitTarget} onChange={(e) => update("profitTarget", +e.target.value)} />
            <div className="ticks"><span>4%</span><span>12%</span><span>20%</span></div>
          </Control>
          <Control label="HOW LONG TO WAIT" value={`${strategy.holdHours} hr`} help="The longest Atlas keeps a trade open. If the loss limit or profit target is not reached, Atlas sells when this time runs out.">
            <div className="segmented four">{[4, 8, 24, 72].map((v) => <button className={strategy.holdHours === v ? "active" : ""} onClick={() => update("holdHours", v)} key={v}>{v === 24 ? "1D" : v === 72 ? "3D" : `${v}H`}</button>)}</div>
          </Control>
          <Control label="ESTIMATED ROBINHOOD EXECUTION COST" value={`${strategy.costs.toFixed(2)}%`} help="Robinhood charges no commission for stock trades, but real orders can still lose a little to the bid–ask spread, price movement while the order fills (slippage), and small sell-side regulatory fees. Atlas subtracts this estimate from every completed buy-and-sell trade.">
            <input aria-label="Transaction costs" type="range" min="0.04" max="0.5" step="0.02" value={strategy.costs} onChange={(e) => update("costs", +e.target.value)} />
            <div className="ticks"><span>0.04%</span><span>Realistic</span><span>0.50%</span></div>
          </Control>

          <div className="section-title event-title"><span>02</span><div><strong>CHOOSE NEWS TYPES</strong><small>What kind of news should trigger a trade?</small></div></div>
          <div className="event-list">{CATEGORIES.map((cat, i) => <label key={cat}><input type="checkbox" checked={enabled[i]} onChange={() => setEnabled((e) => e.map((v, j) => i === j ? !v : v))} /><span className="check">✓</span><i style={{ background: COLORS[i] }} />{cat}</label>)}</div>
        </aside>

        <div className="results">
          <div className="section-title"><span>03</span><div><strong>WHAT HAPPENED?</strong><small>{trades.length.toLocaleString()} example trades replayed · estimated costs included</small></div><div className="confidence">● AMOUNT OF EVIDENCE <b>{trades.length >= 1000 ? "STRONG" : "LIMITED"}</b><Info text="More examples generally make a result less likely to be random. This does not guarantee the strategy will work in the future." /></div></div>

          <div className="metrics">
            <Metric label="ESTIMATED ENDING BALANCE" value={money(endingBalance)} sub={`${money(dollarProfit, true)} · ${pct(totalReturn, true)}`} help={`Starting with ${money(capital)}, this is the estimated account value at the end of the six-month replay. It assumes the strategy spreads money across positions and reinvests results.`} good={dollarProfit > 0} />
            <Metric label="TRADES THAT MADE MONEY" value={pct(winRate)} sub={`${wins.length} winning trades`} help="The percentage of completed trades that ended above their purchase price after estimated trading costs." />
            <Metric label="TYPICAL $100 TRADE" value={money(positionSize * avg / 100, true)} sub={`${pct(avg, true)} average result`} help={`Each trade uses about one-tenth of the starting money—${money(positionSize)} here. This shows the average dollar gain or loss for one such trade.`} good={avg > 0} />
            <Metric label="BIGGEST ACCOUNT DROP" value={money(-capital * drawdown / 100)} sub={`${pct(-drawdown)} from a previous high`} help="Also called maximum drawdown. It shows the worst estimated dollar decline before the strategy recovered or the test ended." danger />
          </div>

          <div className="charts">
            <section className="panel performance">
              <div className="panel-head"><div><span>HOW $100 WOULD HAVE CHANGED</span><small>Atlas strategy compared with the broad U.S. market</small></div><div className="legend"><i className="lime" /> Atlas <i className="gray" /> S&amp;P 500 <Info text="A benchmark is a simple comparison used to judge whether a strategy added value. Here, Atlas is compared with the S&P 500." /></div></div>
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
              <div className="panel-head"><div><span>WHICH NEWS TYPES DID BEST?</span><small>Average result per trade after estimated costs</small></div><Info text="An ‘edge’ means a pattern that performed better than chance or a simple comparison in the historical test. It is evidence to investigate, not a promise about the future." /></div>
              <div className="category-bars">{categoryStats.map((s) => <div className="bar-row" key={s.category}><div><span>{s.category.replace("Mergers & Acquisitions", "M&A")}</span><small>{s.count} trades · {s.wins.toFixed(0)}% win</small></div><div className="bar-track"><i style={{ width: `${Math.max(4, 35 + s.avg * 18)}%`, background: s.avg >= 0 ? s.color : "#fb7185" }} /></div><b className={s.avg >= 0 ? "positive" : "negative"}>{pct(s.avg, true)}</b></div>)}</div>
            </section>
          </div>

          <section className="panel ledger">
            <div className="panel-head"><div><span>EVERY EXAMPLE TRADE</span><small>A detailed list of what Atlas bought and sold</small></div><button onClick={() => navigator.clipboard?.writeText(trades.map(t => `${t.date},${t.ticker},${t.category},${t.returnPct.toFixed(2)}%`).join("\n"))}>COPY LIST</button></div>
            <div className="table-wrap"><table><thead><tr><th>DATE</th><th>EVENT / TICKER</th><th>AMOUNT USED</th><th>BUY PRICE</th><th>SELL PRICE</th><th>TIME HELD</th><th>WHY IT SOLD</th><th>GAIN / LOSS</th><th>RESULT</th></tr></thead><tbody>{visible.map((t) => <tr key={t.id}><td>{t.date}</td><td><strong>{t.ticker}</strong><small>{t.category}</small></td><td>{money(positionSize)}<small>{(positionSize / t.entry).toFixed(2)} shares</small></td><td>${t.entry.toFixed(2)}</td><td>${t.exit.toFixed(2)}</td><td>{t.hold}h</td><td>{t.exitReason}</td><td className={t.returnPct > 0 ? "positive" : "negative"}>{money(positionSize * t.returnPct / 100, true)}<small>{pct(t.returnPct, true)}</small></td><td><span className={`result-pill ${t.returnPct > 0 ? "win" : "loss"}`}>{t.returnPct > 0 ? "WIN" : "LOSS"}</span></td></tr>)}</tbody></table></div>
            <div className="pager"><span>Showing {page * 8 + 1}–{Math.min(page * 8 + 8, trades.length)} of {trades.length.toLocaleString()}</span><div><button disabled={page === 0} onClick={() => setPage(Math.max(0, page - 1))}>←</button><button disabled={(page + 1) * 8 >= trades.length} onClick={() => setPage(page + 1)}>→</button></div></div>
          </section>
        </div>
      </section>
      <footer><span>ATLAS POC / HISTORICAL SIMULATION ONLY</span><span>Results are synthetic for prototype evaluation — not investment advice.</span></footer>
    </main>
  );
}

function Info({ text }: { text: string }) {
  return <details className="info"><summary aria-label="Explain this term">?</summary><div>{text}</div></details>;
}

function Control({ label, value, help, children }: { label: string; value: string; help: string; children: React.ReactNode }) {
  return <div className="control"><div className="control-label"><label>{label} <Info text={help} /></label><b>{value}</b></div>{children}</div>;
}

function Metric({ label, value, sub, help, good, danger }: { label: string; value: string; sub: string; help: string; good?: boolean; danger?: boolean }) {
  return <div className="metric"><span>{label} <Info text={help} /></span><strong className={good ? "positive" : danger ? "negative" : ""}>{value}</strong><small>{sub}</small></div>;
}
