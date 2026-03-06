CREATE TABLE `session_context` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`root_session_id` text NOT NULL,
	`session_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_session_context_root_session_id_session_id_fk` FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_context_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `session_context_root_session_id_idx` ON `session_context` (`root_session_id`);--> statement-breakpoint
CREATE INDEX `session_context_session_id_idx` ON `session_context` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_context_time_created_idx` ON `session_context` (`time_created`);