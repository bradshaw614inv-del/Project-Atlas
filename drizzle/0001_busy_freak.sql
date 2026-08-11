ALTER TABLE `account_state` ADD `max_open_positions` integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE `account_state` ADD `risk_per_trade_pct` real DEFAULT 0.25 NOT NULL;