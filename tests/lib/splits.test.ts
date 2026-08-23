import { describe, it, expect, afterEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { transactions, transactionSplits } from '@/db/schema';
import { REVIEW_WHERE } from '@/lib/categorize/engine';
import { listRules } from '@/lib/categorize/rules';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { archiveCategory } from '@/lib/categories';
import { formatCents } from '@/lib/money';
import { EFFECTIVE_AMOUNT, EFFECTIVE_CATEGORY, getSplits, setTransactionSplits, splitsForTransactions } from '@/lib/splits';
import type { Db } from '@/db/client';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/**
 * Deliberately queries with the imported REVIEW_WHERE rather than restating its predicate
 * (and(isTransfer=false, or(categoryId is null, source='bayes'))) a second time here --
 * see engine.ts, this must stay the single source of truth for "needs review".
 */
function inReviewQueue(db: Db, txnId: number): boolean {
  const row = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.id, txnId), REVIEW_WHERE))
    .get();
  return row !== undefined;
}

const SENTINEL_TIMESTAMP = '2020-01-01T00:00:00.000Z';

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

  const parentRow = (id: number) =>
    current!.db.select().from(transactions).where(eq(transactions.id, id)).get()!;

  return { db: current.db, alice, joint, add, parentRow };
}

describe('setTransactionSplits: happy paths', () => {
  it('splits a transaction into 2 parts that sum to the parent amount', () => {
    const { db, alice, add, parentRow } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add({ amountCents: -10000, categoryId: groceries, source: 'rule' });

    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -7000, note: 'weekly shop' },
        { categoryId: coffee, amountCents: -3000 },
      ],
      userId: alice,
    });

    const rows = getSplits(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => ({ categoryId: r.categoryId, amountCents: r.amountCents, note: r.note }))).toEqual(
      expect.arrayContaining([
        { categoryId: groceries, amountCents: -7000, note: 'weekly shop' },
        { categoryId: coffee, amountCents: -3000, note: null },
      ]),
    );
    for (const row of rows) {
      expect(row.txnId).toBe(id);
      expect(row.id).toBeGreaterThan(0);
    }

    // Binding rule: the parent's OWN category_id is left exactly as it was.
    const parent = parentRow(id);
    expect(parent.categoryId).toBe(groceries);
    expect(parent.categorizationSource).toBe('manual');
    expect(parent.updatedAt).not.toBe(SENTINEL_TIMESTAMP);
    expect(parent.amountCents).toBe(-10000); // untouched, still the original signed magnitude

    // Design ruling 2: a split never trains the categorizer -- no rule should appear.
    expect(listRules('category')).toHaveLength(0);
  });

  it('splits a transaction into 3 parts that sum to the parent amount', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const restaurants = categoryIdByName(db, 'Restaurants');
    const id = add({ amountCents: -6000 });

    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -3000 },
        { categoryId: coffee, amountCents: -2000 },
        { categoryId: restaurants, amountCents: -1000 },
      ],
      userId: alice,
    });

    const rows = getSplits(id);
    expect(rows).toHaveLength(3);
    expect(rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(-6000);
  });

  it('replaces an existing split rather than appending to it', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add({ amountCents: -5000 });

    setTransactionSplits({ txnId: id, parts: [{ categoryId: groceries, amountCents: -3000 }, { categoryId: coffee, amountCents: -2000 }], userId: alice });
    const firstIds = getSplits(id).map((r) => r.id);

    setTransactionSplits({ txnId: id, parts: [{ categoryId: coffee, amountCents: -1000 }, { categoryId: groceries, amountCents: -4000 }], userId: alice });
    const rows = getSplits(id);

    expect(rows).toHaveLength(2);
    expect(rows.some((r) => firstIds.includes(r.id))).toBe(false); // old rows really were deleted, not left behind
    expect(rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(-5000);
  });
});

