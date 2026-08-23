-- WARNING: this migration is hand-maintained, not drizzle-kit-generated.
-- Read the header of drizzle/0000_init.sql and the docblock in drizzle.config.ts before
-- adding another one: there is no 0000_snapshot.json, so `drizzle-kit generate` would
-- diff against an empty baseline and re-emit the whole schema. Hand-author the SQL,
-- append the matching entry to drizzle/meta/_journal.json, and mirror the tables in
-- src/db/schema.ts -- in that order.
--
-- NOTE ON SEPARATORS: drizzle's migrator splits this file on the breakpoint marker written
-- between each statement below, and on nothing else, and it does NOT skip comments. That
-- marker must therefore never appear inside a comment -- including this one, which is why
-- it is described here rather than quoted -- or the file is shredded into fragments that
-- will not parse.
--
-- Finish line (spec 2026-08-22, v1.7.0, Task 1). Four independent additions share this one
-- migration because the plan calls for a single hand-authored file per release rather than
-- one per feature, and all four are needed before any of that release's features can land:
--   (a) transaction_splits -- lets one transaction's amount be divided across more than one
--       category. Created EMPTY; nothing writes to it before Task 2.
--   (b) account_balance_snapshots -- one row per account per day, the source data for net
--       worth history. Created EMPTY; nothing writes to it before Task 6.
--   (c) budget_rollover -- a row's EXISTENCE means rollover is ON for that (scope, user,
--       category); DELETING the row turns it off again, the same absence-is-off pattern the
--       settings table already uses for feature toggles elsewhere in this app. There is
--       deliberately no `enabled` column: existence already carries the on/off meaning, so a
--       second flag could only ever drift out of sync with it, for no cheaper a read. Created
--       EMPTY; nothing writes to it before Task 10.
--   (d) categories.tax_relevant -- marks a category relevant for the tax-year report
--       (Task 15). Defaults to 0, so every existing category is unaffected until an admin
--       opts one in.
--
-- Objects that exist ONLY in SQL and have NO Drizzle representation now number, after this
-- migration:
--   1. the categories.parent_id self-referencing foreign key             (0000)
--   2. the COALESCE(display_description, raw_description) index          (0000)
--   3. the COALESCE month expression index                               (0000)
--   4. every CHECK constraint on warranty_items                          (0002, extended by 0007)
--   5. every CHECK constraint on warranty_receipts                       (0002)
--   6. the warranty_search FTS5 contentless virtual table                (0002)
--   7. its six triggers, which are its ONLY writer                       (0002)
--   8. the is_subscription/name CHECK constraints on warranty_item_types (0003)
--   9. the COLLATE NOCASE collation on warranty_item_types_name_uq       (0003)
--  10. warranty_items.type_id arriving by ALTER TABLE ADD COLUMN         (0003)
--  11. the CHECK constraint on warranty_item_types.kind                  (0004)
--  12. warranty_item_types.kind itself, by ALTER TABLE ADD COLUMN        (0004)
--  13. the CHECK constraints on billing_cycle and billing_amount_cents,
--      and both columns arriving by ALTER TABLE ADD COLUMN               (0005)
--  14. the id = 1 singleton CHECK on notification_smtp                   (0006)
--  15. every other CHECK constraint on notification_smtp                 (0006)
--  16. every CHECK constraint on notification_targets, including the     (0006)
--      channel/secret_encrypted pairing rule
--  17. every CHECK constraint on notification_prefs                      (0006)
--  18. every CHECK constraint on notification_user_settings              (0006)
--  19. every CHECK constraint on notification_outbox                     (0006)
--  20. notification_prefs' WITHOUT ROWID storage class                   (0006)
--  21. the CHECK constraints on the four loan money columns, and all
--      four columns arriving by ALTER TABLE ADD COLUMN                   (0007)
--  22. every CHECK constraint on loan_matcher_rules                      (0007)
--  23. the coalesce(account_id, -1) EXPRESSION in loan_matcher_rules_uq  (0007)
--  24. every CHECK constraint on loan_payments                           (0007)
--  25. the CHECK constraint on transaction_splits                        (0009)
--  26. the CHECK constraint on account_balance_snapshots                 (0009)
--  27. both CHECK constraints on budget_rollover, including the          (0009)
--      scope/user_id pairing rule
--  28. the coalesce(user_id, -1) EXPRESSION in budget_rollover_uq        (0009)
--  29. categories.tax_relevant arriving by ALTER TABLE ADD COLUMN        (0009)
CREATE TABLE `transaction_splits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`txn_id` integer NOT NULL REFERENCES `transactions`(`id`) ON DELETE CASCADE,
	`category_id` integer NOT NULL REFERENCES `categories`(`id`),
	`amount_cents` integer NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	CHECK (`amount_cents` <> 0)
);
--> statement-breakpoint
CREATE INDEX `transaction_splits_txn_idx` ON `transaction_splits` (`txn_id`);
--> statement-breakpoint
CREATE INDEX `transaction_splits_category_idx` ON `transaction_splits` (`category_id`);
--> statement-breakpoint
CREATE TABLE `account_balance_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE CASCADE,
	`date` text NOT NULL,
	`balance_cents` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	CHECK (`source` IN ('simplefin','manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_balance_snapshots_uq` ON `account_balance_snapshots` (`account_id`, `date`);
--> statement-breakpoint
CREATE TABLE `budget_rollover` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`user_id` integer REFERENCES `users`(`id`),
	`category_id` integer NOT NULL REFERENCES `categories`(`id`),
	`start_month` text NOT NULL,
	`created_at` text NOT NULL,
	CHECK (`scope` IN ('household','personal')),
	CHECK ((`scope` = 'personal') = (`user_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_rollover_uq` ON `budget_rollover` (`scope`, coalesce(`user_id`, -1), `category_id`);
--> statement-breakpoint
ALTER TABLE `categories` ADD COLUMN `tax_relevant` integer NOT NULL DEFAULT 0;
