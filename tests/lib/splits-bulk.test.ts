import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { clearCategory, confirmCategory, setTransferFlag } from '@/lib/categorize/engine';
import { listRules } from '@/lib/categorize/rules';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { bulkSetAttribution, bulkSetCategory, bulkSetTransfer } from '@/lib/transactions';
import type { Viewer } from '@/lib/auth/viewer';
import { categoryBreakdown } from '@/lib/reports';

// v1.13.0 ruling R2 (Task 6 fix round 1): categoryBreakdown now takes a viewer as its last
// argument. A household viewer's ownerScope() is always null, so passing this constant reproduces
// the pre-v1.13.0 unscoped behaviour this test already assumes.
const HOUSEHOLD: Viewer = { id: 1, role: 'admin', visibility: 'household' };
import { getSplits, setTransactionSplits } from '@/lib/splits';
import { nowIso } from '@/lib/clock';

/**
 * Adversarial-review fix (2026-08-22): two holes in the transaction-splits feature that Task
 * 2b (spec ruling 2a) never covered, because Task 2b only guarded the AUTOMATIC engine path
 * (ELIGIBLE/REVIEW_WHERE in src/lib/categorize/engine.ts). Neither confirmCategory nor
 * setTransferFlag -- the two functions behind the MANUAL bulk "Categorize" and "Mark
 * transfer" actions -- had ever been told a split transaction is off-limits.
 *
 * Defect 1 (serious, data loss): bulkSetTransfer -> setTransferFlag wrote is_transfer = 1 on
 * a split transaction's PARENT row. Every split-aware aggregate (categoryBreakdown included)
 * filters is_transfer = false, so the split's parts -- still sitting untouched in
 * transaction_splits, still summing correctly -- vanished from every report and budget while
 * the row went on displaying "Split - N parts". It also upserted a `transfer` merchant rule,
 * so the very next UNSPLIT transaction from that merchant would be auto-flagged too.
 *
 * Defect 2 (lower, poisoned signal): bulkSetCategory -> confirmCategory overwrote the
 * parent's category_id, trained Bayes and (rules on) wrote a merchant rule mapping that
 * merchant to ONE category, despite the transaction being deliberately divided across
 * several. Reports stayed correct (EFFECTIVE_CATEGORY prefers the split rows), but the false
 * merchant signal would mis-categorize other, unsplit transactions from that merchant.
 *
 * The fix mirrors Task 2b's own mechanism exactly: confirmCategory and setTransferFlag now
 * refuse outright (return false, write nothing -- no category/transfer write, no rule, no
 * Bayes training) for a transaction that has splits, and the two bulk functions in
 * src/lib/transactions.ts count the refusals as "skipped" instead of failing the whole batch.
 *
 * Defect 3 (final pre-release review, 2026-08-22, worse than either above): clearCategory was
 * the one sibling of confirmCategory/setTransferFlag that never got this guard, even though it
 * is reachable through the OTHER half of the very same setCategoryAction if/else that defect 2
 * closed one branch of. setTransactionSplits stamps categorization_source = 'manual' on the
 * parent when splitting (so the row leaves the review queue) but, by design ruling 2, never
 * calls train() -- so a split parent that a rule or Bayes had already categorized carries
 * 'manual' with NO training behind it, breaking the invariant clearCategory's untrain() relied
 * on (that 'manual' + a real category_id means THIS row's own tokens were trained). Calling
 * clearCategory on such a row untrains someone ELSE's real training at the shared merchant
 * (e.g. another, unsplit transaction at the same merchant that was legitimately confirmed) and
 * unconditionally deletes that merchant's exact category rule too -- neither of which this
 * split row ever earned. clearCategory now gets the identical guard: refuse outright and write
 * nothing for a transaction that has splits.
 */

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const MARCH_RANGE = { from: '2026-03-01', to: '2026-03-31' };

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const joint = insertTestAccount(current.db, { name: 'Joint Chequing' });

  const add = (over: Partial<{ description: string; amountCents: number; date: string }> = {}) => {
    const description = over.description ?? 'ACME SPLIT MERCHANT';
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
      values (${joint}, ${over.date ?? '2026-03-10'}, ${description}, ${normalizeMerchant(description)},
              ${over.amountCents ?? -10000}, null, 'none', ${alice}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };

  const readTxn = (id: number) =>
    current!.sqlite
      .prepare('select category_id, categorization_source, is_transfer from transactions where id = ?')
      .get(id) as { category_id: number | null; categorization_source: string; is_transfer: number };

  return { db: current.db, sqlite: current.sqlite, alice, joint, add, readTxn };
}

