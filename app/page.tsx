"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

const CATEGORIES = ["Defense contract", "FDA decision", "Earnings", "Merger or acquisition", "Commodity or geopolitical", "CEO change", "Other"];
const STORAGE_KEY = "atlas-forward-events-v1";

type PriceUpdate = { price: number; at: string };
type EventRecord = {
  id: string;
  headline: string;
  ticker: string;
  category: string;
  sourceUrl: string;
  eventAt: string;
  entryPrice: number;
  updates: PriceUpdate[];
};

function money(n: number, digits = 2) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

function localDateTimeValue() {
  const d = new Date();
  const shifted = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
}

function displayDate(value: string) {
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function Home() {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [ready, setReady] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [draftPrices, setDraftPrices] = useState<Record<string, string>>({});
  const startingAccount = 1000;
  const positionSize = 100;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setEvents(JSON.parse(saved));
    } catch { /* Start empty if local storage is unavailable. */ }
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  }, [events, ready]);

  const stats = useMemo(() => {
    const measured = events.filter((event) => event.updates.length > 0);
    const results = measured.map((event) => {
      const current = event.updates[event.updates.length - 1].price;
      return (current - event.entryPrice) / event.entryPrice * positionSize;
    });
    const profit = results.reduce((sum, result) => sum + result, 0);
    return { measured: measured.length, profit, winners: results.filter((result) => result > 0).length };
  }, [events]);

  function addEvent(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const record: EventRecord = {
      id: crypto.randomUUID(),
      headline: String(form.get("headline") || "").trim(),
      ticker: String(form.get("ticker") || "").trim().toUpperCase(),
      category: String(form.get("category") || "Other"),
      sourceUrl: String(form.get("sourceUrl") || "").trim(),
      eventAt: String(form.get("eventAt") || ""),
      entryPrice: Number(form.get("entryPrice")),
      updates: [],
    };
    setEvents((current) => [record, ...current]);
    setShowForm(false);
  }

  function addPriceUpdate(id: string) {
    const price = Number(draftPrices[id]);
    if (!Number.isFinite(price) || price <= 0) return;
    setEvents((current) => current.map((event) => event.id === id ? { ...event, updates: [...event.updates, { price, at: new Date().toISOString() }] } : event));
    setDraftPrices((current) => ({ ...current, [id]: "" }));
  }

  function exportCsv() {
    const rows = [["Event time", "Ticker", "Category", "Headline", "Source", "Starting price", "Latest price", "Dollar result"]];
    events.forEach((event) => {
      const latest = event.updates.at(-1)?.price;
      const result = latest ? (latest - event.entryPrice) / event.entryPrice * positionSize : "";
      rows.push([event.eventAt, event.ticker, event.category, event.headline, event.sourceUrl, String(event.entryPrice), latest ? String(latest) : "", String(result)]);
    });
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = "atlas-forward-tracker.csv"; link.click(); URL.revokeObjectURL(url);
  }

  return (
    <main>
      <header className="topbar">
        <div className="brand"><span className="brandmark">A</span><div><strong>ATLAS</strong><small>FORWARD NEWS TRACKER</small></div></div>
        <div className="mode"><span className="pulse" /> TRACKING FROM TODAY FORWARD</div>
      </header>

      <section className="hero forward-hero">
        <div><p className="eyebrow">REAL EVENTS · NO MADE-UP HISTORY</p><h1>Record what happens.<br /><em>Learn as we go.</em></h1><p className="lede">Add a real news event when it happens, record the stock price at that moment, then return later to update the price. Atlas builds evidence from today forward.</p></div>
        <button className="primary" onClick={() => setShowForm(true)}>＋ ADD A REAL EVENT</button>
      </section>

      <section className="truth-banner">
        <strong>How this works</strong><span>Atlas does not invent news or prices. You enter them from the source you trust, and every record keeps its source link and timestamp.</span><Info text="This no-signup version stores records only in this browser on this device. Export the CSV regularly as a backup. Data entered on your phone will not automatically appear on your computer." />
      </section>

      <section className="account-strip">
        <div><span>MODEL ACCOUNT</span><strong>{money(startingAccount, 0)}</strong><small>Ten {money(positionSize, 0)} position slots</small></div>
        <div><span>EVENTS RECORDED</span><strong>{events.length}</strong><small>{stats.measured} with a price update</small></div>
        <div><span>CURRENT TRACKED PROFIT</span><strong className={stats.profit >= 0 ? "positive" : "negative"}>{stats.profit >= 0 ? "+" : ""}{money(stats.profit)}</strong><small>Across updated positions</small></div>
        <div><span>WINNING POSITIONS</span><strong>{stats.measured ? `${Math.round(stats.winners / stats.measured * 100)}%` : "—"}</strong><small>{stats.winners} of {stats.measured}</small></div>
      </section>

      <section className="tracker">
        <div className="tracker-head"><div><span>FORWARD LOG</span><h2>Real events being tracked</h2><p>Update each price whenever you want a new checkpoint.</p></div>{events.length > 0 && <button className="secondary" onClick={exportCsv}>DOWNLOAD BACKUP</button>}</div>

        {!ready ? <div className="empty"><strong>Loading your tracker…</strong></div> : events.length === 0 ? <div className="empty">
          <span className="empty-mark">＋</span><h3>Your tracker starts empty—on purpose.</h3><p>There are no example trades or fictional results. When you see a real news event, add it here with the source and stock price.</p><button className="primary" onClick={() => setShowForm(true)}>ADD YOUR FIRST EVENT</button>
        </div> : <div className="event-grid">{events.map((event) => {
          const latest = event.updates.at(-1);
          const returnPct = latest ? (latest.price - event.entryPrice) / event.entryPrice * 100 : 0;
          const result = positionSize * returnPct / 100;
          return <article className="event-card" key={event.id}>
            <div className="event-top"><div><span className="category">{event.category}</span><strong>{event.ticker}</strong></div><time>{displayDate(event.eventAt)}</time></div>
            <h3>{event.headline}</h3>
            <div className="event-numbers">
              <div><span>PRICE WHEN NEWS HIT</span><b>{money(event.entryPrice)}</b></div>
              <div><span>LATEST PRICE ENTERED</span><b>{latest ? money(latest.price) : "Waiting"}</b></div>
              <div><span>RESULT ON {money(positionSize, 0)}</span><b className={latest ? result >= 0 ? "positive" : "negative" : ""}>{latest ? `${result >= 0 ? "+" : ""}${money(result)} (${returnPct.toFixed(2)}%)` : "—"}</b></div>
            </div>
            <div className="event-actions">
              <label><span>Enter today’s stock price</span><input inputMode="decimal" type="number" min="0.01" step="0.01" placeholder="0.00" value={draftPrices[event.id] || ""} onChange={(e) => setDraftPrices((current) => ({ ...current, [event.id]: e.target.value }))} /></label>
              <button onClick={() => addPriceUpdate(event.id)}>SAVE UPDATE</button>
              {event.sourceUrl && <a href={event.sourceUrl} target="_blank" rel="noreferrer">VIEW SOURCE ↗</a>}
            </div>
            {latest && <small className="updated">Last updated {displayDate(latest.at)}</small>}
          </article>;
        })}</div>}
      </section>

      <footer><span>ATLAS FORWARD TRACKER</span><span>Observation tool only — not investment advice and does not place trades.</span></footer>

      {showForm && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.currentTarget === e.target) setShowForm(false); }}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="add-title">
          <div className="modal-head"><div><span>NEW REAL-WORLD RECORD</span><h2 id="add-title">Add a news event</h2></div><button aria-label="Close" onClick={() => setShowForm(false)}>×</button></div>
          <p>Use the article’s original publication time and the stock price you observed then. Include the source so the record can be checked later.</p>
          <form onSubmit={addEvent}>
            <label className="wide"><span>What happened?</span><input name="headline" required placeholder="Example: Company announces a new contract" /></label>
            <label><span>Stock ticker</span><input name="ticker" required maxLength={8} placeholder="Example: LMT" /></label>
            <label><span>Type of news</span><select name="category">{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label>
            <label><span>Date and time published</span><input name="eventAt" type="datetime-local" required defaultValue={localDateTimeValue()} /></label>
            <label><span>Stock price at that time</span><input name="entryPrice" inputMode="decimal" type="number" min="0.01" step="0.01" required placeholder="0.00" /></label>
            <label className="wide"><span>Link to the original source</span><input name="sourceUrl" type="url" required placeholder="https://…" /></label>
            <div className="form-actions"><button type="button" className="secondary" onClick={() => setShowForm(false)}>CANCEL</button><button className="primary" type="submit">START TRACKING</button></div>
          </form>
        </section>
      </div>}
    </main>
  );
}

function Info({ text }: { text: string }) {
  return <details className="info"><summary aria-label="More information">?</summary><div>{text}</div></details>;
}
