import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openDatabase } from '@/db/client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_MIGRATIONS_DIR = path.join(root, 'drizzle');

/**
 * O-04 (2026-09-02 review, P1). Rolling the image back over a migrated database used to boot
 * SILENTLY. Drizzle compares each local migration's timestamp against the database's single
 * latest `created_at`, so on downgraded code every local migration looks already applied, none
 * re-run, and the old code then serves a schema it does not know about.
 *
 * This matters here more than in most projects: install/synology-compose-pull.yml pins `:latest`
 * and a tag push repoints it, so "pull the previous tag" is the natural recovery move -- and was
 * exactly the unguarded path. The check itself already existed (assertNotNewerThanCode) but was
 * reachable only from restore.
 */
let work: string | null = null;
afterEach(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true });
  work = null;
  delete process.env.BUDGET_MIGRATIONS_DIR;
});

/** A database migrated by the REAL journal, then stamped as if a newer build had touched it. */
function databaseFromTheFuture(extraRows: number): string {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'downgrade-guard-'));
  const file = path.join(work, 'budget.db');
  // Migrate honestly first, so the only thing wrong with this database is what the next step does.
  openDatabase(file).sqlite.close();

  const raw = new Database(file);
  const latest = raw.prepare('select coalesce(max(created_at), 0) as when_ from __drizzle_migrations').get() as {
    when_: number;
  };
  for (let i = 1; i <= extraRows; i += 1) {
    raw
      .prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)')
      .run(`future-migration-${i}`, latest.when_ + i * 1000);
  }
  raw.close();
  return file;
}

describe('O-04: boot refuses a database written by a newer build', () => {
  it('throws rather than migrating and serving', () => {
    const file = databaseFromTheFuture(1);
    expect(() => openDatabase(file)).toThrowError(/newer version/i);
  });

  it('names what to do about it, on a headless box whose only record is the log', () => {
    const file = databaseFromTheFuture(2);
    let message = '';
    try {
      openDatabase(file);
    } catch (error) {
      message = (error as Error).message;
    }
    // The two counts, so the operator can see how far ahead the database is...
    expect(message).toMatch(/\d+/);
    // ...and the way out. "Refusing to start" with no next step is how a NAS stays down.
    expect(message).toMatch(/upgrade|restore/i);
  });

  it('leaves no open handle behind when it refuses', () => {
    const file = databaseFromTheFuture(1);
    expect(() => openDatabase(file)).toThrow();
    // If the refusal leaked its handle, the WAL would still be attached and this exclusive open
    // would fail -- the same close-then-throw discipline the orphan check above it already keeps.
    const probe = new Database(file);
    expect(() => probe.pragma('locking_mode = EXCLUSIVE')).not.toThrow();
    probe.close();
  });

  it('still opens an ordinary database, and one that has never been migrated at all', () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'downgrade-guard-ok-'));
    const fresh = path.join(work, 'fresh.db');
    // A brand-new file: zero applied migrations, which is forward migration's whole job and must
    // never be read as a downgrade.
    const opened = openDatabase(fresh);
    opened.sqlite.close();
    // And re-opening the now-migrated file is the ordinary restart path.
    const again = openDatabase(fresh);
    again.sqlite.close();
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('guards against a REORDERED journal too, not only a longer one', () => {
    // count > local.count catches extra rows; maxWhen > local.maxWhen catches a build whose
    // journal was rewritten with the same number of entries. Both matter -- see the comment on
    // assertNotNewerThanCode, which this shares its rule with.
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'downgrade-guard-reorder-'));
    const file = path.join(work, 'budget.db');
    openDatabase(file).sqlite.close();

    const raw = new Database(file);
    const row = raw.prepare('select count(*) as c, max(created_at) as m from __drizzle_migrations').get() as {
      c: number;
      m: number;
    };
    // Same COUNT, newer timestamp: bump the newest row rather than adding one.
    raw.prepare('update __drizzle_migrations set created_at = ? where created_at = ?').run(row.m + 5000, row.m);
    raw.close();

    expect(() => openDatabase(file)).toThrowError(/newer version/i);
  });
});

describe('O-04: the rule is stated once, not copied', () => {
  it('the restore path and the boot path share one comparison', () => {
    const guard = fs.readFileSync(path.join(root, 'src/lib/db/migration-state.ts'), 'utf8');
    const client = fs.readFileSync(path.join(root, 'src/db/client.ts'), 'utf8');
    const restore = fs.readFileSync(path.join(root, 'scripts/restore-core.ts'), 'utf8');
    // The comparison lives in the leaf module...
    expect(guard).toMatch(/maxWhen\s*>|count\s*>/);
    // ...and both callers reach for it rather than re-deriving it. A second hand-written
    // `backup.maxWhen > local.maxWhen` is exactly the drift this repo keeps paying to remove.
    expect(client).toMatch(/migration-state/);
    expect(restore).toMatch(/migration-state/);
  });
});
