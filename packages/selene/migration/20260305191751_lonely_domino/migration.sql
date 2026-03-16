CREATE TABLE `session_context_state` (
	`session_id` text PRIMARY KEY,
	`root_session_id` text NOT NULL,
	`cursor` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_session_context_state_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_context_state_root_session_id_session_id_fk` FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `session_context_state_root_session_id_idx` ON `session_context_state` (`root_session_id`);--> statement-breakpoint
CREATE INDEX `session_context_state_cursor_idx` ON `session_context_state` (`cursor`);