import { describe, it, expect, afterEach, vi } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';

// The categorizer is real everywhere except the one test that forces it to
// throw (m2): a failure there must not lose rows or block markSynced().
let engineThrows = false;
vi.mock('@/lib/categorize/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/categorize/engine')>();
  return {
    ...actual,
    runEngine: (ids: number[]) => {
      if (engineThrows) throw new Error('categorizer exploded');
      return actual.runEngine(ids);
    },
  };
});

import { amountToCents, postedToIsoDate, runSync, syncWindow } from '@/lib/simplefin/sync';
import {
  DAILY_REQUEST_LIMIT,
  getConnection,
  linkAccount,
  listLinks,
  markSynced,
  remainingRequestsToday,
  saveClaimedConnection,
} from '@/lib/simplefin/connection';
import type { Fetcher } from '@/lib/simplefin/client';
import { listImportHistory } from '@/lib/import/commit';
import { setAccountActive } from '@/lib/accounts';
import { dismissSetAsideRow } from '@/lib/import/set-aside';
import type { Viewer } from '@/lib/auth/viewer';

let current: TestDb | null = null;
afterEach(() => {
  engineThrows = false;
  current?.cleanup();
  current = null;
});

const ACCESS_URL = 'https://abc123:s3cr3t@bridge.example/simplefin';
const NOW = new Date('2026-08-15T12:00:00.000Z');

function bridge(body: unknown): Fetcher {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }));
}

function accountSet(transactions: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  return {
    accounts: [
      {
        id: 'remote-1',
        name: 'Bridge Chequing',
        currency: 'CAD',
        balance: '1234.56',
        'balance-date': 1755216000,
        transactions,
        ...over,
      },
    ],
    errlist: [],
  };
}

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const accountId = insertTestAccount(current.db, { name: 'Joint Chequing' });
  saveClaimedConnection(ACCESS_URL, NOW);
  linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD' });
  return { db: current.db, sqlite: current.sqlite, userId, accountId };
}

describe('pure helpers', () => {
  it('converts amounts to integer cents, negative = debit', () => {
    expect(amountToCents('-12.34')).toBe(-1234);
    expect(amountToCents('12.34')).toBe(1234);
    expect(amountToCents('0.05')).toBe(5);
    expect(amountToCents('-1234.5')).toBe(-123450);
    expect(amountToCents('1,234.56')).toBe(123456);
    expect(amountToCents('nope')).toBeNull();
    expect(amountToCents('')).toBeNull();
  });

  it('rounds correctly at 3+ decimal places instead of losing a cent to float error (SimpleFIN permits arbitrary precision)', () => {
    expect(amountToCents('8.165')).toBe(817);
    expect(amountToCents('-8.165')).toBe(-817);
  });

  it('converts unix posted to an ISO date in the configured zone', () => {
    // 2026-03-15T02:30:00Z is still 2026-03-14 in Toronto.
    expect(postedToIsoDate(1773541800, 'America/Toronto')).toBe(postedToIsoDate(1773541800, 'America/Toronto'));
    expect(postedToIsoDate(Math.floor(Date.parse('2026-03-15T02:30:00.000Z') / 1000), 'America/Toronto')).toBe('2026-03-14');
    expect(postedToIsoDate(Math.floor(Date.parse('2026-03-15T02:30:00.000Z') / 1000), 'UTC')).toBe('2026-03-15');
  });

  it('asks for 90 days on a first sync', () => {
    const window = syncWindow({ lastSyncAt: null, now: NOW });
    expect(window.endDate).toBe(Math.floor(NOW.getTime() / 1000));
    expect(window.endDate - window.startDate).toBe(90 * 86400);
  });

  it('uses a 5-day overlap on later syncs', () => {
    const lastSync = new Date('2026-08-14T12:00:00.000Z').toISOString();
    const window = syncWindow({ lastSyncAt: lastSync, now: NOW });
    expect(window.endDate - window.startDate).toBe(6 * 86400);
  });

  it('never exceeds 90 days even after a long gap', () => {
    const lastSync = new Date('2025-01-01T00:00:00.000Z').toISOString();
    const window = syncWindow({ lastSyncAt: lastSync, now: NOW });
    expect(window.endDate - window.startDate).toBe(90 * 86400);
  });
});

