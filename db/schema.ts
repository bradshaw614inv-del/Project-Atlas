import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// A verified news story pulled from Finnhub. One row per distinct story we've observed.
export const newsStories = sqliteTable("news_stories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  finnhubId: text("finnhub_id").notNull().unique(),
  headline: text("headline").notNull(),
  summary: text("summary").notNull().default(""),
  source: text("source").notNull().default(""),
  url: text("url").notNull().default(""),
  publishedAt: text("published_at").notNull(),
  relatedTickers: text("related_tickers").notNull().default(""), // comma-separated
  finnhubCategory: text("finnhub_category").notNull().default(""),
  firstSeenAt: text("first_seen_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// One row per ticker per scan: the scored evaluation, whether it qualified, and why.
// This is the permanent audit trail — accepted AND rejected candidates are recorded.
export const candidates = sqliteTable("candidates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storyId: integer("story_id").references(() => newsStories.id),
  ticker: text("ticker").notNull(),
  scanAt: text("scan_at").notNull(),
  score: real("score").notNull(),
  status: text("status").notNull(), // WATCH | CAUTION | DISQUALIFIED
  reason: text("reason").notNull(),
  priceAtScan: real("price_at_scan"),
  priceChangePct: real("price_change_pct"),
  marketWeather: text("market_weather").notNull(),
  scoreBand: text("score_band").notNull().default("0-19"),
  signalBreakdown: text("signal_breakdown").notNull().default("[]"),
  analystScore: real("analyst_score").notNull().default(0),
  skepticPenalty: real("skeptic_penalty").notNull().default(0),
  nearMiss: integer("near_miss").notNull().default(0),
  observationType: text("observation_type").notNull().default("NON_TRADE"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// A simulated (paper) position — never a real order. Opened and managed entirely by the engine.
export const positions = sqliteTable("positions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  storyId: integer("story_id").references(() => newsStories.id),
  candidateId: integer("candidate_id").references(() => candidates.id),
  status: text("status").notNull(), // OPEN | CLOSED
  shadow: integer("shadow").notNull().default(0), // 1 = "did not buy" shadow position on a Sit-out day
  entryPrice: real("entry_price").notNull(),
  entryAt: text("entry_at").notNull(),
  shares: real("shares").notNull(),
  initialStopPrice: real("initial_stop_price").notNull(),
  stopPrice: real("stop_price").notNull(),
  targetPrice: real("target_price"),
  highWaterMark: real("high_water_mark").notNull(),
  trailingActivated: integer("trailing_activated").notNull().default(0),
  exitPrice: real("exit_price"),
  exitAt: text("exit_at"),
  exitReason: text("exit_reason"), // STOP_LOSS | TRAILING_STOP | MARKET_CLOSE
  realizedPnl: real("realized_pnl"),
  attribution: text("attribution"),
  atlasEdge: real("atlas_edge"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Audit trail of every material change to a position (opened, stop moved, closed, etc).
export const positionEvents = sqliteTable("position_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  positionId: integer("position_id").notNull().references(() => positions.id),
  at: text("at").notNull(),
  type: text("type").notNull(), // OPENED | STOP_MOVED | TRAILING_ACTIVATED | CLOSED
  price: real("price").notNull(),
  detail: text("detail").notNull().default(""),
});

// One row per scan: the overall market-weather classification and the signals behind it.
export const marketWeatherLog = sqliteTable("market_weather_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scanAt: text("scan_at").notNull(),
  classification: text("classification").notNull(), // TRADE_ELIGIBLE | CAUTION | SIT_OUT
  spyPrice: real("spy_price"),
  spyChangePct: real("spy_change_pct"),
  qqqChangePct: real("qqq_change_pct"),
  reasonFlags: text("reason_flags").notNull().default(""), // JSON array of strings
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Single-row simulated account: sizing basis, daily circuit breaker, realized P&L.
export const accountState = sqliteTable("account_state", {
  id: integer("id").primaryKey(),
  startingCapital: real("starting_capital").notNull().default(10000),
  maxOpenPositions: integer("max_open_positions").notNull().default(6),
  riskPerTradePct: real("risk_per_trade_pct").notNull().default(0.25),
  realizedPnl: real("realized_pnl").notNull().default(0),
  dailyRealizedPnl: real("daily_realized_pnl").notNull().default(0),
  dailyLossShutdown: integer("daily_loss_shutdown").notNull().default(0),
  consecutiveLosses: integer("consecutive_losses").notNull().default(0),
  tradingDay: text("trading_day").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Append-only cash ledger. Contributions change buying power, never trading P&L.
export const accountTransactions = sqliteTable("account_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(), // CONTRIBUTION
  amount: real("amount").notNull(),
  balanceAfter: real("balance_after").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Observability for each cron execution.
export const scanRuns = sqliteTable("scan_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  storiesFetched: integer("stories_fetched").notNull().default(0),
  candidatesEvaluated: integer("candidates_evaluated").notNull().default(0),
  positionsOpened: integer("positions_opened").notNull().default(0),
  positionsClosed: integer("positions_closed").notNull().default(0),
  error: text("error"),
});

// Append-only learning records. Changes never alter the live 60-point gate directly.
export const learningJournal = sqliteTable("learning_journal", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  kind: text("kind").notNull(), // ATTRIBUTION | CALIBRATION | EXPERIMENT | PATTERN
  title: text("title").notNull(),
  detail: text("detail").notNull().default(""),
  evidence: text("evidence").notNull().default("{}"),
});

export const experiments = sqliteTable("experiments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  hypothesis: text("hypothesis").notNull(),
  status: text("status").notNull().default("DRAFT"), // DRAFT | BACKTEST | VALIDATED | REJECTED
  proposedConfig: text("proposed_config").notNull().default("{}"),
  minSampleSize: integer("min_sample_size").notNull().default(30),
  sampleSize: integer("sample_size").notNull().default(0),
  backtestPassed: integer("backtest_passed").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// One post-mortem per closed position, built from real intraday bars after the
// trade is done. This is where Atlas learns: not just what a trade returned,
// but how it got there — how far it ran in favour before reversing, how close
// it came to the stop before recovering, and where it went after the exit.
export const tradeReviews = sqliteTable("trade_reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  positionId: integer("position_id").notNull().references(() => positions.id),
  reviewedAt: text("reviewed_at").notNull(),
  ticker: text("ticker").notNull(),
  // Entry context, denormalised so analysis never depends on a join surviving.
  entryScore: real("entry_score"),
  entryBand: text("entry_band").notNull().default(""),
  catalystLabel: text("catalyst_label").notNull().default(""),
  marketWeather: text("market_weather").notNull().default(""),
  entryHourEt: integer("entry_hour_et"),
  independentSources: integer("independent_sources").notNull().default(0),
  // Outcome
  realizedPnl: real("realized_pnl").notNull(),
  returnPct: real("return_pct").notNull(),
  exitReason: text("exit_reason").notNull().default(""),
  holdMinutes: integer("hold_minutes").notNull().default(0),
  // Excursions: the most useful trade-analysis numbers there are. MFE says how
  // much was left on the table; MAE says how much heat was taken before the
  // outcome, and whether the stop sat too close to normal noise.
  mfePct: real("mfe_pct"),
  maePct: real("mae_pct"),
  mfeMinutes: integer("mfe_minutes"),
  maeMinutes: integer("mae_minutes"),
  stopDistancePct: real("stop_distance_pct"),
  // Did price keep going the way of the exit, or reverse right after? A
  // consistently positive drift after a stop means the stop is too tight.
  postExitDriftPct: real("post_exit_drift_pct"),
  // Plain-language observations derived only from the numbers above.
  findings: text("findings").notNull().default("[]"),
});

export const knowledgeNodes = sqliteTable("knowledge_nodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  type: text("type").notNull(), // TICKER | SECTOR | CATALYST | REGIME
  label: text("label").notNull(),
  metadata: text("metadata").notNull().default("{}"),
});

// Current state of every upstream Atlas depends on. Rows are created the first
// time a connection is probed, so adding a future connection (a broker, say)
// needs no migration — only a probe that reports its status.
export const connectionStatus = sqliteTable("connection_status", {
  name: text("name").primaryKey(),
  kind: text("kind").notNull().default("DATA"), // DATA | BROKER
  status: text("status").notNull(), // LIVE | DEGRADED | DOWN | DISABLED
  critical: integer("critical").notNull().default(0), // 1 = losing it should block trading
  detail: text("detail").notNull().default(""),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastOkAt: text("last_ok_at"),
  lastCheckedAt: text("last_checked_at").notNull(),
});

// Append-only transition log — the notification feed. One row per real status
// change, never one per scan, so a feed that is down for an hour produces a
// single alert rather than twelve.
export const connectionEvents = sqliteTable("connection_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull(),
  name: text("name").notNull(),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  severity: text("severity").notNull(), // INFO | WARNING | CRITICAL
  detail: text("detail").notNull().default(""),
  acknowledgedAt: text("acknowledged_at"),
});

export const knowledgeEdges = sqliteTable("knowledge_edges", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fromKey: text("from_key").notNull(),
  toKey: text("to_key").notNull(),
  relation: text("relation").notNull(),
  weight: real("weight").notNull().default(1),
  evidenceCount: integer("evidence_count").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
