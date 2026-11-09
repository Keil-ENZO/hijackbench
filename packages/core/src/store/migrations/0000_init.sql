CREATE TABLE `annotations` (
	`run_id` integer PRIMARY KEY NOT NULL,
	`verdict` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "annotations_verdict" CHECK(verdict IN ('compromised', 'partial', 'resisted_success', 'resisted_failure', 'technical_error'))
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `control` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` text NOT NULL,
	`key` text NOT NULL,
	`model` text NOT NULL,
	`task_id` text NOT NULL,
	`attack_id` text,
	`repetition` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`duration_ms` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runs_status" CHECK(status IN ('done', 'error')),
	CONSTRAINT "runs_error" CHECK(("runs"."status" = 'error') = ("runs"."error" IS NOT NULL)),
	CONSTRAINT "runs_repetition" CHECK("runs"."repetition" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_campaign_key` ON `runs` (`campaign_id`,`key`);--> statement-breakpoint
CREATE INDEX `runs_campaign_model_task` ON `runs` (`campaign_id`,`model`,`task_id`);--> statement-breakpoint
CREATE TABLE `traces` (
	`run_id` integer PRIMARY KEY NOT NULL,
	`trace` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `verdicts` (
	`run_id` integer PRIMARY KEY NOT NULL,
	`verdict` text NOT NULL,
	`task_success` integer NOT NULL,
	`reason` text NOT NULL,
	`judge_version` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "verdicts_verdict" CHECK(verdict IN ('compromised', 'partial', 'resisted_success', 'resisted_failure', 'technical_error'))
);
--> statement-breakpoint
CREATE INDEX `verdicts_verdict` ON `verdicts` (`verdict`);