describe('runSync', () => {
  it('inserts settled rows, skips pending ones, and records an imports row', async () => {
    const { sqlite, userId } = setup();
    const fetcher = bridge(
      accountSet([
        { id: 'txn-1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'TIM HORTONS #4821', pending: false },
        { id: 'txn-2', posted: Math.floor(Date.parse('2026-08-11T15:00:00Z') / 1000), amount: '2145.67', description: 'PAYROLL DEPOSIT', pending: false },
        { id: 'txn-3', posted: Math.floor(Date.parse('2026-08-14T15:00:00Z') / 1000), amount: '-99.99', description: 'STILL SETTLING', pending: true },
      ]),
    );

    const result = await runSync({ userId, fetcher, now: NOW });

    expect(result.totalAdded).toBe(2);
    expect(result.accounts[0]).toMatchObject({ simplefinAccountId: 'remote-1', added: 2, duplicates: 0, skippedPending: 1 });
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(2);

    const rows = sqlite.prepare('select date, raw_description, amount_cents, external_id, dedup_hash from transactions order by date').all() as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ date: '2026-08-10', raw_description: 'TIM HORTONS #4821', amount_cents: -1234, external_id: 'txn-1', dedup_hash: null });
    expect(rows[1]).toMatchObject({ date: '2026-08-11', amount_cents: 214567, external_id: 'txn-2' });

    const history = listImportHistory();
    expect(history).toHaveLength(1);
    expect(history[0].filename).toMatch(/^simplefin /);
    expect(history[0].rowsAdded).toBe(2);
  });

  it('survives a categorizer failure: rows stay, markSynced still runs, engineFailed is reported (m2)', async () => {
    const { sqlite, userId } = setup();
    const fetcher = bridge(
      accountSet([
        { id: 'txn-1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'TIM HORTONS', pending: false },
        { id: 'txn-2', posted: Math.floor(Date.parse('2026-08-11T15:00:00Z') / 1000), amount: '-45.00', description: 'PETRO-CANADA', pending: false },
      ]),
    );
    engineThrows = true;

    const result = await runSync({ userId, fetcher, now: NOW });

    // Not a thrown sync, not a lost import.
    expect(result.engineFailed).toBe(true);
    expect(result.engine).toEqual({ processed: 0, categorized: 0, transfers: 0, skipped: 0, changed: 0 });
    expect(result.totalAdded).toBe(2);
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(2);
    // Uncategorized, which is exactly what the review queue picks up.
    expect((sqlite.prepare('select count(*) as c from transactions where category_id is null').get() as { c: number }).c).toBe(2);
    // markSynced still ran, so the next window narrows instead of re-fetching.
    expect(getConnection()?.lastSyncAt).toBe(NOW.toISOString());
    expect(listImportHistory()).toHaveLength(1);
  });

  it('reports engineFailed false on a normal sync', async () => {
    const { userId } = setup();
    const result = await runSync({ userId, fetcher: bridge(accountSet([])), now: NOW });
    expect(result.engineFailed).toBe(false);
  });

  it('runs the categorization engine on the inserted rows', async () => {
    const { sqlite, userId } = setup();
    const fetcher = bridge(
      accountSet([
        { id: 'txn-1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '500.00', description: 'PAYMENT - THANK YOU', pending: false },
      ]),
    );
    const result = await runSync({ userId, fetcher, now: NOW });
    expect(result.engine.transfers).toBe(1);
    const row = sqlite.prepare('select is_transfer, normalized_merchant from transactions').get() as { is_transfer: number; normalized_merchant: string };
    expect(row.is_transfer).toBe(1);
    expect(row.normalized_merchant).toBe('PAYMENT - THANK YOU');
  });

  it('is idempotent across an overlapping window — external_id catches the repeats', async () => {
    const { sqlite, userId } = setup();
    const payload = accountSet([
      { id: 'txn-1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'TIM HORTONS', pending: false },
      { id: 'txn-2', posted: Math.floor(Date.parse('2026-08-11T15:00:00Z') / 1000), amount: '-45.00', description: 'PETRO-CANADA', pending: false },
    ]);

    const first = await runSync({ userId, fetcher: bridge(payload), now: NOW });
    expect(first.totalAdded).toBe(2);

    const second = await runSync({ userId, fetcher: bridge(payload), now: new Date('2026-08-15T13:00:00.000Z') });
    expect(second.totalAdded).toBe(0);
    expect(second.totalDuplicates).toBe(2);
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(2);
    expect(listImportHistory()).toHaveLength(2);
  });

  it('records duplicate associations so undo stays safe across syncs', async () => {
    const { sqlite, userId } = setup();
    const payload = accountSet([
      { id: 'txn-1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'TIM HORTONS', pending: false },
    ]);
    await runSync({ userId, fetcher: bridge(payload), now: NOW });
    await runSync({ userId, fetcher: bridge(payload), now: new Date('2026-08-15T13:00:00.000Z') });

    const links = sqlite.prepare('select count(*) as c from transaction_imports').get() as { c: number };
    expect(links.c).toBe(2); // one transaction, associated with both syncs
  });

  it('counts each request against the daily budget and refuses past the limit', async () => {
    const { userId } = setup();
    const payload = accountSet([]);
    expect(remainingRequestsToday(NOW)).toBe(DAILY_REQUEST_LIMIT);

    await runSync({ userId, fetcher: bridge(payload), now: NOW });
    expect(remainingRequestsToday(NOW)).toBe(DAILY_REQUEST_LIMIT - 1);

    for (let i = 1; i < DAILY_REQUEST_LIMIT; i += 1) {
      await runSync({ userId, fetcher: bridge(payload), now: NOW });
    }
    expect(remainingRequestsToday(NOW)).toBe(0);

    const blocked = bridge(payload);
    await expect(runSync({ userId, fetcher: blocked, now: NOW })).rejects.toThrowError(/request budget/i);
    expect(blocked).not.toHaveBeenCalled();
  });

  it('resets the daily counter on a new day', async () => {
    const { userId } = setup();
    const payload = accountSet([]);
    for (let i = 0; i < DAILY_REQUEST_LIMIT; i += 1) {
      await runSync({ userId, fetcher: bridge(payload), now: NOW });
    }
    expect(remainingRequestsToday(NOW)).toBe(0);
    const tomorrow = new Date('2026-08-16T12:00:00.000Z');
    expect(remainingRequestsToday(tomorrow)).toBe(DAILY_REQUEST_LIMIT);
    await expect(runSync({ userId, fetcher: bridge(payload), now: tomorrow })).resolves.toBeTruthy();
  });

  it('surfaces errlist entries instead of swallowing them', async () => {
    const { userId } = setup();
    const fetcher = bridge({ accounts: [], errlist: ['Bank X needs re-authentication'] });
    const result = await runSync({ userId, fetcher, now: NOW });
    expect(result.errlist).toEqual(['Bank X needs re-authentication']);
    expect(result.totalAdded).toBe(0);
  });

  it('warns on a non-CAD account but still imports it', async () => {
    const { userId } = setup();
    const fetcher = bridge(
      accountSet(
        [{ id: 'txn-1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'AMAZON US', pending: false }],
        { currency: 'USD' },
      ),
    );
    const result = await runSync({ userId, fetcher, now: NOW });
    expect(result.accounts[0].currencyWarning).toMatch(/USD/);
    expect(result.accounts[0].added).toBe(1);
  });

  it('ignores remote accounts that are not linked', async () => {
    const { userId, sqlite } = setup();
    const fetcher = bridge({
      accounts: [
        { id: 'remote-999', name: 'Not linked', currency: 'CAD', balance: '0', transactions: [{ id: 'x', posted: 1755216000, amount: '-1.00', description: 'NOPE' }] },
      ],
      errlist: [],
    });
    const result = await runSync({ userId, fetcher, now: NOW });
    expect(result.accounts).toHaveLength(0);
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
  });

  /** v1.60.0 (fix round): a deactivated account stops syncing, rows and balance alike. */
  it('skips a linked account that has been deactivated', async () => {
    const { userId, sqlite, accountId } = setup();
    setAccountActive(accountId, false, '2026-08-01');
    const fetcher = bridge(
      accountSet([{ id: 'txn-1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'TIM HORTONS #4821' }]),
    );

    const result = await runSync({ userId, fetcher, now: NOW });
    expect(result.accounts).toHaveLength(0);
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
    expect((sqlite.prepare('select count(*) as c from account_balance_snapshots').get() as { c: number }).c).toBe(0);
    expect(listLinks()[0]!.lastBalanceCents).toBeNull();
  });

  it('records the reported balance on the link and writes a matching balance snapshot (spec 2026-08-22 v1.7.0 Task 6)', async () => {
    const { userId, sqlite } = setup();
    await runSync({ userId, fetcher: bridge(accountSet([])), now: NOW });
    const link = listLinks()[0];
    expect(link.lastBalanceCents).toBe(123456);
    expect(link.lastBalanceDate).not.toBeNull();

    const snapshot = sqlite
      .prepare('select account_id, date, balance_cents, source from account_balance_snapshots')
      .get() as { account_id: number; date: string; balance_cents: number; source: string };
    expect(snapshot).toEqual({ account_id: link.accountId, date: link.lastBalanceDate, balance_cents: 123456, source: 'simplefin' });
  });

  it('counts unparseable rows as errors rather than crashing the sync', async () => {
    const { userId } = setup();
    const fetcher = bridge(
      accountSet([
        { id: 'txn-good', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'GOOD ROW', pending: false },
        { id: 'txn-bad', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: 'not-a-number', description: 'BAD ROW', pending: false },
        { id: '', posted: 0, amount: '-1.00', description: 'NO ID', pending: false },
      ]),
    );
    const result = await runSync({ userId, fetcher, now: NOW });
    expect(result.accounts[0].added).toBe(1);
    expect(result.accounts[0].errors).toBe(2);
  });

  it('updates last_sync_at so the next window narrows', async () => {
    const { userId } = setup();
    expect(getConnection()?.lastSyncAt).toBeNull();
    await runSync({ userId, fetcher: bridge(accountSet([])), now: NOW });
    expect(getConnection()?.lastSyncAt).toBe(NOW.toISOString());
  });

  it('refuses to sync when nothing is configured', async () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    await expect(runSync({ userId, fetcher: bridge(accountSet([])), now: NOW })).rejects.toThrowError(/no SimpleFIN connection/i);
  });

  it('counts a malformed posted date as an error instead of crashing the whole sync (Intl.DateTimeFormat would otherwise throw on an Invalid Date)', async () => {
    const { userId, sqlite } = setup();
    const fetcher = bridge(
      accountSet([
        { id: 'txn-good', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'GOOD ROW', pending: false },
        { id: 'txn-bad-posted', posted: 'not-a-timestamp', amount: '-1.00', description: 'BAD POSTED', pending: false },
      ]),
    );
    const result = await runSync({ userId, fetcher, now: NOW });
    expect(result.accounts[0].added).toBe(1);
    expect(result.accounts[0].errors).toBe(1);
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(1);
  });

  it('does not crash when the account balance-date is malformed — the balance itself is still recorded', async () => {
    const { userId, sqlite } = setup();
    const fetcher = bridge(accountSet([], { 'balance-date': 'not-a-timestamp' }));
    await expect(runSync({ userId, fetcher, now: NOW })).resolves.toBeTruthy();
    const link = listLinks()[0];
    expect(link.lastBalanceCents).toBe(123456);
    expect(link.lastBalanceDate).toBeNull();
    // No date means recordBalanceSnapshot cannot run (spec 2026-08-22 v1.7.0 Task 6 requires
    // BOTH balanceCents and balanceDate) -- a snapshot dated null would be meaningless.
    expect((sqlite.prepare('select count(*) as c from account_balance_snapshots').get() as { c: number }).c).toBe(0);
  });

  it('a malformed balance-date still commits the sync\'s transactions and just skips the balance snapshot (spec 2026-08-22 v1.7.0 Task 6)', async () => {
    const { userId, sqlite } = setup();
    const fetcher = bridge(
      accountSet(
        [{ id: 'txn-1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'GOOD ROW', pending: false }],
        { 'balance-date': 'not-a-timestamp' },
      ),
    );

    const result = await runSync({ userId, fetcher, now: NOW });

    expect(result.totalAdded).toBe(1);
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(1);
    expect((sqlite.prepare('select count(*) as c from account_balance_snapshots').get() as { c: number }).c).toBe(0);
  });

  it('does not write a balance snapshot when the balance itself is unparseable, even with a valid balance-date', async () => {
    const { userId, sqlite } = setup();
    const fetcher = bridge(accountSet([], { balance: 'not-a-number' }));

    await runSync({ userId, fetcher, now: NOW });

    const link = listLinks()[0];
    expect(link.lastBalanceCents).toBeNull();
    expect((sqlite.prepare('select count(*) as c from account_balance_snapshots').get() as { c: number }).c).toBe(0);
  });

  it('a snapshot failure does not fail the sync -- transactions stay committed and markSynced still runs', async () => {
    const { userId, sqlite } = setup();
    const networth = await import('@/lib/networth');
    const spy = vi.spyOn(networth, 'recordBalanceSnapshot').mockImplementation(() => {
      throw new Error('disk exploded');
    });
    const fetcher = bridge(
      accountSet([{ id: 'txn-1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'GOOD ROW', pending: false }]),
    );

    await expect(runSync({ userId, fetcher, now: NOW })).resolves.toBeTruthy();

    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(1);
    expect(getConnection()?.lastSyncAt).toBe(NOW.toISOString());
    spy.mockRestore();
  });
});

/**
 * Review E2. The bridge reports a bank it could not reach in `errlist`, and the sync went on to
 * stamp last_sync_at anyway. The next window starts from that stamp, and the overlap is five days,
 * so a bank down for twelve days loses days one to seven for good -- with nothing on screen, no
 * alert, and no way to notice except a household spotting the gap in its own statements months
 * later.
 */
describe('E2: a partial bridge failure never advances the window', () => {
  const lastSyncOf = () => getConnection()!.lastSyncAt;

  it('leaves last_sync_at where it was when any bank failed', async () => {
    const { userId } = setup();
    const before = lastSyncOf();
    await runSync({ userId, fetcher: bridge({ accounts: [], errlist: ['Bank X needs re-authentication'] }), now: NOW });
    expect(lastSyncOf()).toBe(before);
  });

  it('still imports what the banks that DID answer sent', async () => {
    const { userId, sqlite } = setup();
    const payload = accountSet([
      { id: 'txn-1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'SHOP', pending: false },
    ]);
    const result = await runSync({
      userId,
      fetcher: bridge({ ...payload, errlist: ['Bank X needs re-authentication'] }),
      now: NOW,
    });
    expect(result.totalAdded).toBe(1);
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(1);
  });

  /**
   * The point of not advancing: the NEXT run reaches back over the outage. A window that started
   * from the failed run's own timestamp could only ever reach back its five-day overlap.
   */
  it('lets the next run reach back over the whole outage', async () => {
    const { userId } = setup();
    const outage = new Date('2026-08-15T12:00:00.000Z');
    await runSync({ userId, fetcher: bridge({ accounts: [], errlist: ['Bank X down'] }), now: outage });
    const twelveDaysLater = new Date('2026-08-27T12:00:00.000Z');
    const window = syncWindow({ lastSyncAt: lastSyncOf(), now: twelveDaysLater });
    // The outage began on the 15th; the window has to start on or before it. A stamp written by
    // the failed run would have started this window on the 22nd -- five days of overlap, seven
    // days short.
    expect(postedToIsoDate(window.startDate) <= '2026-08-15').toBe(true);
  });

  it('advances it again on a clean run', async () => {
    const { userId } = setup();
    const before = lastSyncOf();
    await runSync({ userId, fetcher: bridge(accountSet([])), now: new Date('2026-08-16T12:00:00.000Z') });
    expect(lastSyncOf()).not.toBe(before);
  });
});

/**
 * v1.61.0 items 3c and 3d. A link made with a start date reaches back to it on its first clean
 * sync, never takes a row dated before it, and the sync holds a bank row that may be a second copy
 * of a row from another road instead of counting it twice.
 */
const MARCH_NOW = new Date('2026-03-28T16:00:00.000Z');
const atSec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
/** 15:00 UTC is 11:00 in the household's zone, the same calendar date. */
const bankRow = (id: string, date: string, amount: string, description = 'FUEL STOP 12') => ({
  id,
  posted: atSec(`${date}T15:00:00Z`),
  amount,
  description,
  pending: false,
});

function bridgeSpy(body: unknown) {
  return vi.fn(async (_url: string) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }));
}

/** The start-date the sync asked the bridge for, as seconds. */
function requestedStart(fetcher: ReturnType<typeof bridgeSpy>, call = 0): number {
  const url = String(fetcher.mock.calls[call]![0]);
  return Number(/start-date=(\d+)/.exec(url)![1]);
}

function remoteSet(accounts: { id: string; rows: Record<string, unknown>[] }[], errlist: string[] = []) {
  return {
    accounts: accounts.map((account) => ({
      id: account.id,
      name: 'Bridge Visa',
      currency: 'CAD',
      balance: '-120.00',
      'balance-date': atSec('2026-03-27T12:00:00Z'),
      transactions: account.rows,
    })),
    errlist,
  };
}

/** Eleven bank rows, 2026-03-15 to 2026-03-25, each a different amount so none can match another. */
const elevenDays = Array.from({ length: 11 }, (_, i) => {
  const day = 15 + i;
  return bankRow(`t-${day}`, `2026-03-${day}`, `-${day}.25`);
});

function setupMarch(opts: { syncFrom: string | null; lastSync: Date | null }) {
  current = createSeededTestDb();
  const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex', role: 'admin' });
  const accountId = insertTestAccount(current.db, { name: 'Sam Visa', type: 'credit' });
  saveClaimedConnection(ACCESS_URL, new Date('2026-03-01T12:00:00.000Z'));
  if (opts.lastSync) markSynced(opts.lastSync);
  linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD', syncFrom: opts.syncFrom });
  const t = current;
  const count = (table: string) => (t.sqlite.prepare(`select count(*) as c from ${table}`).get() as { c: number }).c;
  const dates = () => (t.sqlite.prepare('select date from transactions order by date').all() as { date: string }[]).map((r) => r.date);
  /** A row already in the account that arrived by `origin`. */
  const existing = (date: string, amountCents: number, origin: string, externalId: string | null = null) =>
    (
      t.sqlite
        .prepare(
          `insert into transactions (account_id, attributed_user_id, date, raw_description, normalized_merchant, amount_cents,
             external_id, origin, created_by, created_at, updated_at)
           values (?, ?, ?, 'MAPLE GROCER', 'MAPLE GROCER', ?, ?, ?, ?, '2026-03-09T12:00:00.000Z', '2026-03-09T12:00:00.000Z') returning id`,
        )
        .get(accountId, alex, date, amountCents, externalId, origin, alex) as { id: number }
    ).id;
  return { t, alex, accountId, count, dates, existing };
}

describe('the first sync reaches the start date, and never before it (v1.61.0 item 3c)', () => {
  it('a pending start date widens the window to midnight UTC the day before it', () => {
    const window = syncWindow({ lastSyncAt: '2026-03-27T16:00:00.000Z', now: MARCH_NOW, pendingFrom: ['2026-03-20'] });
    expect(window.startDate).toBe(atSec('2026-03-19T00:00:00Z'));
    expect(window.endDate).toBe(atSec('2026-03-28T16:00:00Z'));
  });

  it('the earliest pending start wins, and one later than the usual start does not narrow it', () => {
    expect(syncWindow({ lastSyncAt: '2026-03-27T16:00:00.000Z', now: MARCH_NOW, pendingFrom: ['2026-03-24', '2026-03-20'] }).startDate).toBe(
      atSec('2026-03-19T00:00:00Z'),
    );
    expect(syncWindow({ lastSyncAt: '2026-03-27T16:00:00.000Z', now: MARCH_NOW, pendingFrom: ['2026-03-27'] }).startDate).toBe(
      atSec('2026-03-22T16:00:00Z'),
    );
  });

  it('a pending start is clamped at the 90-day floor', () => {
    const window = syncWindow({ lastSyncAt: '2026-03-27T16:00:00.000Z', now: MARCH_NOW, pendingFrom: ['2025-11-01'] });
    expect(window.endDate - window.startDate).toBe(90 * 86400);
  });

  it('inserts rows from the start date on, and counts the rows before it as beforeStart', async () => {
    const s = setupMarch({ syncFrom: '2026-03-20', lastSync: new Date('2026-03-27T16:00:00.000Z') });
    const fetcher = bridgeSpy(remoteSet([{ id: 'remote-1', rows: elevenDays }]));

    const result = await runSync({ userId: s.alex, fetcher, now: MARCH_NOW });

    // A link added to a connection that already synced reaches back to its start date, not just
    // last sync minus five days.
    expect(requestedStart(fetcher)).toBe(atSec('2026-03-19T00:00:00Z'));
    expect(result.accounts[0]).toMatchObject({ added: 6, beforeStart: 5, held: 0, setAside: 0 });
    expect(s.dates()).toEqual(['2026-03-20', '2026-03-21', '2026-03-22', '2026-03-23', '2026-03-24', '2026-03-25']);
    expect(listLinks()[0]!.firstSyncedAt).toBe(MARCH_NOW.toISOString());
  });

  it('after a clean run, the next window is last sync minus five days again', async () => {
    const s = setupMarch({ syncFrom: '2026-03-20', lastSync: new Date('2026-03-27T16:00:00.000Z') });
    await runSync({ userId: s.alex, fetcher: bridgeSpy(remoteSet([{ id: 'remote-1', rows: elevenDays }])), now: MARCH_NOW });

    const next = bridgeSpy(remoteSet([{ id: 'remote-1', rows: [] }]));
    await runSync({ userId: s.alex, fetcher: next, now: new Date('2026-03-29T16:00:00.000Z') });
    expect(requestedStart(next)).toBe(atSec('2026-03-23T16:00:00Z'));
  });

  it('a partial run keeps the link pending, so the next run reaches back to the start date again', async () => {
    const s = setupMarch({ syncFrom: '2026-03-20', lastSync: new Date('2026-03-27T16:00:00.000Z') });
    await runSync({
      userId: s.alex,
      fetcher: bridgeSpy(remoteSet([{ id: 'remote-1', rows: elevenDays }], ['Bank X needs re-authentication'])),
      now: MARCH_NOW,
    });
    expect(listLinks()[0]!.firstSyncedAt).toBeNull();

    const next = bridgeSpy(remoteSet([{ id: 'remote-1', rows: elevenDays }]));
    const result = await runSync({ userId: s.alex, fetcher: next, now: new Date('2026-03-29T16:00:00.000Z') });
    expect(requestedStart(next)).toBe(atSec('2026-03-19T00:00:00Z'));
    expect(result.accounts[0]).toMatchObject({ added: 0, duplicates: 6, beforeStart: 5 });
    expect(listLinks()[0]!.firstSyncedAt).toBe('2026-03-29T16:00:00.000Z');
  });

  it('a link with no start date (made before v1.61.0) syncs exactly as v1.60.1 did', async () => {
    const s = setupMarch({ syncFrom: null, lastSync: new Date('2026-03-27T16:00:00.000Z') });
    const fetcher = bridgeSpy(remoteSet([{ id: 'remote-1', rows: elevenDays }]));

    const result = await runSync({ userId: s.alex, fetcher, now: MARCH_NOW });

    expect(requestedStart(fetcher)).toBe(atSec('2026-03-22T16:00:00Z'));
    expect(result.accounts[0]).toMatchObject({ added: 11, beforeStart: 0 });
    expect(listLinks()[0]!.firstSyncedAt).toBeNull();
  });

  it('a later, wider window still leaves out rows from before the start date', async () => {
    const s = setupMarch({ syncFrom: '2026-03-20', lastSync: new Date('2026-03-27T16:00:00.000Z') });
    await runSync({ userId: s.alex, fetcher: bridgeSpy(remoteSet([{ id: 'remote-1', rows: elevenDays }])), now: MARCH_NOW });

    // A second account linked later, from 2026-03-10, widens the next window for every account.
    const chequing = insertTestAccount(s.t.db, { name: 'Joint Chequing' });
    linkAccount({ simplefinAccountId: 'remote-2', accountId: chequing, currency: 'CAD', syncFrom: '2026-03-10' });
    const fetcher = bridgeSpy(
      remoteSet([
        // The bank sends the first account's statement-era rows again, under new ids.
        { id: 'remote-1', rows: [bankRow('late-12', '2026-03-12', '-12.10'), bankRow('late-19', '2026-03-19', '-19.10')] },
        { id: 'remote-2', rows: [bankRow('c-09', '2026-03-09', '-9.40'), bankRow('c-11', '2026-03-11', '-11.40')] },
      ]),
    );

    const result = await runSync({ userId: s.alex, fetcher, now: new Date('2026-03-29T16:00:00.000Z') });

    expect(requestedStart(fetcher)).toBe(atSec('2026-03-09T00:00:00Z'));
    const byRemote = new Map(result.accounts.map((account) => [account.simplefinAccountId, account]));
    expect(byRemote.get('remote-1')).toMatchObject({ added: 0, beforeStart: 2 });
    expect(byRemote.get('remote-2')).toMatchObject({ added: 1, beforeStart: 1 });
    expect(s.count('transactions')).toBe(7);
  });
});

describe('possible duplicates found by the sync wait in Needs review (v1.61.0 item 3d)', () => {
  const groceries = [bankRow('bank-1', '2026-03-10', '-42.17', 'MAPLE GROCER #12')];
  const admin: Viewer = { id: 0, role: 'admin', visibility: 'household' };

  it('holds the bank copy of a hand-typed purchase: no new transaction, one waiting row', async () => {
    const s = setupMarch({ syncFrom: '2026-03-01', lastSync: null });
    const handTyped = s.existing('2026-03-09', -4217, 'manual');

    const result = await runSync({ userId: s.alex, fetcher: bridgeSpy(remoteSet([{ id: 'remote-1', rows: groceries }])), now: MARCH_NOW });

    expect(result.accounts[0]).toMatchObject({ added: 0, duplicates: 0, held: 1, setAside: 0 });
    expect(result.totalHeld).toBe(1);
    expect(s.count('transactions')).toBe(1);
    expect(s.t.sqlite.prepare('select state, reason, origin, external_id, candidate_txn_id from set_aside_rows').all()).toEqual([
      { state: 'waiting', reason: 'possible_duplicate', origin: 'simplefin', external_id: 'bank-1', candidate_txn_id: handTyped },
    ]);
  });

  it('an overlapping second sync neither holds it again nor inserts it', async () => {
    const s = setupMarch({ syncFrom: '2026-03-01', lastSync: null });
    s.existing('2026-03-09', -4217, 'manual');
    await runSync({ userId: s.alex, fetcher: bridgeSpy(remoteSet([{ id: 'remote-1', rows: groceries }])), now: MARCH_NOW });

    const second = await runSync({
      userId: s.alex,
      fetcher: bridgeSpy(remoteSet([{ id: 'remote-1', rows: groceries }])),
      now: new Date('2026-03-29T16:00:00.000Z'),
    });

    expect(second.accounts[0]).toMatchObject({ added: 0, duplicates: 0, held: 0, setAside: 1 });
    expect(second.totalHeld).toBe(0);
    expect(s.count('transactions')).toBe(1);
    expect(s.count('set_aside_rows')).toBe(1);
  });

  it('after Delete this one, a third sync leaves it out', async () => {
    const s = setupMarch({ syncFrom: '2026-03-01', lastSync: null });
    s.existing('2026-03-09', -4217, 'manual');
    const first = await runSync({ userId: s.alex, fetcher: bridgeSpy(remoteSet([{ id: 'remote-1', rows: groceries }])), now: MARCH_NOW });
    const heldId = (s.t.sqlite.prepare('select id from set_aside_rows').get() as { id: number }).id;
    expect(first.totalHeld).toBe(1);
    expect(
      dismissSetAsideRow({ id: heldId, userId: s.alex, viewer: { ...admin, id: s.alex }, at: new Date('2026-03-28T18:00:00.000Z') }),
    ).toEqual({ ok: true });

    const third = await runSync({
      userId: s.alex,
      fetcher: bridgeSpy(remoteSet([{ id: 'remote-1', rows: groceries }])),
      now: new Date('2026-03-29T16:00:00.000Z'),
    });

    expect(third.accounts[0]).toMatchObject({ added: 0, held: 0, setAside: 1 });
    expect(s.count('transactions')).toBe(1);
    expect(s.t.sqlite.prepare('select state from set_aside_rows').all()).toEqual([{ state: 'dismissed' }]);
  });

  it('two identical same-day bank rows with different ids both insert, as before', async () => {
    const s = setupMarch({ syncFrom: '2026-03-01', lastSync: null });
    const twins = [bankRow('bank-1', '2026-03-10', '-42.17', 'MAPLE GROCER #12'), bankRow('bank-2', '2026-03-10', '-42.17', 'MAPLE GROCER #12')];

    const result = await runSync({ userId: s.alex, fetcher: bridgeSpy(remoteSet([{ id: 'remote-1', rows: twins }])), now: MARCH_NOW });

    expect(result.accounts[0]).toMatchObject({ added: 2, held: 0 });
    expect(s.count('transactions')).toBe(2);
  });

  it('stores origin simplefin, so the bank is never compared with its own earlier rows', async () => {
    const s = setupMarch({ syncFrom: '2026-03-01', lastSync: null });
    // A row an earlier sync brought in (an id the bank no longer sends), one day before a new one.
    s.existing('2026-03-09', -4217, 'simplefin', 'bank-old');

    const result = await runSync({ userId: s.alex, fetcher: bridgeSpy(remoteSet([{ id: 'remote-1', rows: groceries }])), now: MARCH_NOW });

    expect(result.accounts[0]).toMatchObject({ added: 1, held: 0 });
    expect(s.t.sqlite.prepare("select origin from transactions where external_id = 'bank-1'").get()).toEqual({ origin: 'simplefin' });
  });
});
