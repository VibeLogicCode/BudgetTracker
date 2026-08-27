import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';

const USER = { id: 1, name: 'Alice', username: 'user-1', role: 'admin' as const };
const SAME_ORIGIN = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
const CROSS_ORIGIN = new Headers({ origin: 'http://evil.local', host: 'nas.local:3000' });
let mockHeaders = SAME_ORIGIN;

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => USER),
  requireAdmin: vi.fn(async () => USER),
}));
vi.mock('next/headers', () => ({ headers: async () => mockHeaders }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  addInstallmentAction,
  removeInstallmentAction,
  setInstallmentPaidAction,
  saveLoanRuleAction,
} from '@/app/(app)/warranties/actions';
import { INSTALLMENT_KIND_ERROR, MATCHING_KIND_ERROR } from '@/lib/warranty/constants';
import { listInstallments } from '@/lib/warranty/installments';

const NOW = '2026-08-24T12:00:00.000Z';
const TODAY = '2026-08-24';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  mockHeaders = SAME_ORIGIN;
});

function fd(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

function setup(kind = 'bill'): { itemId: number; userId: number } {
  current = createTestDb();
  const userId = insertTestUser(current.db, { username: 'user-1' });
  const type = current.sqlite
    .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values (?, 0, ?, ?) returning id`)
    .get(`Type ${kind}`, kind, NOW) as { id: number };
  const item = current.sqlite
    .prepare(
      `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
       values ('Municipal tax', '2024-01-15', 0, ?, ?, ?, ?) returning id`,
    )
    .get(userId, type.id, NOW, NOW) as { id: number };
  return { itemId: item.id, userId };
}

describe('addInstallmentAction', () => {
  it('adds one row and reports what happened', async () => {
    const { itemId } = setup();
    const result = await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '1200.00' }));
    expect(result.error).toBeUndefined();
    expect(result.message).toContain('2026-09-30');
    const rows = listInstallments(itemId, TODAY, 30);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountCents).toBe(120_000);
  });

  it('refuses cross-origin before touching the database (MUST-13.1)', async () => {
    const { itemId } = setup();
    mockHeaders = CROSS_ORIGIN;
    const result = await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '1200.00' }));
    expect(result.error).toBeTruthy();
    mockHeaders = SAME_ORIGIN;
    expect(listInstallments(itemId, TODAY, 30)).toEqual([]);
  });

  it('refuses a non-bill item with the one shared sentence', async () => {
    const { itemId } = setup('contract');
    const result = await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '1200.00' }));
    expect(result.error).toBe(INSTALLMENT_KIND_ERROR);
  });

  it('refuses a bad amount and a bad date, each with its own sentence', async () => {
    const { itemId } = setup();
    expect((await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: 'lots' }))).error)
      .toBeTruthy();
    expect((await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '0' }))).error)
      .toBeTruthy();
    expect((await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: 'soon', amount: '10.00' }))).error)
      .toBeTruthy();
    expect(listInstallments(itemId, TODAY, 30)).toEqual([]);
  });
});

describe('setInstallmentPaidAction', () => {
  it('marks and unmarks through one action with a paid field', async () => {
    const { itemId } = setup();
    await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '1200.00' }));
    const id = listInstallments(itemId, TODAY, 30)[0]!.id;

    await setInstallmentPaidAction({}, fd({ id: String(id), itemId: String(itemId), paid: 'true' }));
    expect(listInstallments(itemId, TODAY, 30)[0]!.state).toBe('paid');
    // Hand-marked: paid_txn_id stays NULL, which is what "a person did this" means (B13).
    expect(listInstallments(itemId, TODAY, 30)[0]!.paidTxnId).toBeNull();

    await setInstallmentPaidAction({}, fd({ id: String(id), itemId: String(itemId), paid: 'false' }));
    expect(listInstallments(itemId, TODAY, 30)[0]!.paidAt).toBeNull();
  });

  it('refuses to mark an installment on a non-bill item, but still allows unmarking one', async () => {
    const { itemId } = setup();
    await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '1200.00' }));
    const id = listInstallments(itemId, TODAY, 30)[0]!.id;
    await setInstallmentPaidAction({}, fd({ id: String(id), itemId: String(itemId), paid: 'true' }));
    current!.sqlite.prepare(`update warranty_item_types set kind = 'contract'`).run();

    expect((await setInstallmentPaidAction({}, fd({ id: String(id), itemId: String(itemId), paid: 'true' }))).error)
      .toBe(INSTALLMENT_KIND_ERROR);
    // Unmark is not an add: ruling B7 says a gate never hides or strands a stored value.
    expect((await setInstallmentPaidAction({}, fd({ id: String(id), itemId: String(itemId), paid: 'false' }))).error)
      .toBeUndefined();
    expect(listInstallments(itemId, TODAY, 30)[0]!.paidAt).toBeNull();
  });

  it('refuses an installment that does not belong to the claimed item', async () => {
    const { itemId } = setup();
    await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '1200.00' }));
    const id = listInstallments(itemId, TODAY, 30)[0]!.id;
    const result = await setInstallmentPaidAction({}, fd({ id: String(id), itemId: '9999', paid: 'true' }));
    expect(result.error).toBe('That installment no longer exists.');
  });
});

describe('removeInstallmentAction', () => {
  it('removes it and says the stale case out loud', async () => {
    const { itemId } = setup();
    await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '1200.00' }));
    const id = listInstallments(itemId, TODAY, 30)[0]!.id;
    expect((await removeInstallmentAction({}, fd({ id: String(id), itemId: String(itemId) }))).message).toBeTruthy();
    expect(listInstallments(itemId, TODAY, 30)).toEqual([]);
    // F3-fix-round treatment, same as the loan rules table: a second click has somewhere to land.
    expect((await removeInstallmentAction({}, fd({ id: String(id), itemId: String(itemId) }))).error).toBe(
      'That installment no longer exists.',
    );
  });
});

describe('the payment-matching gate widened to bills', () => {
  it('accepts a rule on a bill and refuses one on a contract, with the shared sentence', async () => {
    const { itemId } = setup();
    insertTestAccount(current!.db, { name: 'Chequing' });
    const ok = await saveLoanRuleAction({}, fd({ itemId: String(itemId), merchantContains: 'CITY TAX', accountId: '' }));
    expect(ok.error).toBeUndefined();

    const contract = setup('contract');
    const refused = await saveLoanRuleAction(
      {},
      fd({ itemId: String(contract.itemId), merchantContains: 'CITY TAX', accountId: '' }),
    );
    expect(refused.error).toBe(MATCHING_KIND_ERROR);
  });
});
