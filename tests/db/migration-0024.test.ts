import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function columns(): string[] {
  return current!.sqlite
    .prepare(`pragma table_info(merchant_rules)`)
    .all()
    .map((row) => (row as { name: string }).name);
}

function indexSql(name: string): string {
  const row = current!.sqlite.prepare(`select sql from sqlite_master where type = 'index' and name = ?`).get(name) as
    | { sql: string | null }
    | undefined;
  return row?.sql ?? '';
}

/**
 * drizzle wraps a SQLite failure in a DrizzleError whose own message is only "Failed to run the
 * query ...", so asserting on the wrapper says nothing about WHY the write was refused. This walks
 * down to the SqliteError underneath, which is where "UNIQUE constraint failed" and friends live.
 */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    let current: unknown = error;
    while (current instanceof Error && current.cause !== undefined) current = current.cause;
    return current instanceof Error ? current.message : String(current);
  }
  return '';
}

/**
 * Migration 0024, for the reported report of 2026-09-13: "insurance is with same company but
 * different amount but imported categorizes the last setting i do so everything goes to home or
 * auto. can i set in rule vendor + amount rule?" -- plus "think about person too so its not just
 * on vendor rule, even sets household, or individual person."
 *
 * Spec: docs/superpowers/specs/2026-09-13-vendor-amount-person-rules-design.md.
 */
describe('migration 0024: bounds and attribution on merchant_rules', () => {
  it('adds the three columns', () => {
    current = createSeededTestDb();
    expect(columns()).toEqual(expect.arrayContaining(['amount_min_cents', 'amount_max_cents', 'attributed_user_id']));
  });

  it('leaves every existing rule unbounded, so nothing already stored changes behaviour', () => {
    current = createSeededTestDb();
    const row = current.db.get<{ minCents: number | null; maxCents: number | null }>(
      sql`select amount_min_cents as minCents, amount_max_cents as maxCents from merchant_rules limit 1`,
    );
    expect(row?.minCents ?? null).toBeNull();
    expect(row?.maxCents ?? null).toBeNull();
  });

  /**
   * The point of the whole migration: two rules for ONE merchant, telling two amounts apart. The
   * old three-column unique index made that impossible. `coalesce` is load-bearing in the new one
   * -- SQLite treats NULLs in a UNIQUE index as distinct, so a plain five-column index would let
   * two UNBOUNDED rules coexist and break every upsert that relies on the conflict target.
   */
  it('lets two rules for one merchant coexist when their amount ranges differ', () => {
    current = createSeededTestDb();
    const now = '2026-09-13T00:00:00.000Z';
    const insert = (min: number, max: number) =>
      current!.db.run(
        sql`insert into merchant_rules (pattern, match_type, rule_kind, category_id, amount_min_cents, amount_max_cents, created_at)
            values ('INTACT INSURANCE', 'exact', 'category', 1, ${min}, ${max}, ${now})`,
      );
    insert(12500, 15500);
    expect(() => insert(28000, 32000)).not.toThrow();
  });

  it('still refuses a second UNBOUNDED rule for the same merchant', () => {
    current = createSeededTestDb();
    const now = '2026-09-13T00:00:00.000Z';
    const insert = () =>
      current!.db.run(
        sql`insert into merchant_rules (pattern, match_type, rule_kind, category_id, created_at)
            values ('INTACT INSURANCE', 'exact', 'category', 1, ${now})`,
      );
    insert();
    expect(refusal(insert)).toMatch(/unique/i);
  });

  it('refuses two rules whose ranges are identical, which would be the same rule twice', () => {
    current = createSeededTestDb();
    const now = '2026-09-13T00:00:00.000Z';
    const insert = () =>
      current!.db.run(
        sql`insert into merchant_rules (pattern, match_type, rule_kind, category_id, amount_min_cents, amount_max_cents, created_at)
            values ('INTACT INSURANCE', 'exact', 'category', 1, 12500, 15500, ${now})`,
      );
    insert();
    expect(refusal(insert)).toMatch(/unique/i);
  });

  it('keeps the index under its old name, so every guard that looks for it still finds it', () => {
    current = createSeededTestDb();
    expect(indexSql('merchant_rules_pattern_uq')).toMatch(/coalesce/i);
  });

  it('points attributed_user_id at a real person, and lets it be NULL for Household', () => {
    current = createSeededTestDb();
    const now = '2026-09-13T00:00:00.000Z';
    const user = insertTestUser(current.db, { role: 'admin' });
    expect(() =>
      current!.db.run(
        sql`insert into merchant_rules (pattern, match_type, rule_kind, attributed_user_id, created_at)
            values ('SAMS GYM', 'exact', 'attribution', ${user}, ${now})`,
      ),
    ).not.toThrow();
    expect(() =>
      current!.db.run(
        sql`insert into merchant_rules (pattern, match_type, rule_kind, attributed_user_id, created_at)
            values ('JOINT GYM', 'exact', 'attribution', null, ${now})`,
      ),
    ).not.toThrow();
    expect(
      refusal(() =>
        current!.db.run(
          sql`insert into merchant_rules (pattern, match_type, rule_kind, attributed_user_id, created_at)
              values ('GHOST GYM', 'exact', 'attribution', 99999, ${now})`,
        ),
      ),
    ).toMatch(/foreign key/i);
  });

  it('records itself in the journal, immediately after 0023, and is the newest', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((row) => row.tag === '0024_rule_bounds_and_attribution')).toMatchObject({ idx: 24 });
    const idxs = journal.entries.map((entry) => entry.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(24)).toBe(idxs.indexOf(23) + 1);
    // This suite now owns the "I am the newest" claim, handed on from 0023's.
    expect(Math.max(...idxs)).toBe(24);
  });

  it('refuses a range whose minimum is above its maximum', () => {
    current = createSeededTestDb();
    const now = '2026-09-13T00:00:00.000Z';
    expect(
      refusal(() =>
        current!.db.run(
          sql`insert into merchant_rules (pattern, match_type, rule_kind, category_id, amount_min_cents, amount_max_cents, created_at)
              values ('BACKWARDS', 'exact', 'category', 1, 20000, 10000, ${now})`,
        ),
      ),
    ).toMatch(/check/i);
  });
});
