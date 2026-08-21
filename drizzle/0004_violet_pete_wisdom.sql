-- Adds the dated trading-day record, operator notes, and the funnel stage on
-- candidates.
--
-- The CREATE TABLE statements for connection_events, connection_status,
-- scan_yield and trade_reviews are re-emitted because drizzle/meta's snapshot
-- had drifted behind the schema (two files both numbered 0003 landed without a
-- matching snapshot). They are guarded with IF NOT EXISTS so this migration is
-- safe against a database that already has them and against one that does not.

CREATE TABLE IF NOT EXISTS `connection_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`name` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`severity` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`acknowledged_at` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `connection_status` (
	`name` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'DATA' NOT NULL,
	`status` text NOT NULL,
	`critical` integer DEFAULT 0 NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_ok_at` text,
	`last_checked_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `operator_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trading_day` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`kind` text DEFAULT 'OBSERVATION' NOT NULL,
	`body` text NOT NULL,
	`resolved` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `scan_yield` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scan_at` text NOT NULL,
	`quotes_usable` integer DEFAULT 0 NOT NULL,
	`quotes_requested` integer DEFAULT 0 NOT NULL,
	`stories_fetched` integer DEFAULT 0 NOT NULL,
	`stories_with_body` integer DEFAULT 0 NOT NULL,
	`candidates_scored` integer DEFAULT 0 NOT NULL,
	`breadth_sample` integer DEFAULT 0 NOT NULL,
	`filings_found` integer DEFAULT 0 NOT NULL,
	`news_tickers_queried` integer DEFAULT 0 NOT NULL,
	`sufficient` integer DEFAULT 1 NOT NULL,
	`findings` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `trade_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` integer NOT NULL,
	`reviewed_at` text NOT NULL,
	`ticker` text NOT NULL,
	`entry_score` real,
	`entry_band` text DEFAULT '' NOT NULL,
	`catalyst_label` text DEFAULT '' NOT NULL,
	`market_weather` text DEFAULT '' NOT NULL,
	`entry_hour_et` integer,
	`independent_sources` integer DEFAULT 0 NOT NULL,
	`realized_pnl` real NOT NULL,
	`return_pct` real NOT NULL,
	`exit_reason` text DEFAULT '' NOT NULL,
	`hold_minutes` integer DEFAULT 0 NOT NULL,
	`mfe_pct` real,
	`mae_pct` real,
	`mfe_minutes` integer,
	`mae_minutes` integer,
	`stop_distance_pct` real,
	`post_exit_drift_pct` real,
	`findings` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `trading_days` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trading_day` text NOT NULL,
	`is_trading_day` integer DEFAULT 1 NOT NULL,
	`scans` integer DEFAULT 0 NOT NULL,
	`stories_fetched` integer DEFAULT 0 NOT NULL,
	`candidates_scored` integer DEFAULT 0 NOT NULL,
	`positions_opened` integer DEFAULT 0 NOT NULL,
	`positions_closed` integer DEFAULT 0 NOT NULL,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`blind_scans` integer DEFAULT 0 NOT NULL,
	`market_weather` text,
	`stage_counts` text DEFAULT '{}' NOT NULL,
	`verdict` text,
	`headline` text,
	`analysis` text,
	`actionable` integer DEFAULT 0 NOT NULL,
	`first_scan_at` text,
	`last_scan_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `trading_days_trading_day_unique` ON `trading_days` (`trading_day`);--> statement-breakpoint
ALTER TABLE `candidates` ADD `blocked_stage` text;