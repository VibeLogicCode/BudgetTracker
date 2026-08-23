import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { clearBudget, effectiveBudget, resolveBudget, setRollover, upsertBudget } from '@/lib/budgets';
import { nowIso } from '@/lib/clock';

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

import { applyAllSuggestionsAction, applySuggestionAction } from '@/app/(app)/budgets/actions';

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

/** Six flat months of spend for a category, ending the month before TARGET. */
const TARGET = '2026-08';
const WINDOW_MONTHS = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'member' });
  const bob = insertTestUser(current.db, { name: 'Bob', username: 'bob', role: 'member' });
  currentUser = { id: alice, name: 'Alice', username: 'alice', role: 'member' };
  const joint = insertTestAccount(current.db, { name: 'Joint Chequing' });
  const spend = (over: { categoryId: number; amountCents: number; date: string; attributedUserId?: number | null }) => {
    current!.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${joint}, ${over.date}, 'X', 'X', ${over.amountCents}, ${over.categoryId}, 'manual', 0, ${over.attributedUserId ?? null}, ${alice}, ${nowIso()}, ${nowIso()})`);
  };
  const flatSix = (categoryId: number, cents: number, attributedUserId?: number) => {
    for (const month of WINDOW_MONTHS) spend({ categoryId, amountCents: -cents, date: `${month}-10`, attributedUserId });
  };
  return { db: current.db, alice, bob, spend, flatSix };
}

describe('MUST-7.4: the amount is never a form field', () => {
  it('writes the recomputed amount and ignores an amount a crafted request adds', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);

    const state = await applySuggestionAction(
      {},
      formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(groceries), amount: '999999' }),
    );

    expect(state.error).toBeUndefined();
    expect(resolveBudget('household', null, groceries, TARGET)).toBe(60000);
  });
});

describe('MUST-7.5: a suggestion that is no longer available writes nothing', () => {
  it('returns the reload error for a category with no computable suggestion', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    // Kids is top-level, has no children and has no spend, so its series is all zeros and
    // suggestBudget returns 'no-spend'.
    const kids = categoryIdByName(db, 'Kids');
    flatSix(groceries, 60000);

    const state = await applySuggestionAction(
      {},
      formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(kids) }),
    );

    expect(state.error).toBe('That suggestion is no longer available. Reload the page.');
    expect(resolveBudget('household', null, kids, TARGET)).toBeNull();
  });
});

describe('MUST-7.6: permissions match setLimitAction exactly', () => {
  it('refuses a member writing to another member personal scope, and allows an admin', async () => {
    const { db, bob, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000, bob);

    const refused = await applySuggestionAction(
      {},
      formData({ scope: 'personal', userId: String(bob), month: TARGET, categoryId: String(groceries) }),
    );
    expect(refused.error).toBe('You can only edit your own personal budgets.');
    expect(resolveBudget('personal', bob, groceries, TARGET)).toBeNull();

    currentUser = { ...currentUser, role: 'admin' };
    const allowed = await applySuggestionAction(
      {},
      formData({ scope: 'personal', userId: String(bob), month: TARGET, categoryId: String(groceries) }),
    );
    expect(allowed.error).toBeUndefined();
    expect(resolveBudget('personal', bob, groceries, TARGET)).toBe(60000);
  });
});

describe('MUST-7.7: applying at month M writes effective_month M and leaves earlier rows alone', () => {
  it('does not mutate a limit set in an earlier month', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 12345 });

    await applySuggestionAction({}, formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(groceries) }));

    expect(resolveBudget('household', null, groceries, '2026-01')).toBe(12345);
    expect(resolveBudget('household', null, groceries, '2026-07')).toBe(12345);
    expect(resolveBudget('household', null, groceries, TARGET)).toBe(60000);
  });
});

describe('MUST-7.8: apply-all never overwrites a typed limit', () => {
  it('skips every category with a resolved limit and names both counts', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const restaurants = categoryIdByName(db, 'Restaurants');
    const food = categoryIdByName(db, 'Food');
    flatSix(groceries, 60000);
    flatSix(restaurants, 30000);
    // Three rows end up with a suggestion: the two children and their rolled-up parent Food
    // at $900.00 a month. Only Restaurants already has a limit, so two are set and one is
    // skipped.
    upsertBudget({ scope: 'household', userId: null, categoryId: restaurants, month: '2026-06', amountCents: 11100 });

    const state = await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: TARGET }));

    expect(state.message).toBe('Set 2 budgets from suggestions. Skipped 1 categories that already had a limit.');
    expect(resolveBudget('household', null, groceries, TARGET)).toBe(60000);
    expect(resolveBudget('household', null, food, TARGET)).toBe(90000);
    expect(resolveBudget('household', null, restaurants, TARGET)).toBe(11100);
  });

  it('applies to the parent and the child independently, because both are rows on the page', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const food = categoryIdByName(db, 'Food');
    flatSix(groceries, 60000);

    await applySuggestionAction({}, formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(food) }));

    expect(resolveBudget('household', null, food, TARGET)).toBe(60000);
    expect(resolveBudget('household', null, groceries, TARGET)).toBeNull();
  });
});

describe('same-origin first', () => {
  it('rejects both actions on a cross-origin request before touching the database', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);
    mockHeaders = CROSS_ORIGIN;

    expect(
      (await applySuggestionAction({}, formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(groceries) })))
        .error,
    ).toBe('Cross-origin request rejected');
    expect((await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: TARGET }))).error).toBe(
      'Cross-origin request rejected',
    );
    expect(resolveBudget('household', null, groceries, TARGET)).toBeNull();
  });
});

describe('MUST-4.6: under three months of history there are no suggestions at all', () => {
  it('refuses every category on a two-month household', async () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -60000, date: '2026-06-10' });
    spend({ categoryId: groceries, amountCents: -60000, date: '2026-07-10' });

    const state = await applySuggestionAction(
      {},
      formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(groceries) }),
    );
    expect(state.error).toBe('That suggestion is no longer available. Reload the page.');
  });
});

describe('controller ruling on the Task 5 review: archived categories are skipped for suggestions', () => {
  it("excludes an archived top-level category with non-zero own spend from apply-all's counts", async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const kids = categoryIdByName(db, 'Kids');
    db.run(sql`update categories set is_archived = 1 where id = ${kids}`);
    flatSix(groceries, 60000);
    flatSix(kids, 6000);

    // Groceries and its rolled-up parent Food are the only two rows with a suggestion; Kids
    // is archived and read-only on the Budgets page, so it is neither set nor counted skipped.
    const state = await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: TARGET }));

    expect(state.message).toBe('Set 2 budgets from suggestions. Skipped 0 categories that already had a limit.');
    expect(resolveBudget('household', null, kids, TARGET)).toBeNull();
  });
});

describe('cheap test additions from the Task 5 review', () => {
  it('running apply-all twice sets nothing the second time and skips exactly what the first run set', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const restaurants = categoryIdByName(db, 'Restaurants');
    flatSix(groceries, 60000);
    flatSix(restaurants, 30000);

    const first = await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: TARGET }));
    const setCount = Number(/^Set (\d+) budgets/.exec(first.message ?? '')?.[1]);
    expect(setCount).toBeGreaterThan(0);

    const second = await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: TARGET }));
    expect(second.message).toBe(`Set 0 budgets from suggestions. Skipped ${setCount} categories that already had a limit.`);
  });

  // MUST-7.6 covers applySuggestionAction; this is the same rule, unexercised for the ALL
  // action until now, even though the production guard already exists for both (actions.ts
  // lines 133-136 and 99-101 read identically).
  it('MUST-7.6 parity: a member calling applyAllSuggestionsAction for another member personal scope is rejected the same way the single action is', async () => {
    const { db, bob, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000, bob);

    const refused = await applyAllSuggestionsAction(
      {},
      formData({ scope: 'personal', userId: String(bob), month: TARGET }),
    );
    expect(refused.error).toBe('You can only edit your own personal budgets.');
    expect(resolveBudget('personal', bob, groceries, TARGET)).toBeNull();
  });
});

/**
 * MUST-6.6 (final-fix-wave item 1, HIGH): apply-all and apply-one may only ever act against the
 * CURRENT month. src/lib/predict/window.ts:19-23 clips the history window only at the bottom,
 * so for a FUTURE target month the six-month window includes the current, partial month —
 * exactly the client must not choose the inputs to the computation discipline MUST-7.4 already
 * applies to the amount. Both actions now reject any month key that is not the real current
 * month, checked immediately after the zod parses, before either action's own permission or
 * suggestion logic runs.
 */
describe('MUST-6.6: only the current month can be suggested against', () => {
  const NEXT = '2026-09';
  const PAST = '2026-07';

  it('applySuggestionAction refuses a next-month key and writes nothing', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);

    const state = await applySuggestionAction(
      {},
      formData({ scope: 'household', userId: '', month: NEXT, categoryId: String(groceries) }),
    );
    expect(state.error).toBe('Suggestions are only available for the current month.');
    expect(resolveBudget('household', null, groceries, NEXT)).toBeNull();
  });

  it('applySuggestionAction refuses a past-month key and writes nothing', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);

    const state = await applySuggestionAction(
      {},
      formData({ scope: 'household', userId: '', month: PAST, categoryId: String(groceries) }),
    );
    expect(state.error).toBe('Suggestions are only available for the current month.');
    expect(resolveBudget('household', null, groceries, PAST)).toBeNull();
  });

  it('applySuggestionAction still works for the current month', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);

    const state = await applySuggestionAction(
      {},
      formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(groceries) }),
    );
    expect(state.error).toBeUndefined();
    expect(resolveBudget('household', null, groceries, TARGET)).toBe(60000);
  });

  it('applyAllSuggestionsAction refuses a next-month key and writes nothing', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);

    const state = await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: NEXT }));
    expect(state.error).toBe('Suggestions are only available for the current month.');
    expect(resolveBudget('household', null, groceries, NEXT)).toBeNull();
  });

  it('applyAllSuggestionsAction refuses a past-month key and writes nothing', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);

    const state = await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: PAST }));
    expect(state.error).toBe('Suggestions are only available for the current month.');
    expect(resolveBudget('household', null, groceries, PAST)).toBeNull();
  });

  it('applyAllSuggestionsAction still works for the current month', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);

    const state = await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: TARGET }));
    // Groceries and its rolled-up parent Food are the two rows with a suggestion (same shape
    // as the other apply-all tests above that flatSix a single leaf category).
    expect(state.message).toBe('Set 2 budgets from suggestions. Skipped 0 categories that already had a limit.');
    expect(resolveBudget('household', null, groceries, TARGET)).toBe(60000);
  });
});

/**
 * v1.7.0 Task 11, deliverable (b)(1): suggested budgets must compare against and write the
 * BASE limit, never the effective (carry-inflated) one.
 *
 * Verification performed BEFORE writing these tests (this is a check of current behaviour, not
 * an assumption):
 *   - `grep -n "limitCents" src/lib/predict/suggest.ts src/lib/predict/history.ts` -> no
 *     matches in either file.
 *   - `grep -n "^import" src/lib/predict/history.ts` -> it imports only `transactions` /
 *     `transactionSplits` from the schema, nothing from `@/lib/budgets` and no `budgets` /
 *     `budgetRollover` table. suggestBudget/suggestionsFor compute purely from the historical
 *     spend series; there is no code path in either file that could read ANY limit, base or
 *     effective. The "compare against base, not effective" requirement is therefore met
 *     structurally, not by chance -- there is no comparison against a limit at all.
 *   - `grep -n "resolveBudget\|upsertBudget\|effectiveBudget" src/app/(app)/budgets/actions.ts`
 *     -> applySuggestionAction/applyAllSuggestionsAction's "already budgeted, skip it" check
 *     calls `resolveBudget` (reads `budgets.amountCents` directly -- the BASE, per budgets.ts's
 *     own doc comment on `effectiveBudget`), never `effectiveBudget` or `budgetProgress`. Both
 *     write only via `upsertBudget`, which has no "effective" column to write to -- carry is
 *     never stored anywhere, only ever computed on read.
 *
 * CONCLUSION: current behaviour is already correct. No change was needed in suggest.ts,
 * history.ts or actions.ts for this point. The tests below pin it against a future regression
 * (e.g. someone "optimizing" the skip check to read budgetProgress() instead of resolveBudget).
 */
describe('v1.7.0 Task 11: a suggested-budget apply is never inflated by an existing rollover carry', () => {
  it('applySuggestionAction writes exactly the suggested amount, with a large carry sitting on the category', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000); // six flat months of spend -> a suggestion of 60000 (MUST-7.4 above)

    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-07' });
    // July: a $1600 base against July's $600 flatSix spend leaves a genuine $1000 leftover,
    // carried into the target month (August).
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-07', amountCents: 160000 });
    // August itself is explicitly cleared, so resolveBudget(TARGET) is null and the apply path
    // is not skipped -- while the carry (computed only over months BEFORE target) survives.
    clearBudget({ scope: 'household', userId: null, categoryId: groceries, month: TARGET });

    const before = effectiveBudget('household', null, groceries, TARGET);
    expect(before.baseCents).toBeNull();
    expect(before.carryCents).toBe(100000); // 160000 base - 60000 July spend

    const state = await applySuggestionAction(
      {},
      formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(groceries) }),
    );

    expect(state.error).toBeUndefined();
    // Exactly the suggestion -- NOT 60000 plus the 100000 carry sitting on the category.
    expect(resolveBudget('household', null, groceries, TARGET)).toBe(60000);
  });

  it('applyAllSuggestionsAction likewise writes exactly the suggested amount under the same carry', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);

    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-07' });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-07', amountCents: 160000 });
    clearBudget({ scope: 'household', userId: null, categoryId: groceries, month: TARGET });
    expect(effectiveBudget('household', null, groceries, TARGET).carryCents).toBe(100000);

    await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: TARGET }));

    expect(resolveBudget('household', null, groceries, TARGET)).toBe(60000);
  });

  it("apply-all's skip-if-already-budgeted check is driven by the BASE, not the effective total", async () => {
    // If a base is already set for the target month, apply-all must skip it regardless of how
    // large a carry sits on top -- exactly resolveBudget's existing "!== null" check, which
    // cannot see the carry at all (it only ever reads budgets.amountCents).
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-07' });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-07', amountCents: 160000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: TARGET, amountCents: 12345 });
    expect(effectiveBudget('household', null, groceries, TARGET).carryCents).toBe(100000);

    const state = await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: TARGET }));

    expect(state.message).toMatch(/skipped 1/i);
    // Untouched -- the base is exactly what was typed, never overwritten and never combined
    // with the carry.
    expect(resolveBudget('household', null, groceries, TARGET)).toBe(12345);
  });
});

/**
 * v1.7.0 Task 11, deliverable (b)(2): a previous release shipped a bug where apply-all wrote a
 * future month using a window that included a partial month; MUST-6.6 above is that fix's own
 * regression coverage. This block proves a rollover row present on the category does not
 * reopen that hole.
 *
 * Verification performed BEFORE writing these tests: reading src/app/(app)/budgets/actions.ts
 * top to bottom, the `month.data !== currentMonth(...)` check in both applySuggestionAction and
 * applyAllSuggestionsAction sits immediately after the zod parses, before any budget or
 * rollover read. Neither action calls `effectiveBudget`, `rolloverStartMonth` or touches
 * `budgetRollover` at all (confirmed by `grep -n "rollover\|effectiveBudget" src/app/(app)/
 * budgets/actions.ts` before this task's own setRolloverAction was added to that file, which
 * returned no matches), so whether rollover is on or off for the category cannot change which
 * months the guard accepts.
 *
 * CONCLUSION: current behaviour already holds; no fix was needed. These tests pin it.
 */
describe('v1.7.0 Task 11: the current-month guard holds even when the category has rollover on', () => {
  const NEXT_MONTH = '2026-09';
  const PAST_MONTH = '2026-07';

  it('applySuggestionAction still refuses a non-current month', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-01' });

    const state = await applySuggestionAction(
      {},
      formData({ scope: 'household', userId: '', month: PAST_MONTH, categoryId: String(groceries) }),
    );
    expect(state.error).toBe('Suggestions are only available for the current month.');
    expect(resolveBudget('household', null, groceries, PAST_MONTH)).toBeNull();
  });

  it('applySuggestionAction still refuses a future month', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-01' });

    const state = await applySuggestionAction(
      {},
      formData({ scope: 'household', userId: '', month: NEXT_MONTH, categoryId: String(groceries) }),
    );
    expect(state.error).toBe('Suggestions are only available for the current month.');
    expect(resolveBudget('household', null, groceries, NEXT_MONTH)).toBeNull();
  });

  it('applyAllSuggestionsAction still refuses a non-current month', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-01' });

    const state = await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: NEXT_MONTH }));
    expect(state.error).toBe('Suggestions are only available for the current month.');
    expect(resolveBudget('household', null, groceries, NEXT_MONTH)).toBeNull();
  });

  it('applyAllSuggestionsAction still refuses a past month', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-01' });

    const state = await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: PAST_MONTH }));
    expect(state.error).toBe('Suggestions are only available for the current month.');
    expect(resolveBudget('household', null, groceries, PAST_MONTH)).toBeNull();
  });
});
