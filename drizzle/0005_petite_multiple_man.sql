ALTER TABLE `scan_yield` ADD `subrequests` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trading_days` ADD `over_budget_scans` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trading_days` ADD `peak_subrequests` integer DEFAULT 0 NOT NULL;