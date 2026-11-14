import { describe, it, expect, afterEach } from 'vitest';
import type { Viewer } from '@/lib/auth/viewer';
import { archiveCategory } from '@/lib/categories';
import {
  aiMerchantTargets,
  aiSuggestionCounts,
  aiSuggestionFor,
  aiSuggestionsForMerchants,
  clearFailedAiSuggestions,
  forgetAiSuggestions,
  ignoreAiSuggestion,
  merchantPromptRow,
  recordMerchantFailure,
  recordMerchantSuggestion,
} from '@/lib/ai/suggestions';
import { buildAiFixture, type AiFixture } from '../../helpers/ai-fixture';

/** v1.64.0 (plan 2026-11-12, A7 and L8). March 2026. */
const AT = new Date('2026-03-10T09:00:00.000Z');
const MODEL = 'test-model:1b';

let fx: AiFixture | null = null;
afterEach(() => {
  fx?.t.cleanup();
  fx = null;
});

const household = (id: number): Viewer => ({ id, role: 'admin', visibility: 'household' });

describe('which merchants are asked about', () => {
  it('is MAPLE GROCER only: not a guess, a rule, a transfer, a split, a blank merchant or Always ask', () => {
    fx = buildAiFixture();
    expect(aiMerchantTargets(100)).toEqual(['MAPLE GROCER']);
    expect(aiSuggestionCounts()).toEqual({ suggested: 0, ignored: 0, failed: 0, toAsk: 1 });
  });

  it('drops a merchant once it has a row of any status', () => {
    for (const write of [
      () => recordMerchantSuggestion({ merchant: 'MAPLE GROCER', categoryId: null, cleanName: 'Maple Grocer', model: MODEL, at: AT }),
      () => recordMerchantFailure({ merchant: 'MAPLE GROCER', model: MODEL, reason: 'x', at: AT }),
    ]) {
      fx = buildAiFixture();
      write();
      expect(aiMerchantTargets(100)).toEqual([]);
      expect(merchantPromptRow('MAPLE GROCER')).toBeNull();
      fx.t.cleanup();
      fx = null;
    }
  });

  it('puts most rows first, then the newest, and honours the limit', () => {
    fx = buildAiFixture();
    const insert = fx.t.sqlite.prepare(
      `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, '2026-03-10T12:00:00.000Z', '2026-03-10T12:00:00.000Z')`,
    );
    insert.run(fx.joint, '2026-03-01', 'PIZZA PLACE', 'PIZZA PLACE', -2400, fx.alex);
    insert.run(fx.joint, '2026-03-11', 'BOOK NOOK', 'BOOK NOOK', -1500, fx.alex);
    expect(aiMerchantTargets(100)).toEqual(['MAPLE GROCER', 'BOOK NOOK', 'PIZZA PLACE']);
    expect(aiMerchantTargets(2)).toEqual(['MAPLE GROCER', 'BOOK NOOK']);
    expect(aiMerchantTargets(0)).toEqual([]);
  });

  it('the prompt row is the newest MAPLE GROCER row, and only its description, amount and date', () => {
    fx = buildAiFixture();
    expect(merchantPromptRow('MAPLE GROCER')).toEqual({ rawDescription: 'MAPLE GROCER 0042', amountCents: -4217, date: '2026-03-09' });
    expect(merchantPromptRow('FUEL STOP 12')).toBeNull();
    expect(merchantPromptRow('CORNER STORE')).toBeNull();
    expect(merchantPromptRow('')).toBeNull();
  });

  it('a row filed meanwhile leaves the merchant with no prompt row', () => {
    fx = buildAiFixture();
    fx.t.sqlite.prepare("update transactions set category_id = ?, categorization_source = 'manual' where normalized_merchant = 'MAPLE GROCER'").run(fx.groceries);
    expect(merchantPromptRow('MAPLE GROCER')).toBeNull();
    expect(aiMerchantTargets(100)).toEqual([]);
  });
});

