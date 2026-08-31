import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { sql } from 'drizzle-orm';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';

let currentUser = { id: 1, name: 'Admin', username: 'admin', role: 'admin' as const };

vi.mock('@/lib/auth/session', () => ({
  requireAdmin: vi.fn(async () => currentUser),
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
  previewRerunAllAction,
  rerunAllAction,
  saveRuleAction,
  setRuleDisabledAction,
} from '@/app/(app)/settings/merchant-rules/actions';
import { listRules, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { upsertRenameRule } from '@/lib/categorize/engine';

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
  const add = (rawDescription: string) => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', ${rawDescription}, ${normalizeMerchant(rawDescription)}, -1000, 'none', ${userId}, ${nowIso()}, ${nowIso()})
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
