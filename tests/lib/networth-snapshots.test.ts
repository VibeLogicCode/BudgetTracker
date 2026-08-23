import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, type TestDb } from '../helpers/db';
import { latestSnapshots, recordBalanceSnapshot } from '@/lib/networth';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

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

    recordBalanceSnapshot({ accountId, date: '2026-08-15', balanceCents: 100000, source: 'simplefin' });
    recordBalanceSnapshot({ accountId, date: '2026-08-15', balanceCents: 150000, source: 'manual' });

    const rows = current.sqlite
      .prepare('select balance_cents, source from account_balance_snapshots where account_id = ?')
      .all(accountId) as { balance_cents: number; source: string }[];
    expect(rows).toEqual([{ balance_cents: 150000, source: 'manual' }]);
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
    expect(latestSnapshots('2026-08-15')).toEqual([{ accountId, date: '2026-08-15', balanceCents: -45000 }]);
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

    expect(latestSnapshots('2026-08-15')).toEqual([{ accountId, date: '2026-08-10', balanceCents: 110000 }]);
  });

  it('returns exactly the snapshot dated today when one exists', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    recordBalanceSnapshot({ accountId, date: '2026-08-15', balanceCents: 55555, source: 'manual' });

    expect(latestSnapshots('2026-08-15')).toEqual([{ accountId, date: '2026-08-15', balanceCents: 55555 }]);
  });

  it('omits accounts with no snapshot while still returning accounts that have one', () => {
    current = createSeededTestDb();
    const withSnapshot = insertTestAccount(current.db, { name: 'Has Balance' });
    insertTestAccount(current.db, { name: 'No Balance' });
    recordBalanceSnapshot({ accountId: withSnapshot, date: '2026-08-15', balanceCents: 42000, source: 'simplefin' });

    expect(latestSnapshots('2026-08-15')).toEqual([{ accountId: withSnapshot, date: '2026-08-15', balanceCents: 42000 }]);
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
