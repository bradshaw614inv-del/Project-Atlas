CREATE TABLE `account_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`amount` real NOT NULL,
	`balance_after` real NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_account_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`starting_capital` real DEFAULT 10000 NOT NULL,
	`max_open_positions` integer DEFAULT 6 NOT NULL,
	`risk_per_trade_pct` real DEFAULT 0.25 NOT NULL,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`daily_realized_pnl` real DEFAULT 0 NOT NULL,
	`daily_loss_shutdown` integer DEFAULT 0 NOT NULL,
	`consecutive_losses` integer DEFAULT 0 NOT NULL,
	`trading_day` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_account_state`("id", "starting_capital", "max_open_positions", "risk_per_trade_pct", "realized_pnl", "daily_realized_pnl", "daily_loss_shutdown", "consecutive_losses", "trading_day", "updated_at") SELECT "id", "starting_capital", "max_open_positions", "risk_per_trade_pct", "realized_pnl", "daily_realized_pnl", "daily_loss_shutdown", "consecutive_losses", "trading_day", "updated_at" FROM `account_state`;--> statement-breakpoint
DROP TABLE `account_state`;--> statement-breakpoint
ALTER TABLE `__new_account_state` RENAME TO `account_state`;--> statement-breakpoint
PRAGMA foreign_keys=ON;