/** Splits `id` (a -$100.00 fixture txn) into $70 groceries / $30 gas -- the reviewer's own
 *  reproduction numbers. */
function splitSeventyThirty(id: number, groceries: number, gas: number, userId: number) {
  setTransactionSplits({
    txnId: id,
    parts: [
      { categoryId: groceries, amountCents: -7000 },
      { categoryId: gas, amountCents: -3000 },
    ],
    userId,
  });
}

/** The amount categoryBreakdown reports for one category over the fixture's month, treating
 *  "absent from the rows" the same as "present at 0" -- the reviewer described the bug as
 *  categoryBreakdown "reporting 0 and 0", and a transaction excluded entirely by the
 *  is_transfer filter produces the former, not the latter. */
function spentAt(categoryId: number): number {
  return categoryBreakdown(MARCH_RANGE, HOUSEHOLD).find((r) => r.categoryId === categoryId)?.spentCents ?? 0;
}

describe('setTransferFlag refuses a split transaction (defect 1 fix, manual counterpart to Task 2b)', () => {
  it('returns false and writes nothing: is_transfer stays 0, no transfer rule, split parts still report their own amounts', () => {
    const { db, alice, add, readTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const id = add();
    splitSeventyThirty(id, groceries, gas, alice);

    expect(spentAt(groceries)).toBe(7000);
    expect(spentAt(gas)).toBe(3000);

    expect(setTransferFlag({ transactionId: id, isTransfer: true, userId: alice })).toBe(false);

    expect(readTxn(id).is_transfer).toBe(0);
    expect(listRules('transfer')).toHaveLength(0);
    expect(spentAt(groceries)).toBe(7000);
    expect(spentAt(gas)).toBe(3000);
  });

  it('an unsplit control transaction can still be flagged a transfer normally', () => {
    const { alice, add, readTxn } = setup();
    const id = add({ description: 'CONTROL MERCHANT' });
    expect(setTransferFlag({ transactionId: id, isTransfer: true, userId: alice })).toBe(true);
    expect(readTxn(id).is_transfer).toBe(1);
    expect(listRules('transfer')).toHaveLength(1);
  });
});

describe('confirmCategory refuses a split transaction (defect 2 fix, manual counterpart to Task 2b)', () => {
  it('returns false and writes nothing: category_id unchanged, no rule, no Bayes training', () => {
    const { db, sqlite, alice, add, readTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add();
    splitSeventyThirty(id, groceries, gas, alice);
    const before = readTxn(id);

    expect(confirmCategory({ transactionId: id, categoryId: coffee, userId: alice })).toBe(false);

    expect(readTxn(id)).toEqual(before);
    expect(listRules('category')).toHaveLength(0);
    expect((sqlite.prepare('select count(*) as c from bayes_tokens').get() as { c: number }).c).toBe(0);
  });

  it('an unsplit control transaction can still be confirmed normally', () => {
    const { db, alice, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add({ description: 'CONTROL MERCHANT' });
    expect(confirmCategory({ transactionId: id, categoryId: coffee, userId: alice })).toBe(true);
    expect(listRules('category')).toHaveLength(1);
  });
});

describe('clearCategory refuses a split transaction (defect 3 fix, the third sibling Task 2b never covered)', () => {
  /**
   * T1 confirms 'groceries' at a merchant -- real training: docCount 1, one bayes_tokens row
   * per distinct token in the normalized merchant. T2 is a SEPARATE transaction at the SAME
   * merchant, given the same category as if Bayes had guessed it, then split -- which stamps
   * ITS parent 'manual' (setTransactionSplits, ruling 2) without ever training it. This is the
   * reviewer's exact reproduction shape: calling clearCategory on T2 must never be able to
   * untrain what T1 actually earned.
   */
  function setupSharedMerchantScenario() {
    const { db, alice, add, readTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const merchant = 'ACME SPLIT MERCHANT';
    const t1 = add({ description: merchant });
    expect(confirmCategory({ transactionId: t1, categoryId: groceries, userId: alice })).toBe(true);
    const t2 = add({ description: merchant });
    current!.db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'bayes' where id = ${t2}`);
    splitSeventyThirty(t2, groceries, gas, alice);
    return { alice, groceries, gas, t1, t2, readTxn };
  }

  function bayesStateFor(categoryId: number) {
    const totals = current!.sqlite
      .prepare('select doc_count as docCount, token_total as tokenTotal from bayes_category_totals where category_id = ?')
      .get(categoryId) as { docCount: number; tokenTotal: number } | undefined;
    const tokens = current!.sqlite
      .prepare('select token, count from bayes_tokens where category_id = ? order by token')
      .all(categoryId) as { token: string; count: number }[];
    return { totals: totals ?? { docCount: 0, tokenTotal: 0 }, tokens };
  }

  it("reviewer's exact reproduction: T1's real training survives a clearCategory aimed at split T2", () => {
    const { alice, groceries, t2 } = setupSharedMerchantScenario();

    // Real training from T1's confirm, pinned exactly: 'ACME SPLIT MERCHANT' tokenizes to
    // three distinct tokens, each trained once.
    const before = bayesStateFor(groceries);
    expect(before).toEqual({
      totals: { docCount: 1, tokenTotal: 3 },
      tokens: [
        { token: 'ACME', count: 1 },
        { token: 'MERCHANT', count: 1 },
        { token: 'SPLIT', count: 1 },
      ],
    });

    // deleteRule: true — this test is about the split guard itself, not the delete decision.
    expect(clearCategory({ transactionId: t2, userId: alice, deleteRule: true })).toBe(false);

    // Unchanged, down to the exact numbers -- not merely "still some tokens exist".
    expect(bayesStateFor(groceries)).toEqual(before);
  });

  it("does not delete the merchant rule T1's confirm created, and leaves T2's row and its split parts exactly as they were", () => {
    const { alice, groceries, t2, readTxn } = setupSharedMerchantScenario();
    const beforeTxn = readTxn(t2);
    const beforeSplits = getSplits(t2);
    expect(beforeTxn).toMatchObject({ category_id: groceries, categorization_source: 'manual' });

    // deleteRule: true — this test is about the split guard itself, not the delete decision.
    expect(clearCategory({ transactionId: t2, userId: alice, deleteRule: true })).toBe(false);

    expect(listRules('category')).toHaveLength(1);
    expect(listRules('category')[0]).toMatchObject({ pattern: 'ACME SPLIT MERCHANT', matchType: 'exact', categoryId: groceries });
    // The parent's own category/source and its split rows must not end up inconsistent with
    // each other -- a refused call writes NOTHING, on either side.
    expect(readTxn(t2)).toEqual(beforeTxn);
    expect(getSplits(t2)).toEqual(beforeSplits);
  });

  it('an unsplit control transaction can still be cleared normally', () => {
    const { db, alice, add, readTxn } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add({ description: 'CONTROL MERCHANT' });
    expect(confirmCategory({ transactionId: id, categoryId: coffee, userId: alice })).toBe(true);

    // deleteRule: true — this test is about the engine's own delete path, not ruling P5.
    expect(clearCategory({ transactionId: id, userId: alice, deleteRule: true })).toBe(true);

    expect(readTxn(id)).toMatchObject({ category_id: null, categorization_source: 'none' });
    expect((current!.sqlite.prepare('select count(*) as c from bayes_tokens').get() as { c: number }).c).toBe(0);
  });
});

describe('bulkSetTransfer (defect 1, the actual reported path): skips split rows and reports both counts', () => {
  it("reviewer's exact reproduction: bulkSetTransfer no longer erases a split's money from categoryBreakdown", () => {
    const { db, alice, add, readTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const id = add();
    splitSeventyThirty(id, groceries, gas, alice);

    expect(spentAt(groceries)).toBe(7000);
    expect(spentAt(gas)).toBe(3000);

    const result = bulkSetTransfer([id], true, alice);

    expect(result).toEqual({ changed: 0, skipped: 1 });
    expect(readTxn(id).is_transfer).toBe(0);
    expect(spentAt(groceries)).toBe(7000);
    expect(spentAt(gas)).toBe(3000);
    expect(listRules('transfer')).toHaveLength(0);
  });

  it('mixed batch: two unsplit rows are changed, the split one is skipped, counts are 2 changed / 1 skipped', () => {
    const { db, alice, add, readTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const splitId = add({ description: 'ACME SPLIT MERCHANT' });
    splitSeventyThirty(splitId, groceries, gas, alice);
    const a = add({ description: 'CONTROL A' });
    const b = add({ description: 'CONTROL B' });

    const result = bulkSetTransfer([splitId, a, b], true, alice);

    expect(result).toEqual({ changed: 2, skipped: 1 });
    expect(readTxn(splitId).is_transfer).toBe(0);
    expect(readTxn(a).is_transfer).toBe(1);
    expect(readTxn(b).is_transfer).toBe(1);
    expect(listRules('transfer')).toHaveLength(2); // the two controls, never the split row
  });

  it('an all-split batch changes nothing and reports every row skipped', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const first = add({ description: 'ACME SPLIT MERCHANT ONE' });
    const second = add({ description: 'ACME SPLIT MERCHANT TWO' });
    splitSeventyThirty(first, groceries, gas, alice);
    splitSeventyThirty(second, groceries, gas, alice);

    expect(bulkSetTransfer([first, second], true, alice)).toEqual({ changed: 0, skipped: 2 });
  });

  it('an empty id list reports zero changed and zero skipped', () => {
    const { alice } = setup();
    expect(bulkSetTransfer([], true, alice)).toEqual({ changed: 0, skipped: 0 });
  });
});

describe('bulkSetCategory (defect 2, the actual reported path): skips split rows and reports both counts', () => {
  it('a bulk categorize attempt on a split row writes no rule, no Bayes tokens, and leaves category_id unchanged', () => {
    const { db, sqlite, alice, add, readTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add();
    splitSeventyThirty(id, groceries, gas, alice);
    const before = readTxn(id);

    const result = bulkSetCategory([id], coffee, alice, true);

    expect(result).toEqual({ changed: 0, skipped: 1 });
    expect(readTxn(id)).toEqual(before);
    expect(listRules('category')).toHaveLength(0);
    expect((sqlite.prepare('select count(*) as c from bayes_tokens').get() as { c: number }).c).toBe(0);
  });

  it('mixed batch: two unsplit rows are changed, the split one is skipped, counts are 2 changed / 1 skipped', () => {
    const { db, alice, add, readTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const coffee = categoryIdByName(db, 'Coffee');
    const splitId = add({ description: 'ACME SPLIT MERCHANT' });
    splitSeventyThirty(splitId, groceries, gas, alice);
    const a = add({ description: 'CONTROL A' });
    const b = add({ description: 'CONTROL B' });

    const result = bulkSetCategory([splitId, a, b], coffee, alice, true);

    expect(result).toEqual({ changed: 2, skipped: 1 });
    expect(readTxn(a).category_id).toBe(coffee);
    expect(readTxn(b).category_id).toBe(coffee);
    expect(readTxn(splitId).category_id).toBeNull();
    expect(listRules('category').map((r) => r.pattern).sort()).toEqual(
      [normalizeMerchant('CONTROL A'), normalizeMerchant('CONTROL B')].sort(),
    );
  });

  it('an empty id list reports zero changed and zero skipped', () => {
    const { alice } = setup();
    expect(bulkSetCategory([], 1, alice, true)).toEqual({ changed: 0, skipped: 0 });
  });
});

describe('bulk attribution on a split transaction still works (the fix must not over-reach into ruling 1)', () => {
  it('bulkSetAttribution changes a split transaction exactly like any other row', () => {
    const { db, sqlite, alice, add } = setup();
    const bob = insertTestUser(db, { name: 'Bob', username: 'bob' });
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const id = add();
    splitSeventyThirty(id, groceries, gas, alice);

    expect(bulkSetAttribution([id], bob)).toBe(1);
    expect((sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(id) as { a: number | null }).a).toBe(
      bob,
    );
  });
});
