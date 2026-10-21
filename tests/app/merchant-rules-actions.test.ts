import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { sql } from 'drizzle-orm';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';

let currentUser = { id: 1, name: 'Admin', username: 'admin', role: 'admin' as const };

vi.mock('@/lib/auth/session', () => ({
  requireAdmin: vi.fn(async () => currentUser),
  // v1.56.1: the Rules page's Send back item posts to the Always ask dialog's own action, which
  // asks for any signed-in, household-wide viewer.
  requireUser: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { requireAdmin } from '@/lib/auth/session';
import {
  applyRuleNowAction,
  bulkDeleteRulesAction,
  bulkSetDisabledAction,
  deleteRuleAction,
  deleteRuleAndClearAction,
  previewRerunAllAction,
  previewRuleClearAction,
  rerunAllAction,
  saveRuleAction,
  setRuleDisabledAction,
} from '@/app/(app)/settings/merchant-rules/actions';
import {
  CATEGORY_RULE_NEEDS_CATEGORY_ERROR,
  listRules,
  setAlwaysAskRule,
  setRuleDisabledFlag,
  upsertRuleFromCorrection,
} from '@/lib/categorize/rules';
import { rerunEngine, upsertRenameRule } from '@/lib/categorize/engine';
import { archiveCategory, listCategories } from '@/lib/categories';
import MerchantRulesPage from '@/app/(app)/settings/merchant-rules/page';
import { previewAlwaysAskAction, sendBackToReviewAction } from '@/app/(app)/transactions/actions';

let current: TestDb | null = null;
afterEach(() => {
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
  const userId = insertTestUser(current.db, { name: 'Admin', username: 'admin' });
  const accountId = insertTestAccount(current.db);
  currentUser = { id: userId, name: 'Admin', username: 'admin', role: 'admin' };
  /** `date` is optional and defaults to the original fixture date, so every pre-v1.24.0 caller
   *  reads exactly as it did; the date-range tests below are the reason it exists. */
  const add = (rawDescription: string, date = '2026-03-02') => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, ${date}, ${rawDescription}, ${normalizeMerchant(rawDescription)}, -1000, 'none', ${userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { db: current.db, sqlite: current.sqlite, userId, accountId, add };
}

describe('saveRuleAction', () => {
  it('creates a category rule', async () => {
    const { db, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const result = await saveRuleAction(
      {},
      formData({ pattern: 'tim hortons', matchType: 'exact', ruleKind: 'category', categoryId: String(coffee), renameTo: '' }),
    );
    expect(result.message).toBeTruthy();
    // item 9: uppercased on save, even though this admin typed it lowercase.
    expect(listRules('category')).toHaveLength(1);
    expect(listRules('category')[0]).toMatchObject({ pattern: 'TIM HORTONS', categoryId: coffee, createdBy: userId });
  });

  it('creates a rename rule and reports how many transactions it applied to', async () => {
    const { add } = setup();
    add('MCDONALDS');
    add('MCDONALDS');
    const result = await saveRuleAction(
      {},
      formData({ pattern: 'MCDONALDS', matchType: 'exact', ruleKind: 'rename', categoryId: '', renameTo: "McDonald's" }),
    );
    expect(result.message).toMatch(/applied to 2 transaction/);
  });

  it('rejects a rename rule with no display name', async () => {
    setup();
    const result = await saveRuleAction(
      {},
      formData({ pattern: 'MCDONALDS', matchType: 'exact', ruleKind: 'rename', categoryId: '', renameTo: '   ' }),
    );
    expect(result.error).toMatch(/display name/);
  });

  /**
   * v1.31.0 R-02 (P2). The Category select offers "(none)" for every kind, so "category" plus an
   * untouched select saved a rule that WON its merchant in matchRule and then had nothing to file
   * it as -- the merchant silently stopped being categorised by anything, including by the shorter
   * rule that would have. Refused here in the sentence rules.ts exports, and nowhere silently.
   */
  it('refuses a category rule with no category, and writes nothing', async () => {
    setup();
    const result = await saveRuleAction(
      {},
      formData({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: '', renameTo: '' }),
    );
    expect(result.error).toBe(CATEGORY_RULE_NEEDS_CATEGORY_ERROR);
    expect(result.message).toBeUndefined();
    expect(listRules()).toHaveLength(0);
  });

  it('still accepts the kinds whose outcome is not a category with an empty select', async () => {
    setup();
    expect(
      (await saveRuleAction({}, formData({ pattern: 'E-TRANSFER', matchType: 'contains', ruleKind: 'transfer', categoryId: '', renameTo: '' })))
        .message,
    ).toBeTruthy();
    expect(
      (await saveRuleAction({}, formData({ pattern: 'VISA PAYMENT', matchType: 'exact', ruleKind: 'not_transfer', categoryId: '', renameTo: '' })))
        .message,
    ).toBeTruthy();
    expect(listRules()).toHaveLength(2);
  });

  it('rejects an empty pattern', async () => {
    setup();
    const result = await saveRuleAction({}, formData({ pattern: '', matchType: 'exact', ruleKind: 'category', categoryId: '', renameTo: '' }));
    expect(result.error).toBeTruthy();
  });

  it('refuses a non-admin caller', async () => {
    setup();
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error('not admin'));
    await expect(
      saveRuleAction({}, formData({ pattern: 'X', matchType: 'exact', ruleKind: 'category', categoryId: '', renameTo: '' })),
    ).rejects.toThrow(/not admin/);
  });
});

describe('deleteRuleAction', () => {
  it('returns a clean error for a non-numeric ruleId', async () => {
    setup();
    const result = await deleteRuleAction({}, formData({ ruleId: 'nope' }));
    expect(result.error).toBeTruthy();
  });

  it('returns an error when the rule does not exist', async () => {
    setup();
    const result = await deleteRuleAction({}, formData({ ruleId: '999999' }));
    expect(result.error).toBeTruthy();
  });

  it('deletes a category rule', async () => {
    const { db, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const upserted = upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');
    const result = await deleteRuleAction({}, formData({ ruleId: String(upserted.ruleId) }));
    expect(result.message).toBeTruthy();
    expect(listRules().find((r) => r.id === upserted.ruleId)).toBeUndefined();
  });

  it('deleting a rename rule reports how many transactions reverted', async () => {
    const { add, userId } = setup();
    add('MCDONALDS');
    const upserted = upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');
    const result = await deleteRuleAction({}, formData({ ruleId: String(upserted.ruleId) }));
    expect(result.message).toMatch(/1 transaction went back to the bank text/);
  });
});

describe('bulkDeleteRulesAction', () => {
  it('deletes every valid id and reports the total, ignoring an already-gone one', async () => {
    const { db, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const a = upsertRuleFromCorrection({ pattern: 'AAA', matchType: 'contains', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    const b = upsertRuleFromCorrection({ pattern: 'BBB', matchType: 'contains', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    if (!a.ok || !b.ok) throw new Error('unexpected refusal');
    const result = await bulkDeleteRulesAction({}, formData({ ids: `${a.ruleId},${b.ruleId},999999` }));
    expect(result.message).toMatch(/Deleted 2 rules/);
    expect(listRules()).toHaveLength(0);
  });

  it('states the real transaction consequence of deleting rename rules, not just the rule count', async () => {
    const { add, userId } = setup();
    add('MCDONALDS');
    add('WENDYS');
    const rename1 = upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    const rename2 = upsertRenameRule({ pattern: 'WENDYS', matchType: 'exact', renameTo: "Wendy's", userId, actorRole: 'admin' });
    if (!rename1.ok || !rename2.ok) throw new Error('unexpected refusal');
    const result = await bulkDeleteRulesAction({}, formData({ ids: `${rename1.ruleId},${rename2.ruleId}` }));
    expect(result.message).toMatch(/Deleted 2 rules/);
    expect(result.message).toMatch(/2 transactions went back to the bank text/);
  });

  it('errors on an empty selection', async () => {
    setup();
    const result = await bulkDeleteRulesAction({}, formData({ ids: '' }));
    expect(result.error).toBeTruthy();
  });
});

describe('setRuleDisabledAction / bulkSetDisabledAction (item 11)', () => {
  it('disabling a rename rule reports how many rows reverted', async () => {
    const { add, userId } = setup();
    add('MCDONALDS');
    const upserted = upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');
    const result = await setRuleDisabledAction({}, formData({ ruleId: String(upserted.ruleId), disabled: '1' }));
    expect(result.message).toMatch(/Rule disabled\..*1 transaction went back to the bank text/);
    expect(listRules('rename')[0].disabledAt).not.toBeNull();
  });

  it('re-enabling restores the rows', async () => {
    const { add, userId } = setup();
    add('MCDONALDS');
    const upserted = upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');
    await setRuleDisabledAction({}, formData({ ruleId: String(upserted.ruleId), disabled: '1' }));
    const result = await setRuleDisabledAction({}, formData({ ruleId: String(upserted.ruleId), disabled: '0' }));
    expect(result.message).toMatch(/Rule enabled\..*1 transaction restored/);
  });

  it('bulk-disables several rules at once', async () => {
    const { db, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const a = upsertRuleFromCorrection({ pattern: 'AAA', matchType: 'contains', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    const b = upsertRuleFromCorrection({ pattern: 'BBB', matchType: 'contains', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    if (!a.ok || !b.ok) throw new Error('unexpected refusal');
    const result = await bulkSetDisabledAction({}, formData({ ids: `${a.ruleId},${b.ruleId}`, disabled: '1' }));
    expect(result.message).toMatch(/Disabled 2 rules/);
    expect(listRules().every((r) => r.disabledAt !== null)).toBe(true);
  });
});

describe('applyRuleNowAction (item 11: per-rule Apply now)', () => {
  it('applies the rule and reports what actually changed', async () => {
    const { db, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add('TIM HORTONS');
    const upserted = upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');

    const result = await applyRuleNowAction({}, formData({ ruleId: String(upserted.ruleId) }));
    expect(result.message).toMatch(/Applied: 1 of 1 eligible transaction changed/);
    const row = current!.sqlite.prepare('select category_id from transactions where id = ?').get(id) as { category_id: number | null };
    expect(row.category_id).toBe(coffee);
  });

  it('reports nothing to do when no transaction matches', async () => {
    const { db, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const upserted = upsertRuleFromCorrection({ pattern: 'NOBODY SHOPS HERE', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');
    const result = await applyRuleNowAction({}, formData({ ruleId: String(upserted.ruleId) }));
    expect(result.message).toMatch(/Nothing to apply/);
  });
});

describe('previewRerunAllAction / rerunAllAction (item 11: global Re-run rules)', () => {
  it('previews, then really changes, the same eligible rows', async () => {
    const { db, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    add('TIM HORTONS');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });

    const preview = await previewRerunAllAction();
    expect(preview).toEqual({ eligible: 1, wouldChange: 1 });

    const result = await rerunAllAction({}, new FormData());
    expect(result.message).toMatch(/Re-ran the rules: 1 of 1 eligible transaction changed/);
  });

  it('reports nothing to re-run when the queue is empty', async () => {
    setup();
    const result = await rerunAllAction({}, new FormData());
    expect(result.message).toMatch(/Nothing to re-run/);
  });

  it('never touches a manually-categorized row', async () => {
    const { db, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    const id = add('TIM HORTONS');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual' where id = ${id}`);
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });

    const preview = await previewRerunAllAction();
    expect(preview).toEqual({ eligible: 0, wouldChange: 0 });
    await rerunAllAction({}, new FormData());
    const row = current!.sqlite.prepare('select category_id from transactions where id = ?').get(id) as { category_id: number | null };
    expect(row.category_id).toBe(groceries);
  });
});

/**
 * v1.24.0 (the ask: deleting a rule should also un-apply it from transactions, for all date
 * ranges or one the user chooses). The order these two do their work in is the part worth pinning: attribution is
 * DERIVED (no rule id is stored on a transaction), so the rule has to still exist while the rows
 * are being resolved. Deleting first would clear nothing at all and still report success.
 */
describe('previewRuleClearAction (v1.24.0: the count the dialog states)', () => {
  it('reports the rows a clear would touch, and the rule kind, for the whole history', async () => {
    const { db, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    add('TIM HORTONS', '2026-01-15');
    add('TIM HORTONS', '2026-03-31');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    rerunEngine();
    const ruleId = listRules('category')[0].id;

    expect(await previewRuleClearAction(ruleId, null, null)).toEqual({ affected: 2, kind: 'category' });
    expect(await previewRuleClearAction(ruleId, '2026-02-01', null)).toEqual({ affected: 1, kind: 'category' });
    expect(await previewRuleClearAction(ruleId, '2026-01-15', '2026-01-15')).toEqual({ affected: 1, kind: 'category' });
  });

  it('reports the backwards range instead of a zero that looks like "nothing to do"', async () => {
    const { db, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    const result = await previewRuleClearAction(listRules('category')[0].id, '2026-03-31', '2026-01-01');
    expect(result.error).toMatch(/ends before it starts/);
    expect(result.affected).toBe(0);
  });

  it('says so when the rule is already gone', async () => {
    setup();
    expect(await previewRuleClearAction(999999, null, null)).toMatchObject({ affected: 0, kind: null });
  });

  it('refuses a non-admin caller', async () => {
    setup();
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error('not admin'));
    await expect(previewRuleClearAction(1, null, null)).rejects.toThrow(/not admin/);
  });
});

describe('deleteRuleAndClearAction (v1.24.0)', () => {
  it('clears the rows FIRST and then deletes the rule, reporting the real transaction count', async () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const a = add('TIM HORTONS', '2026-01-15');
    const b = add('TIM HORTONS', '2026-03-31');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    rerunEngine();
    const ruleId = listRules('category')[0].id;
    const read = (id: number) =>
      sqlite.prepare('select category_id, categorization_source from transactions where id = ?').get(id) as {
        category_id: number | null;
        categorization_source: string;
      };
    expect(read(a).category_id).toBe(coffee);

    const result = await deleteRuleAndClearAction({}, formData({ ruleId: String(ruleId), from: '', to: '' }));
    expect(result.message).toMatch(/cleared from 2 transactions/);
    expect(result.message).toMatch(/back in Needs review/);
    expect(read(a)).toMatchObject({ category_id: null, categorization_source: 'none' });
    expect(read(b)).toMatchObject({ category_id: null, categorization_source: 'none' });
    expect(listRules().find((r) => r.id === ruleId)).toBeUndefined();
  });

  it('clears the one row a rule filed after its category was archived, then deletes the rule', async () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const a = add('TIM HORTONS', '2026-01-15');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    rerunEngine();
    const ruleId = listRules('category')[0].id;
    archiveCategory(coffee, true);

    const result = await deleteRuleAndClearAction({}, formData({ ruleId: String(ruleId), from: '', to: '' }));
    expect(result.message).toMatch(/cleared from 1 transaction/);
    const row = sqlite.prepare('select category_id from transactions where id = ?').get(a) as { category_id: number | null };
    expect(row.category_id).toBeNull();
    expect(listRules().find((r) => r.id === ruleId)).toBeUndefined();
  });

  it('honours a date range and says which range it acted on', async () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const jan = add('TIM HORTONS', '2026-01-15');
    const mar = add('TIM HORTONS', '2026-03-31');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    rerunEngine();
    const ruleId = listRules('category')[0].id;

    const result = await deleteRuleAndClearAction({}, formData({ ruleId: String(ruleId), from: '2026-03-01', to: '2026-03-31' }));
    expect(result.message).toMatch(/cleared from 1 transaction between 2026-03-01 and 2026-03-31/);
    const read = (id: number) => sqlite.prepare('select category_id from transactions where id = ?').get(id) as { category_id: number | null };
    expect(read(mar).category_id).toBeNull();
    expect(read(jan).category_id).toBe(coffee);
  });

  it('a rename rule ignores the supplied dates and reverts every row', async () => {
    const { sqlite, add, userId } = setup();
    const jan = add('MCDONALDS', '2026-01-05');
    const mar = add('MCDONALDS', '2026-03-05');
    const upserted = upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');

    const result = await deleteRuleAndClearAction({}, formData({ ruleId: String(upserted.ruleId), from: '2026-03-01', to: '2026-03-31' }));
    expect(result.message).toMatch(/2 transactions went back to the bank text/);
    const display = (id: number) =>
      sqlite.prepare('select display_description from transactions where id = ?').get(id) as { display_description: string | null };
    expect(display(jan).display_description).toBeNull();
    expect(display(mar).display_description).toBeNull();
    expect(listRules('rename')).toHaveLength(0);
  });

  it('rejects a backwards range with a sentence, and changes nothing', async () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add('TIM HORTONS', '2026-01-15');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    rerunEngine();
    const ruleId = listRules('category')[0].id;

    const result = await deleteRuleAndClearAction({}, formData({ ruleId: String(ruleId), from: '2026-03-31', to: '2026-01-01' }));
    expect(result.error).toMatch(/ends before it starts/);
    expect(listRules().find((r) => r.id === ruleId)).toBeDefined();
    const row = sqlite.prepare('select category_id from transactions where id = ?').get(id) as { category_id: number | null };
    expect(row.category_id).toBe(coffee);
  });

  it('rejects a malformed date', async () => {
    const { db, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    const result = await deleteRuleAndClearAction({}, formData({ ruleId: String(listRules('category')[0].id), from: 'last tuesday', to: '' }));
    expect(result.error).toMatch(/YYYY-MM-DD/);
  });

  it('refuses to clear a not-a-transfer override -- that would re-flag money as transfers', async () => {
    const { sqlite, add, userId } = setup();
    const id = add('PAYMENT - THANK YOU', '2026-02-02');
    rerunEngine();
    const upserted = upsertRuleFromCorrection({ pattern: 'PAYMENT - THANK YOU', matchType: 'exact', ruleKind: 'not_transfer', categoryId: null, createdBy: userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');

    const result = await deleteRuleAndClearAction({}, formData({ ruleId: String(upserted.ruleId), from: '', to: '' }));
    expect(result.error).toMatch(/can only be deleted/);
    expect(listRules().find((r) => r.id === upserted.ruleId)).toBeDefined();
    const row = sqlite.prepare('select is_transfer from transactions where id = ?').get(id) as { is_transfer: number };
    expect(row.is_transfer).toBe(1);
  });

  it('errors cleanly when the rule is already gone', async () => {
    setup();
    const result = await deleteRuleAndClearAction({}, formData({ ruleId: '999999', from: '', to: '' }));
    expect(result.error).toMatch(/no longer exists/);
  });

  it('refuses a non-admin caller', async () => {
    setup();
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error('not admin'));
    await expect(deleteRuleAndClearAction({}, formData({ ruleId: '1', from: '', to: '' }))).rejects.toThrow(/not admin/);
  });

  it('leaves deleteRuleAction as the delete-only path: a category rule keeps its rows exactly as they were', async () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add('TIM HORTONS', '2026-01-15');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    rerunEngine();
    const ruleId = listRules('category')[0].id;

    const result = await deleteRuleAction({}, formData({ ruleId: String(ruleId) }));
    expect(result.message).toBe('Rule deleted.');
    const row = sqlite.prepare('select category_id from transactions where id = ?').get(id) as { category_id: number | null };
    expect(row.category_id).toBe(coffee);
  });
});

describe('previewRerunAllAction / rerunAllAction take a date range too (v1.24.0)', () => {
  it('previews and runs only the rows in range, and names the range in its message', async () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const jan = add('TIM HORTONS', '2026-01-15');
    const mar = add('TIM HORTONS', '2026-03-31');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });

    expect(await previewRerunAllAction()).toEqual({ eligible: 2, wouldChange: 2 });
    expect(await previewRerunAllAction('2026-03-01', null)).toEqual({ eligible: 1, wouldChange: 1 });

    const result = await rerunAllAction({}, formData({ from: '2026-03-01', to: '2026-03-31' }));
    expect(result.message).toMatch(/Re-ran the rules between 2026-03-01 and 2026-03-31: 1 of 1 eligible transaction changed/);
    const read = (id: number) => sqlite.prepare('select category_id from transactions where id = ?').get(id) as { category_id: number | null };
    expect(read(mar).category_id).toBe(coffee);
    expect(read(jan).category_id).toBeNull();
  });

  it('rejects a backwards range rather than running over nothing', async () => {
    setup();
    const result = await rerunAllAction({}, formData({ from: '2026-03-31', to: '2026-01-01' }));
    expect(result.error).toMatch(/ends before it starts/);
  });
});

/**
 * v1.31.0 review finding R-08 (P3). "A rename revert ignores the date range" was written FOUR
 * times: twice in this file (previewRuleClearAction and deleteRuleAndClearAction each dropped the
 * scope themselves) and twice in the engine, which enforces it in both the count and the write.
 * The two copies here are gone; the engine is the single authority.
 *
 * The property that has to survive is the one the deleted comment claimed -- "the preview must
 * count what the write will really touch" -- so it is asserted directly instead of restated.
 */
describe('v1.31.0 R-08: the engine alone decides that a rename revert ignores the date range', () => {
  it('the preview count and the write agree for a rename, with a range that excludes its rows', async () => {
    const { userId, add } = setup();
    // Both rows are dated 2026-03-02; the range below asks for January only, so a scope that was
    // honoured would count and clear nothing.
    const a = add('WALMART SUPERCENTRE #1');
    const b = add('WALMART SUPERCENTRE #2');
    upsertRenameRule({ pattern: 'WALMART', matchType: 'contains', renameTo: 'Walmart', userId, actorRole: 'admin' });
    const ruleId = listRules('rename')[0].id;

    const preview = await previewRuleClearAction(ruleId, '2026-01-01', '2026-01-31');
    expect({ affected: preview.affected, kind: preview.kind }).toEqual({ affected: 2, kind: 'rename' });

    const result = await deleteRuleAndClearAction(
      {},
      formData({ ruleId: String(ruleId), from: '2026-01-01', to: '2026-01-31' }),
    );
    expect(result.message).toMatch(/2 transactions went back to the bank text/);
    for (const id of [a, b]) {
      const row = current!.sqlite.prepare('select display_source from transactions where id = ?').get(id) as {
        display_source: string | null;
      };
      expect(row.display_source).toBeNull();
    }
  });

  it('still honours the range for a category rule, where a bounded clear IS supported', async () => {
    const { db, userId, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const inRange = add('TIM HORTONS #1', '2026-01-15');
    const outOfRange = add('TIM HORTONS #2', '2026-03-02');
    upsertRuleFromCorrection({
      pattern: 'TIM HORTONS',
      matchType: 'contains',
      ruleKind: 'category',
      categoryId: coffee,
      createdBy: userId,
      actorRole: 'admin',
    });
    const ruleId = listRules('category').find((rule) => rule.pattern === 'TIM HORTONS')!.id;
    rerunEngine();

    const preview = await previewRuleClearAction(ruleId, '2026-01-01', '2026-01-31');
    expect(preview.affected).toBe(1);
    await deleteRuleAndClearAction({}, formData({ ruleId: String(ruleId), from: '2026-01-01', to: '2026-01-31' }));

    const read = (id: number) =>
      (current!.sqlite.prepare('select category_id from transactions where id = ?').get(id) as { category_id: number | null }).category_id;
    expect(read(inRange)).toBeNull();
    expect(read(outOfRange)).toBe(coffee);
  });
});

/**
 * v1.31.0 review finding R-13 (P3), save half. `categoryId` arrived as `z.string()` and went
 * straight into `Number(...)`: no existence check and no archived check. A nonexistent id reached
 * a column with `foreign_keys = ON` behind it, so SQLite raised a constraint error, nothing caught
 * it, and a form submission answered 500. An archived id was accepted outright, and a rule filing
 * money into a retired category files it where no spend report shows it.
 */
describe('v1.31.0 R-13: saveRuleAction validates the category it is handed', () => {
  it('refuses an id no category has, in words, and writes nothing', async () => {
    const { db } = setup();
    const highest = Math.max(...listCategories({ includeArchived: true }).map((row) => row.id));
    const result = await saveRuleAction(
      {},
      formData({ pattern: 'GHOST CAFE', matchType: 'exact', ruleKind: 'category', categoryId: String(highest + 500), renameTo: '' }),
    );
    expect(result.error).toMatch(/no longer exists/);
    expect(listRules().some((rule) => rule.pattern === 'GHOST CAFE')).toBe(false);
    expect(db).toBeDefined();
  });

  it('refuses a non-numeric id rather than writing NaN into the column', async () => {
    setup();
    const result = await saveRuleAction(
      {},
      formData({ pattern: 'GHOST CAFE', matchType: 'exact', ruleKind: 'category', categoryId: 'abc', renameTo: '' }),
    );
    expect(result.error).toBe('Invalid rule.');
    expect(listRules()).toEqual([]);
  });

  it('refuses an ARCHIVED category and names it', async () => {
    const { db } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    archiveCategory(coffee, true);

    const result = await saveRuleAction(
      {},
      formData({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: String(coffee), renameTo: '' }),
    );
    expect(result.error).toMatch(/"Coffee" is archived/);
    expect(result.error).toMatch(/Pick a live category/);
    expect(listRules()).toEqual([]);
  });

  it('saves a live category over an archived one on edit', async () => {
    const { db, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    const upserted = upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');
    archiveCategory(coffee, true);

    const result = await saveRuleAction(
      {},
      formData({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: String(groceries), renameTo: '', fromRuleId: String(upserted.ruleId) }),
    );
    expect(result.message).toBe('Rule saved.');
    expect(listRules()).toHaveLength(1);
    expect(listRules()[0].categoryId).toBe(groceries);
  });

  it('still accepts a live category, and still accepts "(none)" for a kind that has none', async () => {
    const { db } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    expect(
      (
        await saveRuleAction(
          {},
          formData({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: String(coffee), renameTo: '' }),
        )
      ).message,
    ).toBe('Rule saved.');
    expect(
      (
        await saveRuleAction(
          {},
          formData({ pattern: 'E-TRANSFER', matchType: 'contains', ruleKind: 'transfer', categoryId: '', renameTo: '' }),
        )
      ).message,
    ).toBe('Rule saved.');
    expect(listRules().map((rule) => rule.pattern).sort()).toEqual(['E-TRANSFER', 'TIM HORTONS']);
  });

  it('still gives the R-02 sentence for a category rule with no category, not this one', async () => {
    setup();
    const result = await saveRuleAction(
      {},
      formData({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: '', renameTo: '' }),
    );
    expect(result.error).toBe(CATEGORY_RULE_NEEDS_CATEGORY_ERROR);
  });
});

/**
 * v1.56.1 (v1.56.0 review M-3). Rows a rule or a guess filed before an Always ask rule existed --
 * including rows a category rule it now shadows filed -- can go back to review from the rule's row on
 * this page, through the dialog's own action. N is read from the props the page hands its client.
 */
describe('Send matching rows back to review, from an Always ask rule on the Rules page', () => {
  async function sendBackCountOnPage(ruleId: number): Promise<number | undefined> {
    const element = await MerchantRulesPage({ searchParams: Promise.resolve({ kind: 'always_ask' }) });
    return (element.props as { sendBackCounts: Record<number, number> }).sendBackCounts[ruleId];
  }
  const state = (id: number) =>
    current!.sqlite.prepare('select category_id, categorization_source from transactions where id = ?').get(id) as {
      category_id: number | null;
      categorization_source: string;
    };

  it('N on the row is exactly the rule- and guess-filed rows the action resets; hand-set and split rows stay', async () => {
    const { db, sqlite, userId, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    // A category rule files a row, then an Always ask rule on wider text shadows that rule.
    const shadowed = upsertRuleFromCorrection({ pattern: 'E-TRANSFER ***KD4', matchType: 'exact', ruleKind: 'category', categoryId: groceries, createdBy: userId, actorRole: 'admin' });
    if (!shadowed.ok) throw new Error('refused');
    const byRule = add('E-TRANSFER ***KD4');
    rerunEngine();
    expect(state(byRule)).toEqual({ category_id: groceries, categorization_source: 'rule' });
    const byGuess = add('E-TRANSFER ***PW2');
    const byHand = add('E-TRANSFER ***PW2');
    const splitRow = add('E-TRANSFER ***KD4');
    const other = add('CEDAR BAKERY');
    const file = sqlite.prepare('update transactions set categorization_source = ?, category_id = ? where id = ?');
    file.run('bayes', groceries, byGuess);
    file.run('manual', coffee, byHand);
    file.run('rule', groceries, splitRow);
    file.run('rule', coffee, other);
    const part = sqlite.prepare('insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (?, ?, ?, ?)');
    part.run(splitRow, groceries, -600, nowIso());
    part.run(splitRow, coffee, -400, nowIso());
    const ask = setAlwaysAskRule({ pattern: 'E-TRANSFER', matchType: 'contains', userId, actorRole: 'admin' });
    if (!ask.ok) throw new Error('refused');

    expect(await sendBackCountOnPage(ask.ruleId)).toBe(2);
    expect(await sendBackToReviewAction({}, formData({ ruleId: String(ask.ruleId) }))).toEqual({ message: 'Sent 2 transactions back to review.' });
    expect(state(byRule)).toEqual({ category_id: null, categorization_source: 'none' });
    expect(state(byGuess)).toEqual({ category_id: null, categorization_source: 'none' });
    expect(state(byHand)).toEqual({ category_id: coffee, categorization_source: 'manual' });
    expect(state(splitRow)).toEqual({ category_id: groceries, categorization_source: 'rule' });
    expect(state(other)).toEqual({ category_id: coffee, categorization_source: 'rule' });
    expect(await sendBackCountOnPage(ask.ruleId)).toBe(0);
  });

  it('a disabled Always ask rule offers nothing', async () => {
    const { db, sqlite, userId, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const id = add('E-TRANSFER ***KD4');
    sqlite.prepare('update transactions set categorization_source = ?, category_id = ? where id = ?').run('rule', groceries, id);
    const ask = setAlwaysAskRule({ pattern: 'E-TRANSFER', matchType: 'contains', userId, actorRole: 'admin' });
    if (!ask.ok) throw new Error('refused');
    setRuleDisabledFlag(ask.ruleId, true);
    expect(await sendBackCountOnPage(ask.ruleId) ?? 0).toBe(0);
  });
});

/** v1.56.1 (v1.56.0 review M-4). The dialog's "Matches N" and the Rules page's Affects are one number. */
describe('Matches N: the Always ask dialog and the Rules page agree', () => {
  it('two overlapping Always ask rules show the same number in the dialog and in Affects', async () => {
    const { userId, add } = setup();
    add('E-TRANSFER ***AB1');
    add('E-TRANSFER ***AB1');
    add('E-TRANSFER ***QX7');
    add('CEDAR BAKERY');
    const wide = setAlwaysAskRule({ pattern: 'E-TRANSFER', matchType: 'contains', userId, actorRole: 'admin' });
    const narrow = setAlwaysAskRule({ pattern: 'E-TRANSFER ***AB1', matchType: 'exact', userId, actorRole: 'admin' });
    if (!wide.ok || !narrow.ok) throw new Error('refused');
    const element = await MerchantRulesPage({ searchParams: Promise.resolve({ kind: 'always_ask' }) });
    const affects = (element.props as { impactCounts: Record<number, number> }).impactCounts;
    const dialog = async (pattern: string, matchType: string) => (await previewAlwaysAskAction({}, formData({ pattern, matchType }))).message;
    expect(await dialog('E-TRANSFER', 'contains')).toBe(`Matches ${affects[wide.ruleId]} transactions.`);
    expect(await dialog('E-TRANSFER ***AB1', 'exact')).toBe(`Matches ${affects[narrow.ruleId]} transactions.`);
    expect([affects[wide.ruleId], affects[narrow.ruleId]]).toEqual([3, 2]);
  });
});