describe('setTransactionSplits: validation', () => {
  it('throws naming the difference when parts do not sum to the parent amount', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add({ amountCents: -10000 });

    // Parts total -$90.00 against a -$100.00 parent: a $10.00 shortfall.
    expect(() =>
      setTransactionSplits({
        txnId: id,
        parts: [
          { categoryId: groceries, amountCents: -6000 },
          { categoryId: coffee, amountCents: -3000 },
        ],
        userId: alice,
      }),
    ).toThrow(/\$10\.00/);
    expect(getSplits(id)).toHaveLength(0); // the whole attempt rolled back
  });

  it('throws when given exactly one part', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const id = add({ amountCents: -5000 });

    expect(() => setTransactionSplits({ txnId: id, parts: [{ categoryId: groceries, amountCents: -5000 }], userId: alice })).toThrow(/at least 2/i);
    expect(getSplits(id)).toHaveLength(0);
  });

  it('throws when a part\'s sign does not match the parent\'s sign', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add({ amountCents: -10000 });

    // Sums correctly to -10000 (5000 + -15000), but the first part has the wrong sign.
    expect(() =>
      setTransactionSplits({
        txnId: id,
        parts: [
          { categoryId: groceries, amountCents: 5000 },
          { categoryId: coffee, amountCents: -15000 },
        ],
        userId: alice,
      }),
    ).toThrow(/sign/i);
    expect(getSplits(id)).toHaveLength(0);
  });

  it('throws the exact message when the parent is a transfer', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add({ amountCents: -5000, isTransfer: true });

    expect(() =>
      setTransactionSplits({
        txnId: id,
        parts: [
          { categoryId: groceries, amountCents: -3000 },
          { categoryId: coffee, amountCents: -2000 },
        ],
        userId: alice,
      }),
    ).toThrow('Transfers cannot be split.');
    expect(getSplits(id)).toHaveLength(0);
  });

  it('throws when a part\'s category is archived', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    archiveCategory(coffee, true);
    const id = add({ amountCents: -5000 });

    expect(() =>
      setTransactionSplits({
        txnId: id,
        parts: [
          { categoryId: groceries, amountCents: -3000 },
          { categoryId: coffee, amountCents: -2000 },
        ],
        userId: alice,
      }),
    ).toThrow(/archived/i);
    expect(getSplits(id)).toHaveLength(0);
  });

  it('throws when a part names a category that does not exist', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const id = add({ amountCents: -5000 });

    expect(() =>
      setTransactionSplits({
        txnId: id,
        parts: [
          { categoryId: 999999, amountCents: -3000 },
          { categoryId: groceries, amountCents: -2000 },
        ],
        userId: alice,
      }),
    ).toThrow(/No category 999999/);
  });

  it('throws when the parent transaction does not exist', () => {
    const { alice } = setup();
    const groceries = categoryIdByName(current!.db, 'Groceries');
    const coffee = categoryIdByName(current!.db, 'Coffee');
    expect(() =>
      setTransactionSplits({
        txnId: 999999,
        parts: [
          { categoryId: groceries, amountCents: -3000 },
          { categoryId: coffee, amountCents: -2000 },
        ],
        userId: alice,
      }),
    ).toThrow(/No transaction 999999/);
  });
});

describe('setTransactionSplits: review queue interplay', () => {
  // REVIEW_WHERE (engine.ts) is and(isTransfer=false, or(categoryId is null, source='bayes')).
  // A split leaves the parent's category_id exactly as it was, so the ONLY fixture where
  // stamping source='manual' actually flips REVIEW_WHERE to false is a row that was already
  // sitting in the queue as an unconfirmed BAYES GUESS (category_id already non-null). A
  // truly uncategorized row (category_id NULL) stays matched by the null-category disjunct
  // regardless of source, split or not -- see the "clearing" test below for that case.
  it('a Bayes-guessed row leaves the review queue once it is split', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add({ amountCents: -10000, categoryId: groceries, source: 'bayes' });

    expect(inReviewQueue(db, id)).toBe(true);

    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -7000 },
        { categoryId: coffee, amountCents: -3000 },
      ],
      userId: alice,
    });

    expect(inReviewQueue(db, id)).toBe(false);
  });

  it('clearing a split on an uncategorized row resets categorization_source to none and reruns the engine', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add({ amountCents: -10000, categoryId: null, source: 'none' });
    expect(inReviewQueue(db, id)).toBe(true);

    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -7000 },
        { categoryId: coffee, amountCents: -3000 },
      ],
      userId: alice,
    });

    setTransactionSplits({ txnId: id, parts: [], userId: alice });

    expect(getSplits(id)).toHaveLength(0);
    const parent = db.select().from(transactions).where(eq(transactions.id, id)).get()!;
    expect(parent.categorizationSource).toBe('none');
    expect(parent.categoryId).toBeNull();
    // Nothing in the seeded db matches this merchant, so the reran engine leaves it
    // uncategorized -- and, critically, still inside the review queue it started in.
    expect(inReviewQueue(db, id)).toBe(true);
  });

  it('clearing a split leaves an already-confirmed category alone (does not blank it or rerun the engine)', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add({ amountCents: -5000, categoryId: groceries, source: 'rule' });

    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -3000 },
        { categoryId: coffee, amountCents: -2000 },
      ],
      userId: alice,
    });
    setTransactionSplits({ txnId: id, parts: [], userId: alice });

    const parent = db.select().from(transactions).where(eq(transactions.id, id)).get()!;
    // category_id was never null, so the "give the engine another shot" branch never fires;
    // the row keeps the manual stamp the split itself applied rather than being reset.
    expect(parent.categoryId).toBe(groceries);
    expect(parent.categorizationSource).toBe('manual');
  });

  it('clearing a split still bumps updated_at even when category_id is not null (the budget-evaluator fingerprint depends on this)', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add({ amountCents: -5000, categoryId: groceries, source: 'rule' });

    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -3000 },
        { categoryId: coffee, amountCents: -2000 },
      ],
      userId: alice,
    });

    // Force updated_at to a known-stale value so the clear's own bump is unambiguous,
    // independent of how close together the two setTransactionSplits calls land in real time.
    db.run(sql`update transactions set updated_at = ${SENTINEL_TIMESTAMP} where id = ${id}`);

    setTransactionSplits({ txnId: id, parts: [], userId: alice });

    const parent = db.select().from(transactions).where(eq(transactions.id, id)).get()!;
    // category_id was never null, so categorization_source stays exactly as the split left it
    // (see the test above) -- but updated_at MUST move regardless. evaluateBudgets()'s
    // fingerprint (src/lib/notify/evaluate/budget.ts) is built from
    // max(transactions.updated_at); that is the ONLY column that changes when a split is
    // cleared off a row that already carried a category, so if this stays stale the evaluator
    // can silently miss a budget that just went over (see the end-to-end reproduction in
    // tests/lib/notify/evaluate/budget.test.ts).
    expect(parent.categoryId).toBe(groceries);
    expect(parent.categorizationSource).toBe('manual');
    expect(parent.updatedAt).not.toBe(SENTINEL_TIMESTAMP);
  });
});

