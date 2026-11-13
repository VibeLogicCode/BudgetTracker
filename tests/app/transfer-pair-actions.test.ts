import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { CROSS_ORIGIN_ERROR } from '@/lib/auth/csrf';
import { lastBulkUndo } from '@/lib/bulk-undo';
import { nowIso } from '@/lib/clock';
import { getSetting } from '@/lib/settings';
import { dismissalKey, TRANSFER_PAIR_STALE_ERROR } from '@/lib/transfer-pairs';

let currentUser: { id: number; name: string; username: string; role: 'admin' | 'member'; visibility?: 'household' | 'self' } = {
  id: 1,
  name: 'Alex',
  username: 'alex',
  role: 'admin',
};
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
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
import { revalidatePath } from 'next/cache';

import { confirmTransferPairAction, dismissTransferPairAction } from '@/app/(app)/transactions/transfer-pair-actions';

let current: TestDb | null = null;
beforeEach(() => {
  sameOrigin.value = true;
  vi.mocked(revalidatePath).mockClear();
});
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const t = current;
  const alex = insertTestUser(t.db, { name: 'Alex', username: 'alex', role: 'admin' });
  currentUser = { id: alex, name: 'Alex', username: 'alex', role: 'admin' };
  const chequing = insertTestAccount(t.db, { name: 'Everyday Chequing', type: 'chequing' });
  const savings = insertTestAccount(t.db, { name: 'Rainy Day Savings', type: 'savings' });
  const insert = t.sqlite.prepare(
    `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, categorization_source,
       is_transfer, created_by, created_at, updated_at)
     values (?, '2026-03-09', 'E-TRANSFER 4417', 'e-transfer 4417', ?, 'none', 0, ?, ?, ?) returning id`,
  );
  const add = (accountId: number, cents: number) => (insert.get(accountId, cents, alex, nowIso(), nowIso()) as { id: number }).id;
  const out = add(chequing, -50000);
  const inc = add(savings, 50000);
  const form = (o = out, i = inc) => {
    const data = new FormData();
    data.set('outId', String(o));
    data.set('inId', String(i));
    return data;
  };
  const flags = () => t.sqlite.prepare('select is_transfer as v from transactions order by id').all() as Array<{ v: number }>;
  return { t, alex, out, inc, form, flags };
}

describe('confirmTransferPairAction', () => {
  it('marks both rows, records an undo, saves no rule and revalidates the money pages', async () => {
    const { t, alex, form, flags } = setup();
    const result = await confirmTransferPairAction({}, form());
    expect(result).toEqual({ message: 'Marked 2 transactions as a transfer pair.' });
    expect(flags().map((row) => row.v)).toEqual([1, 1]);
    expect(t.sqlite.prepare('select count(*) as n from merchant_rules').get()).toEqual({ n: 0 });
    expect(lastBulkUndo(alex, new Date())?.rows).toBe(2);
    const paths = vi.mocked(revalidatePath).mock.calls.map((call) => call[0]);
    expect(paths).toEqual(['/transactions', '/dashboard', '/budgets', '/reports']);
  });

  it('counts only the row it changed when one side is already a transfer', async () => {
    const { t, alex, inc, form, flags } = setup();
    t.sqlite.prepare('update transactions set is_transfer = 1 where id = ?').run(inc);
    const result = await confirmTransferPairAction({}, form());
    expect(result).toEqual({ message: 'Marked 1 transaction as a transfer; the other side already was one.' });
    expect(flags().map((row) => row.v)).toEqual([1, 1]);
    expect(lastBulkUndo(alex, new Date())).toMatchObject({ rows: 1, label: 'Marked 1 transaction as a transfer; the other side already was one.' });
  });

  it('checks the origin before anything else', async () => {
    const { form, flags } = setup();
    sameOrigin.value = false;
    expect(await confirmTransferPairAction({}, form())).toEqual({ error: CROSS_ORIGIN_ERROR });
    expect(flags().map((row) => row.v)).toEqual([0, 0]);
  });

  it('refuses bad ids and a stale pair', async () => {
    const { t, out, inc, form, flags } = setup();
    expect(await confirmTransferPairAction({}, form(0, inc))).toEqual({ error: 'Invalid request.' });
    t.sqlite.prepare("update transactions set date = '2026-03-30' where id = ?").run(inc);
    expect(await confirmTransferPairAction({}, form(out, inc))).toEqual({ error: TRANSFER_PAIR_STALE_ERROR });
    expect(flags().map((row) => row.v)).toEqual([0, 0]);
  });

  it('refuses a self-scoped viewer', async () => {
    const { alex, form, flags } = setup();
    currentUser = { id: alex, name: 'Alex', username: 'alex', role: 'member', visibility: 'self' };
    const result = await confirmTransferPairAction({}, form());
    expect(result.error).toBeTruthy();
    expect(flags().map((row) => row.v)).toEqual([0, 0]);
  });
});

describe('dismissTransferPairAction', () => {
  it('remembers the dismissal and writes no transfer', async () => {
    const { out, inc, form, flags } = setup();
    const result = await dismissTransferPairAction({}, form());
    expect(result.error).toBeUndefined();
    expect(getSetting(dismissalKey(out, inc))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(flags().map((row) => row.v)).toEqual([0, 0]);
  });

  it('checks the origin first', async () => {
    const { out, inc, form } = setup();
    sameOrigin.value = false;
    expect(await dismissTransferPairAction({}, form())).toEqual({ error: CROSS_ORIGIN_ERROR });
    expect(getSetting(dismissalKey(out, inc))).toBeNull();
  });
});
