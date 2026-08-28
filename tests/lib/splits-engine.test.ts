import { describe, it, expect, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { transactions } from '@/db/schema';
import { eligibleForRerun, reviewQueueCount, reviewQueueIds, rerunEngine, runEngine } from '@/lib/categorize/engine';
import { upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { listReviewQueue } from '@/lib/transactions';
import { getSplits, setTransactionSplits } from '@/lib/splits';

/**
 * Task 2b (spec 2026-08-22, v1.7.0, design ruling 2a): a split transaction is categorized by
 * definition -- by its parts, in transaction_splits -- even though setTransactionSplits
 * (src/lib/splits.ts) deliberately leaves the parent's own category_id untouched. So
 * REVIEW_WHERE and ELIGIBLE (src/lib/categorize/engine.ts) must both additionally exclude any
 * transaction that has splits: without that, a row that was genuinely uncategorized before
 * being split keeps matching their `category_id IS NULL` disjunct forever, which means it (a)
 * nags in the review queue permanently and (b) stays eligible for rerunEngine, which can flag
 * it a transfer and silently drop every one of its split parts out of every report and budget
 * aggregate (all of which exclude transfers). These tests exercise that exclusion end to end.
 */

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const SENTINEL_TIMESTAMP = '2020-01-01T00:00:00.000Z';
const byId = (a: number, b: number) => a - b;

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const joint = insertTestAccount(current.db, { name: 'Joint Chequing' });

  const add = (
    over: Partial<{
      date: string;
      description: string;
      amountCents: number;
      categoryId: number | null;
      source: 'rule' | 'bayes' | 'manual' | 'none';
      isTransfer: boolean;
    }> = {},
  ) => {
    const description = over.description ?? 'GENERIC MERCHANT';
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, created_by, created_at, updated_at)
      values (${joint}, ${over.date ?? '2026-03-02'}, ${description}, ${normalizeMerchant(description)},
              ${over.amountCents ?? -10000}, ${over.categoryId ?? null}, ${over.source ?? 'none'},
              ${over.isTransfer ? 1 : 0}, ${alice}, ${SENTINEL_TIMESTAMP}, ${SENTINEL_TIMESTAMP})
      returning id`);
    return row.id;
  };

  const parentRow = (id: number) => current!.db.select().from(transactions).where(eq(transactions.id, id)).get()!;

  /** Splits `id` into groceries/coffee parts summing to its -$100.00 fixture amount. */
  const splitInTwo = (id: number, groceries: number, coffee: number) =>
    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -7000 },
        { categoryId: coffee, amountCents: -3000 },
      ],
      userId: alice,
    });

  return { db: current.db, alice, joint, add, parentRow, splitInTwo };
}

describe('review queue excludes a split transaction (ruling 2a)', () => {
  it('a split row with category_id NULL leaves reviewQueueIds, listReviewQueue and reviewQueueCount; an unsplit control stays', () => {
    const { db, add, parentRow, splitInTwo } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const target = add({ description: 'UNCATEGORIZED SHOP', amountCents: -10000, categoryId: null, source: 'none' });
    const control = add({ description: 'UNCATEGORIZED SHOP TWO', amountCents: -4000, categoryId: null, source: 'none' });

    // Both rows start in the queue -- confirming the fixture really is the bug condition:
    // genuinely uncategorized before either is touched.
    expect(reviewQueueIds().sort(byId)).toEqual([target, control].sort(byId));
    expect(reviewQueueCount()).toBe(2);

    splitInTwo(target, groceries, coffee);
    // The split leaves category_id NULL (binding rule in splits.ts) -- without this being
    // true, the rest of the assertions below would prove nothing about the fix.
    expect(parentRow(target).categoryId).toBeNull();

    expect(reviewQueueIds()).toEqual([control]);
    expect(reviewQueueCount()).toBe(1);
    expect(listReviewQueue().map((r) => r.id)).toEqual([control]);
  });
});

describe('eligibleForRerun excludes a split transaction', () => {
  it('a split row is absent from eligibleForRerun while an unsplit control remains eligible', () => {
    const { db, add, splitInTwo } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const target = add({ description: 'UNCATEGORIZED SHOP', amountCents: -10000, categoryId: null, source: 'none' });
    const control = add({ description: 'UNCATEGORIZED SHOP TWO', amountCents: -4000, categoryId: null, source: 'none' });

    expect(eligibleForRerun().sort(byId)).toEqual([target, control].sort(byId));

    splitInTwo(target, groceries, coffee);

    expect(eligibleForRerun()).toEqual([control]);
  });
});

describe('rerunEngine never touches a split transaction, even one a transfer rule would match', () => {
  it("leaves the split row's is_transfer and category_id untouched while correctly flagging an identical unsplit control (the regression that matters most)", () => {
    const { db, alice, add, parentRow, splitInTwo } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const description = 'ACME PAYMENTS TRANSFER SVC';
    const merchant = normalizeMerchant(description);

    // Build the transfer rule EXPLICITLY. This merchant text does not appear in
    // CARD_PAYMENT_PATTERNS (verified: no listed pattern is a substring of it), so the ONLY
    // thing that can flag it a transfer is this learned rule -- the test must prove the
    // protection actually engages, not assume detectTransfer would ever match anything here.
    upsertRuleFromCorrection({ pattern: merchant, matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: alice, actorRole: 'admin' });

    const target = add({ description, amountCents: -10000, categoryId: null, source: 'none' });
    const control = add({ description, amountCents: -5000, categoryId: null, source: 'none' });

    splitInTwo(target, groceries, coffee);
    expect(getSplits(target)).toHaveLength(2);

    rerunEngine();

    const targetRow = parentRow(target);
    expect(targetRow.isTransfer).toBe(false);
    expect(targetRow.categoryId).toBeNull();
    expect(targetRow.categorizationSource).toBe('manual'); // stamped by the split; the engine never ran on it
    expect(getSplits(target)).toHaveLength(2); // the parts themselves are never touched either

    // The control proves the rule genuinely matches this merchant -- and that the new
    // exclusion is scoped to split rows only, not a blanket change to transfer detection.
    expect(parentRow(control).isTransfer).toBe(true);
  });
});

describe('clearing a split restores normal engine behaviour', () => {
  it('puts the row back into reviewQueueIds, listReviewQueue, reviewQueueCount and eligibleForRerun', () => {
    const { db, alice, add, parentRow, splitInTwo } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const target = add({ description: 'UNCATEGORIZED SHOP', amountCents: -10000, categoryId: null, source: 'none' });
    const control = add({ description: 'UNCATEGORIZED SHOP TWO', amountCents: -4000, categoryId: null, source: 'none' });

    splitInTwo(target, groceries, coffee);
    expect(reviewQueueIds()).toEqual([control]);
    expect(eligibleForRerun()).toEqual([control]);

    setTransactionSplits({ txnId: target, parts: [], userId: alice });

    expect(getSplits(target)).toHaveLength(0);
    // The clear path resets an uncategorized row's source to 'none' and reruns the engine
    // (src/lib/splits.ts); nothing in this seeded db matches "UNCATEGORIZED SHOP", so it
    // stays genuinely uncategorized -- and, critically, is visible again everywhere it
    // should be.
    expect(parentRow(target)).toMatchObject({ categoryId: null, categorizationSource: 'none' });

    expect(reviewQueueIds().sort(byId)).toEqual([target, control].sort(byId));
    expect(reviewQueueCount()).toBe(2);
    expect(listReviewQueue().map((r) => r.id).sort(byId)).toEqual([target, control].sort(byId));
    expect(eligibleForRerun().sort(byId)).toEqual([target, control].sort(byId));
  });
});

/**
 * v1.12.1 (item BC / MON-6): runEngine re-derived ELIGIBLE's category half in JavaScript
 * (`row.categoryId === null || row.source === 'bayes'`) but never carried its splits half, so
 * a split parent that still matches a transfer/category rule was categorized (or flagged a
 * transfer) here even though eligibleForRerun/rerunEngine — which go through ELIGIBLE directly
 * — already excluded it. selectRowsByIds now selects hasSplits alongside the row so both paths
 * share one predicate.
 */
function setupSplitWithNullParentCategory() {
  const { db, alice, add, splitInTwo } = setup();
  const groceries = categoryIdByName(db, 'Groceries');
  const coffee = categoryIdByName(db, 'Coffee');
  const description = 'ACME SPLIT TRANSFER MERCHANT';
  const merchant = normalizeMerchant(description);
  // A rule this uncategorized-before-split row's merchant would otherwise match.
  upsertRuleFromCorrection({ pattern: merchant, matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: alice, actorRole: 'admin' });

  const txnId = add({ description, amountCents: -10000, categoryId: null, source: 'none' });
  splitInTwo(txnId, groceries, coffee);

  return { db, txnId };
}

describe('v1.12.1: runEngine keeps the splits guard (item BC / MON-6)', () => {
  it('skips a split parent whose own category_id is NULL, instead of categorizing it', () => {
    const { db, txnId } = setupSplitWithNullParentCategory();
    const before = db.get<{ c: number | null; t: number }>(
      sql`select category_id as c, is_transfer as t from transactions where id = ${txnId}`,
    );

    const result = runEngine([txnId]);

    const after = db.get<{ c: number | null; t: number }>(
      sql`select category_id as c, is_transfer as t from transactions where id = ${txnId}`,
    );
    expect(after.c).toBe(before.c);
    expect(after.t).toBe(before.t);
    expect(result.skipped).toBe(1);
    expect(result.categorized).toBe(0);
  });
});
