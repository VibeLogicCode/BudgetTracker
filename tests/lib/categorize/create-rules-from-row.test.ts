import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { createRulesFromRow, previewRulesFromRow } from '@/lib/categorize/engine';
import { listRules } from '@/lib/categorize/rules';
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
