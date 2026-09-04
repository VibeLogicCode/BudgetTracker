import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPIRING_SOON_DAYS, STATUS_CASE_SQL, warrantyStatus } from '@/lib/warranty/expiry';
import { addDaysIso } from '@/lib/dates';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';

const ROOT = process.cwd();
const RECURRING = 'src/lib/recurring.ts';
const TODAY = '2026-09-04';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/**
 * v1.31.0 item M-2. "This item has not ended" is written THREE times: `warrantyStatus()` in
 * TypeScript, `STATUS_CASE_SQL` as a raw SQL CASE, and `notEnded()` in src/lib/recurring.ts as a
 * composable drizzle predicate. All three agree today. Nothing tied them together.
 *
 * WHY THREE COPIES AND NOT ONE. There is a real structural excuse, which is why M-2 is minor
 * rather than important: `STATUS_CASE_SQL` is a raw string with `i.` aliases and positional `?`
 * binds, so it cannot compose into a drizzle `and()`, and the obvious consolidation -- exporting a
 * drizzle predicate from src/lib/warranty/expiry.ts -- would drag `@/db/schema` and drizzle into a
 * module that 'use client' components value-import (StatusBadge among them), which
 * tests/ops/client-bundle.test.ts exists to prevent. Making expiry.ts import the schema to remove
 * a duplicate would trade a stated duplication for an unstated bundle regression, so the
 * duplication stays and this file is what stops it drifting.
 *
 * WHAT THIS FILE DOES INSTEAD, and why it is not a fourth copy. It EXTRACTS recurring.ts's own
 * predicate from its source text and runs it, so the SQL under test is the shipped SQL rather than
 * a restatement of it -- a test that retyped the predicate would agree with itself forever while
 * the real one drifted (the failure mode tests/ops/canadian-merchants-pack.test.ts calls out for
 * reimplementing what it guards). All three answers are then compared on the dates where an
 * off-by-one lives: the day before expiry, the expiry date itself, and the day after.
 *
 * WHAT IT CANNOT CATCH. It reads ONE named function. A second not-ended predicate written
 * somewhere else is invisible to it; only `isLifetime`-bearing predicates exist under src/ today
 * (checked while writing this), and the durable fix -- one composable definition both SQL callers
 * read -- is still the better answer whenever expiry.ts can be split so the client half stays pure.
 */
function extractNotEndedSql(): { sql: string; binds: number } {
  const source = fs.readFileSync(path.join(ROOT, RECURRING), 'utf8');
  const start = source.indexOf('function notEnded(');
  expect(start, `${RECURRING} no longer declares notEnded()`).toBeGreaterThan(-1);
  const open = source.indexOf('`', start);
  const close = source.indexOf('`', open + 1);
  expect(close, 'notEnded() is no longer a single tagged template').toBeGreaterThan(open);
  const template = source.slice(open + 1, close);

  // `${warrantyItems.expiryDate}` -> `expiry_date`; `${today}` -> a positional bind. Drizzle emits
  // exactly this substitution at runtime, minus the table alias, which the query below supplies.
  let binds = 0;
  const converted = template
    .replace(/\$\{warrantyItems\.([A-Za-z0-9_$]+)\}/g, (_all, column: string) =>
      column.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
    )
    .replace(/\$\{[^}]+\}/g, () => {
      binds += 1;
      return '?';
    });
  expect(converted, 'the extracted predicate no longer mentions both columns').toContain('is_lifetime');
  expect(converted).toContain('expiry_date');
  expect(binds, 'notEnded() no longer takes exactly one bound value (today)').toBe(1);
  return { sql: converted, binds };
}

interface Row {
  id: number;
  label: string;
  expiryDate: string | null;
  isLifetime: boolean;
}

/** One row per way an item can sit relative to today, with the three boundary dates in the middle. */
function seedItems(): Row[] {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { username: 'expiry' });
  const type = current.sqlite
    .prepare("insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Streaming', 1, 'subscription', ?) returning id")
    .get(TODAY) as { id: number };

  const cases: { label: string; expiryDate: string | null; isLifetime: boolean }[] = [
    { label: 'ended yesterday', expiryDate: addDaysIso(TODAY, -1), isLifetime: false },
    { label: 'ends today', expiryDate: TODAY, isLifetime: false },
    { label: 'ends tomorrow', expiryDate: addDaysIso(TODAY, 1), isLifetime: false },
    { label: 'ends on the expiring-soon edge', expiryDate: addDaysIso(TODAY, EXPIRING_SOON_DAYS), isLifetime: false },
    { label: 'ends the day after that edge', expiryDate: addDaysIso(TODAY, EXPIRING_SOON_DAYS + 1), isLifetime: false },
    { label: 'ended long ago', expiryDate: addDaysIso(TODAY, -400), isLifetime: false },
    { label: 'no end date recorded', expiryDate: null, isLifetime: false },
    { label: 'open ended', expiryDate: null, isLifetime: true },
  ];

  // warranty_months and expiry_date are NULL together or set together (a CHECK constraint on the
  // table, and MUST-3.6: the expiry is computed at write time from the term, never derived on read).
  const insert = current.sqlite.prepare(
    `insert into warranty_items (name, purchase_date, warranty_months, expiry_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
     values (?, '2024-01-15', ?, ?, ?, ?, ?, ?, ?) returning id`,
  );
  return cases.map((entry) => {
    const row = insert.get(
      entry.label,
      entry.expiryDate === null ? null : 12,
      entry.expiryDate,
      entry.isLifetime ? 1 : 0,
      userId,
      type.id,
      TODAY,
      TODAY,
    ) as { id: number };
    return { id: row.id, ...entry };
  });
}

