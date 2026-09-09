import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from '../helpers/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 2026-09-08. month_closures: which months the household has declared complete.
 *
 * Recorded rather than inferred, because a quiet account has nothing to import and no import-timing
 * rule can tell that from a statement that has not arrived — see the migration's own comment and
 * src/lib/month-close.ts.
 */
let t: TestDb | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

describe('drizzle/0022_month_closures.sql', () => {
  it('creates the table with the month as its primary key', () => {
    t = createTestDb();
    const columns = (t.sqlite.pragma('table_info(month_closures)') as { name: string; pk: number }[]);
    expect(columns.map((c) => c.name).sort()).toEqual(['closed_at', 'closed_by', 'month', 'summary_sent_at']);
    // One closure per month, enforced by the schema rather than by a query: two rows for the same
    // month would make "has this been summarised" ambiguous.
    expect(columns.find((c) => c.name === 'month')?.pk).toBe(1);
  });

  it('allows a null closed_by, which is how an automatic closure records itself', () => {
    t = createTestDb();
    // A household whose accounts are all SimpleFIN-linked closes without anybody pressing
    // anything, and NULL is the same "no person was involved" convention notification_outbox
    // already uses for the family channel.
    expect(() =>
      t!.sqlite.prepare('insert into month_closures (month, closed_by, closed_at) values (?, ?, ?)').run('2026-07', null, '2026-08-01T00:00:00.000Z'),
    ).not.toThrow();
  });

  it('refuses a second row for the same month', () => {
    t = createTestDb();
    const insert = () =>
      t!.sqlite
        .prepare('insert into month_closures (month, closed_by, closed_at) values (?, ?, ?)')
        .run('2026-07', null, '2026-08-01T00:00:00.000Z');
    insert();
    expect(insert).toThrow(/UNIQUE|PRIMARY/i);
  });

  it('records itself in the journal, immediately after 0021', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((row) => row.tag === '0022_month_closures');
    expect(entry).toMatchObject({ idx: 22, tag: '0022_month_closures' });
    const idxs = journal.entries.map((e) => e.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(22)).toBe(idxs.indexOf(21) + 1);
    // The "I am the newest" claim moved on to migration-0023.test.ts. This suite keeps the
    // ordering claim, which is the one that stays true for ever.
  });
});
