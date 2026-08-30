import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSeededTestDb, categoryIdByName, insertTestUser, type TestDb } from '../helpers/db';
import { budgetProgress, resolveBudget, rolloverStartMonth, setRollover, upsertBudget } from '@/lib/budgets';

let currentUser: { id: number; name: string; username: string; role: 'admin' | 'member' } = {
  id: 1,
  name: 'Alice',
  username: 'alice',
  role: 'member',
};
let mockHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => mockHeaders,
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { copyPreviousMonthAction, setLimitAction, setRolloverAction, setSavingsTargetAction } from '@/app/(app)/budgets/actions';
import { rolloverIdsFor } from '@/app/(app)/budgets/page';
// Lane 1 (src/lib/savings-target.ts): not mocked here, same as every other library import in
// this file -- these tests read the real row a save wrote, the same way resolveBudget above
// verifies setLimitAction/copyPreviousMonthAction against the real budgets table.
import { getSavingsTarget, saveSavingsTarget } from '@/lib/savings-target';

const SAME_ORIGIN = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
const CROSS_ORIGIN = new Headers({ origin: 'http://evil.local', host: 'nas.local:3000' });

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  mockHeaders = SAME_ORIGIN;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'member' });
  const bob = insertTestUser(current.db, { name: 'Bob', username: 'bob', role: 'member' });
  const admin = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
  const groceries = categoryIdByName(current.db, 'Groceries');
  currentUser = { id: alice, name: 'Alice', username: 'alice', role: 'member' };
  mockHeaders = SAME_ORIGIN;
  return { db: current.db, sqlite: current.sqlite, alice, bob, admin, groceries };
}

describe('setLimitAction — review finding 6', () => {
  it('rejects a cross-origin submission before touching the database', async () => {
    const { groceries } = setup();
    mockHeaders = CROSS_ORIGIN;
    const result = await setLimitAction(
      {},
      formData({ scope: 'household', month: '2026-03', categoryId: String(groceries), userId: '', amount: '50.00' }),
    );
    expect(result.error).toMatch(/cross-origin/i);
    expect(resolveBudget('household', null, groceries, '2026-03')).toBeNull();
  });

  it("rejects a member editing another member's personal budget", async () => {
    const { bob, groceries } = setup();
    const result = await setLimitAction(
      {},
      formData({ scope: 'personal', month: '2026-03', categoryId: String(groceries), userId: String(bob), amount: '50.00' }),
    );
    expect(result.error).toMatch(/your own/i);
    expect(resolveBudget('personal', bob, groceries, '2026-03')).toBeNull();
  });

  it("lets an admin override and edit another member's personal budget", async () => {
    const { admin, bob, groceries } = setup();
    currentUser = { id: admin, name: 'Admin', username: 'admin', role: 'admin' };
    const result = await setLimitAction(
      {},
      formData({ scope: 'personal', month: '2026-03', categoryId: String(groceries), userId: String(bob), amount: '50.00' }),
    );
    expect(result.message).toBeTruthy();
    expect(resolveBudget('personal', bob, groceries, '2026-03')).toBe(5000);
  });

  it('happy path: a member sets their own personal budget and a household budget', async () => {
    const { alice, groceries } = setup();
    const own = await setLimitAction(
      {},
      formData({ scope: 'personal', month: '2026-03', categoryId: String(groceries), userId: '', amount: '25.00' }),
    );
    expect(own.message).toBeTruthy();
    expect(resolveBudget('personal', alice, groceries, '2026-03')).toBe(2500);

    const household = await setLimitAction(
      {},
      formData({ scope: 'household', month: '2026-03', categoryId: String(groceries), userId: '', amount: '100.00' }),
    );
    expect(household.message).toBeTruthy();
    expect(resolveBudget('household', null, groceries, '2026-03')).toBe(10000);
  });

  it('a blank amount clears the budget from the viewed month forward', async () => {
    const { groceries } = setup();
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 8000 });
    const result = await setLimitAction(
      {},
      formData({ scope: 'household', month: '2026-03', categoryId: String(groceries), userId: '', amount: '' }),
    );
    expect(result.message).toMatch(/cleared/i);
    expect(resolveBudget('household', null, groceries, '2026-03')).toBeNull();
    expect(resolveBudget('household', null, groceries, '2026-02')).toBe(8000);
  });
});

