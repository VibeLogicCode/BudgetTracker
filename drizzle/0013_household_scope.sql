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
-- Kids' scope, ownership and the household features
-- (spec docs/superpowers/specs/2026-08-27-kids-scope-and-household-features-design.md, v1.13.0).
--
-- ADDITIVE ONLY. Five ALTER TABLE ADD COLUMNs, one CREATE TABLE, two indexes. There is NO table
-- rebuild in this file, and that is deliberate:
--
--   accounts.type is widened from three values to five ('savings' and 'asset', ruling R10) with NO
--   DDL AT ALL, because that column has never carried a CHECK. drizzle/0000_init.sql declares it as
--   `type` text NOT NULL and no migration since has touched it -- the three-value enum lives only in
--   src/db/schema.ts's Drizzle definition and in the zod schema in src/lib/accounts.ts. Rebuilding
--   accounts to ADD a CHECK was considered and rejected: six tables carry foreign keys into it
--   (transactions, imports, account_card_people, simplefin_account_links, account_balance_snapshots,
--   loan_matcher_rules), which would make the safest change in this release the riskiest one, for a
--   constraint the app already enforces at two boundaries. Planner micro-ruling M2.
--
-- THE FOREIGN-KEY PRAGMA IS NOT IN THIS FILE, ON PURPOSE -- see 0011's header. src/db/client.ts's
-- openDatabase() disables foreign keys around the whole migration pass and re-enables them (plus a
-- foreign_key_check) immediately after. Do not put a pragma here.
--
-- THE THREE ADDED CHECKS ARE FORWARD-ONLY. SQLite's ALTER TABLE ADD COLUMN does not re-validate
-- existing rows against a CHECK added that way -- the same fact drizzle/0007_loans.sql's header
-- records. Harmless here precisely because these are NEW columns: every pre-existing row takes the
-- DEFAULT, which satisfies both users CHECKs by construction. The cross-column rule that visibility
-- 'self' and role 'admin' are mutually exclusive is therefore NOT attempted in SQL at all; it lives
-- in setUserVisibility() beside assertBalanceAnchorPairing's precedent (micro-ruling M1).
--
-- audit_log.action and .entity carry a LENGTH check and never a value enum: an enum CHECK would make
-- every future audited operation a table rebuild, and ruling R3 says keep it small. audit_log has no
-- ON DELETE for the same reason src/lib/auth/users.ts:186 gives -- this project deactivates users and
-- never deletes them, so user_id cannot dangle.
--
-- Objects that exist ONLY in SQL and have NO Drizzle representation now number, after this migration
-- (entries 1-33 are restated verbatim from drizzle/0011_bill_installments.sql's and
-- drizzle/0012_totp_last_counter.sql's headers):
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
--  32. users.totp_last_counter arriving by ALTER TABLE ADD COLUMN        (0012)
--  33. bill_installments.unlinked_at arriving by ALTER TABLE ADD COLUMN  (0012)
--  34. the visibility CHECK on users, and the column arriving by        (0013)
--      ALTER TABLE ADD COLUMN
--  35. the can_sign_in CHECK on users, and the column arriving by        (0013)
--      ALTER TABLE ADD COLUMN
--  36. users.last_account_id arriving by ALTER TABLE ADD COLUMN          (0013)
--  37. merchant_rules.last_modified_by arriving by ALTER TABLE ADD COLUMN (0013)
--  38. warranty_items.budget_category_id arriving by ALTER TABLE ADD COLUMN (0013)
--  39. both CHECK constraints on audit_log                               (0013)
--
-- audit_log_at_idx and audit_log_entity_idx are plain indexes and ARE mirrored in src/db/schema.ts,
-- so they do not appear in the list above -- the same rule bill_installments_txn_uq follows.
ALTER TABLE `users` ADD COLUMN `visibility` text NOT NULL DEFAULT 'household' CHECK (`visibility` IN ('household', 'self'));
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `can_sign_in` integer NOT NULL DEFAULT 1 CHECK (`can_sign_in` IN (0, 1));
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `last_account_id` integer REFERENCES `accounts`(`id`);
--> statement-breakpoint
ALTER TABLE `merchant_rules` ADD COLUMN `last_modified_by` integer REFERENCES `users`(`id`);
--> statement-breakpoint
ALTER TABLE `warranty_items` ADD COLUMN `budget_category_id` integer REFERENCES `categories`(`id`);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`),
	`action` text NOT NULL CHECK (length(trim(`action`)) BETWEEN 1 AND 40),
	`entity` text NOT NULL CHECK (length(trim(`entity`)) BETWEEN 1 AND 40),
	`entity_id` integer NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);
--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity`, `entity_id`);
