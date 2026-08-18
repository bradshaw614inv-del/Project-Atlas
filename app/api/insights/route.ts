import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { candidates, connectionEvents, connectionStatus, experiments, knowledgeEdges, knowledgeNodes, learningJournal, marketWeatherLog, newsStories, positionEvents, positions, scanRuns, tradeReviews } from "../../../db/schema";

const PAPER_TRADE_TARGET = 100;
const HOLDOUT_TRADE_TARGET = 30;

export async function GET(request: Request) {
  const db = getDb();
  const candidateRows = await db.select().from(candidates).orderBy(desc(candidates.id)).limit(1000);
  const closed = await db.select().from(positions).where(eq(positions.status, "CLOSED")).orderBy(desc(positions.id)).limit(500);
  const bands = ["0-34", "35-49", "50-59", "60-79", "80-100"].map((band) => {
    const observations = candidateRows.filter((row) => row.scoreBand === band);
    const tradeIds = new Set(observations.filter((row) => row.observationType === "TRADE").map((row) => row.id));
    const outcomes = closed.filter((row) => row.candidateId && tradeIds.has(row.candidateId));
    const wins = outcomes.filter((row) => (row.realizedPnl ?? 0) > 0).length;
    return { band, count: observations.length, trades: tradeIds.size, closed: outcomes.length, wins, winRate: outcomes.length >= 30 ? wins / outcomes.length : null };
  });
  const realClosed = closed.filter((row) => !row.shadow);
  const shadowClosed = closed.filter((row) => row.shadow);
  const pnl = realClosed.reduce((sum, row) => sum + (row.realizedPnl ?? 0), 0);
  const shadowPnl = shadowClosed.reduce((sum, row) => sum + (row.realizedPnl ?? 0), 0);
  const atlasEdge = realClosed.length >= 30 ? realClosed.reduce((sum, row) => sum + (row.atlasEdge ?? 0), 0) / realClosed.length : null;
  const reviews = await db.select().from(tradeReviews).orderBy(desc(tradeReviews.id)).limit(60);
  const [connections, alerts] = await Promise.all([
    db.select().from(connectionStatus),
    db.select().from(connectionEvents).orderBy(desc(connectionEvents.id)).limit(25),
  ]);
  const [journal, experimentRows, nodes, edges, scans, weatherRows, stories] = await Promise.all([
    db.select().from(learningJournal).orderBy(desc(learningJournal.id)).limit(30),
    db.select().from(experiments).orderBy(desc(experiments.id)).limit(30),
    db.select().from(knowledgeNodes).limit(100),
    db.select().from(knowledgeEdges).orderBy(desc(knowledgeEdges.id)).limit(200),
    db.select().from(scanRuns).orderBy(desc(scanRuns.id)).limit(250),
    db.select().from(marketWeatherLog).orderBy(desc(marketWeatherLog.id)).limit(100),
    db.select().from(newsStories).orderBy(desc(newsStories.id)).limit(1000),
  ]);
  const traceableStories = stories.filter((story) => story.source.trim() && /^https?:\/\//i.test(story.url));
  const outlets = Array.from(new Set(traceableStories.map((story) => story.source.trim()).filter(Boolean))).sort();
  const hasEdgar = stories.some((story) => story.source === "SEC EDGAR");
  const completedScans = scans.filter((scan) => scan.finishedAt && !scan.error).length;
  const failedScans = scans.filter((scan) => !!scan.error).length;
  const recentCompleteness = weatherRows.map((row) => {
    const match = (JSON.parse(row.reasonFlags || "[]") as string[]).find((flag) => flag.startsWith("Weather data completeness "));
    return match ? Number(match.match(/(\d+)%/)?.[1] ?? 0) : 0;
  });
  const averageWeatherCompleteness = recentCompleteness.length ? recentCompleteness.reduce((sum, value) => sum + value, 0) / recentCompleteness.length : 0;
  const readiness = {
    status: realClosed.length >= PAPER_TRADE_TARGET && averageWeatherCompleteness >= 80 && failedScans === 0 ? "PILOT_REVIEW" : "NOT_READY",
    paperTrades: realClosed.length, paperTradeTarget: PAPER_TRADE_TARGET,
    holdoutTrades: 0, holdoutTradeTarget: HOLDOUT_TRADE_TARGET,
    completedScans, failedScans, averageWeatherCompleteness,
    gates: [
      { label: "Prospective paper trades", passed: realClosed.length >= PAPER_TRADE_TARGET, value: `${realClosed.length}/${PAPER_TRADE_TARGET}` },
      { label: "Weather input completeness", passed: averageWeatherCompleteness >= 80, value: `${averageWeatherCompleteness.toFixed(0)}% / 80%` },
      { label: "Recent scan reliability", passed: failedScans === 0 && completedScans >= 50, value: `${completedScans} complete · ${failedScans} failed` },
      { label: "Frozen-rule holdout", passed: false, value: `0/${HOLDOUT_TRADE_TARGET}` },
    ],
  };
  // Roles are static descriptions; status comes from the real probe recorded on
  // the last scan. A connection Atlas has never successfully reached reports
  // UNKNOWN rather than defaulting to LIVE.
  const ROLES: Record<string, string> = {
    "Yahoo Finance": "Quotes, session VWAP, and company news",
    "Nasdaq Trading Halts": "Hard entry gate",
    "Federal Reserve": "Macro-event caution gate",
    "BLS": "Official macro verification",
    "openFDA": "Regulatory corroboration",
    "Coinbase": "Independent crypto quote check",
    "Press-release wires": "Issuer press-release corroboration",
  };
  const byName = new Map(connections.map((row) => [row.name, row]));
  const sourceRoles = Object.entries(ROLES).map(([name, role]) => {
    const row = byName.get(name);
    return {
      name, role,
      status: row?.status ?? "UNKNOWN",
      critical: row?.critical === 1,
      detail: row?.detail ?? "never probed",
      lastOkAt: row?.lastOkAt ?? null,
      lastCheckedAt: row?.lastCheckedAt ?? null,
    };
  }).concat([
    { name: "Robinhood", role: "Broker execution — not connected; Atlas is paper-only", status: "NOT_CONNECTED", critical: false, detail: "No brokerage is connected. Atlas never places real orders.", lastOkAt: null, lastCheckedAt: null },
    { name: "X", role: "Discovery only; never scoring", status: "DISABLED", critical: false, detail: "Read API is paid.", lastOkAt: null, lastCheckedAt: null },
  ]);
  const downConnections = sourceRoles.filter((source) => source.status === "DOWN" || source.status === "DEGRADED");

  const positionId = Number(new URL(request.url).searchParams.get("positionId"));
  const replay = Number.isInteger(positionId) && positionId > 0
    ? await db.select().from(positionEvents).where(eq(positionEvents.positionId, positionId)).orderBy(positionEvents.id)
    : [];
  return Response.json({
    threshold: 60,
    phase: "INFORMATION_COLLECTION",
    provenance: { policy: "REAL_INPUTS_PAPER_OUTCOMES", providerCount: 9, providers: ["Yahoo Finance", "SEC EDGAR", "Nasdaq Trading Halts", "Federal Reserve", "BLS", "openFDA", "Coinbase", "Business Wire / PR Newswire", "Official issuer/agency releases"], outletCount: outlets.length, outlets, traceableStories: traceableStories.length, storiesChecked: stories.length, news: "Yahoo Finance company news, SEC EDGAR, press-release wires, and official issuer/agency releases", quotes: "Yahoo Finance real observed prices with independent Coinbase crypto corroboration", securities: "Real listed ticker universe", fills: "Paper calculations from observed scan quotes", simulatedFields: ["paper entry", "paper exit", "paper return", "paper loss", "paper portfolio value"], unavailableInputsAreSynthetic: false, sourceRoles },
    bands,
    nearMisses: candidateRows.filter((row) => row.nearMiss).slice(0, 50),
    confidenceTimeline: candidateRows.slice(0, 120).reverse().map((row) => ({ id: row.id, ticker: row.ticker, scanAt: row.scanAt, score: row.score, band: row.scoreBand, signals: JSON.parse(row.signalBreakdown || "[]") })),
    memory: { tradeObservations: candidateRows.filter((row) => row.observationType === "TRADE").length, nonTradeObservations: candidateRows.filter((row) => row.observationType === "NON_TRADE").length },
    performance: { closedTrades: realClosed.length, runningPnl: pnl, shadowClosed: shadowClosed.length, shadowPnl, atlasEdge },
    validationPolicy: { minSampleSize: PAPER_TRADE_TARGET, holdoutSampleSize: HOLDOUT_TRADE_TARGET, requiresBacktest: true, liveConfigMutationAllowed: false },
    readiness,
    journal, experiments: experimentRows, knowledgeGraph: { nodes, edges }, replay,
    tradeLearning: (() => {
      const withMfe = reviews.filter((r) => r.mfePct !== null);
      const stopped = reviews.filter((r) => r.exitReason === "STOP_LOSS" && r.postExitDriftPct !== null);
      const avg = (list: number[]) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
      return {
        reviews: reviews.slice(0, 25).map((r) => ({ ...r, findings: JSON.parse(r.findings || "[]") as string[] })),
        reviewed: reviews.length,
        avgMfePct: avg(withMfe.map((r) => r.mfePct!)),
        avgMaePct: avg(reviews.filter((r) => r.maePct !== null).map((r) => r.maePct!)),
        avgHoldMinutes: avg(reviews.map((r) => r.holdMinutes)),
        // A stop that is consistently followed by a bounce is sitting inside
        // normal noise rather than catching a real breakdown.
        stoppedThenRecovered: stopped.filter((r) => (r.postExitDriftPct ?? 0) > 0).length,
        stoppedTotal: stopped.length,
        // How much of the best in-trade move was actually captured.
        avgCapturedShare: avg(withMfe.filter((r) => (r.mfePct ?? 0) > 0.1).map((r) => (r.returnPct / r.mfePct!) * 100)),
      };
    })(),
    connectionHealth: {
      connections: sourceRoles,
      down: downConnections,
      criticalDown: downConnections.some((source) => source.critical && source.status === "DOWN"),
      alerts,
    },
  });
}
