import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';

let currentUser = { id: 1, name: 'Admin', username: 'admin', role: 'admin' as const };
let requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });

vi.mock('@/lib/auth/session', () => ({
  requireAdmin: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => requestHeaders,
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import {
  createAccountAction,
  setAccountActiveAction,
  updateAccountAction,
} from '@/app/(app)/settings/accounts/actions';
import { getAccount, listAccounts } from '@/lib/accounts';
import { requireAdmin } from '@/lib/auth/session';
import { revalidatePath } from 'next/cache';
import { getProfileByName, setProfileActive } from '@/lib/import/presets';
import { linkAccount } from '@/lib/simplefin/connection';
import { PROFILE_RENDERING_ROUTES } from '@/app/(app)/settings/managers/revalidation-routes';

let current: TestDb | null = null;

beforeEach(() => {
  requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
});

afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const adminId = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
  const bobId = insertTestUser(current.db, { name: 'Bob', username: 'bob', role: 'member' });
  currentUser = { id: adminId, name: 'Admin', username: 'admin', role: 'admin' };
  return { db: current.db, adminId, bobId };
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe('createAccountAction', () => {
  it('creates a joint account that immediately shows up in listAccounts', async () => {
    setup();
    const result = await createAccountAction({}, formData({ name: 'Joint Chequing', institution: 'TD Canada Trust', type: 'chequing', owner: '' }));

    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/Joint Chequing/);
    const accounts = listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ name: 'Joint Chequing', institution: 'TD Canada Trust', type: 'chequing', ownerUserId: null, isActive: true });
  });

  it('accepts a blank institution — a cash jar has no bank', async () => {
    setup();
    const result = await createAccountAction({}, formData({ name: 'Grocery Cash', institution: '', type: 'cash', owner: '' }));

    expect(result.error).toBeUndefined();
    expect(listAccounts()[0]).toMatchObject({ name: 'Grocery Cash', institution: '', type: 'cash' });
  });

  it('assigns a personal owner when one is picked', async () => {
    const { bobId } = setup();
    await createAccountAction({}, formData({ name: 'Bob Visa', institution: 'Amex', type: 'credit', owner: String(bobId) }));
    expect(listAccounts()[0]).toMatchObject({ name: 'Bob Visa', ownerUserId: bobId });
  });

  it('refuses a nameless account', async () => {
    setup();
    const result = await createAccountAction({}, formData({ name: '   ', institution: 'TD', type: 'chequing', owner: '' }));
    expect(result.error).toMatch(/name/i);
    expect(listAccounts()).toHaveLength(0);
  });

  it('refuses an unsupported type instead of writing an unusable row', async () => {
    setup();
    const result = await createAccountAction({}, formData({ name: 'Savings', institution: 'TD', type: 'savings', owner: '' }));
    expect(result.error).toBeTruthy();
    expect(listAccounts()).toHaveLength(0);
  });

  it('refuses an owner who does not exist rather than throwing a foreign-key error', async () => {
    setup();
    const result = await createAccountAction({}, formData({ name: 'Ghost Account', institution: 'TD', type: 'chequing', owner: '9999' }));
    expect(result.error).toMatch(/no longer exists/i);
    expect(listAccounts()).toHaveLength(0);
  });

  it('rejects a cross-origin request before touching the database', async () => {
    setup();
    requestHeaders = new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' });
    const result = await createAccountAction({}, formData({ name: 'Attacker Account', institution: 'X', type: 'chequing', owner: '' }));
    expect(result.error).toBe('Cross-origin request rejected');
    expect(listAccounts()).toHaveLength(0);
  });
});

