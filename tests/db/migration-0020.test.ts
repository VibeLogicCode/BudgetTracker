import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@/db/client';
import { createTestDb, type TestDb } from '../helpers/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_MIGRATIONS_DIR = path.join(root, 'drizzle');

/** A database migrated to 0019 and no further, plus the staged migrations dir that got it there.
 *  Same shape as migration-0019.test.ts's own helper, which stages at 0018. */
function buildPreMigrationDb(): { file: string; tempMigrationsDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0020-migrations-'));
  const names = fs.readdirSync(REAL_MIGRATIONS_DIR).filter((n) => n.endsWith('.sql') && n !== '0020_bill_item_type.sql');
  for (const name of names) fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, name), path.join(stageDir, name));
  fs.mkdirSync(path.join(stageDir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    version: string;
    dialect: string;
    entries: { idx: number }[];
  };
  fs.writeFileSync(
    path.join(stageDir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 19) }),
  );
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0020-db-'));
  return { file: path.join(dbDir, 'budget.db'), tempMigrationsDir: stageDir };
}

interface TypeRow { id: number; name: string; kind: string; is_subscription: number }

function itemTypes(sqlite: TestDb['sqlite']): TypeRow[] {
  return sqlite.prepare('select id, name, kind, is_subscription from warranty_item_types order by id').all() as TypeRow[];
}

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  delete process.env.BUDGET_MIGRATIONS_DIR;
});

describe('drizzle/0020_bill_item_type.sql', () => {
  it('seeds a Bill type carrying kind = bill', () => {
    current = createTestDb();
    const bill = itemTypes(current.sqlite).find((row) => row.name === 'Bill');
    expect(bill, 'no Bill item type was seeded').toBeDefined();
    expect(bill?.kind).toBe('bill');
    // is_subscription predates `kind` and is derived FROM it on every write
    // (src/lib/warranty/types.ts sets it as kind === 'subscription'), so a bill is 0 for the same
    // reason Contract and Loan are.
    expect(bill?.is_subscription).toBe(0);
  });

  it('makes every kind a person is expected to use reachable without creating a type by hand', () => {
    current = createTestDb();
    const kinds = new Set(itemTypes(current.sqlite).map((row) => row.kind));
    // The point of the migration: 0011 admitted 'bill' and built bill_installments behind it, but
    // seeded no row, so the feature existed and could not be reached. This asserts the gap is
    // closed for EVERY kind rather than only the one reported, which is what stops the next kind
    // shipping the same way.
    for (const kind of ['warranty', 'subscription', 'contract', 'loan', 'bill']) {
      expect(kinds, `no item type carries kind '${kind}'`).toContain(kind);
    }
  });

  it('leaves a household-created Bill row alone, whatever its casing, and never duplicates it', () => {
    // The idempotency that matters, exercised for real rather than asserted about the SQL text.
    // warranty_item_types_name_uq (0003) is COLLATE NOCASE, so an unconditional insert against an
    // existing 'bill' would not merely duplicate a row -- it would fail the index and take the
    // whole upgrade down for a household that had already made their own.
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    try {
      process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
      const staged = openDatabase(file);
      // Lower-case, and deliberately carrying a DIFFERENT kind: whatever the household chose is
      // theirs to keep, and this migration has no business reclassifying it.
      staged.sqlite
        .prepare("insert into warranty_item_types (name, is_subscription, kind, created_at) values ('bill', 0, 'contract', '2026-02-01T00:00:00.000Z')")
        .run();
      const before = itemTypes(staged.sqlite).filter((row) => row.name.toLowerCase() === 'bill');
      expect(before).toHaveLength(1);
      staged.sqlite.close();

      delete process.env.BUDGET_MIGRATIONS_DIR; // falls back to the real drizzle/, which includes 0020
      const upgraded = openDatabase(file);
      try {
        const after = itemTypes(upgraded.sqlite).filter((row) => row.name.toLowerCase() === 'bill');
        expect(after, 'the migration inserted a second Bill row past the NOCASE index').toHaveLength(1);
        expect(after[0]?.name, "the household's own casing was rewritten").toBe('bill');
        expect(after[0]?.kind, "the household's own kind was rewritten").toBe('contract');
        expect(after[0]?.id).toBe(before[0]?.id);
      } finally {
        upgraded.sqlite.close();
      }
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });

  it('records itself in the journal, immediately after 0019, and is the newest', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((row) => row.tag === '0020_bill_item_type');
    expect(entry).toMatchObject({ idx: 20, tag: '0020_bill_item_type' });
    const idxs = journal.entries.map((e) => e.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(20)).toBe(idxs.indexOf(19) + 1);
    // This suite now owns the "I am the newest" claim, handed on from 0019's suite the way 0019
    // took it from 0018. Whichever migration is last owns it; nobody else asserts it.
    expect(Math.max(...idxs)).toBe(20);
  });

  it('inserts conditionally, so re-running it can never violate the NOCASE name index', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0020_bill_item_type.sql'), 'utf8');
    expect(sqlText).toMatch(/where\s+not\s+exists/i);
    // COLLATE NOCASE is load-bearing, not decoration: without it the guard passes for a household
    // that created 'bill' and the insert then fails warranty_item_types_name_uq.
    expect(sqlText).toMatch(/collate\s+nocase/i);
  });
});
