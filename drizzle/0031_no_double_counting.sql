-- v1.61.0. No double counting: how each transaction arrived, the imported rows the app is
-- deliberately not counting, and the first day a linked bank account takes from the bank.
--
-- Hand-maintained like every migration since 0000 (see 0013's header): the journal entry and the
-- src/db/schema.ts mirror travel with this file, and the statement separator never appears inside
-- a comment. No foreign-key pragma here; openDatabase() handles that around the whole pass.
--
-- transactions.origin. A purchase can reach an account by four roads, and only a row from a
-- DIFFERENT road can be a second copy of one already there. external_id alone cannot tell the
-- roads apart: QFX FITIDs and SimpleFIN ids share it. The CHECK is forward-only, as 0013's were;
-- every existing row takes the DEFAULT and then the backfill below, both inside the four values.
ALTER TABLE `transactions` ADD COLUMN `origin` text NOT NULL DEFAULT 'manual' CHECK (`origin` IN ('manual', 'csv', 'ofx', 'simplefin'));
--> statement-breakpoint
-- Backfill, read off what each row already says about itself, most certain first.
-- 1. A CSV row is the only kind that stores a dedup hash: commitImport writes NULL there for every
--    provider-id row, and a hand-typed row never has one.
UPDATE `transactions` SET `origin` = 'csv' WHERE `dedup_hash` IS NOT NULL;
--> statement-breakpoint
-- 2. A provider-id row that a SimpleFIN run brought in or met again (a run links every id it
--    already holds). Every sync import has been named `simplefin <date> <time>` since the
--    connector shipped (syncLabel, src/lib/simplefin/sync.ts), and the import page recognises a
--    sync row by the same prefix.
UPDATE `transactions` SET `origin` = 'simplefin'
WHERE `dedup_hash` IS NULL AND `external_id` IS NOT NULL AND (
  EXISTS (
    SELECT 1 FROM `transaction_imports` `ti` JOIN `imports` `i` ON `i`.`id` = `ti`.`import_id`
    WHERE `ti`.`transaction_id` = `transactions`.`id` AND `i`.`filename` LIKE 'simplefin %'
  )
  OR EXISTS (
    SELECT 1 FROM `imports` `i` WHERE `i`.`id` = `transactions`.`import_id` AND `i`.`filename` LIKE 'simplefin %'
  )
);
--> statement-breakpoint
-- 3. Every other provider-id row came from a QFX/OFX file. 4. The rest stay 'manual'.
UPDATE `transactions` SET `origin` = 'ofx' WHERE `origin` = 'manual' AND `external_id` IS NOT NULL;
--> statement-breakpoint
-- The imported rows the app is deliberately not counting: held as a possible duplicate (waiting),
-- or left out by a person (dismissed). Keyed exactly as a transaction is, per account: the hash for
-- a CSV row, the provider id otherwise, never both, so a re-import or the sync's overlap finds the
-- record by the same key it would have found the transaction by.
CREATE TABLE `set_aside_rows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL REFERENCES `accounts`(`id`),
	`import_id` integer REFERENCES `imports`(`id`) ON DELETE SET NULL,
	`state` text NOT NULL CHECK (`state` IN ('waiting', 'dismissed')),
	`reason` text NOT NULL CHECK (`reason` IN ('possible_duplicate', 'deleted')),
	`origin` text NOT NULL CHECK (`origin` IN ('csv', 'ofx', 'simplefin')),
	`date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`raw_description` text NOT NULL,
	`attributed_user_id` integer REFERENCES `users`(`id`),
	`dedup_hash` text,
	`external_id` text,
	`hash_version` integer NOT NULL DEFAULT 1,
	`candidate_txn_id` integer REFERENCES `transactions`(`id`) ON DELETE SET NULL,
	`decided_by` integer REFERENCES `users`(`id`),
	`decided_at` text,
	`created_at` text NOT NULL,
	CHECK (`dedup_hash` IS NOT NULL OR `external_id` IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `set_aside_rows_dedup_uq` ON `set_aside_rows` (`account_id`, `dedup_hash`) WHERE `dedup_hash` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `set_aside_rows_external_id_uq` ON `set_aside_rows` (`account_id`, `external_id`) WHERE `external_id` IS NOT NULL;
--> statement-breakpoint
-- Needs review lists and counts the waiting rows only. The predicate is a literal, so the count
-- plans through it before any value is bound (the 0030 lesson).
CREATE INDEX `set_aside_rows_waiting_idx` ON `set_aside_rows` (`created_at`) WHERE `state` = 'waiting';
--> statement-breakpoint
-- A transaction delete reopens the rows that name it, and its ON DELETE SET NULL looks them up here.
CREATE INDEX `set_aside_rows_candidate_idx` ON `set_aside_rows` (`candidate_txn_id`);
--> statement-breakpoint
-- An undo removes its import's waiting rows, and the import delete nulls the rest through here.
CREATE INDEX `set_aside_rows_import_idx` ON `set_aside_rows` (`import_id`);
--> statement-breakpoint
-- The first day this linked account takes from the bank (YYYY-MM-DD), and when a sync first ran
-- clean after it was set. Both NULL on every existing link, which keeps today's behaviour.
ALTER TABLE `simplefin_account_links` ADD COLUMN `sync_from` text;
--> statement-breakpoint
ALTER TABLE `simplefin_account_links` ADD COLUMN `first_synced_at` text;