describe('copyPreviousMonthAction — review finding 6', () => {
  it('rejects a cross-origin submission before touching the database', async () => {
    const { sqlite, groceries } = setup();
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-02', amountCents: 8000 });
    mockHeaders = CROSS_ORIGIN;
    const result = await copyPreviousMonthAction({}, formData({ scope: 'household', month: '2026-03', userId: '' }));
    expect(result.error).toMatch(/cross-origin/i);
    // No new row written at the viewed month — only the pre-existing 2026-02 row exists.
    expect((sqlite.prepare('select count(*) as c from budgets where effective_month = ?').get('2026-03') as { c: number }).c).toBe(0);
  });

  it("rejects a member copying another member's personal budgets", async () => {
    const { sqlite, bob, groceries } = setup();
    upsertBudget({ scope: 'personal', userId: bob, categoryId: groceries, month: '2026-02', amountCents: 8000 });
    const result = await copyPreviousMonthAction({}, formData({ scope: 'personal', month: '2026-03', userId: String(bob) }));
    expect(result.error).toMatch(/your own/i);
    expect((sqlite.prepare('select count(*) as c from budgets where effective_month = ?').get('2026-03') as { c: number }).c).toBe(0);
  });

  it("lets an admin override and copy another member's personal budgets", async () => {
    const { admin, bob, groceries } = setup();
    upsertBudget({ scope: 'personal', userId: bob, categoryId: groceries, month: '2026-02', amountCents: 8000 });
    currentUser = { id: admin, name: 'Admin', username: 'admin', role: 'admin' };
    const result = await copyPreviousMonthAction({}, formData({ scope: 'personal', month: '2026-03', userId: String(bob) }));
    expect(result.message).toMatch(/copied 1/i);
    expect(resolveBudget('personal', bob, groceries, '2026-03')).toBe(8000);
  });

  it('happy path: a member copies their own personal budgets and the household budgets', async () => {
    const { alice, groceries } = setup();
    upsertBudget({ scope: 'personal', userId: alice, categoryId: groceries, month: '2026-02', amountCents: 3000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-02', amountCents: 8000 });

    const own = await copyPreviousMonthAction({}, formData({ scope: 'personal', month: '2026-03', userId: '' }));
    expect(own.message).toMatch(/copied 1/i);
    expect(resolveBudget('personal', alice, groceries, '2026-03')).toBe(3000);

    const household = await copyPreviousMonthAction({}, formData({ scope: 'household', month: '2026-03', userId: '' }));
    expect(household.message).toMatch(/copied 1/i);
    expect(resolveBudget('household', null, groceries, '2026-03')).toBe(8000);
  });

  // Lane 3 item 1 / ruling T4: the same button that seeds budgets by copy-forward now seeds the
  // savings target too, household scope only (ruling T3 -- a personal-scope copy has no target
  // of its own to bring forward).
  it('household copy also carries the savings target forward, and names it in the message', async () => {
    setup();
    saveSavingsTarget({ month: '2026-02', mode: 'percent', value: 20 });
    const result = await copyPreviousMonthAction({}, formData({ scope: 'household', month: '2026-03', userId: '' }));
    expect(result.message).toMatch(/and the savings target/i);
    expect(getSavingsTarget('2026-03')).toEqual({ month: '2026-03', mode: 'percent', value: 20 });
  });

  it('household copy still succeeds, and says nothing about a target, when the previous month had none', async () => {
    setup();
    const result = await copyPreviousMonthAction({}, formData({ scope: 'household', month: '2026-03', userId: '' }));
    expect(result.message).not.toMatch(/savings target/i);
    expect(getSavingsTarget('2026-03')).toBeNull();
  });

  it("a personal copy never touches the savings target -- it is household scope only (ruling T3)", async () => {
    const { alice, groceries } = setup();
    upsertBudget({ scope: 'personal', userId: alice, categoryId: groceries, month: '2026-02', amountCents: 3000 });
    saveSavingsTarget({ month: '2026-02', mode: 'percent', value: 20 });
    const result = await copyPreviousMonthAction({}, formData({ scope: 'personal', month: '2026-03', userId: '' }));
    expect(result.message).not.toMatch(/savings target/i);
    expect(getSavingsTarget('2026-03')).toBeNull();
  });
});

/**
 * Ruling T6: set on Budgets, not Settings. Ruling T3: household scope only, so unlike
 * setLimitAction there is no personal-scope branch and no per-user ownership check here -- any
 * household member (not just an admin) may set it, mirroring how any member may set a household
 * budget LIMIT rather than the admin-only "Roll over unspent" rule.
 */
describe('setSavingsTargetAction', () => {
  it('rejects a cross-origin submission before touching the database', async () => {
    setup();
    mockHeaders = CROSS_ORIGIN;
    const result = await setSavingsTargetAction({}, formData({ month: '2026-03', mode: 'percent', value: '20' }));
    expect(result.error).toMatch(/cross-origin/i);
    expect(getSavingsTarget('2026-03')).toBeNull();
  });

  it('rejects an invalid month and writes nothing', async () => {
    setup();
    const result = await setSavingsTargetAction({}, formData({ month: 'not-a-month', mode: 'percent', value: '20' }));
    expect(result.error).toBe('Invalid request.');
  });

  it('rejects a blank value', async () => {
    setup();
    const result = await setSavingsTargetAction({}, formData({ month: '2026-03', mode: 'percent', value: '' }));
    expect(result.error).toMatch(/enter a value/i);
    expect(getSavingsTarget('2026-03')).toBeNull();
  });

  it('rejects a percent target outside 1-100', async () => {
    setup();
    const tooLow = await setSavingsTargetAction({}, formData({ month: '2026-03', mode: 'percent', value: '0' }));
    expect(tooLow.error).toMatch(/1 to 100/i);
    const tooHigh = await setSavingsTargetAction({}, formData({ month: '2026-03', mode: 'percent', value: '101' }));
    expect(tooHigh.error).toMatch(/1 to 100/i);
    const notWhole = await setSavingsTargetAction({}, formData({ month: '2026-03', mode: 'percent', value: '20.5' }));
    expect(notWhole.error).toMatch(/1 to 100/i);
    expect(getSavingsTarget('2026-03')).toBeNull();
  });

  it('saves a whole-percent target', async () => {
    setup();
    const result = await setSavingsTargetAction({}, formData({ month: '2026-03', mode: 'percent', value: '20' }));
    expect(result.message).toBeTruthy();
    expect(getSavingsTarget('2026-03')).toEqual({ month: '2026-03', mode: 'percent', value: 20 });
  });

  it('rejects a non-positive amount', async () => {
    setup();
    const result = await setSavingsTargetAction({}, formData({ month: '2026-03', mode: 'amount', value: '0' }));
    expect(result.error).toMatch(/positive amount/i);
    expect(getSavingsTarget('2026-03')).toBeNull();
  });

  it('saves an amount target in cents, from a dollar string', async () => {
    setup();
    const result = await setSavingsTargetAction({}, formData({ month: '2026-03', mode: 'amount', value: '250.00' }));
    expect(result.message).toBeTruthy();
    expect(getSavingsTarget('2026-03')).toEqual({ month: '2026-03', mode: 'amount', value: 25000 });
  });

  it('upserts rather than duplicating a month, and switching mode replaces the old row outright', async () => {
    setup();
    await setSavingsTargetAction({}, formData({ month: '2026-03', mode: 'percent', value: '20' }));
    await setSavingsTargetAction({}, formData({ month: '2026-03', mode: 'amount', value: '100.00' }));
    expect(getSavingsTarget('2026-03')).toEqual({ month: '2026-03', mode: 'amount', value: 10000 });
  });

  it('a non-admin member may set the household target -- ruling T3 has no stricter gate here', async () => {
    const { alice } = setup();
    currentUser = { id: alice, name: 'Alice', username: 'alice', role: 'member' };
    const result = await setSavingsTargetAction({}, formData({ month: '2026-03', mode: 'percent', value: '20' }));
    expect(result.error).toBeUndefined();
    expect(getSavingsTarget('2026-03')).toEqual({ month: '2026-03', mode: 'percent', value: 20 });
  });
});

/**
 * v1.7.0 Task 11, deliverable (a): the "Roll over unspent" toggle's server action. Permission
 * is deliberately STRICTER than setLimitAction's for household scope: the spec (Task 11,
 * "Budgets page:" bullet) says "admin + the personal-scope owner", not "any member" -- rollover
 * is a policy choice about how a shared household budget behaves across months, so changing it
 * there is admin-only, while a personal budget's own owner may still choose it for themselves,
 * same as they may set their own limit.
 */
describe('setRolloverAction — admin, and for a personal-scope budget its own owner', () => {
  it('rejects a cross-origin submission before touching the database', async () => {
    const { admin, groceries } = setup();
    currentUser = { id: admin, name: 'Admin', username: 'admin', role: 'admin' };
    mockHeaders = CROSS_ORIGIN;
    const result = await setRolloverAction(
      {},
      formData({ scope: 'household', month: '2026-03', categoryId: String(groceries), userId: '', enabled: 'on' }),
    );
    expect(result.error).toMatch(/cross-origin/i);
    expect(rolloverStartMonth('household', null, groceries)).toBeNull();
  });

  it('rejects a non-admin member turning rollover on for a household budget', async () => {
    const { groceries } = setup();
    const result = await setRolloverAction(
      {},
      formData({ scope: 'household', month: '2026-03', categoryId: String(groceries), userId: '', enabled: 'on' }),
    );
    expect(result.error).toMatch(/admin/i);
    expect(rolloverStartMonth('household', null, groceries)).toBeNull();
  });

  it('lets an admin turn rollover on for a household budget, starting at the submitted month', async () => {
    const { admin, groceries } = setup();
    currentUser = { id: admin, name: 'Admin', username: 'admin', role: 'admin' };
    const result = await setRolloverAction(
      {},
      formData({ scope: 'household', month: '2026-03', categoryId: String(groceries), userId: '', enabled: 'on' }),
    );
    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/on/i);
    expect(rolloverStartMonth('household', null, groceries)).toBe('2026-03');
  });

  it('lets an admin turn household rollover back off, and the row is gone', async () => {
    const { admin, groceries } = setup();
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-01' });
    currentUser = { id: admin, name: 'Admin', username: 'admin', role: 'admin' };
    // No "enabled" field at all -- exactly what an unchecked checkbox submits.
    const result = await setRolloverAction({}, formData({ scope: 'household', month: '2026-03', categoryId: String(groceries), userId: '' }));
    expect(result.message).toMatch(/off/i);
    expect(rolloverStartMonth('household', null, groceries)).toBeNull();
  });

  it("rejects a member turning rollover on for another member's personal budget", async () => {
    const { bob, groceries } = setup();
    const result = await setRolloverAction(
      {},
      formData({ scope: 'personal', month: '2026-03', categoryId: String(groceries), userId: String(bob), enabled: 'on' }),
    );
    expect(result.error).toMatch(/your own/i);
    expect(rolloverStartMonth('personal', bob, groceries)).toBeNull();
  });

  it('lets a member turn rollover on for their own personal budget without being an admin', async () => {
    const { alice, groceries } = setup();
    const result = await setRolloverAction(
      {},
      formData({ scope: 'personal', month: '2026-03', categoryId: String(groceries), userId: '', enabled: 'on' }),
    );
    expect(result.error).toBeUndefined();
    expect(rolloverStartMonth('personal', alice, groceries)).toBe('2026-03');
  });

  it("lets an admin turn rollover on for another member's personal budget", async () => {
    const { admin, bob, groceries } = setup();
    currentUser = { id: admin, name: 'Admin', username: 'admin', role: 'admin' };
    const result = await setRolloverAction(
      {},
      formData({ scope: 'personal', month: '2026-03', categoryId: String(groceries), userId: String(bob), enabled: 'on' }),
    );
    expect(result.error).toBeUndefined();
    expect(rolloverStartMonth('personal', bob, groceries)).toBe('2026-03');
  });

  it('rejects an invalid month and writes nothing', async () => {
    const { admin, groceries } = setup();
    currentUser = { id: admin, name: 'Admin', username: 'admin', role: 'admin' };
    const result = await setRolloverAction(
      {},
      formData({ scope: 'household', month: 'not-a-month', categoryId: String(groceries), userId: '', enabled: 'on' }),
    );
    expect(result.error).toBe('Invalid request.');
    expect(rolloverStartMonth('household', null, groceries)).toBeNull();
  });

  it('re-enabling an already-on rollover leaves its original startMonth untouched (setRollover\'s own no-op rule)', async () => {
    const { admin, groceries } = setup();
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-01' });
    currentUser = { id: admin, name: 'Admin', username: 'admin', role: 'admin' };
    await setRolloverAction({}, formData({ scope: 'household', month: '2026-06', categoryId: String(groceries), userId: '', enabled: 'on' }));
    expect(rolloverStartMonth('household', null, groceries)).toBe('2026-01');
  });
});

/**
 * v1.7.0 Task 11: rolloverIdsFor (src/app/(app)/budgets/page.tsx) is the page's own bridge
 * between budget_rollover's absence-is-off rows and the client's on/off checkboxes -- BudgetRow
 * itself (src/lib/budgets.ts, not modified by this task) carries no boolean "is rollover on"
 * field, only baseLimitCents/carryCents, so the page reads rolloverStartMonth per rendered row.
 */
describe('rolloverIdsFor (page.tsx)', () => {
  it('is empty when nothing is enabled, lists the category once enabled, and empties again once disabled', () => {
    const { groceries } = setup();
    expect(rolloverIdsFor('household', null, budgetProgress('2026-03'))).not.toContain(groceries);

    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-03' });
    expect(rolloverIdsFor('household', null, budgetProgress('2026-03'))).toContain(groceries);

    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: false, startMonth: '2026-03' });
    expect(rolloverIdsFor('household', null, budgetProgress('2026-03'))).not.toContain(groceries);
  });

  it('keeps household and personal rollover independent for the same category', () => {
    const { alice, groceries } = setup();
    setRollover({ scope: 'personal', userId: alice, categoryId: groceries, enabled: true, startMonth: '2026-03' });

    expect(rolloverIdsFor('personal', alice, budgetProgress('2026-03', 'personal', alice))).toContain(groceries);
    expect(rolloverIdsFor('household', null, budgetProgress('2026-03'))).not.toContain(groceries);
  });
});
