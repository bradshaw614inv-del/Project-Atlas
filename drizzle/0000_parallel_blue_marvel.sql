CREATE TABLE `account_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`starting_capital` real DEFAULT 1000 NOT NULL,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`daily_realized_pnl` real DEFAULT 0 NOT NULL,
	`daily_loss_shutdown` integer DEFAULT 0 NOT NULL,
	`consecutive_losses` integer DEFAULT 0 NOT NULL,
	`trading_day` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer,
	`ticker` text NOT NULL,
	`scan_at` text NOT NULL,
	`score` real NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`price_at_scan` real,
	`price_change_pct` real,
	`market_weather` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `news_stories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `market_weather_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scan_at` text NOT NULL,
	`classification` text NOT NULL,
	`spy_price` real,
	`spy_change_pct` real,
	`qqq_change_pct` real,
	`reason_flags` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `news_stories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`finnhub_id` text NOT NULL,
	`headline` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`published_at` text NOT NULL,
	`related_tickers` text DEFAULT '' NOT NULL,
	`finnhub_category` text DEFAULT '' NOT NULL,
	`first_seen_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `news_stories_finnhub_id_unique` ON `news_stories` (`finnhub_id`);--> statement-breakpoint
CREATE TABLE `position_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` integer NOT NULL,
	`at` text NOT NULL,
	`type` text NOT NULL,
	`price` real NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`story_id` integer,
	`candidate_id` integer,
	`status` text NOT NULL,
	`shadow` integer DEFAULT 0 NOT NULL,
	`entry_price` real NOT NULL,
	`entry_at` text NOT NULL,
	`shares` real NOT NULL,
	`initial_stop_price` real NOT NULL,
	`stop_price` real NOT NULL,
	`target_price` real,
	`high_water_mark` real NOT NULL,
	`trailing_activated` integer DEFAULT 0 NOT NULL,
	`exit_price` real,
	`exit_at` text,
	`exit_reason` text,
	`realized_pnl` real,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `news_stories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `scan_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`stories_fetched` integer DEFAULT 0 NOT NULL,
	`candidates_evaluated` integer DEFAULT 0 NOT NULL,
	`positions_opened` integer DEFAULT 0 NOT NULL,
	`positions_closed` integer DEFAULT 0 NOT NULL,
	`error` text
);