describe('setAccountActiveAction (archive only — there is no delete)', () => {
  it('deactivates and reactivates, keeping the row either way', async () => {
    setup();
    await createAccountAction({}, formData({ name: 'Old Visa', institution: 'TD', type: 'credit', owner: '' }));
    const id = listAccounts()[0].id;

    const off = await setAccountActiveAction({}, formData({ accountId: String(id), active: '0' }));
    expect(off.message).toMatch(/deactivated/i);
    expect(listAccounts()).toHaveLength(0);
    expect(listAccounts({ includeInactive: true })).toHaveLength(1);
    expect(getAccount(id)).toMatchObject({ id, isActive: false });

    await setAccountActiveAction({}, formData({ accountId: String(id), active: '1' }));
    expect(listAccounts()).toHaveLength(1);
  });

  it('refuses a malformed request and an unknown account', async () => {
    setup();
    expect((await setAccountActiveAction({}, formData({ accountId: '1', active: 'yes' }))).error).toBe('Invalid request.');
    expect((await setAccountActiveAction({}, formData({ accountId: '4242', active: '0' }))).error).toMatch(/no longer exists/i);
  });

  it('rejects a cross-origin request', async () => {
    setup();
    await createAccountAction({}, formData({ name: 'Old Visa', institution: 'TD', type: 'credit', owner: '' }));
    const id = listAccounts()[0].id;
    requestHeaders = new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' });

    expect((await setAccountActiveAction({}, formData({ accountId: String(id), active: '0' }))).error).toBe('Cross-origin request rejected');
    expect(getAccount(id)!.isActive).toBe(true);
  });
});

describe('updateAccountAction (spec 2026-08-22 v1.7.0 Task 1b: one form replaces three row buttons)', () => {
  it('updates name, owner and mapping together in one submit', async () => {
    const { db, bobId } = setup();
    const builtin = getProfileByName('TD Chequing/Debit')!;
    const id = insertTestAccount(db, { name: 'Joint Chequing' });

    const result = await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Bob Chequing', owner: String(bobId), profile: String(builtin.id) }),
    );

    expect(result.error).toBeUndefined();
    expect(getAccount(id)).toMatchObject({ name: 'Bob Chequing', ownerUserId: bobId, importProfileId: builtin.id });
  });

  it('changing only the name leaves owner and mapping untouched', async () => {
    const { db, bobId } = setup();
    const builtin = getProfileByName('TD Visa')!;
    const id = insertTestAccount(db, { name: 'Bob Visa', ownerUserId: bobId, importProfileId: builtin.id });

    const result = await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Bob Visa Gold', owner: String(bobId), profile: String(builtin.id) }),
    );

    expect(result.error).toBeUndefined();
    expect(getAccount(id)).toMatchObject({ name: 'Bob Visa Gold', ownerUserId: bobId, importProfileId: builtin.id });
  });

  it('does not clear a dormant pin -- a mapping no longer offered -- when the save does not intend to touch it', async () => {
    const { db } = setup();
    const builtin = getProfileByName('Scotiabank Chequing/Debit')!;
    const id = insertTestAccount(db, { name: 'Joint Chequing', importProfileId: builtin.id });
    setProfileActive(builtin.id, false); // the pin is now dormant: deactivated, no longer offered

    const result = await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Joint Chequing Renamed', owner: '', profile: String(builtin.id) }),
    );

    expect(result.error).toBeUndefined();
    expect(getAccount(id)).toMatchObject({ name: 'Joint Chequing Renamed', importProfileId: builtin.id });
  });

  it('rejects a cross-origin request before touching the database', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing' });
    requestHeaders = new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' });

    const result = await updateAccountAction({}, formData({ accountId: String(id), name: 'Attacker Rename', owner: '', profile: '' }));

    expect(result.error).toBe('Cross-origin request rejected');
    expect(getAccount(id)).toMatchObject({ name: 'Joint Chequing' });
  });

  it('refuses a non-admin caller', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing' });
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error('not admin'));

    await expect(
      updateAccountAction({}, formData({ accountId: String(id), name: 'Attacker Rename', owner: '', profile: '' })),
    ).rejects.toThrow(/not admin/);
    expect(getAccount(id)).toMatchObject({ name: 'Joint Chequing' });
  });

  it('returns the existing message for an unknown account', async () => {
    setup();
    const result = await updateAccountAction({}, formData({ accountId: '4242', name: 'Nope', owner: '', profile: '' }));
    expect(result.error).toMatch(/no longer exists/i);
  });

  it('refuses a blank name', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing' });
    const result = await updateAccountAction({}, formData({ accountId: String(id), name: '   ', owner: '', profile: '' }));
    expect(result.error).toBeTruthy();
    expect(getAccount(id)).toMatchObject({ name: 'Joint Chequing' });
  });

  it('refuses a malformed owner value with the existing message', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing' });
    const result = await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Joint Chequing', owner: 'not-a-number', profile: '' }),
    );
    expect(result.error).toBe('Pick an owner, or Joint.');
  });

  it('refuses an owner who does not exist', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing' });
    const result = await updateAccountAction({}, formData({ accountId: String(id), name: 'Joint Chequing', owner: '9999', profile: '' }));
    expect(result.error).toMatch(/no longer exists/i);
    expect(getAccount(id)!.ownerUserId).toBeNull();
  });

  it('refuses a malformed mapping value with the existing message', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing' });
    const result = await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Joint Chequing', owner: '', profile: 'not-a-number' }),
    );
    expect(result.error).toBe('Pick a mapping, or None.');
  });

  it('refuses a mapping that is not offered -- unknown or deactivated', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing' });

    const unknown = await updateAccountAction({}, formData({ accountId: String(id), name: 'Joint Chequing', owner: '', profile: '999999' }));
    expect(unknown.error).toMatch(/not available/i);

    const builtin = getProfileByName('Scotiabank Chequing/Debit')!;
    setProfileActive(builtin.id, false);
    const deactivated = await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Joint Chequing', owner: '', profile: String(builtin.id) }),
    );
    expect(deactivated.error).toMatch(/not available/i);
    expect(getAccount(id)!.importProfileId).toBeNull();
  });

  it('never applies a mapping change to a SimpleFIN-managed account, even if one is submitted', async () => {
    const { db } = setup();
    const builtin = getProfileByName('TD Visa')!;
    const id = insertTestAccount(db, { name: 'Bridge Chequing' });
    linkAccount({ simplefinAccountId: 'remote-1', accountId: id, currency: 'CAD' });

    const result = await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Bridge Chequing Renamed', owner: '', profile: String(builtin.id) }),
    );

    expect(result.error).toBeUndefined();
    expect(getAccount(id)).toMatchObject({ name: 'Bridge Chequing Renamed', importProfileId: null });
  });

  it('revalidates every route that renders a profile list, including /settings/accounts itself', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing' });
    vi.mocked(revalidatePath).mockClear();

    await updateAccountAction({}, formData({ accountId: String(id), name: 'Joint Chequing', owner: '', profile: '' }));

    const calls = vi.mocked(revalidatePath).mock.calls.map((call) => call[0]);
    for (const route of PROFILE_RENDERING_ROUTES) expect(calls).toContain(route);
  });
});

