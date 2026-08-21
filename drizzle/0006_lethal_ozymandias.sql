CREATE TABLE IF NOT EXISTS `missed_opportunities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`candidate_id` integer NOT NULL,
	`trading_day` text NOT NULL,
	`ticker` text NOT NULL,
	`blocked_at` text NOT NULL,
	`blocked_stage` text NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`reference_price` real NOT NULL,
	`stop_distance_pct` real NOT NULL,
	`resolved` integer DEFAULT 0 NOT NULL,
	`would_have_won` integer,
	`mfe_pct` real,
	`mae_pct` real,
	`decided_after_minutes` integer,
	`resolved_at` text,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidates`(`id`) ON UPDATE no action ON DELETE no action
);
