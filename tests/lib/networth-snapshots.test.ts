import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { deleteCsvSnapshotsForAccountDates, latestSnapshots, recordBalanceSnapshot } from '@/lib/networth';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/** Fresh seeded db plus one account -- the fixture v1.12.1's own describe blocks below reuse. */
function setup(): { accountId: number } {
  current = createSeededTestDb();
  const accountId = insertTestAccount(current.db);
  return { accountId };
}

/** Same, but two accounts, for tests asserting one account's delete leaves the other alone. */
function setupTwoAccounts(): { accountId: number; otherAccountId: number } {
  current = createSeededTestDb();
  const accountId = insertTestAccount(current.db, { name: 'Account A' });
  const otherAccountId = insertTestAccount(current.db, { name: 'Account B' });
  return { accountId, otherAccountId };
}

/**
 * Reads one account_balance_snapshots row back by (account_id, date). Typed as always-present --
 * every call site in this file reads a date it just wrote -- unlike commit.test.ts's own
 * snapshotAt, which also asserts absence after undo and stays optional for that reason.
 */
function snapshotAt(accountId: number, date: string): { balanceCents: number; source: string } {
  return current!.sqlite
    .prepare('select balance_cents as balanceCents, source from account_balance_snapshots where account_id = ? and date = ?')
    .get(accountId, date) as { balanceCents: number; source: string };
}

describe('recordBalanceSnapshot (spec 2026-08-22 v1.7.0 Task 6)', () => {
  it('inserts the first snapshot for an account and date', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);

    recordBalanceSnapshot({ accountId, date: '2026-08-15', balanceCents: 123456, source: 'simplefin' });

    const rows = current.sqlite
      .prepare('select account_id, date, balance_cents, source from account_balance_snapshots')
      .all() as { account_id: number; date: string; balance_cents: number; source: string }[];
    expect(rows).toEqual([{ account_id: accountId, date: '2026-08-15', balance_cents: 123456, source: 'simplefin' }]);
  });

  it('a second write for the same account and date REPLACES the balance instead of adding a row', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);

    // v1.12.1 (item BB / MON-4): 'manual' then 'simplefin', not the reverse -- source authority
    // is now enforced (see the describe block below this one), and a downgrade write would no
    // longer replace the row this test is checking for. An upgrade still does, which is all this
    // test is about: one row survives, not two.
    recordBalanceSnapshot({ accountId, date: '2026-08-15', balanceCents: 100000, source: 'manual' });
    recordBalanceSnapshot({ accountId, date: '2026-08-15', balanceCents: 150000, source: 'simplefin' });

    const rows = current.sqlite
      .prepare('select balance_cents, source from account_balance_snapshots where account_id = ?')
      .all(accountId) as { balance_cents: number; source: string }[];
    expect(rows).toEqual([{ balance_cents: 150000, source: 'simplefin' }]);
  });

  it('a write for a different date on the same account adds a second row (history is kept across days)', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);

    recordBalanceSnapshot({ accountId, date: '2026-08-14', balanceCents: 100000, source: 'simplefin' });
    recordBalanceSnapshot({ accountId, date: '2026-08-15', balanceCents: 105000, source: 'simplefin' });

    const count = current.sqlite
      .prepare('select count(*) as c from account_balance_snapshots where account_id = ?')
      .get(accountId) as { c: number };
    expect(count.c).toBe(2);
  });

  it('a write for a different account adds a separate row, even on the same date', () => {
    current = createSeededTestDb();
    const a = insertTestAccount(current.db, { name: 'Account A' });
    const b = insertTestAccount(current.db, { name: 'Account B' });

    recordBalanceSnapshot({ accountId: a, date: '2026-08-15', balanceCents: 100000, source: 'simplefin' });
    recordBalanceSnapshot({ accountId: b, date: '2026-08-15', balanceCents: 200000, source: 'simplefin' });

    const count = current.sqlite.prepare('select count(*) as c from account_balance_snapshots').get() as { c: number };
    expect(count.c).toBe(2);
  });

  it('stores and returns a negative balance untouched -- a credit card owing money is never sign-flipped', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db, { type: 'credit' });

    recordBalanceSnapshot({ accountId, date: '2026-08-15', balanceCents: -45000, source: 'simplefin' });

    const row = current.sqlite
      .prepare('select balance_cents from account_balance_snapshots where account_id = ?')
      .get(accountId) as { balance_cents: number };
    expect(row.balance_cents).toBe(-45000);
    // movedSinceCents 0 throughout this suite: none of these fixtures seed a transaction after
    // the anchor, so every balance here IS its snapshot's own stored figure.
    expect(latestSnapshots('2026-08-15')).toEqual([
      { accountId, date: '2026-08-15', balanceCents: -45000, movedSinceCents: 0 },
    ]);
  });

  it('rejects a non-ISO date and writes nothing', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);

    expect(() => recordBalanceSnapshot({ accountId, date: '08/15/2026', balanceCents: 100, source: 'manual' })).toThrow();
    expect(() => recordBalanceSnapshot({ accountId, date: '2026-02-30', balanceCents: 100, source: 'manual' })).toThrow();
    expect(() => recordBalanceSnapshot({ accountId, date: '', balanceCents: 100, source: 'manual' })).toThrow();
    expect(current.sqlite.prepare('select count(*) as c from account_balance_snapshots').get()).toMatchObject({ c: 0 });
  });

  it('rejects an account that does not exist and writes nothing', () => {
    current = createSeededTestDb();
    expect(() => recordBalanceSnapshot({ accountId: 999999, date: '2026-08-15', balanceCents: 100, source: 'manual' })).toThrow();
    expect(current.sqlite.prepare('select count(*) as c from account_balance_snapshots').get()).toMatchObject({ c: 0 });
  });
});

