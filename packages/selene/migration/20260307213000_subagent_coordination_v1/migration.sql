CREATE TABLE `session_coordination` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`root_session_id` text NOT NULL,
	`from_session_id` text NOT NULL,
	`to_session_id` text,
	`to_agent` text,
	`request_id` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`metadata` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_session_coordination_root_session_id_session_id_fk` FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_coordination_from_session_id_session_id_fk` FOREIGN KEY (`from_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_coordination_to_session_id_session_id_fk` FOREIGN KEY (`to_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `session_coordination_root_session_id_idx` ON `session_coordination` (`root_session_id`);
--> statement-breakpoint
CREATE INDEX `session_coordination_from_session_id_idx` ON `session_coordination` (`from_session_id`);
--> statement-breakpoint
CREATE INDEX `session_coordination_to_session_id_idx` ON `session_coordination` (`to_session_id`);
--> statement-breakpoint
CREATE INDEX `session_coordination_to_agent_idx` ON `session_coordination` (`to_agent`);
--> statement-breakpoint
CREATE INDEX `session_coordination_request_id_idx` ON `session_coordination` (`request_id`);
--> statement-breakpoint
CREATE INDEX `session_coordination_status_idx` ON `session_coordination` (`status`);
--> statement-breakpoint
CREATE INDEX `session_coordination_time_created_idx` ON `session_coordination` (`time_created`);
--> statement-breakpoint
CREATE TABLE `session_coordination_state` (
	`session_id` text PRIMARY KEY NOT NULL,
	`root_session_id` text NOT NULL,
	`cursor` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_session_coordination_state_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_coordination_state_root_session_id_session_id_fk` FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `session_coordination_state_root_session_id_idx` ON `session_coordination_state` (`root_session_id`);
--> statement-breakpoint
CREATE INDEX `session_coordination_state_cursor_idx` ON `session_coordination_state` (`cursor`);
