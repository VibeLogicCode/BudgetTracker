import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { addDaysIso, monthEnd } from '@/lib/dates';
import { netWorthHint, netWorthOverTime, recordBalanceSnapshot } from '@/lib/networth';

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
    // Account a's June 10 snapshot is only 20 days old as of June 30 -- fresh.
    expect(series.find((p) => p.month === '2026-06')!.accountsStale).toBe(0);
    expect(series.find((p) => p.month === '2026-07')!.accountsMissing).toBe(1);
    // By July 31, account a is still carrying its June 10 snapshot forward -- now 51 days old,
    // past the 45-day threshold. accountsMissing (b) and accountsStale (a) are both non-zero
    // here, for two DIFFERENT accounts -- that is expected, not a violation of the one-bucket
    // rule (which applies per account, not per month).
    expect(series.find((p) => p.month === '2026-07')!.accountsStale).toBe(1);
    // Both accounts have a snapshot at or before August 31 -- nothing missing. But account a's
    // June 10 snapshot is now 82 days old, well past the threshold -- it must not read as
    // current just because accountsMissing is 0.
    expect(series.find((p) => p.month === '2026-08')!.accountsMissing).toBe(0);
    expect(series.find((p) => p.month === '2026-08')!.assetsCents).toBe(300_000);
    expect(series.find((p) => p.month === '2026-08')!.accountsStale).toBe(1);
  });
});