describe('updateAccountAction — manual balance entry (spec 2026-08-22 v1.7.0 Task 6)', () => {
  function snapshotRows() {
    return current!.sqlite
      .prepare('select account_id, date, balance_cents, source from account_balance_snapshots')
      .all() as { account_id: number; date: string; balance_cents: number; source: string }[];
  }

  it('supplying a balance records a snapshot', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing' });

    const result = await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Joint Chequing', owner: '', profile: '', balance: '1234.56', asOfDate: '2026-08-20' }),
    );

    expect(result.error).toBeUndefined();
    expect(snapshotRows()).toEqual([{ account_id: id, date: '2026-08-20', balance_cents: 123456, source: 'manual' }]);
  });

  it('ruling R9 (v1.8.0): a credit account\'s balance input is the amount OWED and is negated on write', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Visa', type: 'credit' });

    const result = await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Visa', owner: '', profile: '', balance: '500.00', asOfDate: '2026-08-20' }),
    );

    expect(result.error).toBeUndefined();
    expect(snapshotRows()).toEqual([{ account_id: id, date: '2026-08-20', balance_cents: -50000, source: 'manual' }]);
  });

  it('a second save for the same as-of date replaces that day\'s balance rather than adding a row', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing' });

    await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Joint Chequing', owner: '', profile: '', balance: '100.00', asOfDate: '2026-08-20' }),
    );
    await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Joint Chequing', owner: '', profile: '', balance: '200.00', asOfDate: '2026-08-20' }),
    );

    expect(snapshotRows()).toEqual([{ account_id: id, date: '2026-08-20', balance_cents: 20000, source: 'manual' }]);
  });

  it('leaving the balance blank records nothing and still saves the other fields', async () => {
    const { db, bobId } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing' });

    const result = await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Renamed Chequing', owner: String(bobId), profile: '', balance: '', asOfDate: '2026-08-20' }),
    );

    expect(result.error).toBeUndefined();
    expect(getAccount(id)).toMatchObject({ name: 'Renamed Chequing', ownerUserId: bobId });
    expect(snapshotRows()).toEqual([]);
  });

  it('an unparseable balance returns an error and writes nothing -- not even the name change', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing' });

    const result = await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Attempted Rename', owner: '', profile: '', balance: 'not-a-number', asOfDate: '2026-08-20' }),
    );

    expect(result.error).toBeTruthy();
    expect(getAccount(id)).toMatchObject({ name: 'Joint Chequing' });
    expect(snapshotRows()).toEqual([]);
  });

  it('an invalid as-of date returns an error and writes nothing, even with a valid balance', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing' });

    const result = await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Attempted Rename', owner: '', profile: '', balance: '100.00', asOfDate: 'not-a-date' }),
    );

    expect(result.error).toBeTruthy();
    expect(getAccount(id)).toMatchObject({ name: 'Joint Chequing' });
    expect(snapshotRows()).toEqual([]);
  });

  it('v1.12.1 (MON-4 follow-up): a hand-typed balance is not silently dropped -- the message says so when a bank statement already covers that day', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing' });
    // A csv snapshot outranks manual (SNAPSHOT_SOURCE_RANK) -- write one first for the same
    // day, then attempt the exact write the accounts form makes.
    current!.sqlite
      .prepare(
        `insert into account_balance_snapshots (account_id, date, balance_cents, source, created_at)
         values (?, '2026-08-20', 500000, 'csv', '2026-08-20T00:00:00.000Z')`,
      )
      .run(id);

    const result = await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Joint Chequing', owner: '', profile: '', balance: '100.00', asOfDate: '2026-08-20' }),
    );

    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/kept the figure from the bank statement/i);
    // The bank figure survives untouched -- the whole point of the message being honest.
    expect(snapshotRows()).toEqual([{ account_id: id, date: '2026-08-20', balance_cents: 500000, source: 'csv' }]);
  });

  it('rejects a non-admin caller even when a balance is supplied', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing' });
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error('not admin'));

    await expect(
      updateAccountAction(
        {},
        formData({ accountId: String(id), name: 'Joint Chequing', owner: '', profile: '', balance: '100.00', asOfDate: '2026-08-20' }),
      ),
    ).rejects.toThrow(/not admin/);
    expect(snapshotRows()).toEqual([]);
  });
});

