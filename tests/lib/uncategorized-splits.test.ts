import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import type { Viewer } from '@/lib/auth/viewer';
import { groupTransactionsByCategory, listTransactions } from '@/lib/transactions';
import { setTransactionSplits } from '@/lib/splits';
import { nowIso } from '@/lib/clock';

const HOUSEHOLD: Viewer = { id: 1, role: 'admin', visibility: 'household' };

/**
 * "Uncategorized" means no category AND no split parts. A fully split row keeps category_id null
 * on the parent -- its categories live in transaction_splits -- so a bare `category_id is null`
 * lists it as uncategorized while the grouped view (split-aware) counts it under its parts.
 */
let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db);
  const accountId = insertTestAccount(current.db);
  const groceries = categoryIdByName(current.db, 'Groceries');
  const coffee = categoryIdByName(current.db, 'Coffee');
  const add = (merchant: string, amountCents: number, categoryId: number | null) =>
    current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-10', ${merchant}, ${merchant}, ${amountCents}, ${categoryId}, 'none', ${userId}, ${nowIso()}, ${nowIso()})
      returning id`).id;

  const plain = add('CORNER KIOSK', -1500, null);
  const split = add('HARBOUR MART', -6000, null);
  setTransactionSplits({
    txnId: split,
    parts: [
      { categoryId: groceries, amountCents: -4000 },
      { categoryId: coffee, amountCents: -2000 },
    ],
    userId,
  });
  const filed = add('BEAN BARN', -450, coffee);
  return { plain, split, filed };
}

const ids = (filter: Parameters<typeof listTransactions>[0]) =>
  listTransactions({ pageSize: 200, ...filter }, HOUSEHOLD).rows.map((row) => row.id);

describe('a fully split row is not uncategorized', () => {
  it('is absent from the Uncategorized drill-down; an unsplit row with no category is still there', () => {
    const { plain, split, filed } = setup();
    const listed = ids({ categoryId: 'uncategorized' });
    expect(listed).toContain(plain);
    expect(listed).not.toContain(split);
    expect(listed).not.toContain(filed);
  });

  it('is absent from the uncategorized-only filter', () => {
    const { plain, split } = setup();
    const listed = ids({ uncategorizedOnly: true });
    expect(listed).toContain(plain);
    expect(listed).not.toContain(split);
  });

  it('is absent from the review queue uncategorized tab', () => {
    const { plain, split } = setup();
    const listed = ids({ reviewOnly: true, reviewQueue: 'uncategorized' });
    expect(listed).toContain(plain);
    expect(listed).not.toContain(split);
  });

  it('the Uncategorized cluster header and its drill-down list agree', () => {
    setup();
    const groups = groupTransactionsByCategory({}, HOUSEHOLD).groups;
    const header = groups.find((group) => group.categoryId === null);
    const list = listTransactions({ categoryId: 'uncategorized', pageSize: 200 }, HOUSEHOLD);
    expect(header?.count).toBe(list.total);
  });
});