describe('latestSnapshots (spec 2026-08-22 v1.7.0 Task 6)', () => {
  it('returns nothing when there are no snapshots at all', () => {
    current = createSeededTestDb();
    insertTestAccount(current.db);
    expect(latestSnapshots('2026-08-15')).toEqual([]);
  });

  it('picks the newest snapshot at or before today and ignores future-dated rows', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    recordBalanceSnapshot({ accountId, date: '2026-08-01', balanceCents: 100000, source: 'simplefin' });
    recordBalanceSnapshot({ accountId, date: '2026-08-10', balanceCents: 110000, source: 'simplefin' });
    recordBalanceSnapshot({ accountId, date: '2026-08-20', balanceCents: 999999, source: 'simplefin' }); // after "today" below

    expect(latestSnapshots('2026-08-15')).toEqual([
      { accountId, date: '2026-08-10', balanceCents: 110000, movedSinceCents: 0 },
    ]);
  });

  it('returns exactly the snapshot dated today when one exists', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    recordBalanceSnapshot({ accountId, date: '2026-08-15', balanceCents: 55555, source: 'manual' });

    expect(latestSnapshots('2026-08-15')).toEqual([
      { accountId, date: '2026-08-15', balanceCents: 55555, movedSinceCents: 0 },
    ]);
  });

  it('omits accounts with no snapshot while still returning accounts that have one', () => {
    current = createSeededTestDb();
    const withSnapshot = insertTestAccount(current.db, { name: 'Has Balance' });
    insertTestAccount(current.db, { name: 'No Balance' });
    recordBalanceSnapshot({ accountId: withSnapshot, date: '2026-08-15', balanceCents: 42000, source: 'simplefin' });

    expect(latestSnapshots('2026-08-15')).toEqual([
      { accountId: withSnapshot, date: '2026-08-15', balanceCents: 42000, movedSinceCents: 0 },
    ]);
  });

  it('reports non-zero movedSinceCents when transactions posted after the anchor', () => {
    // v1.8.0 review defect. latestSnapshots now resolves through balanceAsOf, so balanceCents
    // is current while `date` stays the ANCHOR date. Without movedSinceCents the accounts page
    // had no way to tell those apart and rendered "<today's figure> as of <old date>" -- a
    // today number wearing an anchor-date label, which is what ruling R7 exists to prevent.
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    const userId = insertTestUser(current.db);
    recordBalanceSnapshot({ accountId, date: '2026-08-01', balanceCents: 100000, source: 'csv' });
    current.sqlite
      .prepare(
        `insert into transactions
           (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
         values (?, '2026-08-10', 'GROCERY STORE', 'GROCERY STORE', -2500, ?, ?, ?)`,
      )
      .run(accountId, userId, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');

    expect(latestSnapshots('2026-08-15')).toEqual([
      { accountId, date: '2026-08-01', balanceCents: 97500, movedSinceCents: -2500 },
    ]);
  });

  it('returns one row per account even across many days of history', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    for (const date of ['2026-07-01', '2026-07-15', '2026-08-01', '2026-08-10']) {
      recordBalanceSnapshot({ accountId, date, balanceCents: 1000, source: 'simplefin' });
    }
    expect(latestSnapshots('2026-08-31')).toHaveLength(1);
  });
});

