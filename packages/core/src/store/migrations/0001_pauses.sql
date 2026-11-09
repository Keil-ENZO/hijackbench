CREATE TABLE `pauses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` text NOT NULL,
	`kind` text NOT NULL,
	`run_key` text NOT NULL,
	`started_at` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`from_c` integer NOT NULL,
	`to_c` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "pauses_kind" CHECK(kind IN ('pause', 'cut'))
);
--> statement-breakpoint
CREATE INDEX `pauses_campaign` ON `pauses` (`campaign_id`);