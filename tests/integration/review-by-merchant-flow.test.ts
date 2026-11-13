import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { reviewQueueCount, runEngine } from '@/lib/categorize/engine';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { commitImport } from '@/lib/import/commit';
import { computeRowHashes } from '@/lib/import/dedup';
import { BULK_UNDO_STALE_ERROR } from '@/lib/bulk-undo';

/**
 * v1.62.0 (plan B7). Needs review by merchant, end to end through the real actions: one decision
 * files a merchant's queued rows and remembers it for the next import, and an Undo within 15
 * minutes puts the queue back as it was. Explicit clock (Date only), invented household.
 */
const user = vi.hoisted(() => ({
  value: { id: 0, name: 'Alex', username: 'alex', role: 'admin' as 'admin' | 'member', visibility: 'household' as 'household' | 'self' },
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: vi.fn(async () => user.value) }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { reviewMerchantGroupAction, undoBulkAction } from '@/app/(app)/transactions/actions';

const DECIDED = new Date('2026-03-14T15:00:00.000Z');
const TEN_MINUTES_ON = new Date('2026-03-14T15:10:00.000Z');

let t: TestDb | null = null;
beforeEach(() => {
  vi.useFakeTimers({ now: DECIDED, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  t?.cleanup();
  t = null;
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

/** Six rows waiting in Needs review: three MAPLE GROCER, two FUEL STOP 12, one STREAMBOX. */
function sixRowQueue() {
  t = createSeededTestDb();
  const db = t;
  const alex = insertTestUser(db.db, { name: 'Alex', username: 'alex', role: 'admin' });
  insertTestUser(db.db, { name: 'Sam', username: 'sam', role: 'member' });
  user.value = { id: alex, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
  const accountId = insertTestAccount(db.db, { name: 'Joint Chequing' });
  const insert = db.sqlite.prepare(
    `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, '2026-03-14T09:00:00.000Z', '2026-03-14T09:00:00.000Z') returning id`,
  );
  const add = (description: string, amountCents: number, date: string) =>
    (insert.get(accountId, date, description, normalizeMerchant(description), amountCents, alex) as { id: number }).id;
  const maple = [add('MAPLE GROCER', -4217, '2026-03-02'), add('MAPLE GROCER', -1805, '2026-03-09'), add('MAPLE GROCER', -6340, '2026-03-12')];
  add('FUEL STOP 12', -6130, '2026-03-05');
  add('FUEL STOP 12', -5500, '2026-03-11');
  add('STREAMBOX', -1699, '2026-03-08');
  const groceries = categoryIdByName(db.db, 'Groceries');
  const row = (id: number) =>
    db.sqlite.prepare('select category_id as categoryId, categorization_source as source from transactions where id = ?').get(id) as {
      categoryId: number | null;
      source: string;
    };
  const mapleRules = () => db.sqlite.prepare("select * from merchant_rules where pattern = 'MAPLE GROCER' and rule_kind = 'category'").all();
  // The import as commitStagedImport (src/lib/import/flow.ts) runs it: commit, then the engine.
  const nextImport = () => {
    const committed = commitImport({
      accountId,
      profileId: null,
      filename: 'march-2.csv',
      importedBy: alex,
      rows: computeRowHashes(accountId, [
        { rowIndex: 0, rawDate: '2026-03-16', date: '2026-03-16', rawDescription: 'MAPLE GROCER', amountCents: -2875, balanceCents: null, cells: [] },
      ]),
      errors: [],
      origin: 'csv',
      at: TEN_MINUTES_ON,
    });
    runEngine(committed.insertedTransactionIds);
    return committed;
  };
  return { maple, groceries, row, mapleRules, nextImport };
}

function fileMapleAsGroceries(groceries: number) {
  return reviewMerchantGroupAction(
    {},
    form({ scope: 'review=1&group=merchant', merchant: 'MAPLE GROCER', decision: 'category', categoryId: String(groceries), createRules: 'on' }),
  );
}

describe('review by merchant, end to end (v1.62.0 B7)', () => {
  it('one decision files the merchant, and the next import of it files by rule', async () => {
    const q = sixRowQueue();
    expect(reviewQueueCount()).toBe(6);

    expect(await fileMapleAsGroceries(q.groceries)).toEqual({ message: 'Categorized 3 transactions from MAPLE GROCER as Groceries.' });
    expect(reviewQueueCount()).toBe(3);
    expect(q.mapleRules()).toHaveLength(1);

    vi.setSystemTime(TEN_MINUTES_ON);
    const imported = q.nextImport();
    expect(imported.rowsAdded).toBe(1);
    expect(q.row(imported.insertedTransactionIds[0] as number)).toEqual({ categoryId: q.groceries, source: 'rule' });
    expect(reviewQueueCount()).toBe(3);
  });

  it('an Undo within 15 minutes puts the three rows back in the queue and removes the rule', async () => {
    const q = sixRowQueue();
    await fileMapleAsGroceries(q.groceries);
    expect(reviewQueueCount()).toBe(3);

    vi.setSystemTime(TEN_MINUTES_ON);
    expect(await undoBulkAction({}, form({}))).toEqual({ message: 'Undone. 3 transactions are back as they were; 1 rule removed.' });
    for (const id of q.maple) expect(q.row(id)).toEqual({ categoryId: null, source: 'none' });
    expect(q.mapleRules()).toEqual([]);
    expect(reviewQueueCount()).toBe(6);
  });

  it('once the next import has used the rule, the Undo refuses and changes nothing', async () => {
    const q = sixRowQueue();
    await fileMapleAsGroceries(q.groceries);
    vi.setSystemTime(TEN_MINUTES_ON);
    q.nextImport();
    const rulesBefore = q.mapleRules();

    expect(await undoBulkAction({}, form({}))).toEqual({ error: BULK_UNDO_STALE_ERROR });
    expect(q.mapleRules()).toEqual(rulesBefore);
    for (const id of q.maple) expect(q.row(id)).toEqual({ categoryId: q.groceries, source: 'manual' });
  });
});