describe('updateAccountAction — ruling R9: credit balances are entered as money owed (spec 2026-08-23 v1.8.0 Task 4)', () => {
  function snapshotRows() {
    return current!.sqlite
      .prepare('select account_id, date, balance_cents, source from account_balance_snapshots')
      .all() as { account_id: number; date: string; balance_cents: number; source: string }[];
  }

  it('negates a credit input so a card owing $500 stores -50000, never +50000', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Visa', type: 'credit' });

    await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Visa', owner: '', profile: '', balance: '500.00', asOfDate: '2026-08-20' }),
    );

    expect(snapshotRows()).toEqual([{ account_id: id, date: '2026-08-20', balance_cents: -50000, source: 'manual' }]);
  });

  it('keeps the typed sign for a chequing account -- a $1500.00 input stores +150000, not negated', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing', type: 'chequing' });

    await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Joint Chequing', owner: '', profile: '', balance: '1500.00', asOfDate: '2026-08-20' }),
    );

    expect(snapshotRows()).toEqual([{ account_id: id, date: '2026-08-20', balance_cents: 150000, source: 'manual' }]);
  });

  it('still allows a negative chequing balance for an overdrawn account, untouched', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Joint Chequing', type: 'chequing' });

    await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Joint Chequing', owner: '', profile: '', balance: '-200.00', asOfDate: '2026-08-20' }),
    );

    expect(snapshotRows()).toEqual([{ account_id: id, date: '2026-08-20', balance_cents: -20000, source: 'manual' }]);
  });

  it('keeps the typed sign for a cash account too -- R9 only singles out credit', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Grocery Cash', type: 'cash' });

    await updateAccountAction(
      {},
      formData({ accountId: String(id), name: 'Grocery Cash', owner: '', profile: '', balance: '75.00', asOfDate: '2026-08-20' }),
    );

    expect(snapshotRows()).toEqual([{ account_id: id, date: '2026-08-20', balance_cents: 7500, source: 'manual' }]);
  });
});
