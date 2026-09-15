import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { confirmCategory, createRulesFromRow, previewRulesFromRow } from '@/lib/categorize/engine';
import { listRules, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { setTransactionSplits } from '@/lib/splits';
import { nowIso } from '@/lib/clock';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function fixture() {
  current = createSeededTestDb();
  const alex = insertTestUser(current.db, { name: 'Alex', role: 'admin' });
  const sam = insertTestUser(current.db, { name: 'Sam', role: 'member' });
  const accountId = insertTestAccount(current.db, { ownerUserId: alex });
  const add = (description: string, amountCents: number) => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents,
                                categorization_source, attributed_user_id, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', ${description}, ${normalizeMerchant(description)}, ${amountCents},
              'none', ${alex}, ${alex}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { alex, sam, accountId, add };
}

function rowState(id: number) {
  return current!.db.get<{ categoryId: number | null; attributedUserId: number | null }>(
    sql`select category_id as categoryId, attributed_user_id as attributedUserId from transactions where id = ${id}`,
  );
}

const MERCHANT = 'ACME INSURANCE';

/**
 * The owner, 2026-09-13: "can i set in rule vendor + amount rule? they dont have to be automatic
 * but something i create from kebab menu?" -- and, separately, "think about person too".
 *
 * ONE engine function behind the kebab dialog. It writes up to two rules (a category rule and a
 * person rule, both bounded by the same window) and then applies them to the merchant's own rows.
 *
 * Spec: docs/superpowers/specs/2026-09-13-vendor-amount-person-rules-design.md, ruling P16.
 */
describe('previewRulesFromRow: the sentence before the click', () => {
  it('counts the merchant rows, and how many of them the window holds', () => {
    const { alex, add } = fixture();
    add('ACME INSURANCE', -14012);
    add('ACME INSURANCE', -13500);
    add('ACME INSURANCE', -8940);

    const preview = previewRulesFromRow({
      normalizedMerchant: MERCHANT,
      amountMinCents: 12500,
      amountMaxCents: 15500,
      categoryId: categoryIdByName(current!.db, 'Car Insurance'),
      attributedUserId: undefined,
      userId: alex,
      actorRole: 'admin',
    });

    expect(preview).toMatchObject({ merchantRows: 3, matchingRows: 2, categoryChanges: 2, personChanges: 0 });
  });

  it('counts a person change only where the person would actually differ', () => {
    const { alex, sam, add } = fixture();
    add('ACME INSURANCE', -14012);
    add('ACME INSURANCE', -13500);

    const preview = previewRulesFromRow({
      normalizedMerchant: MERCHANT,
      amountMinCents: null,
      amountMaxCents: null,
      categoryId: undefined,
      attributedUserId: sam,
      userId: alex,
      actorRole: 'admin',
    });

    expect(preview).toMatchObject({ matchingRows: 2, categoryChanges: 0, personChanges: 2 });
  });

  it('writes nothing', () => {
    const { alex, sam, add } = fixture();
    const id = add('ACME INSURANCE', -14012);
    previewRulesFromRow({
      normalizedMerchant: MERCHANT, amountMinCents: null, amountMaxCents: null,
      categoryId: categoryIdByName(current!.db, 'Car Insurance'), attributedUserId: sam,
      userId: alex, actorRole: 'admin',
    });
    expect(listRules()).toHaveLength(0);
    expect(rowState(id).categoryId).toBeNull();
  });
});

describe('createRulesFromRow: two rules, one pass', () => {
  it('writes both rules with the same window and files the rows behind them', () => {
    const { alex, sam, add } = fixture();
    const inside = add('ACME INSURANCE', -14012);
    const outside = add('ACME INSURANCE', -8940);
    const auto = categoryIdByName(current!.db, 'Car Insurance');

    const result = createRulesFromRow({
      normalizedMerchant: MERCHANT,
      amountMinCents: 12500,
      amountMaxCents: 15500,
      categoryId: auto,
      attributedUserId: sam,
      userId: alex,
      actorRole: 'admin',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rulesCreated).toBe(2);
    expect(result.categoryChanged).toBe(1);
    expect(result.personChanged).toBe(1);

    const rules = listRules();
    expect(rules.map((rule) => rule.ruleKind).sort()).toEqual(['attribution', 'category']);
    for (const rule of rules) {
      expect({ min: rule.amountMinCents, max: rule.amountMaxCents }).toEqual({ min: 12500, max: 15500 });
    }
    expect(rowState(inside)).toEqual({ categoryId: auto, attributedUserId: sam });
    // The charge outside the window is untouched, which is the whole point of the window.
    expect(rowState(outside)).toEqual({ categoryId: null, attributedUserId: alex });
  });

  it('writes one rule when only a category was asked for', () => {
    const { alex, add } = fixture();
    const id = add('ACME INSURANCE', -14012);
    const auto = categoryIdByName(current!.db, 'Car Insurance');

    const result = createRulesFromRow({
      normalizedMerchant: MERCHANT, amountMinCents: null, amountMaxCents: null,
      categoryId: auto, attributedUserId: undefined, userId: alex, actorRole: 'admin',
    });

    expect(result.ok && result.rulesCreated).toBe(1);
    expect(listRules()[0].ruleKind).toBe('category');
    expect(rowState(id).categoryId).toBe(auto);
    // The person was not part of the ask, so it stays exactly as it was.
    expect(rowState(id).attributedUserId).toBe(alex);
  });

  it('sets Household when that is the person chosen', () => {
    const { alex, add } = fixture();
    const id = add('ACME INSURANCE', -14012);

    createRulesFromRow({
      normalizedMerchant: MERCHANT, amountMinCents: null, amountMaxCents: null,
      categoryId: undefined, attributedUserId: null, userId: alex, actorRole: 'admin',
    });

    expect(rowState(id).attributedUserId).toBeNull();
  });

  it('never touches a transfer, which belongs to nobody and has no category to set', () => {
    const { alex, sam, add } = fixture();
    const id = add('ACME INSURANCE', -14012);
    current!.db.run(sql`update transactions set is_transfer = 1 where id = ${id}`);

    const result = createRulesFromRow({
      normalizedMerchant: MERCHANT, amountMinCents: null, amountMaxCents: null,
      categoryId: categoryIdByName(current!.db, 'Car Insurance'), attributedUserId: sam,
      userId: alex, actorRole: 'admin',
    });

    expect(result.ok && result.categoryChanged).toBe(0);
    expect(rowState(id)).toEqual({ categoryId: null, attributedUserId: alex });
  });

  /**
   * applyCategoryToMatching discards confirmCategory's has_splits refusal and so over-reports what
   * it did. This function does not inherit that: a split row's parts ARE its categorization, so it
   * is skipped and SAID to be skipped.
   */
  it('reports the split rows it skipped rather than counting them as filed', () => {
    const { alex, add } = fixture();
    const plain = add('ACME INSURANCE', -14012);
    const split = add('ACME INSURANCE', -14012);
    const auto = categoryIdByName(current!.db, 'Car Insurance');
    setTransactionSplits({
      txnId: split,
      parts: [
        { categoryId: auto, amountCents: -7006, note: null },
        { categoryId: categoryIdByName(current!.db, 'Home Insurance'), amountCents: -7006, note: null },
      ],
      userId: alex,
    });

    const result = createRulesFromRow({
      normalizedMerchant: MERCHANT, amountMinCents: null, amountMaxCents: null,
      categoryId: auto, attributedUserId: undefined, userId: alex, actorRole: 'admin',
    });

    expect(result.ok && result.categoryChanged).toBe(1);
    expect(result.ok && result.splitsSkipped).toBe(1);
    expect(rowState(plain).categoryId).toBe(auto);
  });

  it('refuses when neither a category nor a person was chosen', () => {
    const { alex } = fixture();
    expect(() =>
      createRulesFromRow({
        normalizedMerchant: MERCHANT, amountMinCents: null, amountMaxCents: null,
        categoryId: undefined, attributedUserId: undefined, userId: alex, actorRole: 'admin',
      }),
    ).toThrow(/category|person/i);
  });
});

/**
 * Ruling P16 and risk 5. A member who owns neither rule is refused before any write. A member who
 * owns ONE of the two is the case that needs a transaction: the second rule refuses, and the first
 * must be rolled back, or the household is left with half a statement -- one rule written, no rows
 * changed, and a dialog reporting a refusal.
 */
describe('createRulesFromRow: a refusal leaves nothing behind', () => {
  it('rolls the first rule back when the second is owned by somebody else', () => {
    const { alex, sam, add } = fixture();
    const id = add('ACME INSURANCE', -14012);
    const auto = categoryIdByName(current!.db, 'Car Insurance');
    // Alex owns the person rule this member is about to try to overwrite.
    createRulesFromRow({
      normalizedMerchant: MERCHANT, amountMinCents: null, amountMaxCents: null,
      categoryId: undefined, attributedUserId: alex, userId: alex, actorRole: 'admin',
    });
    const before = listRules().length;

    const result = createRulesFromRow({
      normalizedMerchant: MERCHANT, amountMinCents: null, amountMaxCents: null,
      categoryId: auto, attributedUserId: sam, userId: sam, actorRole: 'member',
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('owned_by_another');
    // The category rule the first upsert would have written is gone with it.
    expect(listRules()).toHaveLength(before);
    expect(rowState(id)).toEqual({ categoryId: null, attributedUserId: alex });
  });
});

/**
 * T10 / Q3 of docs/superpowers/specs/2026-09-13-vendor-amount-person-rules-design.md, the gap
 * v1.39.0 shipped knowingly and the help text had to apologise for.
 *
 * Correcting a row in review calls confirmCategory with createRule: true, which upserts the
 * MERCHANT-WIDE exact rule. Once an amount rule exists under that merchant, the two disagree: you
 * correct a $130 insurance charge, the correction takes on the row, and the next import files it
 * the old way because the bounded rule still wins with its own answer. Nothing on screen explains
 * it, and the household has no reason to suspect the rule they just edited was not the one acting.
 *
 * The fix is the planner's recommendation: when EXACTLY ONE bounded exact rule covers the row's
 * amount, the correction edits that rule. Exactly one, because two overlapping windows have no
 * single obvious target and guessing between them would be a worse failure than the one being
 * fixed -- there the merchant-wide rule stays the honest default.
 */
describe('teaching a category edits the rule that actually decides the row', () => {
  function insurance() {
    const { alex, add } = fixture();
    const auto = categoryIdByName(current!.db, 'Car Insurance');
    const home = categoryIdByName(current!.db, 'Home Insurance');
    const inside = add('ACME INSURANCE', -14012);
    createRulesFromRow({
      normalizedMerchant: MERCHANT, amountMinCents: 12500, amountMaxCents: 15500,
      categoryId: auto, attributedUserId: undefined, userId: alex, actorRole: 'admin',
    });
    return { alex, auto, home, inside, add };
  }

  it('edits the bounded rule when one covers the amount, and leaves the merchant-wide rule alone', () => {
    const { alex, home, inside } = insurance();
    const merchantWide = categoryIdByName(current!.db, 'Groceries');
    upsertRuleFromCorrection({
      pattern: MERCHANT, matchType: 'exact', ruleKind: 'category', categoryId: merchantWide,
      createdBy: alex, actorRole: 'admin',
    });

    expect(confirmCategory({ transactionId: inside, categoryId: home, userId: alex, createRule: true, actorRole: 'admin' }).ok).toBe(true);

    const rules = listRules('category');
    const bounded = rules.find((rule) => rule.amountMinCents === 12500);
    const wide = rules.find((rule) => rule.amountMinCents === null);
    expect(bounded?.categoryId).toBe(home);
    // Untouched: the correction was about a $140.12 charge, which that rule does not decide.
    expect(wide?.categoryId).toBe(merchantWide);
  });

  it('still writes the merchant-wide rule for a charge no window covers', () => {
    const { alex, home, auto, add } = insurance();
    const outside = add('ACME INSURANCE', -8940);

    confirmCategory({ transactionId: outside, categoryId: home, userId: alex, createRule: true, actorRole: 'admin' });

    const rules = listRules('category');
    expect(rules.find((rule) => rule.amountMinCents === null)?.categoryId).toBe(home);
    // The bounded rule keeps its own answer -- this correction said nothing about that window.
    expect(rules.find((rule) => rule.amountMinCents === 12500)?.categoryId).toBe(auto);
  });

  /**
   * Two windows both holding the amount have no single obvious target. Picking one would be a
   * guess, and a guess that silently edits the wrong rule is worse than the gap this closes.
   */
  it('falls back to the merchant-wide rule when two windows both cover the amount', () => {
    const { alex, home, add } = insurance();
    const groceries = categoryIdByName(current!.db, 'Groceries');
    upsertRuleFromCorrection({
      pattern: MERCHANT, matchType: 'exact', ruleKind: 'category', categoryId: groceries,
      amountMinCents: 13000, amountMaxCents: 20000, createdBy: alex, actorRole: 'admin',
    });
    const inside = add('ACME INSURANCE', -14012);

    confirmCategory({ transactionId: inside, categoryId: home, userId: alex, createRule: true, actorRole: 'admin' });

    const rules = listRules('category');
    expect(rules.find((rule) => rule.amountMinCents === null)?.categoryId).toBe(home);
    expect(rules.find((rule) => rule.amountMinCents === 12500)?.categoryId).not.toBe(home);
    expect(rules.find((rule) => rule.amountMinCents === 13000)?.categoryId).not.toBe(home);
  });

  it('is unaffected for a household with no bounded rules at all', () => {
    const { alex, add } = fixture();
    const coffee = categoryIdByName(current!.db, 'Coffee');
    const id = add('TIM HORTONS', -485);

    confirmCategory({ transactionId: id, categoryId: coffee, userId: alex, createRule: true, actorRole: 'admin' });

    const rules = listRules('category');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ pattern: 'TIM HORTONS', categoryId: coffee, amountMinCents: null });
  });
});
