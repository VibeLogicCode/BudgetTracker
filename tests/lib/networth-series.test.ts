import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { netWorthOverTime, recordBalanceSnapshot } from '@/lib/networth';

/**
 * netWorthOverTime (spec 2026-08-22, v1.7.0, Task 7). Consumes the snapshot capture from
 * Task 6 (recordBalanceSnapshot) and debtOverTime from @/lib/loans (untouched here).
 */

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/**
 * A minimal loan-kind warranty_items fixture, duplicated locally rather than imported --
 * tests/lib/loans/debt-over-time.test.ts's own seedItem helper is private to that file. Only
 * the two dates debtOverTime keys off (createdAt = existence, balanceUpdatedAt = the anchor)
 * and the balance itself matter here; no payments are seeded, so the loan's contribution to
 * debtOverTime is simply its balance, unchanged, for every month at or after the anchor.
 */
function seedLoan(t: TestDb, ownerUserId: number, balanceCents: number, anchor = '2020-01-01T00:00:00.000Z'): number {
  const type = t.sqlite
    .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values (?, 0, 'loan', ?) returning id`)
    .get(`Loan type ${Math.random().toString(36).slice(2, 8)}`, anchor) as { id: number };
  const row = t.sqlite
    .prepare(
      `insert into warranty_items
         (name, purchase_date, is_lifetime, owner_user_id, type_id, current_balance_cents, balance_updated_at, created_at, updated_at)
       values ('Loan', '2020-01-01', 0, ?, ?, ?, ?, ?, ?) returning id`,
    )
    .get(ownerUserId, type.id, balanceCents, anchor, anchor, anchor) as { id: number };
  return row.id;
}

function deactivateAccount(t: TestDb, accountId: number): void {
  t.sqlite.prepare('update accounts set is_active = 0 where id = ?').run(accountId);
}

describe('netWorthOverTime: carry-forward', () => {
  it('a January snapshot still counts for February and March when no newer one exists', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    recordBalanceSnapshot({ accountId, date: '2026-01-15', balanceCents: 500_000, source: 'manual' });

    const series = netWorthOverTime(3, { endMonth: '2026-03', today: '2026-03-18' });

    expect(series.map((p) => p.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    for (const point of series) {
      expect(point.assetsCents).toBe(500_000);
      expect(point.accountsMissing).toBe(0);
      expect(point.netCents).toBe(500_000);
    }
  });
});

describe('netWorthOverTime: accountsMissing', () => {
  it('counts accounts with no snapshot at or before that month end, and reports 0 once every account has one', () => {
    current = createSeededTestDb();
    const a = insertTestAccount(current.db, { name: 'Has balance from June' });
    const b = insertTestAccount(current.db, { name: 'Has balance from August' });
    recordBalanceSnapshot({ accountId: a, date: '2026-06-10', balanceCents: 100_000, source: 'manual' });
    recordBalanceSnapshot({ accountId: b, date: '2026-08-05', balanceCents: 200_000, source: 'manual' });

    const series = netWorthOverTime(3, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.map((p) => p.month)).toEqual(['2026-06', '2026-07', '2026-08']);

    expect(series.find((p) => p.month === '2026-06')!.accountsMissing).toBe(1);
    expect(series.find((p) => p.month === '2026-06')!.assetsCents).toBe(100_000);
    expect(series.find((p) => p.month === '2026-07')!.accountsMissing).toBe(1);
    // Both accounts have a snapshot at or before August 31 -- nothing missing.
    expect(series.find((p) => p.month === '2026-08')!.accountsMissing).toBe(0);
    expect(series.find((p) => p.month === '2026-08')!.assetsCents).toBe(300_000);
  });
});

describe('netWorthOverTime: signed balances', () => {
  it('a negative (credit card) balance lands in debtsCents, never as a negative asset', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db, { type: 'credit' });
    recordBalanceSnapshot({ accountId, date: '2026-08-01', balanceCents: -75_000, source: 'simplefin' });

    const series = netWorthOverTime(1, { endMonth: '2026-08', today: '2026-08-18' });

    expect(series).toHaveLength(1);
    expect(series[0].assetsCents).toBe(0);
    expect(series[0].debtsCents).toBe(75_000);
    expect(series[0].netCents).toBe(-75_000);
  });
});

describe('netWorthOverTime: loan inclusion', () => {
  it('folds debtOverTime\'s owed figure for the month into debtsCents', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { username: 'nw-loan' });
    // A zero-balance account snapshot keeps the series non-empty (a household with only loans
    // and no account snapshot ever has none, per the "no snapshots at all" rule below) while
    // contributing nothing itself, isolating the loan's effect on debtsCents.
    const accountId = insertTestAccount(current.db);
    recordBalanceSnapshot({ accountId, date: '2020-06-01', balanceCents: 0, source: 'manual' });
    seedLoan(current, userId, 450_000);

    const series = netWorthOverTime(1, { endMonth: '2026-08', today: '2026-08-18' });

    expect(series).toHaveLength(1);
    expect(series[0].assetsCents).toBe(0);
    expect(series[0].debtsCents).toBe(450_000);
    expect(series[0].netCents).toBe(-450_000);
  });
});

describe('netWorthOverTime: empty cases', () => {
  it('returns [] when there are no accounts at all', () => {
    current = createSeededTestDb();
    expect(netWorthOverTime(3, { endMonth: '2026-08', today: '2026-08-18' })).toEqual([]);
  });

  it('returns [] when an account exists but has never received a snapshot', () => {
    current = createSeededTestDb();
    insertTestAccount(current.db);
    expect(netWorthOverTime(3, { endMonth: '2026-08', today: '2026-08-18' })).toEqual([]);
  });
});

describe('netWorthOverTime: leading months are omitted, never fabricated', () => {
  it('months before the first snapshot of any account are absent from the series', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    recordBalanceSnapshot({ accountId, date: '2026-07-20', balanceCents: 100_000, source: 'manual' });

    const series = netWorthOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });

    // The window is 2026-03..2026-08; only July (which contains the first snapshot) and
    // August survive -- March through June are never fabricated.
    expect(series.map((p) => p.month)).toEqual(['2026-07', '2026-08']);
  });
});

describe('netWorthOverTime: inactive accounts', () => {
  it('excludes an inactive account entirely -- not counted, not missing, not summed', () => {
    current = createSeededTestDb();
    const active = insertTestAccount(current.db, { name: 'Active' });
    const inactive = insertTestAccount(current.db, { name: 'Deactivated' });
    recordBalanceSnapshot({ accountId: active, date: '2026-08-01', balanceCents: 100_000, source: 'manual' });
    // A wildly different balance: if this leaked in, assetsCents or accountsMissing would be
    // visibly wrong below.
    recordBalanceSnapshot({ accountId: inactive, date: '2026-08-01', balanceCents: 999_999_999, source: 'manual' });
    deactivateAccount(current, inactive);

    const series = netWorthOverTime(1, { endMonth: '2026-08', today: '2026-08-18' });

    expect(series).toHaveLength(1);
    expect(series[0].assetsCents).toBe(100_000);
    expect(series[0].accountsMissing).toBe(0);
  });
});

describe('netWorthOverTime: exact arithmetic', () => {
  it('nets assets, a credit card and a loan exactly, on a mixed fixture', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { username: 'nw-mixed' });
    const chequing = insertTestAccount(current.db, { name: 'Chequing', type: 'chequing' });
    const credit = insertTestAccount(current.db, { name: 'Credit card', type: 'credit' });
    recordBalanceSnapshot({ accountId: chequing, date: '2026-08-01', balanceCents: 500_000, source: 'manual' });
    recordBalanceSnapshot({ accountId: credit, date: '2026-08-01', balanceCents: -125_000, source: 'simplefin' });
    seedLoan(current, userId, 300_000);

    const series = netWorthOverTime(1, { endMonth: '2026-08', today: '2026-08-18' });

    expect(series).toHaveLength(1);
    const point = series[0];
    expect(point.assetsCents).toBe(500_000);
    expect(point.debtsCents).toBe(125_000 + 300_000);
    expect(point.netCents).toBe(500_000 - (125_000 + 300_000));
    expect(point.netCents).toBe(75_000);
    expect(point.accountsMissing).toBe(0);
  });
});

describe('netWorthOverTime: clock-free', () => {
  it('is pure -- the same inputs produce identical output on repeated calls', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    recordBalanceSnapshot({ accountId, date: '2026-08-01', balanceCents: 42_000, source: 'manual' });

    const first = netWorthOverTime(4, { endMonth: '2026-08', today: '2026-08-18' });
    const second = netWorthOverTime(4, { endMonth: '2026-08', today: '2026-08-18' });

    expect(second).toEqual(first);
  });

  // Durable regression guard for the project-wide v1.4.0 rule (pure date/stat functions take
  // now/today as parameters, no clock access inside): scans the source text of networth.ts
  // itself, the same source-scan idiom tests/lib/loans/invariants.test.ts uses for its own
  // grep-style guards.
  it('source guard: src/lib/networth.ts never calls new Date()', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const source = fs.readFileSync(path.join(root, 'src/lib/networth.ts'), 'utf8');
    expect(source).not.toMatch(/new Date\(/);
  });
});
