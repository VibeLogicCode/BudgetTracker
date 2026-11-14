import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { formatCents } from '@/lib/money';
import { getSplits } from '@/lib/splits';
import type { SessionUser } from '@/lib/auth/session';

let currentUser: SessionUser = { id: 1, name: 'Admin', username: 'admin', role: 'admin', visibility: 'household' };
const sameOrigin = vi.hoisted(() => ({ value: true }));

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () =>
    sameOrigin.value
      ? new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' })
      : new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { revalidatePath } from 'next/cache';
import { CROSS_ORIGIN_ERROR } from '@/lib/auth/csrf';
import { saveSplitsAction } from '@/app/(app)/transactions/actions';

let current: TestDb | null = null;

afterEach(() => {
  sameOrigin.value = true;
  current?.cleanup();
  current = null;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function setup() {
  current = createSeededTestDb();
  const adminId = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
  currentUser = { id: adminId, name: 'Admin', username: 'admin', role: 'admin', visibility: 'household' };
  return { db: current.db, sqlite: current.sqlite, adminId };
}

function addAccount(ownerUserId: number | null = null): number {
  return insertTestAccount(current!.db, { name: 'Joint Chequing', ownerUserId });
}

function addTxn(accountId: number, amountCents = -5000, isTransfer = false): number {
  const description = 'COSTCO';
  const row = current!.db.get<{ id: number }>(sql`
    insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
    values (${accountId}, '2026-03-02', ${description}, ${normalizeMerchant(description)}, ${amountCents}, ${isTransfer ? 1 : 0}, ${currentUser.id}, ${nowIso()}, ${nowIso()})
    returning id`);
  return row.id;
}

describe('saveSplitsAction', () => {
  it('happy path: writes the parts and stamps the parent categorization_source manual', async () => {
    const { db, sqlite } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const accountId = addAccount(null);
    const id = addTxn(accountId, -5000);

    const result = await saveSplitsAction(
      {},
      formData({
        txnId: String(id),
        parts: JSON.stringify([
          { categoryId: groceries, amountCents: -3000 },
          { categoryId: coffee, amountCents: -2000, note: 'shared with Bob' },
        ]),
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.message).toBeTruthy();

    const rows = getSplits(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([-3000, -2000].sort((a, b) => a - b));
    expect(rows.find((r) => r.categoryId === coffee)?.note).toBe('shared with Bob');

    const parent = sqlite.prepare('select categorization_source as source from transactions where id = ?').get(id) as {
      source: string;
    };
    expect(parent.source).toBe('manual');
  });

  /** Spec 2026-10-21 (fix from Budgets) §2.5: a card-row fix changes the figures Budgets, Dashboard and Reports show. */
  it('revalidates every page whose figures a split changes', async () => {
    const { db } = setup();
    const id = addTxn(addAccount(null), -5000);
    vi.mocked(revalidatePath).mockClear();
    const result = await saveSplitsAction(
      {},
      formData({
        txnId: String(id),
        parts: JSON.stringify([
          { categoryId: categoryIdByName(db, 'Groceries'), amountCents: -3000 },
          { categoryId: categoryIdByName(db, 'Coffee'), amountCents: -2000 },
        ]),
      }),
    );
    expect(result.error).toBeUndefined();
    expect(vi.mocked(revalidatePath).mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining(['/budgets', '/transactions', '/dashboard', '/reports', '/review']),
    );
  });

  it('an empty parts array clears an existing split', async () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const accountId = addAccount(null);
    const id = addTxn(accountId, -5000);

    await saveSplitsAction(
      {},
      formData({
        txnId: String(id),
        parts: JSON.stringify([
          { categoryId: groceries, amountCents: -3000 },
          { categoryId: coffee, amountCents: -2000 },
        ]),
      }),
    );
    expect(getSplits(id)).toHaveLength(2);

    const result = await saveSplitsAction({}, formData({ txnId: String(id), parts: '[]' }));
    expect(result.error).toBeUndefined();
    expect(result.message).toBeTruthy();
    expect(getSplits(id)).toHaveLength(0);
  });

  it('rejects malformed JSON without touching an existing split', async () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const accountId = addAccount(null);
    const id = addTxn(accountId, -5000);

    await saveSplitsAction(
      {},
      formData({
        txnId: String(id),
        parts: JSON.stringify([
          { categoryId: groceries, amountCents: -3000 },
          { categoryId: coffee, amountCents: -2000 },
        ]),
      }),
    );

    const result = await saveSplitsAction({}, formData({ txnId: String(id), parts: '{not valid json' }));
    expect(result.error).toBeTruthy();
    expect(getSplits(id)).toHaveLength(2);
  });

  // Deliberately permissive, and it must stay that way while its neighbours are: every other
  // action in transactions/actions.ts lets any signed-in member recategorize, rename or
  // reattribute a transaction on someone else's account, so refusing only splits would be
  // household friction with nothing behind it. If per-account scoping ever arrives it has to
  // cover all of those together.
  it('a member who does not own the account may still split its transactions', async () => {
    const { db } = setup();
    const owner = insertTestUser(db, { name: 'Owner', username: 'owner', role: 'member' });
    const other = insertTestUser(db, { name: 'Other', username: 'other', role: 'member' });
    const accountId = addAccount(owner);
    const id = addTxn(accountId, -5000);
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');

    currentUser = { id: other, name: 'Other', username: 'other', role: 'member', visibility: 'household' };
    const result = await saveSplitsAction(
      {},
      formData({
        txnId: String(id),
        parts: JSON.stringify([
          { categoryId: groceries, amountCents: -3000 },
          { categoryId: coffee, amountCents: -2000 },
        ]),
      }),
    );

    expect(result.error).toBeUndefined();
    expect(getSplits(id)).toHaveLength(2);
  });

  it('the account owner may split even without admin rights', async () => {
    const { db } = setup();
    const owner = insertTestUser(db, { name: 'Owner', username: 'owner', role: 'member' });
    const accountId = addAccount(owner);
    const id = addTxn(accountId, -5000);
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');

    currentUser = { id: owner, name: 'Owner', username: 'owner', role: 'member', visibility: 'household' };
    const result = await saveSplitsAction(
      {},
      formData({
        txnId: String(id),
        parts: JSON.stringify([
          { categoryId: groceries, amountCents: -3000 },
          { categoryId: coffee, amountCents: -2000 },
        ]),
      }),
    );

    expect(result.error).toBeUndefined();
    expect(getSplits(id)).toHaveLength(2);
  });

  it("a sum mismatch surfaces the library's real message", async () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const accountId = addAccount(null);
    const id = addTxn(accountId, -5000);

    const result = await saveSplitsAction(
      {},
      formData({
        txnId: String(id),
        parts: JSON.stringify([
          { categoryId: groceries, amountCents: -3000 },
          { categoryId: coffee, amountCents: -1000 },
        ]),
      }),
    );

    expect(result.error).toBe(
      `Split parts total ${formatCents(-4000)} but the transaction is ${formatCents(-5000)} (difference ${formatCents(1000)}).`,
    );
    expect(getSplits(id)).toHaveLength(0);
  });

  it('splitting a transfer surfaces the exact "Transfers cannot be split." message', async () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const accountId = addAccount(null);
    const id = addTxn(accountId, -5000, true);

    const result = await saveSplitsAction(
      {},
      formData({
        txnId: String(id),
        parts: JSON.stringify([
          { categoryId: groceries, amountCents: -3000 },
          { categoryId: coffee, amountCents: -2000 },
        ]),
      }),
    );

    expect(result.error).toBe('Transfers cannot be split.');
  });

  it('an unknown transaction is rejected instead of throwing', async () => {
    setup();
    const result = await saveSplitsAction({}, formData({ txnId: '999999', parts: '[]' }));
    expect(result.error).toBe('That transaction no longer exists.');
  });

  it('rejects a cross-origin request before touching the database', async () => {
    setup();
    sameOrigin.value = false;
    const result = await saveSplitsAction({}, formData({ txnId: '1', parts: '[]' }));
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
  });
});

// v1.63.0 (plan 2026-11-12, D2): a part's person, and who may set it.
import { buildSplitPersonFixture, type SplitPersonFixture } from '../helpers/split-person-fixture';
import { NOT_YOURS_ERROR } from '@/lib/auth/viewer';
import { UNKNOWN_SPLIT_PERSON_ERROR } from '@/lib/splits';

describe('saveSplitsAction: a part belongs to a person (v1.63.0)', () => {
  function as(f: SplitPersonFixture, id: number, name: string, role: 'admin' | 'member', visibility: 'household' | 'self') {
    current = f.t;
    currentUser = { id, name, username: name.toLowerCase(), role, visibility };
  }
  const parts = (f: SplitPersonFixture, persons: [unknown, unknown, unknown]) =>
    JSON.stringify([
      { categoryId: f.groceries, amountCents: -8000, person: persons[0] },
      { categoryId: f.dining, amountCents: -4000, person: persons[1] },
      { categoryId: f.supplies, amountCents: -3000, person: persons[2] },
    ]);

  it('an admin saves the split and the parts read back as written', async () => {
    const f = buildSplitPersonFixture({ allFollow: true });
    as(f, f.alex, 'Alex', 'admin', 'household');
    const result = await saveSplitsAction({}, formData({ txnId: String(f.maple), parts: parts(f, ['follow', f.sam, 'household']) }));
    expect(result.error).toBeUndefined();
    expect(getSplits(f.maple).map((p) => [p.personSet, p.attributedUserId])).toEqual([
      [false, null],
      [true, f.sam],
      [true, null],
    ]);
  });

  it('a part with no person posted follows the transaction (a stale client keeps working)', async () => {
    const f = buildSplitPersonFixture();
    as(f, f.alex, 'Alex', 'admin', 'household');
    const result = await saveSplitsAction({}, formData({ txnId: String(f.maple), parts: JSON.stringify([
      { categoryId: f.groceries, amountCents: -9000 },
      { categoryId: f.dining, amountCents: -6000 },
    ]) }));
    expect(result.error).toBeUndefined();
    expect(getSplits(f.maple).every((p) => p.personSet === false)).toBe(true);
  });

  it('a household member assigns a part to Sam', async () => {
    const f = buildSplitPersonFixture({ allFollow: true });
    as(f, f.sam, 'Sam', 'member', 'household');
    const result = await saveSplitsAction({}, formData({ txnId: String(f.maple), parts: parts(f, ['follow', f.sam, 'follow']) }));
    expect(result.error).toBeUndefined();
    expect(getSplits(f.maple)[1]).toMatchObject({ personSet: true, attributedUserId: f.sam });
  });

  it('a self viewer splits his own row with parts following or set to himself', async () => {
    const f = buildSplitPersonFixture();
    as(f, f.sam, 'Sam', 'member', 'self');
    const body = (persons: [unknown, unknown]) =>
      formData({ txnId: String(f.fuel), parts: JSON.stringify([
        { categoryId: f.transport, amountCents: -3000, person: persons[0] },
        { categoryId: f.dining, amountCents: -3130, person: persons[1] },
      ]) });
    expect((await saveSplitsAction({}, body(['follow', f.sam]))).error).toBeUndefined();
    expect(getSplits(f.fuel)[1]).toMatchObject({ personSet: true, attributedUserId: f.sam });
  });

  it('a self viewer is refused setting a part to someone else', async () => {
    const f = buildSplitPersonFixture();
    as(f, f.sam, 'Sam', 'member', 'self');
    const result = await saveSplitsAction({}, formData({ txnId: String(f.fuel), parts: JSON.stringify([
      { categoryId: f.transport, amountCents: -3000, person: f.alex },
      { categoryId: f.dining, amountCents: -3130, person: 'follow' },
    ]) }));
    expect(result.error).toBe(NOT_YOURS_ERROR);
    expect(getSplits(f.fuel)).toHaveLength(0);
  });

  it('a self viewer is refused editing a row that is not his, even though a part of it is his', async () => {
    const f = buildSplitPersonFixture();
    as(f, f.sam, 'Sam', 'member', 'self');
    const before = getSplits(f.maple);
    const result = await saveSplitsAction({}, formData({ txnId: String(f.maple), parts: '[]' }));
    expect(result.error).toBe(NOT_YOURS_ERROR);
    expect(getSplits(f.maple)).toEqual(before);
  });

  it('a self viewer is refused editing his own row once a part is set to someone else', async () => {
    const f = buildSplitPersonFixture();
    as(f, f.alex, 'Alex', 'admin', 'household');
    await saveSplitsAction({}, formData({ txnId: String(f.fuel), parts: JSON.stringify([
      { categoryId: f.transport, amountCents: -3000, person: 'follow' },
      { categoryId: f.dining, amountCents: -3130, person: f.alex },
    ]) }));
    as(f, f.sam, 'Sam', 'member', 'self');
    const result = await saveSplitsAction({}, formData({ txnId: String(f.fuel), parts: '[]' }));
    expect(result.error).toBe(NOT_YOURS_ERROR);
    expect(getSplits(f.fuel)).toHaveLength(2);
  });

  it('a person who is not in the household is refused and nothing is written', async () => {
    const f = buildSplitPersonFixture({ allFollow: true });
    as(f, f.alex, 'Alex', 'admin', 'household');
    const refused = await saveSplitsAction({}, formData({ txnId: String(f.maple), parts: parts(f, ['follow', 9999, 'follow']) }));
    expect(refused.error).toBe(UNKNOWN_SPLIT_PERSON_ERROR);
    expect(getSplits(f.maple).every((p) => p.personSet === false)).toBe(true);
  });
});
