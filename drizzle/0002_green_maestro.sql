CREATE TABLE `experiments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`hypothesis` text NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`proposed_config` text DEFAULT '{}' NOT NULL,
	`min_sample_size` integer DEFAULT 30 NOT NULL,
	`sample_size` integer DEFAULT 0 NOT NULL,
	`backtest_passed` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `knowledge_edges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_key` text NOT NULL,
	`to_key` text NOT NULL,
	`relation` text NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`evidence_count` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `knowledge_nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`type` text NOT NULL,
	`label` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_nodes_key_unique` ON `knowledge_nodes` (`key`);--> statement-breakpoint
CREATE TABLE `learning_journal` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`evidence` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
ALTER TABLE `candidates` ADD `score_band` text DEFAULT '0-19' NOT NULL;--> statement-breakpoint
ALTER TABLE `candidates` ADD `signal_breakdown` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `candidates` ADD `analyst_score` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `candidates` ADD `skeptic_penalty` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `candidates` ADD `near_miss` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `candidates` ADD `observation_type` text DEFAULT 'NON_TRADE' NOT NULL;--> statement-breakpoint
ALTER TABLE `positions` ADD `attribution` text;--> statement-breakpoint
ALTER TABLE `positions` ADD `atlas_edge` real;