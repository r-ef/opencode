CREATE TABLE `session_coordinator_plan` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`root_session_id` text NOT NULL,
	`session_id` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`query` text NOT NULL,
	`requirements` text NOT NULL,
	`summary` text,
	`metadata` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_session_coordinator_plan_root_session_id_session_id_fk` FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_coordinator_plan_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `session_coordinator_plan_root_session_id_idx` ON `session_coordinator_plan` (`root_session_id`);
--> statement-breakpoint
CREATE INDEX `session_coordinator_plan_status_idx` ON `session_coordinator_plan` (`status`);
--> statement-breakpoint
CREATE TABLE `session_coordinator_work` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` integer NOT NULL,
	`root_session_id` text NOT NULL,
	`session_id` text,
	`role` text NOT NULL,
	`agent` text NOT NULL,
	`scope` text NOT NULL,
	`goal` text NOT NULL,
	`status` text NOT NULL,
	`depends_on` text,
	`verify_against` text,
	`metadata` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_session_coordinator_work_plan_id_plan_id_fk` FOREIGN KEY (`plan_id`) REFERENCES `session_coordinator_plan`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_coordinator_work_root_session_id_session_id_fk` FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_coordinator_work_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `session_coordinator_work_plan_id_idx` ON `session_coordinator_work` (`plan_id`);
--> statement-breakpoint
CREATE INDEX `session_coordinator_work_root_session_id_idx` ON `session_coordinator_work` (`root_session_id`);
--> statement-breakpoint
CREATE INDEX `session_coordinator_work_session_id_idx` ON `session_coordinator_work` (`session_id`);
--> statement-breakpoint
CREATE INDEX `session_coordinator_work_status_idx` ON `session_coordinator_work` (`status`);
--> statement-breakpoint
CREATE TABLE `session_coordinator_claim` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` integer NOT NULL,
	`work_id` text NOT NULL,
	`root_session_id` text NOT NULL,
	`session_id` text,
	`topic` text NOT NULL,
	`statement` text NOT NULL,
	`evidence` text NOT NULL,
	`confidence` text NOT NULL,
	`status` text NOT NULL,
	`metadata` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_session_coordinator_claim_plan_id_plan_id_fk` FOREIGN KEY (`plan_id`) REFERENCES `session_coordinator_plan`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_coordinator_claim_work_id_work_id_fk` FOREIGN KEY (`work_id`) REFERENCES `session_coordinator_work`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_coordinator_claim_root_session_id_session_id_fk` FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_coordinator_claim_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `session_coordinator_claim_plan_id_idx` ON `session_coordinator_claim` (`plan_id`);
--> statement-breakpoint
CREATE INDEX `session_coordinator_claim_work_id_idx` ON `session_coordinator_claim` (`work_id`);
--> statement-breakpoint
CREATE INDEX `session_coordinator_claim_root_session_id_idx` ON `session_coordinator_claim` (`root_session_id`);
--> statement-breakpoint
CREATE INDEX `session_coordinator_claim_status_idx` ON `session_coordinator_claim` (`status`);
--> statement-breakpoint
CREATE INDEX `session_coordinator_claim_topic_idx` ON `session_coordinator_claim` (`topic`);
