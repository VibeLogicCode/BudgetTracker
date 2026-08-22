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
-- Import attribution, mapping deactivation and account-pinned mappings (spec 2026-08-22,
-- v1.6.0). Two independent additions share this one migration only because both are needed
-- before any of that release's three features can land:
--   (a) import_profiles.is_active -- lets a profile (built-in or custom) be hidden from the
--       import picker without deleting it. Same type, same default, and -- like the two
--       existing is_active columns on users and accounts (0000_init) -- no CHECK: this
--       project has never put a CHECK on an is_active flag of this shape.
--   (b) account_card_people -- a per-account map from a normalized card/cardholder value
--       (read from an optional column a mapping may now name) to the person that value
--       belongs to, so a joint statement's rows can be attributed per row instead of
--       entirely to the account owner. Created EMPTY; nothing writes to it before this
--       release's Task 3.
--
-- Deliberately NO ON DELETE clause on either account_card_people foreign key (NO ACTION,
-- the default): this matches the existing, unchanged convention for every other direct
-- reference to accounts or users -- accounts.owner_user_id, accounts.import_profile_id and
-- imports.imported_by all carry no ON DELETE either. This project has no code path that
-- hard-deletes a user or an account (both are soft-deleted through their own is_active
-- flag), so nothing here can be orphaned by app behaviour today; with foreign_keys=ON on
-- every connection (src/db/client.ts), a hypothetical future hard-delete would instead fail
-- loudly with a FOREIGN KEY constraint error rather than silently orphaning a row, and would
-- need to clear referencing account_card_people rows first -- the same way deleteProfile()
-- in src/lib/import/presets.ts already clears accounts/imports before deleting an
-- import_profiles row, rather than relying on a cascade that does not exist.
--
-- Unlike every migration before it, this one adds NO object that exists only in SQL: the new
-- column, the new table, both its foreign keys and its UNIQUE(account_id, card_value) index
-- are all fully representable in src/db/schema.ts. The running enumeration below (kept for
-- continuity with 0002-0007) is therefore unchanged, still stopping at 24.
--
-- Objects that exist ONLY in SQL and have NO Drizzle representation (unchanged by this
-- migration -- see note above):
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
ALTER TABLE `import_profiles` ADD COLUMN `is_active` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE `account_card_people` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL REFERENCES `accounts`(`id`),
	`card_value` text NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`),
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_card_people_uq` ON `account_card_people` (`account_id`, `card_value`);
