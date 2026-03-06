ALTER TABLE `session` ADD `kind` text DEFAULT 'interactive' NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `root_id` text REFERENCES session(id);--> statement-breakpoint
ALTER TABLE `session` ADD `branch_from_session_id` text;--> statement-breakpoint
ALTER TABLE `session` ADD `branch_from_message_id` text;--> statement-breakpoint
UPDATE `session`
SET `kind` = CASE
  WHEN `parent_id` IS NULL THEN 'interactive'
  ELSE 'subagent'
END;--> statement-breakpoint
WITH RECURSIVE `chain`(`id`, `root_id`) AS (
  SELECT `id`, `id`
  FROM `session`
  WHERE `parent_id` IS NULL
  UNION ALL
  SELECT `child`.`id`, `chain`.`root_id`
  FROM `session` `child`
  JOIN `chain` ON `child`.`parent_id` = `chain`.`id`
)
UPDATE `session`
SET `root_id` = COALESCE(
  (SELECT `chain`.`root_id` FROM `chain` WHERE `chain`.`id` = `session`.`id`),
  `session`.`id`
);--> statement-breakpoint
CREATE INDEX `session_kind_idx` ON `session` (`kind`);--> statement-breakpoint
CREATE INDEX `session_root_idx` ON `session` (`root_id`);--> statement-breakpoint
CREATE INDEX `session_branch_from_session_idx` ON `session` (`branch_from_session_id`);
