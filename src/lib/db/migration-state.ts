import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

/**
 * O-04 (2026-09-02 review, P1). "Is this database ahead of the code trying to open it?" — asked at
 * BOOT (src/db/client.ts) and before a RESTORE (scripts/restore-core.ts), and until this module
 * existed it was only ever answered on the restore path.
 *
 * A LEAF MODULE, and that is the point rather than tidiness. The obvious fix was for db/client.ts
 * to import assertNotNewerThanCode from scripts/restore-core.ts, which src/lib/backup/restore.ts
 * already does — but restore-core pulls in `tar` and the whole restore machinery, and db/client.ts
 * is the single hottest import in the application. Worse, its message is written for restoring
 * ("This backup was made by a newer version…"), which is a lie at boot: there is no backup
 * involved, there is a volume with a database on it. Same shape as the notEnded extraction into
 * src/lib/warranty/expiry-sql.ts — the copy that could not be shared was the copy with a wrong
 * dependency, not a wrong idea.
 *
 * Plain Errors here, never RestoreError: this module sits below both callers and must not know
 * about either one's error vocabulary. restore-core re-wraps to satisfy MUST-20.12 (every error
 * reaching restore-result.json is an operator-readable RestoreError), and boot throws its own.
 */
export interface MigrationCounts {
  /** How many migrations are recorded. */
  count: number;
  /** The newest `created_at` / journal `when`, in epoch ms. Zero when there are none. */
  maxWhen: number;
}

/** Raised for a journal that cannot be read or parsed — a corrupted installation, not a downgrade. */
export class MigrationJournalError extends Error {}

/**
 * What the CODE ships, read from drizzle's own journal rather than by counting `.sql` files: the
 * journal is what drizzle itself compares against, so anything else would be a second opinion.
 */
export function readLocalMigrationCounts(migrationsFolder: string): MigrationCounts {
  const journal = path.join(migrationsFolder, 'meta', '_journal.json');
  let raw: string;
  try {
    raw = fs.readFileSync(journal, 'utf8');
  } catch {
    throw new MigrationJournalError('Could not read the local migrations journal.');
  }
  let parsed: { entries?: { when?: number }[] };
  try {
    parsed = JSON.parse(raw) as { entries?: { when?: number }[] };
  } catch {
    throw new MigrationJournalError('The local migrations journal is not valid JSON.');
  }
  const entries = parsed.entries ?? [];
  return {
    count: entries.length,
    maxWhen: entries.reduce((max, entry) => Math.max(max, Number(entry.when ?? 0)), 0),
  };
}

/**
 * What the DATABASE has applied. Takes an already-open handle rather than a path, so the boot path
 * can ask the question on the connection it just opened instead of opening a second one against a
 * file it is midway through preparing.
 *
 * A database with no `__drizzle_migrations` table is a pre-migrator or hand-made one: zero applied,
 * and forward migration is exactly what should happen to it. Not an error, and emphatically not a
 * downgrade.
 */
export function readAppliedMigrationCounts(sqlite: BetterSqlite3.Database): MigrationCounts {
  const table = sqlite
    .prepare("select name from sqlite_master where type='table' and name='__drizzle_migrations'")
    .get();
  if (!table) return { count: 0, maxWhen: 0 };
  const row = sqlite
    .prepare('select count(*) as count, coalesce(max(created_at), 0) as maxWhen from __drizzle_migrations')
    .get() as { count: number; maxWhen: number };
  return { count: Number(row.count), maxWhen: Number(row.maxWhen) };
}

/**
 * THE ONE COMPARISON. Both halves earn their place and dropping either one opens a real hole:
 * `count` catches the ordinary case (the newer build shipped more migrations), and `maxWhen`
 * catches a journal that was REORDERED or rewritten with the same number of entries, which a count
 * alone reads as identical. Together they are the strongest statement that can be made before a
 * migration has run — the only moment at which the question can honestly be asked at all.
 */
export function isNewerThanCode(applied: MigrationCounts, local: MigrationCounts): boolean {
  return applied.maxWhen > local.maxWhen || applied.count > local.count;
}
