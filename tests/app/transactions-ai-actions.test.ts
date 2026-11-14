import { describe, it, expect, vi, afterEach } from 'vitest';
import { archiveCategory } from '@/lib/categories';
import { listRules, ruleOwnedError } from '@/lib/categorize/rules';
import { ALWAYS_ASK_NO_RULE } from '@/lib/categorize/engine';
import { CROSS_ORIGIN_ERROR } from '@/lib/auth/csrf';
import { NOT_YOURS_ERROR } from '@/lib/auth/viewer';
import { aiSuggestionFor, recordMerchantSuggestion } from '@/lib/ai/suggestions';
import { buildAiFixture, type AiFixture } from '../helpers/ai-fixture';

/** v1.64.0 (plan 2026-11-12, lane C1). Invented household, March 2026, no model anywhere. */
const user = vi.hoisted(() => ({
  value: { id: 0, name: 'Alex', username: 'alex', role: 'admin' as 'admin' | 'member', visibility: 'household' as 'household' | 'self' },
}));
const sameOrigin = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/auth/session', () => ({ requireUser: vi.fn(async () => user.value) }));
vi.mock('next/headers', () => ({
  headers: async () =>
    sameOrigin.value
      ? new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' })
      : new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { acceptAiSuggestionAction, ignoreAiSuggestionAction } from '@/app/(app)/transactions/ai-actions';
import { setCategoryAction } from '@/app/(app)/transactions/actions';

const AT = new Date('2026-03-10T09:00:00.000Z');
let fx: AiFixture | null = null;
afterEach(() => {
  sameOrigin.value = true;
  fx?.t.cleanup();
  fx = null;
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function setup(): AiFixture {
  fx = buildAiFixture();
  user.value = { id: fx.alex, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
  recordMerchantSuggestion({ merchant: 'MAPLE GROCER', categoryId: fx.groceries, cleanName: 'Maple Grocer', model: 'test-model:1b', at: AT });
  return fx;
}

const rowState = (id: number) =>
  fx!.t.sqlite
    .prepare(
      'select category_id as category, categorization_source as source, display_description as name, display_source as nameSource from transactions where id = ?',
    )
    .get(id) as { category: number | null; source: string; name: string | null; nameSource: string | null };

const rulesOf = (kind: 'category' | 'rename') =>
  listRules(kind).map((rule) => ({ pattern: rule.pattern, matchType: rule.matchType, categoryId: rule.categoryId, renameTo: rule.renameTo }));

describe('acceptAiSuggestionAction', () => {
  it('files the row manual with one exact rule when remembered, the same as setCategoryAction with teach', async () => {
    const f = setup();
    const result = await acceptAiSuggestionAction({}, form({ transactionId: String(f.rows.mapleNewest), part: 'category', remember: '1' }));
    expect(result.error).toBeUndefined();
    const viaAi = { row: rowState(f.rows.mapleNewest), rules: rulesOf('category'), message: result.message };
    expect(viaAi.row).toMatchObject({ category: f.groceries, source: 'manual' });
    expect(viaAi.rules).toEqual([{ pattern: 'MAPLE GROCER', matchType: 'exact', categoryId: f.groceries, renameTo: null }]);

    fx!.t.cleanup();
    const g = setup();
    const direct = await setCategoryAction({}, form({ transactionId: String(g.rows.mapleNewest), categoryId: String(g.groceries), teach: '1' }));
    expect({ row: rowState(g.rows.mapleNewest), rules: rulesOf('category'), message: direct.message }).toEqual(viaAi);
  });

  it('files the row and writes no rule without Remember', async () => {
    const f = setup();
    const result = await acceptAiSuggestionAction({}, form({ transactionId: String(f.rows.mapleOld), part: 'category' }));
    expect(result.error).toBeUndefined();
    expect(rowState(f.rows.mapleOld)).toMatchObject({ category: f.groceries, source: 'manual' });
    expect(rulesOf('category')).toEqual([]);
  });

  it('renames one row (display source manual) or writes a rename rule when remembered', async () => {
    const f = setup();
    const one = await acceptAiSuggestionAction({}, form({ transactionId: String(f.rows.mapleOld), part: 'name' }));
    expect(one.message).toBe('Renamed this transaction only.');
    expect(rowState(f.rows.mapleOld)).toMatchObject({ name: 'Maple Grocer', nameSource: 'manual' });
    expect(rulesOf('rename')).toEqual([]);

    const all = await acceptAiSuggestionAction({}, form({ transactionId: String(f.rows.mapleNewest), part: 'name', remember: '1' }));
    expect(all.error).toBeUndefined();
    expect(rulesOf('rename')).toEqual([{ pattern: 'MAPLE GROCER', matchType: 'exact', categoryId: null, renameTo: 'Maple Grocer' }]);
    expect(rowState(f.rows.mapleNewest).name).toBe('Maple Grocer');
  });

  it('refuses a self viewer, a row filed meanwhile, an archived category and an ignored suggestion', async () => {
    const f = setup();
    const fields = { transactionId: String(f.rows.mapleOld), part: 'category', remember: '1' };

    user.value = { ...user.value, id: f.sam, name: 'Sam', username: 'sam', role: 'member', visibility: 'self' };
    expect((await acceptAiSuggestionAction({}, form(fields))).error).toBe('Review is not available on this account.');
    user.value = { id: f.alex, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };

    f.t.sqlite.prepare('update transactions set category_id = ?, categorization_source = ? where id = ?').run(f.gas, 'manual', f.rows.mapleOld);
    expect((await acceptAiSuggestionAction({}, form(fields))).error).toBe('This row was filed meanwhile; nothing changed.');
    expect(rowState(f.rows.mapleOld).category).toBe(f.gas);

    archiveCategory(f.groceries, true);
    expect((await acceptAiSuggestionAction({}, form({ ...fields, transactionId: String(f.rows.mapleNewest) }))).error).toBe(
      'That suggested category is archived now, so it cannot be used.',
    );
    expect(rowState(f.rows.mapleNewest).category).toBeNull();
    expect(rulesOf('category')).toEqual([]);

    f.t.sqlite.prepare("update ai_suggestions set status = 'ignored' where normalized_merchant = 'MAPLE GROCER'").run();
    expect((await acceptAiSuggestionAction({}, form({ ...fields, transactionId: String(f.rows.mapleNoted) }))).error).toBe(
      'That suggestion is no longer available.',
    );
  });

  it('refuses a cross-origin post and a row that is not the viewers', async () => {
    const f = setup();
    sameOrigin.value = false;
    expect((await acceptAiSuggestionAction({}, form({ transactionId: String(f.rows.mapleOld), part: 'category' }))).error).toBe(CROSS_ORIGIN_ERROR);
    sameOrigin.value = true;
    expect((await acceptAiSuggestionAction({}, form({ transactionId: '999999', part: 'category' }))).error).toBe(NOT_YOURS_ERROR);
    expect(rowState(f.rows.mapleOld).category).toBeNull();
  });

  it('files an Always ask merchant row, writes no rule and returns the note', async () => {
    const f = setup();
    recordMerchantSuggestion({ merchant: 'CORNER STORE', categoryId: f.groceries, cleanName: null, model: 'test-model:1b', at: AT });
    const result = await acceptAiSuggestionAction({}, form({ transactionId: String(f.rows.corner), part: 'category', remember: '1' }));
    expect(result.message).toContain(ALWAYS_ASK_NO_RULE);
    expect(rowState(f.rows.corner)).toMatchObject({ category: f.groceries, source: 'manual' });
    expect(rulesOf('category')).toEqual([]);
  });

  it('gives another member rule sentence and changes nothing', async () => {
    const f = setup();
    f.t.sqlite
      .prepare(
        `insert into merchant_rules (pattern, match_type, rule_kind, category_id, created_by, created_at) values ('MAPLE GROCER', 'exact', 'category', ?, ?, '2026-03-01T00:00:00.000Z')`,
      )
      .run(f.gas, f.alex);
    user.value = { id: f.sam, name: 'Sam', username: 'sam', role: 'member', visibility: 'household' };
    const result = await acceptAiSuggestionAction({}, form({ transactionId: String(f.rows.mapleOld), part: 'category', remember: '1' }));
    expect(result.error).toBe(ruleOwnedError('Alex'));
    expect(rowState(f.rows.mapleOld).category).toBeNull();
    expect(rulesOf('category')).toEqual([{ pattern: 'MAPLE GROCER', matchType: 'exact', categoryId: f.gas, renameTo: null }]);
  });
});

describe('ignoreAiSuggestionAction', () => {
  it('marks the merchant ignored and says so', async () => {
    setup();
    const result = await ignoreAiSuggestionAction({}, form({ merchant: 'MAPLE GROCER' }));
    expect(result).toEqual({ message: 'Ignored. No more AI suggestions for MAPLE GROCER.' });
    expect(aiSuggestionFor('MAPLE GROCER')?.status).toBe('ignored');
  });

  it('refuses a self viewer, a cross-origin post and a merchant with no suggestion', async () => {
    const f = setup();
    sameOrigin.value = false;
    expect((await ignoreAiSuggestionAction({}, form({ merchant: 'MAPLE GROCER' }))).error).toBe(CROSS_ORIGIN_ERROR);
    sameOrigin.value = true;
    expect((await ignoreAiSuggestionAction({}, form({ merchant: 'FUEL STOP 12' }))).error).toBe('That suggestion is no longer available.');
    user.value = { ...user.value, id: f.sam, role: 'member', visibility: 'self' };
    expect((await ignoreAiSuggestionAction({}, form({ merchant: 'MAPLE GROCER' }))).error).toBe('Review is not available on this account.');
    expect(aiSuggestionFor('MAPLE GROCER')?.status).toBe('suggested');
  });
});