describe('reading suggestions for Review', () => {
  it('gives suggested rows to a household viewer and nothing to a self viewer', () => {
    fx = buildAiFixture();
    recordMerchantSuggestion({ merchant: 'MAPLE GROCER', categoryId: fx.groceries, cleanName: 'Maple Grocer', model: MODEL, at: AT });
    expect(aiSuggestionsForMerchants(['MAPLE GROCER', 'FUEL STOP 12'], household(fx.alex))).toEqual({
      'MAPLE GROCER': { categoryId: fx.groceries, categoryLabel: 'Food › Groceries', cleanName: 'Maple Grocer' },
    });
    expect(aiSuggestionsForMerchants(['MAPLE GROCER'], { id: fx.sam, role: 'member', visibility: 'self' })).toEqual({});
    expect(aiSuggestionsForMerchants([], household(fx.alex))).toEqual({});
  });

  it('reads an archived category as none, and leaves out a row with neither part', () => {
    fx = buildAiFixture();
    recordMerchantSuggestion({ merchant: 'MAPLE GROCER', categoryId: fx.groceries, cleanName: null, model: MODEL, at: AT });
    recordMerchantSuggestion({ merchant: 'BOOK NOOK', categoryId: fx.gas, cleanName: 'Book Nook', model: MODEL, at: AT });
    archiveCategory(fx.groceries, true);
    archiveCategory(fx.gas, true);
    expect(aiSuggestionsForMerchants(['MAPLE GROCER', 'BOOK NOOK'], household(fx.alex))).toEqual({
      'BOOK NOOK': { categoryId: null, categoryLabel: null, cleanName: 'Book Nook' },
    });
  });

  it('shows only suggested rows, and the accept check reads any status', () => {
    fx = buildAiFixture();
    recordMerchantFailure({ merchant: 'BOOK NOOK', model: MODEL, reason: 'Nothing in the answer could be used.', at: AT });
    expect(aiSuggestionsForMerchants(['BOOK NOOK'], household(fx.alex))).toEqual({});
    expect(aiSuggestionFor('BOOK NOOK')).toEqual({ merchant: 'BOOK NOOK', status: 'failed', categoryId: null, cleanName: null, model: MODEL });
    expect(aiSuggestionFor('NOBODY')).toBeNull();
  });
});

describe('the writers', () => {
  it('writes one row per merchant', () => {
    fx = buildAiFixture();
    expect(recordMerchantSuggestion({ merchant: 'MAPLE GROCER', categoryId: fx.groceries, cleanName: 'Maple Grocer', model: MODEL, at: AT })).toBe(true);
    expect(recordMerchantSuggestion({ merchant: 'MAPLE GROCER', categoryId: null, cleanName: 'Other', model: MODEL, at: AT })).toBe(false);
    expect(recordMerchantFailure({ merchant: 'MAPLE GROCER', model: MODEL, reason: 'x', at: AT })).toBe(false);
    expect(aiSuggestionFor('MAPLE GROCER')?.cleanName).toBe('Maple Grocer');
  });

  it('ignore sets who and when; forget deletes every row; clear-failed deletes failed rows only', () => {
    fx = buildAiFixture();
    recordMerchantSuggestion({ merchant: 'MAPLE GROCER', categoryId: fx.groceries, cleanName: 'Maple Grocer', model: MODEL, at: AT });
    recordMerchantSuggestion({ merchant: 'BOOK NOOK', categoryId: null, cleanName: 'Book Nook', model: MODEL, at: AT });
    recordMerchantFailure({ merchant: 'PIZZA PLACE', model: MODEL, reason: 'x'.repeat(500), at: AT });

    expect(ignoreAiSuggestion({ merchant: 'MAPLE GROCER', userId: fx.alex, at: new Date('2026-03-10T10:00:00.000Z') })).toBe(true);
    expect(ignoreAiSuggestion({ merchant: 'MAPLE GROCER', userId: fx.alex, at: AT })).toBe(false);
    expect(ignoreAiSuggestion({ merchant: 'NOBODY', userId: fx.alex, at: AT })).toBe(false);
    expect(
      fx.t.sqlite.prepare("select status, decided_by as by, decided_at as at from ai_suggestions where normalized_merchant = 'MAPLE GROCER'").get(),
    ).toEqual({ status: 'ignored', by: fx.alex, at: '2026-03-10T10:00:00.000Z' });
    expect(aiSuggestionsForMerchants(['MAPLE GROCER'], household(fx.alex))).toEqual({});
    expect((fx.t.sqlite.prepare("select length(reason) as n from ai_suggestions where normalized_merchant = 'PIZZA PLACE'").get() as { n: number }).n).toBe(200);
    expect(aiSuggestionCounts()).toEqual({ suggested: 1, ignored: 1, failed: 1, toAsk: 0 });

    expect(clearFailedAiSuggestions()).toBe(1);
    expect(aiSuggestionCounts()).toMatchObject({ suggested: 1, ignored: 1, failed: 0 });
    expect(forgetAiSuggestions()).toBe(2);
    expect(aiSuggestionCounts()).toEqual({ suggested: 0, ignored: 0, failed: 0, toAsk: 1 });
  });

  it('never touches a transaction or a rule', () => {
    fx = buildAiFixture();
    const snapshot = () => [
      fx!.t.sqlite.prepare('select * from transactions order by id').all(),
      fx!.t.sqlite.prepare('select * from merchant_rules order by id').all(),
    ];
    const before = snapshot();
    recordMerchantSuggestion({ merchant: 'MAPLE GROCER', categoryId: fx.groceries, cleanName: 'Maple Grocer', model: MODEL, at: AT });
    ignoreAiSuggestion({ merchant: 'MAPLE GROCER', userId: fx.alex, at: AT });
    forgetAiSuggestions();
    expect(snapshot()).toEqual(before);
  });
});
