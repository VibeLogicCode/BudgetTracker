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
-- Bills with due dates (spec docs/superpowers/specs/2026-08-24-bills-with-due-dates-design.md,
-- v1.12.0). Two parts, in this order because the second cannot be pointed at until the first
-- has made the new kind legal:
--   Part 1: widen warranty_item_types.kind to admit 'bill'. A full table rebuild.
--   Part 2: bill_installments -- the explicit schedule that replaces a cadence for a bill.
--
-- ============================================================================================
-- WHY PART 1 IS A REBUILD, AND WHY IT IS NOT 0010'S SHORTCUT.
--
-- warranty_item_types.kind carries CHECK (kind IN ('warranty','subscription','contract','loan'))
-- from 0004, and SQLite cannot ALTER a CHECK. 0010 answered the same problem by dropping and
-- recreating its table, and its own header forbids copying that anywhere the data cannot be
-- regenerated. Item types are exactly that: a person types them, nothing else stores them, and
-- warranty_items.type_id points at them. So this is the real thing -- a __new_ table,
-- INSERT ... SELECT, DROP, RENAME, and every surviving constraint and index re-declared:
--   * both 0003 CHECKs (is_subscription IN (0,1); length(trim(name)) BETWEEN 1 AND 60)
--   * the widened kind CHECK, now five values
--   * AUTOINCREMENT -- surviving rows keep their existing ids, but this is not an absolute
--     never-reused guarantee across the rebuild: SQLite seeds the __new_ table's sequence from
--     the highest id the INSERT ... SELECT actually copies, not from the highest id the OLD
--     table's sqlite_sequence remembers ever having assigned. If the all-time-highest type id had
--     already been deleted before this migration ran, the rebuilt table's sequence regresses to
--     the current max(id) and a future insert can reissue that deleted id. Harmless here: FK
--     enforcement means no live warranty_items row can still be pointing at a deleted type, so a
--     reissued id cannot collide with a dangling reference.
--   * warranty_item_types_name_uq, WITH its COLLATE NOCASE collation
-- The explicit id column in the INSERT is what keeps warranty_items.type_id resolving.
--
-- THE FOREIGN-KEY PRAGMA IS NOT IN THIS FILE, ON PURPOSE. Drizzle's SQLite dialect runs every
-- pending migration inside one BEGIN ... COMMIT, and SQLite documents PRAGMA foreign_keys as a
-- no-op inside a transaction; a pragma written here would look like protection and provide
-- none. src/db/client.ts's openDatabase() disables foreign keys around the whole migration
-- pass and re-enables them (plus a foreign_key_check) immediately after. Do not put a pragma
-- back into this file.
-- ============================================================================================
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
--   8. the is_subscription/name CHECK constraints on warranty_item_types (0003, re-declared 0011)
--   9. the COLLATE NOCASE collation on warranty_item_types_name_uq       (0003, re-declared 0011)
--  10. warranty_items.type_id arriving by ALTER TABLE ADD COLUMN         (0003)
--  11. the CHECK constraint on warranty_item_types.kind                  (0004, SUPERSEDED by 31)
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
--  26. the CHECK constraint on account_balance_snapshots                 (0009, superseded by 0010)
--  27. both CHECK constraints on budget_rollover, including the          (0009)
--      scope/user_id pairing rule
--  28. the coalesce(user_id, -1) EXPRESSION in budget_rollover_uq        (0009)
--  29. categories.tax_relevant arriving by ALTER TABLE ADD COLUMN        (0009)
--  30. every CHECK constraint on bill_installments                       (0011)
--  31. the widened kind CHECK on warranty_item_types, now five values,   (0011)
--      SUPERSEDING entry 11
--
-- bill_installments_txn_uq is a plain unique index and IS mirrored in src/db/schema.ts, so it
-- does not appear in the list above.
--
-- ON DELETE SET NULL on paid_txn_id follows warranty_items.transaction_id's precedent
-- (MUST-3.7: an import undo must not take the evidence with it) and is a BACKSTOP ONLY. What
-- actually keeps a row honest is the explicit reversal in
-- reverseInstallmentLinksForTransactions(), because a cascade can drop the link but cannot
-- restore paid_at (ruling B14).
--
-- There is deliberately NO unique index on (item_id, due_date): two parcels can fall due on
-- the same day for the same bill, at different amounts. Ordering is due_date ASC, id ASC
-- everywhere, so "the earliest unpaid installment" stays total and deterministic.
--
-- due_date's shape check uses LIKE, not GLOB, even though '_' reads like a GLOB wildcard: SQLite's
-- GLOB wildcards are '?' and '*' (shell-style), and it matches '_' literally, so a GLOB version of
-- this pattern rejects every date, valid ones included. LIKE is what actually makes '_' a
-- single-character wildcard here. Verified against SQLite 3.53.2.
CREATE TABLE `__new_warranty_item_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_subscription` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`kind` text NOT NULL DEFAULT 'warranty' CHECK (`kind` IN ('warranty', 'subscription', 'contract', 'loan', 'bill')),
	CHECK (`is_subscription` IN (0, 1)),
	CHECK (length(trim(`name`)) BETWEEN 1 AND 60)
);
--> statement-breakpoint
INSERT INTO `__new_warranty_item_types` (`id`, `name`, `is_subscription`, `created_at`, `kind`)
	SELECT `id`, `name`, `is_subscription`, `created_at`, `kind` FROM `warranty_item_types`;
--> statement-breakpoint
DROP TABLE `warranty_item_types`;
--> statement-breakpoint
ALTER TABLE `__new_warranty_item_types` RENAME TO `warranty_item_types`;
--> statement-breakpoint
CREATE UNIQUE INDEX `warranty_item_types_name_uq` ON `warranty_item_types` (`name` COLLATE NOCASE);
--> statement-breakpoint
CREATE TABLE `bill_installments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL REFERENCES `warranty_items`(`id`) ON DELETE CASCADE,
	`due_date` text NOT NULL CHECK (`due_date` LIKE '____-__-__'),
	`amount_cents` integer NOT NULL CHECK (`amount_cents` > 0),
	`paid_at` text,
	`paid_txn_id` integer REFERENCES `transactions`(`id`) ON DELETE SET NULL,
	`created_at` text NOT NULL,
	CHECK (`paid_txn_id` IS NULL OR `paid_at` IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bill_installments_txn_uq` ON `bill_installments` (`paid_txn_id`);
--> statement-breakpoint
CREATE INDEX `bill_installments_item_idx` ON `bill_installments` (`item_id`, `due_date`);
--> statement-breakpoint
CREATE INDEX `bill_installments_due_idx` ON `bill_installments` (`paid_at`, `due_date`);