describe('M-2: "has not ended" means the same thing in all three places it is written', () => {
  it('recurring.ts\'s drizzle predicate, STATUS_CASE_SQL and warrantyStatus() agree on every boundary date', () => {
    const rows = seedItems();
    const { sql: notEndedSql } = extractNotEndedSql();
    const sqlite = (current as TestDb).sqlite;

    // 1. The predicate as recurring.ts actually ships it.
    const liveIds = new Set(
      (sqlite.prepare(`select id from warranty_items where ${notEndedSql}`).all(TODAY) as { id: number }[]).map((row) => row.id),
    );

    // 2. STATUS_CASE_SQL, with the two binds its docblock specifies, in that order.
    const soon = addDaysIso(TODAY, EXPIRING_SOON_DAYS);
    const statuses = new Map(
      (
        sqlite.prepare(`select i.id as id, ${STATUS_CASE_SQL} as status from warranty_items i`).all(TODAY, soon) as {
          id: number;
          status: string;
        }[]
      ).map((row) => [row.id, row.status]),
    );

    const disagreements = rows
      .map((row) => ({
        label: row.label,
        // 3. warrantyStatus(), the TypeScript original.
        typescript: warrantyStatus({ expiryDate: row.expiryDate, isLifetime: row.isLifetime }, TODAY) !== 'expired',
        caseSql: statuses.get(row.id) !== 'expired',
        predicate: liveIds.has(row.id),
      }))
      .filter((row) => !(row.typescript === row.caseSql && row.caseSql === row.predicate));

    expect(
      disagreements,
      'The three expressions of "this item has not ended" no longer agree. They are ' +
        'warrantyStatus() and STATUS_CASE_SQL (src/lib/warranty/expiry.ts) and notEnded() ' +
        '(src/lib/recurring.ts). `< today` and `>= today` are complements, so any difference here ' +
        'is a real off-by-one on the expiry date itself -- and the Recurring card would then count ' +
        'an ended contract as tracked, which is the one row that card exists to surface.',
    ).toEqual([]);

    // The comparison is not vacuous: both partitions are non-empty, so an "agrees" that came from
    // three empty sets could not pass.
    expect(rows.filter((row) => liveIds.has(row.id)).length).toBeGreaterThan(0);
    expect(rows.filter((row) => !liveIds.has(row.id)).length).toBeGreaterThan(0);
    // And coverage is inclusive of the expiry date itself, which is the whole boundary (MUST-3.14).
    const endsToday = rows.find((row) => row.label === 'ends today') as Row;
    expect(liveIds.has(endsToday.id)).toBe(true);
    const endedYesterday = rows.find((row) => row.label === 'ended yesterday') as Row;
    expect(liveIds.has(endedYesterday.id)).toBe(false);
  });

  it('an off-by-one in the extracted predicate is caught, not tolerated (positive control)', () => {
    // Nothing above proves the comparison can FAIL. Here the shipped predicate is deliberately
    // weakened from `>= ?` to `> ?` -- the one plausible typo -- and the boundary row must move.
    const rows = seedItems();
    const { sql: notEndedSql } = extractNotEndedSql();
    const sqlite = (current as TestDb).sqlite;
    const broken = notEndedSql.replace('>= ?', '> ?');
    expect(broken, 'the extracted predicate no longer contains the inclusive comparison').not.toBe(notEndedSql);

    const endsToday = rows.find((row) => row.label === 'ends today') as Row;
    const live = new Set(
      (sqlite.prepare(`select id from warranty_items where ${notEndedSql}`).all(TODAY) as { id: number }[]).map((row) => row.id),
    );
    const brokenLive = new Set(
      (sqlite.prepare(`select id from warranty_items where ${broken}`).all(TODAY) as { id: number }[]).map((row) => row.id),
    );
    expect(live.has(endsToday.id)).toBe(true);
    expect(brokenLive.has(endsToday.id)).toBe(false);
    expect(warrantyStatus({ expiryDate: endsToday.expiryDate, isLifetime: false }, TODAY)).toBe('expiring');
  });
});