describe('getSplits', () => {
  it('returns an empty array for a transaction that was never split', () => {
    const { add } = setup();
    const id = add();
    expect(getSplits(id)).toEqual([]);
  });
});

describe('splitsForTransactions', () => {
  it('batches splits for several transactions, keyed by txnId, omitting unsplit ones', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const restaurants = categoryIdByName(db, 'Restaurants');

    const twoPart = add({ amountCents: -5000 });
    const unsplit = add({ amountCents: -2000 });
    const threePart = add({ amountCents: -6000 });

    setTransactionSplits({ txnId: twoPart, parts: [{ categoryId: groceries, amountCents: -3000 }, { categoryId: coffee, amountCents: -2000 }], userId: alice });
    setTransactionSplits({
      txnId: threePart,
      parts: [
        { categoryId: groceries, amountCents: -3000 },
        { categoryId: coffee, amountCents: -2000 },
        { categoryId: restaurants, amountCents: -1000 },
      ],
      userId: alice,
    });

    const result = splitsForTransactions([twoPart, unsplit, threePart]);
    expect(result.get(twoPart)).toHaveLength(2);
    expect(result.get(threePart)).toHaveLength(3);
    expect(result.has(unsplit)).toBe(false);
  });

  it('is empty-safe for an empty id list', () => {
    setup();
    const result = splitsForTransactions([]);
    expect(result.size).toBe(0);
  });
});

describe('EFFECTIVE_CATEGORY / EFFECTIVE_AMOUNT (the split-aware LEFT JOIN)', () => {
  it('an unsplit transaction yields exactly one row carrying its own category and amount', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const id = add({ amountCents: -4321, categoryId: groceries });

    const rows = db
      .select({ txnId: transactions.id, categoryId: EFFECTIVE_CATEGORY, amountCents: EFFECTIVE_AMOUNT })
      .from(transactions)
      .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
      .where(eq(transactions.id, id))
      .all();

    expect(rows).toEqual([{ txnId: id, categoryId: groceries, amountCents: -4321 }]);
  });

  it('an N-way split transaction yields N rows carrying each part\'s effective category and amount', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const restaurants = categoryIdByName(db, 'Restaurants');
    const id = add({ amountCents: -6000, categoryId: groceries });

    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -3000 },
        { categoryId: coffee, amountCents: -2000 },
        { categoryId: restaurants, amountCents: -1000 },
      ],
      userId: alice,
    });

    const rows = db
      .select({ txnId: transactions.id, categoryId: EFFECTIVE_CATEGORY, amountCents: EFFECTIVE_AMOUNT })
      .from(transactions)
      .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
      .where(eq(transactions.id, id))
      .all();

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.txnId === id)).toBe(true);
    expect(rows.map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([-3000, -2000, -1000].sort((a, b) => a - b));
    const effectiveCategoryIds = rows.map((r) => r.categoryId);
    expect(effectiveCategoryIds.every((categoryId) => categoryId !== null)).toBe(true); // coalesce never falls through to the parent here
    expect((effectiveCategoryIds as number[]).sort((a, b) => a - b)).toEqual([groceries, coffee, restaurants].sort((a, b) => a - b));
    // The parent's OWN category_id (groceries, untouched by the split) never leaks through
    // as a 4th row or as a value alongside the three real parts -- coalesce always prefers
    // the split row once one exists for that (txn, category) join.
    expect(rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(-6000);
  });
});

// Sanity check for the difference-naming test above: prove formatCents actually produces
// the string being asserted on, so that test can't pass for the wrong reason.
describe('sanity', () => {
  it('formatCents(1000) really is "$10.00"', () => {
    expect(formatCents(1000)).toBe('$10.00');
  });
});