describe('v1.12.1: source authority is implemented, not just documented (item BB / MON-4)', () => {
  it('a hand-typed correction does not overwrite the bank statement figure', () => {
    const { accountId } = setup();
    recordBalanceSnapshot({ accountId, date: '2026-08-20', balanceCents: 341218, source: 'csv' });
    recordBalanceSnapshot({ accountId, date: '2026-08-20', balanceCents: 310244, source: 'manual' });

    const row = snapshotAt(accountId, '2026-08-20');
    expect(row.balanceCents).toBe(341218);
    expect(row.source).toBe('csv');
  });

  it('a statement figure does overwrite a hand-typed one', () => {
    const { accountId } = setup();
    recordBalanceSnapshot({ accountId, date: '2026-08-20', balanceCents: 310244, source: 'manual' });
    recordBalanceSnapshot({ accountId, date: '2026-08-20', balanceCents: 341218, source: 'csv' });

    expect(snapshotAt(accountId, '2026-08-20').balanceCents).toBe(341218);
  });

  it('simplefin outranks csv, and equal rank is still last-write', () => {
    const { accountId } = setup();
    recordBalanceSnapshot({ accountId, date: '2026-08-20', balanceCents: 100, source: 'csv' });
    recordBalanceSnapshot({ accountId, date: '2026-08-20', balanceCents: 200, source: 'simplefin' });
    expect(snapshotAt(accountId, '2026-08-20').balanceCents).toBe(200);

    // Equal rank must stay last-write, or re-importing a corrected statement could never fix a day.
    recordBalanceSnapshot({ accountId, date: '2026-08-20', balanceCents: 300, source: 'simplefin' });
    expect(snapshotAt(accountId, '2026-08-20').balanceCents).toBe(300);
  });

  it('a first write of any source still inserts', () => {
    const { accountId } = setup();
    recordBalanceSnapshot({ accountId, date: '2026-08-21', balanceCents: 500, source: 'manual' });
    expect(snapshotAt(accountId, '2026-08-21').balanceCents).toBe(500);
  });
});

describe('v1.12.1: csv snapshots can be deleted (item AE / MON-5)', () => {
  it('deletes only csv rows, only on the named account and dates', () => {
    const { accountId, otherAccountId } = setupTwoAccounts();
    recordBalanceSnapshot({ accountId, date: '2026-08-30', balanceCents: 1, source: 'csv' });
    recordBalanceSnapshot({ accountId, date: '2026-08-31', balanceCents: 2, source: 'csv' });
    recordBalanceSnapshot({ accountId, date: '2026-09-01', balanceCents: 3, source: 'manual' });
    recordBalanceSnapshot({ accountId: otherAccountId, date: '2026-08-31', balanceCents: 4, source: 'csv' });

    const deleted = deleteCsvSnapshotsForAccountDates(accountId, ['2026-08-30', '2026-08-31', '2026-09-01']);

    expect(deleted).toBe(2);
    expect(snapshotAt(accountId, '2026-09-01').balanceCents).toBe(3);
    expect(snapshotAt(otherAccountId, '2026-08-31').balanceCents).toBe(4);
  });

  it('an empty date list deletes nothing and runs no query', () => {
    const { accountId } = setup();
    expect(deleteCsvSnapshotsForAccountDates(accountId, [])).toBe(0);
  });
});