describe('netWorthOverTime: accountsStale', () => {
  it('reviewer repro: a snapshot ten months old must not read as current -- accountsMissing stays 0 (a snapshot DOES exist) but it now counts in accountsStale', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    recordBalanceSnapshot({ accountId, date: '2025-10-15', balanceCents: 500_000, source: 'manual' });

    const series = netWorthOverTime(1, { endMonth: '2026-08', today: '2026-08-22' });

    expect(series).toHaveLength(1);
    // This is the exact defect: accountsMissing is correctly 0 because a snapshot exists, but
    // before the fix nothing distinguished "exists" from "ten months old".
    expect(series[0].accountsMissing).toBe(0);
    expect(series[0].accountsStale).toBe(1);
    // Disclosure only -- the stale balance still carries forward into the total at full value.
    expect(series[0].assetsCents).toBe(500_000);
  });

  it('a snapshot inside the threshold is in NEITHER bucket', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    // 30 days before the August month end -- comfortably inside the 45-day slack.
    recordBalanceSnapshot({ accountId, date: addDaysIso(monthEnd('2026-08'), -30), balanceCents: 100_000, source: 'manual' });

    const series = netWorthOverTime(1, { endMonth: '2026-08', today: '2026-08-22' });

    expect(series[0].accountsMissing).toBe(0);
    expect(series[0].accountsStale).toBe(0);
  });

  it('an account with no snapshot at all is in accountsMissing only, never also in accountsStale', () => {
    current = createSeededTestDb();
    const withSnapshot = insertTestAccount(current.db, { name: 'Has balance' });
    insertTestAccount(current.db, { name: 'Never snapshotted' });
    recordBalanceSnapshot({ accountId: withSnapshot, date: '2026-08-01', balanceCents: 100_000, source: 'manual' });

    const series = netWorthOverTime(1, { endMonth: '2026-08', today: '2026-08-22' });

    expect(series[0].accountsMissing).toBe(1);
    expect(series[0].accountsStale).toBe(0);
  });

  it('boundary: exactly 45 days old is not stale, 46 days old (one day past) is', () => {
    current = createSeededTestDb();
    const onBoundary = insertTestAccount(current.db, { name: 'Exactly on the line' });
    const pastBoundary = insertTestAccount(current.db, { name: 'One day past' });
    const end = monthEnd('2026-08');
    recordBalanceSnapshot({ accountId: onBoundary, date: addDaysIso(end, -45), balanceCents: 10_000, source: 'manual' });
    recordBalanceSnapshot({ accountId: pastBoundary, date: addDaysIso(end, -46), balanceCents: 10_000, source: 'manual' });

    const series = netWorthOverTime(1, { endMonth: '2026-08', today: '2026-08-22' });

    expect(series[0].accountsMissing).toBe(0);
    expect(series[0].accountsStale).toBe(1); // only the 46-day-old account
  });

  it('staleness is evaluated per month -- fresh in an early month, stale once enough months pass with no new snapshot', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    recordBalanceSnapshot({ accountId, date: '2026-01-20', balanceCents: 100_000, source: 'manual' });

    const series = netWorthOverTime(3, { endMonth: '2026-03', today: '2026-03-25' });

    expect(series.map((p) => p.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(series.find((p) => p.month === '2026-01')!.accountsStale).toBe(0); // 11 days old
    expect(series.find((p) => p.month === '2026-02')!.accountsStale).toBe(0); // 39 days old
    expect(series.find((p) => p.month === '2026-03')!.accountsStale).toBe(1); // 70 days old
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
  it('excludes an inactive account entirely -- not counted, not missing, not stale, not summed', () => {
    current = createSeededTestDb();
    const active = insertTestAccount(current.db, { name: 'Active' });
    const inactive = insertTestAccount(current.db, { name: 'Deactivated' });
    recordBalanceSnapshot({ accountId: active, date: '2026-08-01', balanceCents: 100_000, source: 'manual' });
    // A wildly different balance AND a snapshot old enough to be stale on its own: if either
    // leaked in, assetsCents, accountsMissing or accountsStale would be visibly wrong below.
    recordBalanceSnapshot({ accountId: inactive, date: '2020-01-01', balanceCents: 999_999_999, source: 'manual' });
    deactivateAccount(current, inactive);

    const series = netWorthOverTime(1, { endMonth: '2026-08', today: '2026-08-18' });

    expect(series).toHaveLength(1);
    expect(series[0].assetsCents).toBe(100_000);
    expect(series[0].accountsMissing).toBe(0);
    expect(series[0].accountsStale).toBe(0);
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

/**
 * Adversarial-review fix (2026-08-23), Defect 2: the dashboard "Net worth" stat tile's hint was
 * the fixed string "Assets minus debts and loans, across every tracked account" regardless of
 * accountsMissing/accountsStale, contradicting the Reports card's own honesty note for the same
 * figure on the same day. netWorthHint is the pure copy-selection logic behind that tile's hint
 * prop (src/app/(app)/dashboard/page.tsx calls it directly on the latest NetWorthPoint) -- kept
 * here, next to NetWorthPoint's own tests, rather than in a dashboard-page test, since the page
 * itself is an async server component with no existing test harness and the fix is entirely
 * this pure string selection.
 */
describe('netWorthHint', () => {
  it('keeps the plain "every tracked account" wording when nothing is missing or stale', () => {
    expect(netWorthHint({ accountsMissing: 0, accountsStale: 0 })).toBe(
      'Assets minus debts and loans, across every tracked account',
    );
  });

  it('says so plainly, singular, when exactly one account has no balance at all -- and drops the "every tracked account" claim', () => {
    const hint = netWorthHint({ accountsMissing: 1, accountsStale: 0 });
    expect(hint).toBe('1 account has no balance yet');
    expect(hint).not.toContain('every tracked account');
  });

  it('says so plainly, plural, when more than one account has no balance at all', () => {
    const hint = netWorthHint({ accountsMissing: 3, accountsStale: 0 });
    expect(hint).toBe('3 accounts have no balance yet');
    expect(hint).not.toContain('every tracked account');
  });

  it('says so plainly, singular, when exactly one account is stale', () => {
    const hint = netWorthHint({ accountsMissing: 0, accountsStale: 1 });
    expect(hint).toBe('1 account has an outdated balance');
    expect(hint).not.toContain('every tracked account');
  });

  it('says so plainly, plural, when more than one account is stale', () => {
    const hint = netWorthHint({ accountsMissing: 0, accountsStale: 2 });
    expect(hint).toBe('2 accounts have outdated balances');
    expect(hint).not.toContain('every tracked account');
  });

  it('covers both counts at once without claiming every account is current, and stays short', () => {
    const hint = netWorthHint({ accountsMissing: 1, accountsStale: 1 });
    expect(hint).toBe('Some accounts have no balance or an outdated one');
    expect(hint).not.toContain('every tracked account');
  });
});
