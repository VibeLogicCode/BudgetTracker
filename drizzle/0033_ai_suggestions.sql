-- v1.64.0. Local AI suggestions: one row per merchant, written only by src/lib/ai/suggestions.ts.
--
-- Hand-maintained like every migration since 0000 (see 0013's header): the journal entry and the
-- src/db/schema.ts mirror travel with this file, and the statement separator never appears inside
-- a comment. No foreign-key pragma here; openDatabase() handles that around the whole pass.
--
-- The table starts empty and stays empty until an admin turns local AI on. A row is a suggestion
-- shown in Review ('suggested'), an answer that could not be used ('failed', so the merchant is not
-- asked again every tick), or a suggestion a person set aside ('ignored'). Nothing reads it to file
-- a row: a person using a suggestion goes through the existing category and rename actions.
-- category_id references categories, which are archived and never deleted, so it cannot block a
-- delete; an archived category reads as no suggestion.
CREATE TABLE `ai_suggestions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`normalized_merchant` text NOT NULL CHECK (length(`normalized_merchant`) >= 1),
	`status` text NOT NULL CHECK (`status` IN ('suggested', 'failed', 'ignored')),
	`category_id` integer REFERENCES `categories`(`id`),
	`clean_name` text CHECK (`clean_name` IS NULL OR length(`clean_name`) BETWEEN 1 AND 60),
	`model` text NOT NULL CHECK (length(`model`) BETWEEN 1 AND 100),
	`reason` text CHECK (`reason` IS NULL OR length(`reason`) <= 200),
	`created_at` text NOT NULL,
	`decided_by` integer REFERENCES `users`(`id`),
	`decided_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_suggestions_merchant_uq` ON `ai_suggestions` (`normalized_merchant`);
