-- v1.8.0 (spec docs/superpowers/specs/2026-08-23-v1.8.0-balances-and-cleanup-design.md).
--
-- One change: account_balance_snapshots.source gains 'csv', for a balance read out of a
-- statement's own running-balance column via the new ImportMapping.balanceCol
-- (src/lib/import/mapping.ts). That makes this the table's third writer, alongside SimpleFIN
-- (src/lib/simplefin/sync.ts) and the manual "balance as of date" form
-- (src/app/(app)/settings/accounts/actions.ts).
--
-- 'csv' is a DISTINCT source value rather than being folded into 'manual' because ruling R3
-- ranks a bank's own statement figure above a hand-typed one for the same date, and that
-- ordering is not expressible if the two are indistinguishable.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is recreated. This supersedes
-- constraint 26 in 0009_finish_line.sql's header list. 0009 itself is NOT edited -- shipped
-- migrations are append-only.
--
-- ============================================================================================
-- DROP-AND-RECREATE IS DELIBERATE HERE AND IS NOT A REUSABLE PATTERN.
--
-- Owner ruling 2026-08-23: the only install is the NAS, it holds dummy data, and no snapshot
-- row is worth preserving. So this discards every existing row instead of the 12-step
-- INSERT ... SELECT rebuild a CHECK change normally requires. That is safe exactly once,
-- right now, for this table.
--
-- A future session MUST NOT copy this shape. By design this table is about to become the only
-- record of balances that no CSV can regenerate: a manual snapshot is typed by hand and exists
-- nowhere else, and src/lib/balance.ts anchors every balance it resolves on one. Any later
-- constraint change on this table needs the real rebuild -- __new_ table, INSERT ... SELECT,
-- DROP, RENAME, re-CREATE the unique index, and every CHECK re-declared.
--
-- tests/db/migration-0010.test.ts pins the row loss deliberately, so it reads as a decision
-- rather than as a bug someone should quietly "fix" later.
-- ============================================================================================
DROP TABLE `account_balance_snapshots`;
--> statement-breakpoint
CREATE TABLE `account_balance_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`date` text NOT NULL,
	`balance_cents` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CHECK (`source` IN ('simplefin','manual','csv'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_balance_snapshots_uq` ON `account_balance_snapshots` (`account_id`,`date`);
