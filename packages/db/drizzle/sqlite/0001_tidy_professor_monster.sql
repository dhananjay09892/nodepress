CREATE TABLE `slug_redirects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_id` integer NOT NULL,
	`type` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`content_id`) REFERENCES `content`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slug_redirects_type_slug_idx` ON `slug_redirects` (`type`,`slug`);--> statement-breakpoint
CREATE INDEX `slug_redirects_content_idx` ON `slug_redirects` (`content_id`);