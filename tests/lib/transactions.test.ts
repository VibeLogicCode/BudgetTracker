import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import type { Viewer } from '@/lib/auth/viewer';
import {
  bulkAssignToLoan,
  bulkSetAttribution,
  bulkSetCategory,
  bulkSetNotes,
  bulkSetTransfer,
  countMatchingMerchant,
  createManualTransaction,
  displayNameOf,
  getTransaction,
  groupTransactionsByCategory,
  listReviewQueue,
  listTransactions,
  manualTransactionSchema,
  transactionOwners,
  updateTransactionNotes,
  type TransactionFilter,
} from '@/lib/transactions';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { listRules, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { setTransactionDisplayName, upsertRenameRule } from '@/lib/categorize/engine';
import { nowIso } from '@/lib/clock';
import { setTransactionSplits } from '@/lib/splits';
import { loanLinksForTransactions } from '@/lib/loans';
import { createWarrantyItem } from '@/lib/warranty/items';
import { createItemType } from '@/lib/warranty/types';

// v1.13.0 ruling R2: listTransactions/getTransaction now require a viewer. Every existing call in
// this file predates viewer scoping and expects the pre-v1.13.0, household-wide result set, so a
// household viewer here reproduces byte-identical behaviour to before.
const VIEWER: Viewer = { id: 1, role: 'admin', visibility: 'household' };

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const bob = insertTestUser(current.db, { name: 'Bob', username: 'bob' });
  const joint = insertTestAccount(current.db, { name: 'Joint Chequing' });
  const aliceVisa = insertTestAccount(current.db, { name: 'Alice Visa', type: 'credit', ownerUserId: alice });

  // v1.26.0 Lane 2 item 2 added `importId` (defaulting to null, i.e. today's behaviour for every
  // pre-existing caller in this file) so the import filter and the grouped aggregate can be given
  // rows that belong to a real import batch.
  const add = (over: Partial<{ accountId: number; date: string; description: string; amountCents: number; categoryId: number | null; attributedUserId: number | null; source: string; isTransfer: boolean; importId: number | null }> = {}) => {
    const description = over.description ?? 'TIM HORTONS';
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, import_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${over.accountId ?? joint}, ${over.importId ?? null}, ${over.date ?? '2026-03-02'}, ${description}, ${normalizeMerchant(description)},
              ${over.amountCents ?? -1000}, ${over.categoryId ?? null}, ${over.source ?? 'none'},
              ${over.isTransfer ? 1 : 0}, ${over.attributedUserId ?? null}, ${alice}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { db: current.db, sqlite: current.sqlite, alice, bob, joint, aliceVisa, add };
}

describe('listTransactions', () => {
  it('paginates newest first and reports the total', () => {
    const { add } = setup();
    for (let i = 1; i <= 12; i += 1) add({ date: `2026-03-${String(i).padStart(2, '0')}`, description: `SHOP ${i}` });
    const page = listTransactions({ pageSize: 5, page: 1 }, VIEWER);
    expect(page.total).toBe(12);
    expect(page.pageCount).toBe(3);
    expect(page.rows).toHaveLength(5);
    expect(page.rows[0].date).toBe('2026-03-12');
    expect(listTransactions({ pageSize: 5, page: 3 }, VIEWER).rows).toHaveLength(2);
  });

  it('joins the account, category and attributed user names', () => {
    const { db, alice, joint, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add({ categoryId: coffee, attributedUserId: alice, source: 'manual' });
    const row = listTransactions({}, VIEWER).rows.find((r) => r.id === id)!;
    expect(row).toMatchObject({
      accountId: joint,
      accountName: 'Joint Chequing',
      categoryId: coffee,
      categoryName: 'Coffee',
      attributedUserId: alice,
      attributedUserName: 'Alice',
      source: 'manual',
      normalizedMerchant: 'TIM HORTONS',
    });
  });

  it('filters by account, category, person, date range and text search', () => {
    const { db, alice, bob, joint, aliceVisa, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    const a = add({ accountId: joint, categoryId: coffee, attributedUserId: alice, date: '2026-03-01', description: 'TIM HORTONS' });
    const b = add({ accountId: aliceVisa, categoryId: groceries, attributedUserId: bob, date: '2026-04-15', description: 'LOBLAWS #1042' });

    expect(listTransactions({ accountId: joint }, VIEWER).rows.map((r) => r.id)).toEqual([a]);
    expect(listTransactions({ categoryId: groceries }, VIEWER).rows.map((r) => r.id)).toEqual([b]);
    expect(listTransactions({ attributedUserId: alice }, VIEWER).rows.map((r) => r.id)).toEqual([a]);
    expect(listTransactions({ from: '2026-04-01' }, VIEWER).rows.map((r) => r.id)).toEqual([b]);
    expect(listTransactions({ to: '2026-03-31' }, VIEWER).rows.map((r) => r.id)).toEqual([a]);
    expect(listTransactions({ search: 'loblaws' }, VIEWER).rows.map((r) => r.id)).toEqual([b]);
    expect(listTransactions({ search: 'hortons' }, VIEWER).rows.map((r) => r.id)).toEqual([a]);
  });

  /**
   * v1.21.0 item 3 (owner's screenshot of the chip row: "filter on page transactions only
   * filter where i directly assign parent and ignore all child"). A top-level chip's own
   * meaning is "this category and its children" -- the same rule foldRollup (budgets.ts) and
   * categoryBreakdown's parentId ?? categoryId (reports.ts) already use for the SAME category's
   * total, so the list a chip shows now agrees with the number that chip's own budget card
   * counts.
   */
  it('a parent category matches its own direct rows AND every child\'s -- what a chip means', () => {
    const { db, add } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    const health = categoryIdByName(db, 'Health');
    const direct = add({ categoryId: food, description: 'FARMERS MARKET' });
    const child = add({ categoryId: groceries, description: 'LOBLAWS' });
    const unrelated = add({ categoryId: health, description: 'PHARMACY' });

    expect(listTransactions({ categoryId: food }, VIEWER).rows.map((r) => r.id).sort()).toEqual([direct, child].sort());
    expect(unrelated).toBeGreaterThan(0);
  });

  /**
   * `exact: true` is the opposite, explicit mode -- what the Budgets "Not in a sub-category"
   * row's own drill-down wants (categoryTransactions in src/lib/budgets.ts already filters this
   * way for that surface; this is the same answer for Transactions' `?category=<id>&exact=1`).
   */
  it('categoryExact restricts the match to that category alone, no children', () => {
    const { db, add } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    const direct = add({ categoryId: food, description: 'FARMERS MARKET' });
    const child = add({ categoryId: groceries, description: 'LOBLAWS' });

    expect(listTransactions({ categoryId: food, categoryExact: true }, VIEWER).rows.map((r) => r.id)).toEqual([direct]);
    expect(child).toBeGreaterThan(0);
  });

  /**
   * Second defect found alongside the first: this filter used to read transactions.categoryId
   * while every TOTAL in the app reads EFFECTIVE_CATEGORY (split-aware, src/lib/splits.ts) --
   * so a $60 split to Groceries counted toward the Groceries budget but never appeared here.
   * The transaction's own (now stale) top-level categoryId is Coffee; only its PARTS decide
   * which category filter finds it once it has been split.
   */
  it('is split-aware: a split part is found by its OWN category, not the parent transaction\'s', () => {
    const { db, alice, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    const restaurants = categoryIdByName(db, 'Restaurants');
    const id = add({ categoryId: coffee, amountCents: -10000, description: 'MIXED RECEIPT' });
    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -6000 },
        { categoryId: restaurants, amountCents: -4000 },
      ],
      userId: alice,
    });

    expect(listTransactions({ categoryId: groceries }, VIEWER).rows.map((r) => r.id)).toEqual([id]);
    expect(listTransactions({ categoryId: restaurants }, VIEWER).rows.map((r) => r.id)).toEqual([id]);
    // The parent's own stale categoryId (Coffee) no longer decides anything once it is split.
    expect(listTransactions({ categoryId: coffee }, VIEWER).rows.map((r) => r.id)).toEqual([]);
  });

  it('treats % and _ in the search box as literal characters, not LIKE wildcards', () => {
    const { add } = setup();
    const literal = add({ description: 'CASHBACK 50% BONUS' });
    const decoy = add({ description: 'CASHBACK 5000 BONUS' });
    const underscore = add({ description: 'FEE_WAIVED' });
    const underscoreDecoy = add({ description: 'FEEXWAIVED' });

    // "50%" used to mean "50 followed by anything", which swept up the 5000 row.
    expect(listTransactions({ search: '50%' }, VIEWER).rows.map((r) => r.id)).toEqual([literal]);
    expect(listTransactions({ search: '50% ' }, VIEWER).rows.map((r) => r.id)).toEqual([literal]);
    // "_" used to match any single character, so FEEXWAIVED matched too.
    expect(listTransactions({ search: 'FEE_' }, VIEWER).rows.map((r) => r.id)).toEqual([underscore]);
    expect(listTransactions({ search: 'FEE' }, VIEWER).rows.map((r) => r.id).sort()).toEqual([underscore, underscoreDecoy].sort());
    expect(decoy).toBeGreaterThan(0);
  });

  it('treats a literal backslash in the search box as a backslash', () => {
    const { add } = setup();
    const withSlash = add({ description: 'A\\B STORE' });
    add({ description: 'AB STORE' });
    // The escape character itself has to be escaped, or "A\" would consume the next char.
    expect(listTransactions({ search: 'A\\B' }, VIEWER).rows.map((r) => r.id)).toEqual([withSlash]);
  });

  it('filters uncategorized and unattributed as first-class values', () => {
    const { db, alice, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const categorized = add({ categoryId: coffee, attributedUserId: alice });
    const bare = add({ description: 'SOME SHOP' });

    expect(listTransactions({ categoryId: 'uncategorized' }, VIEWER).rows.map((r) => r.id)).toEqual([bare]);
    expect(listTransactions({ uncategorizedOnly: true }, VIEWER).rows.map((r) => r.id)).toEqual([bare]);
    expect(listTransactions({ attributedUserId: 'unattributed' }, VIEWER).rows.map((r) => r.id)).toEqual([bare]);
    expect(listTransactions({}, VIEWER).total).toBe(2);
    expect(categorized).toBeGreaterThan(0);
  });

  /**
   * v1.24.0 Lane A item 2 (owner report: "currently once i apply a trasnfer its hard to find
   * that data again"). `transferView: 'only'` is the new state -- the recovery path for a
   * mis-tagged transfer, which REVIEW_WHERE (src/lib/categorize/engine.ts) excludes
   * unconditionally, so it needs its own way back into view. All three states proven against the
   * same fixture: one ordinary row, one transfer.
   */
  describe('transferView (Lane A item 2)', () => {
    it("'all' (and the default, omitted) returns both rows", () => {
      const { add } = setup();
      const normal = add({ description: 'TIM HORTONS' });
      const transfer = add({ description: 'PAYMENT - THANK YOU', isTransfer: true });
      expect(listTransactions({}, VIEWER).rows.map((r) => r.id).sort()).toEqual([normal, transfer].sort());
      expect(listTransactions({ transferView: 'all' }, VIEWER).rows.map((r) => r.id).sort()).toEqual(
        [normal, transfer].sort(),
      );
    });

    it("'none' excludes transfers -- the old includeTransfers: false behaviour", () => {
      const { add } = setup();
      const normal = add({ description: 'TIM HORTONS' });
      add({ description: 'PAYMENT - THANK YOU', isTransfer: true });
      expect(listTransactions({ transferView: 'none' }, VIEWER).rows.map((r) => r.id)).toEqual([normal]);
    });

    it("'only' returns transfers and nothing else -- the recovery path for a mis-tagged one", () => {
      const { add } = setup();
      add({ description: 'TIM HORTONS' });
      const transfer = add({ description: 'PAYMENT - THANK YOU', isTransfer: true });
      expect(listTransactions({ transferView: 'only' }, VIEWER).rows.map((r) => r.id)).toEqual([transfer]);
    });
  });

  it('clamps the page size', () => {
    const { add } = setup();
    add();
    expect(listTransactions({ pageSize: 5000 }, VIEWER).pageSize).toBe(200);
    expect(listTransactions({ pageSize: 0 }, VIEWER).pageSize).toBe(50);
    expect(listTransactions({ page: -3 }, VIEWER).page).toBe(1);
  });
});

describe('createManualTransaction', () => {
  it('stores a NULL dedup hash and NULL import id', () => {
    const { sqlite, alice, joint } = setup();
    const id = createManualTransaction({
      accountId: joint,
      date: '2026-03-02',
      description: 'Farmers market',
      amountCents: -2500,
      categoryId: null,
      attributedUserId: alice,
      userId: alice,
      actorRole: 'admin',
    });
    const row = sqlite.prepare('select dedup_hash, import_id, created_by, attributed_user_id, normalized_merchant, categorization_source from transactions where id = ?').get(id) as Record<string, unknown>;
    expect(row).toMatchObject({ dedup_hash: null, import_id: null, created_by: alice, attributed_user_id: alice, normalized_merchant: 'FARMERS MARKET' });
  });

  it('lets two identical manual entries coexist', () => {
    const { alice, joint } = setup();
    const make = () =>
      createManualTransaction({ accountId: joint, date: '2026-03-02', description: 'Coffee', amountCents: -500, categoryId: null, attributedUserId: alice, userId: alice, actorRole: 'admin' });
    const first = make();
    const second = make();
    expect(second).not.toBe(first);
    expect(listTransactions({}, VIEWER).total).toBe(2);
  });

  it('defaults attribution to the account owner when none is given', () => {
    const { sqlite, alice, aliceVisa, joint } = setup();
    const personal = createManualTransaction({ accountId: aliceVisa, date: '2026-03-02', description: 'Coffee', amountCents: -500, categoryId: null, attributedUserId: null, userId: alice, actorRole: 'admin' });
    const shared = createManualTransaction({ accountId: joint, date: '2026-03-02', description: 'Coffee', amountCents: -500, categoryId: null, attributedUserId: null, userId: alice, actorRole: 'admin' });
    expect((sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(personal) as { a: number | null }).a).toBe(alice);
    expect((sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(shared) as { a: number | null }).a).toBeNull();
  });

  it('runs the engine on the new row', () => {
    const { db, sqlite, alice, joint } = setup();
    const id = createManualTransaction({ accountId: joint, date: '2026-03-02', description: 'PAYMENT - THANK YOU', amountCents: 50000, categoryId: null, attributedUserId: null, userId: alice, actorRole: 'admin' });
    expect((sqlite.prepare('select is_transfer from transactions where id = ?').get(id) as { is_transfer: number }).is_transfer).toBe(1);
    expect(db).toBeDefined();
  });

  it('treats an explicit category as a confirmation that trains Bayes and makes a rule', () => {
    const { db, sqlite, alice, joint } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = createManualTransaction({ accountId: joint, date: '2026-03-02', description: 'Tim Hortons', amountCents: -485, categoryId: coffee, attributedUserId: alice, userId: alice, actorRole: 'admin' });
    const row = sqlite.prepare('select category_id, categorization_source from transactions where id = ?').get(id) as { category_id: number; categorization_source: string };
    expect(row).toEqual({ category_id: coffee, categorization_source: 'manual' });
    expect(listRules('category').map((r) => r.pattern)).toEqual(['TIM HORTONS']);
  });

  it('runs transfer detection even when a category was chosen, and keeps that category', () => {
    const { db, sqlite, alice, joint } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = createManualTransaction({
      accountId: joint,
      date: '2026-03-02',
      description: 'TD VISA PAYMENT',
      amountCents: 50000,
      categoryId: coffee,
      attributedUserId: alice,
      userId: alice,
      actorRole: 'admin',
    });
    const row = sqlite
      .prepare('select is_transfer, category_id, categorization_source from transactions where id = ?')
      .get(id) as { is_transfer: number; category_id: number; categorization_source: string };
    // Previously the engine was skipped entirely whenever a category came in, so a
    // hand-entered card payment could never be flagged as a transfer.
    expect(row.is_transfer).toBe(1);
    // ...and the engine must not have overridden the user's explicit choice.
    expect(row.category_id).toBe(coffee);
    expect(row.categorization_source).toBe('manual');
  });

  it('applies rename rules to a manual entry that arrives with a category', () => {
    const { db, sqlite, alice, joint } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    upsertRenameRule({ pattern: 'TIM HORTONS', matchType: 'exact', renameTo: 'Morning coffee', userId: alice, actorRole: 'admin' });
    const id = createManualTransaction({
      accountId: joint,
      date: '2026-03-02',
      description: 'Tim Hortons',
      amountCents: -485,
      categoryId: coffee,
      attributedUserId: alice,
      userId: alice,
      actorRole: 'admin',
    });
    const row = sqlite
      .prepare('select display_description, display_source, category_id from transactions where id = ?')
      .get(id) as { display_description: string | null; display_source: string | null; category_id: number };
    expect(row.display_description).toBe('Morning coffee');
    expect(row.display_source).toBe('rename');
    expect(row.category_id).toBe(coffee);
  });

  it('validates its input with zod', () => {
    expect(manualTransactionSchema.safeParse({ accountId: 1, date: '2026-13-40', description: 'x', amountCents: -1, categoryId: null, attributedUserId: null }).success).toBe(false);
    expect(manualTransactionSchema.safeParse({ accountId: 1, date: '2026-03-02', description: '', amountCents: -1, categoryId: null, attributedUserId: null }).success).toBe(false);
    expect(manualTransactionSchema.safeParse({ accountId: 1, date: '2026-03-02', description: 'x', amountCents: 0, categoryId: null, attributedUserId: null }).success).toBe(true);
  });

  // v1.13.0 whole-branch review, item I4. confirmCategory was previously called with
  // actorRole: 'admin' hardcoded and createRule defaulting on, so ANY caller's quick-add --
  // including a member's -- would silently overwrite a merchant rule someone else in the
  // household owns, bypassing ruling R4 entirely for this one write path.
  describe('ruling R4 (item I4): actorRole threaded through, so a member cannot silently overwrite a foreign-owned rule', () => {
    it("refuses a member's quick-add over a foreign-owned rule, and inserts no row at all", () => {
      const { db, sqlite, alice, joint } = setup();
      const charlie = insertTestUser(db, { name: 'Charlie', username: 'charlie', role: 'member' });
      const coffee = categoryIdByName(db, 'Coffee');
      const groceries = categoryIdByName(db, 'Groceries');
      // Alice (admin) owns the TIM HORTONS -> Coffee rule.
      upsertRuleFromCorrection({
        pattern: normalizeMerchant('TIM HORTONS'),
        matchType: 'exact',
        ruleKind: 'category',
        categoryId: coffee,
        createdBy: alice,
        actorRole: 'admin',
      });
      const before = (sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c;

      expect(() =>
        createManualTransaction({
          accountId: joint,
          date: '2026-03-02',
          description: 'Tim Hortons',
          amountCents: -485,
          categoryId: groceries,
          attributedUserId: charlie,
          userId: charlie,
          actorRole: 'member',
        }),
      ).toThrow('Alice set up this rule. Ask an admin to change it under Settings → Categories & rules.');

      // No row inserted -- the whole write rolled back, not merely left uncategorized.
      const after = (sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c;
      expect(after).toBe(before);
      // The rule itself is untouched.
      expect(listRules('category').find((r) => r.pattern === normalizeMerchant('TIM HORTONS'))?.categoryId).toBe(coffee);
    });

    it('an admin CAN overwrite the same rule via quick-add', () => {
      const { db, sqlite, alice, joint } = setup();
      const charlie = insertTestUser(db, { name: 'Charlie', username: 'charlie', role: 'member' });
      const coffee = categoryIdByName(db, 'Coffee');
      const groceries = categoryIdByName(db, 'Groceries');
      upsertRuleFromCorrection({
        pattern: normalizeMerchant('TIM HORTONS'),
        matchType: 'exact',
        ruleKind: 'category',
        categoryId: coffee,
        createdBy: alice,
        actorRole: 'admin',
      });

      const id = createManualTransaction({
        accountId: joint,
        date: '2026-03-02',
        description: 'Tim Hortons',
        amountCents: -485,
        categoryId: groceries,
        attributedUserId: charlie,
        userId: charlie,
        actorRole: 'admin',
      });

      const row = sqlite.prepare('select category_id as c from transactions where id = ?').get(id) as { c: number | null };
      expect(row.c).toBe(groceries);
      expect(listRules('category').find((r) => r.pattern === normalizeMerchant('TIM HORTONS'))?.categoryId).toBe(groceries);
    });
  });
});

describe('bulk actions', () => {
  it('sets attribution without touching created_by', () => {
    const { sqlite, alice, bob, add } = setup();
    const ids = [add(), add({ description: 'LOBLAWS' })];
    expect(bulkSetAttribution(ids, bob)).toBe(2);
    const rows = sqlite.prepare('select attributed_user_id, created_by from transactions').all() as { attributed_user_id: number; created_by: number }[];
    expect(rows.every((r) => r.attributed_user_id === bob)).toBe(true);
    expect(rows.every((r) => r.created_by === alice)).toBe(true);
    expect(bulkSetAttribution(ids, null)).toBe(2);
    expect((sqlite.prepare('select count(*) as c from transactions where attributed_user_id is null').get() as { c: number }).c).toBe(2);
  });

  it('bulk categorize confirms every row and can create rules', () => {
    const { db, sqlite, alice, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const ids = [add({ description: 'TIM HORTONS' }), add({ description: 'STARBUCKS' })];
    expect(bulkSetCategory(ids, coffee, alice, true, 'admin')).toEqual({ ok: true, changed: 2, skipped: 0 });
    const rows = sqlite.prepare('select category_id, categorization_source from transactions').all() as { category_id: number; categorization_source: string }[];
    expect(rows.every((r) => r.category_id === coffee && r.categorization_source === 'manual')).toBe(true);
    expect(listRules('category').map((r) => r.pattern).sort()).toEqual(['STARBUCKS', 'TIM HORTONS']);
  });

  it('bulk categorize can skip rule creation', () => {
    const { db, alice, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    bulkSetCategory([add()], coffee, alice, false, 'admin');
    expect(listRules('category')).toHaveLength(0);
  });

  it('bulk mark transfer teaches exact transfer rules', () => {
    const { sqlite, alice, add } = setup();
    const ids = [add({ description: 'E-TRANSFER SENT J DOE' })];
    expect(bulkSetTransfer(ids, true, alice, 'admin')).toEqual({ ok: true, changed: 1, skipped: 0 });
    expect((sqlite.prepare('select is_transfer from transactions where id = ?').get(ids[0]) as { is_transfer: number }).is_transfer).toBe(1);
    expect(listRules('transfer').map((r) => ({ pattern: r.pattern, matchType: r.matchType }))).toEqual([
      { pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact' },
    ]);
  });

  it('bulk actions on an empty id list do nothing', () => {
    const { alice } = setup();
    expect(bulkSetAttribution([], null)).toBe(0);
    expect(bulkSetCategory([], 1, alice, true, 'admin')).toEqual({ ok: true, changed: 0, skipped: 0 });
    expect(bulkSetTransfer([], true, alice, 'admin')).toEqual({ ok: true, changed: 0, skipped: 0 });
  });

  /**
   * v1.25.0 Lane R item R3. bulkSetNotes is NOT subject to the split guard bulkSetCategory/
   * bulkSetTransfer honour above (see this function's own doc comment) -- a note is metadata
   * about the row, not a claim about which category the money belongs to. Every selected id is
   * written unconditionally, hence the plain `number` return, the same shape bulkSetAttribution
   * already uses just above for the same reason.
   */
  it('bulk note writes every selected row, INCLUDING a split one -- not subject to the split guard', () => {
    const { db, sqlite, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const splitId = add({ description: 'SPLIT MERCHANT' });
    setTransactionSplits({
      txnId: splitId,
      parts: [
        { categoryId: groceries, amountCents: -700 },
        { categoryId: gas, amountCents: -300 },
      ],
      userId: alice,
    });
    const plain = add({ description: 'CONTROL' });

    expect(bulkSetNotes([splitId, plain], 'shared with Bob')).toBe(2);
    const rows = sqlite.prepare('select id, notes from transactions where id in (?, ?)').all(splitId, plain) as { id: number; notes: string | null }[];
    expect(rows.every((r) => r.notes === 'shared with Bob')).toBe(true);
  });

  it('bulk note clears every selected row when given null, and does nothing for an empty id list', () => {
    const { sqlite, add } = setup();
    const id = add();
    bulkSetNotes([id], 'temp');
    expect(bulkSetNotes([id], null)).toBe(1);
    expect((sqlite.prepare('select notes from transactions where id = ?').get(id) as { notes: string | null }).notes).toBeNull();
    expect(bulkSetNotes([], 'x')).toBe(0);
  });
});

/**
 * v1.25.0 Lane R item R3. bulkAssignToLoan calls assignTransactionToLoan (src/lib/loans.ts,
 * a concurrent lane's file, not edited by this task) once per id -- MUST-13.2/MUST-13.16 and
 * rulings P4/B10 live there (tests/ops/loan-invariants.test.ts), not re-derived here. A loan-kind
 * warranty item is seeded via the real createItemType/createWarrantyItem entry points (the same
 * ones tests/app/transactions-actions.test.ts's own seedLoanItem uses), not raw SQL, so this
 * exercises the real Dataverse-shaped invariants those functions already enforce.
 */
describe('bulkAssignToLoan (v1.25.0 Lane R item R3)', () => {
  function seedLoan(userId: number, balanceCents = 2_000_000): number {
    const loanType = createItemType(`Loan ${Math.random().toString(36).slice(2)}`, 'loan');
    return createWarrantyItem({
      name: 'Car Loan',
      vendor: null,
      model: null,
      serial: null,
      purchaseDate: '2026-01-01',
      warrantyMonths: null,
      isLifetime: false,
      priceCents: null,
      ownerUserId: userId,
      transactionId: null,
      typeId: loanType.id,
      notes: null,
      principalCents: 3_000_000,
      interestRateBps: 0,
      currentBalanceCents: balanceCents,
      balanceUpdatedAt: nowIso(),
      loanDirection: 'owed',
    });
  }

  it('links every selected transaction to the given loan', () => {
    const { alice, add } = setup();
    const itemId = seedLoan(alice);
    const a = add({ description: 'PAYMENT A', amountCents: -1000 });
    const b = add({ description: 'PAYMENT B', amountCents: -2000 });

    expect(bulkAssignToLoan([a, b], itemId)).toEqual({ changed: 2, skipped: 0 });
    const links = loanLinksForTransactions([a, b]);
    expect(links.get(a)?.[0]?.itemId).toBe(itemId);
    expect(links.get(b)?.[0]?.itemId).toBe(itemId);
  });

  it('links a SPLIT transaction too -- NOT subject to the split guard bulkSetCategory/bulkSetTransfer honour', () => {
    const { db, alice, add } = setup();
    const itemId = seedLoan(alice);
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const splitId = add({ description: 'SPLIT MERCHANT', amountCents: -1000 });
    setTransactionSplits({
      txnId: splitId,
      parts: [
        { categoryId: groceries, amountCents: -700 },
        { categoryId: gas, amountCents: -300 },
      ],
      userId: alice,
    });

    // assignTransactionToLoan writes to loan_payments only, never category_id/is_transfer, so
    // the split's own per-part categorization is untouched by this -- see bulkAssignToLoan's own
    // doc comment (src/lib/transactions.ts) for the fuller justification.
    expect(bulkAssignToLoan([splitId], itemId)).toEqual({ changed: 1, skipped: 0 });
    expect(loanLinksForTransactions([splitId]).get(splitId)?.[0]?.itemId).toBe(itemId);
  });

  it('a row already linked to the SAME loan is reported skipped, not changed, and left as-is', () => {
    const { alice, add } = setup();
    const itemId = seedLoan(alice);
    const id = add({ description: 'PAYMENT A', amountCents: -1000 });

    expect(bulkAssignToLoan([id], itemId)).toEqual({ changed: 1, skipped: 0 });
    // Second call, same loan: assignTransactionToLoan's own `{ linked: false }` no-op.
    expect(bulkAssignToLoan([id], itemId)).toEqual({ changed: 0, skipped: 1 });
  });

  it('a row assignTransactionToLoan refuses outright (a zero-amount transaction) is caught and counted as skipped, without aborting the rest of the batch', () => {
    const { alice, add } = setup();
    const itemId = seedLoan(alice);
    const zero = add({ description: 'ZERO', amountCents: 0 });
    const ok = add({ description: 'PAYMENT A', amountCents: -1000 });

    // Order matters: the refusing id comes FIRST, proving one row's throw does not abort ids
    // after it in the same batch.
    expect(bulkAssignToLoan([zero, ok], itemId)).toEqual({ changed: 1, skipped: 1 });
    expect(loanLinksForTransactions([ok]).get(ok)?.[0]?.itemId).toBe(itemId);
    expect(loanLinksForTransactions([zero]).get(zero) ?? []).toHaveLength(0);
  });

  it('an empty id list changes and skips nothing', () => {
    const { alice } = setup();
    const itemId = seedLoan(alice);
    expect(bulkAssignToLoan([], itemId)).toEqual({ changed: 0, skipped: 0 });
  });
});

/**
 * v1.14.1 ruling R1. `?review=1` is a filter, not a page: reviewOnly pushes engine.ts's own
 * REVIEW_WHERE into buildWhere rather than restating the queue definition here, and flips the
 * order to oldest-first. listReviewQueue (below) stays as the byte-for-byte proof the two agree.
 */
describe('listTransactions reviewOnly (ruling R1)', () => {
  it('returns exactly the rows listReviewQueue returns, in the same oldest-first order', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const older = add({ date: '2026-03-01', description: 'SHOP A' });
    const bayesRow = add({ date: '2026-03-05', description: 'SHOP B', categoryId: groceries, source: 'bayes' });
    add({ date: '2026-03-06', description: 'SHOP C', categoryId: groceries, source: 'manual' });
    add({ date: '2026-03-07', description: 'PAYMENT - THANK YOU', isTransfer: true });

    const page = listTransactions({ reviewOnly: true }, VIEWER);
    expect(page.rows.map((r) => r.id)).toEqual([older, bayesRow]);
    expect(page.rows.map((r) => r.id)).toEqual(listReviewQueue().map((r) => r.id));
  });

  it("still honours a self viewer's owner scope on top of the review filter", () => {
    const { alice, bob, add } = setup();
    const aliceOwn = add({ date: '2026-03-01', description: 'ALICE SHOP', attributedUserId: alice });
    add({ date: '2026-03-02', description: 'BOB SHOP', attributedUserId: bob });

    const selfViewer: Viewer = { id: alice, role: 'member', visibility: 'self' };
    const page = listTransactions({ reviewOnly: true }, selfViewer);
    expect(page.rows.map((r) => r.id)).toEqual([aliceOwn]);
  });

  it('defaults to newest-first when reviewOnly is not set (unchanged behaviour)', () => {
    const { add } = setup();
    const first = add({ date: '2026-03-01', description: 'SHOP A' });
    const second = add({ date: '2026-03-02', description: 'SHOP B' });
    expect(listTransactions({}, VIEWER).rows.map((r) => r.id)).toEqual([second, first]);
  });
});

/**
 * v1.25.0 Lane R item R1 (deferred from v1.20.0). `reviewQueue` chips onto `reviewOnly`
 * (TransactionFilter's own doc comment) -- these tests are the executable proof of the two
 * clauses stated in this task's report: a "suggested" row has categoryId set AND source =
 * 'bayes'; an "uncategorized" row has categoryId null. Meaningless without reviewOnly (see the
 * last test below), and always composed as `and(REVIEW_WHERE, <clause>)` inside buildWhere --
 * never a standalone filter -- so a row REVIEW_WHERE itself excludes (a transfer, here) stays
 * excluded under every chip value, even one it would otherwise satisfy alone.
 */
describe('listTransactions reviewOnly + reviewQueue chips (v1.25.0 Lane R item R1)', () => {
  it('reviewQueue: "suggested" returns only the bayes-guessed row', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const uncategorized = add({ date: '2026-03-01', description: 'SHOP A' });
    const bayesRow = add({ date: '2026-03-05', description: 'SHOP B', categoryId: groceries, source: 'bayes' });

    const page = listTransactions({ reviewOnly: true, reviewQueue: 'suggested' }, VIEWER);
    expect(page.rows.map((r) => r.id)).toEqual([bayesRow]);
    expect(page.rows.map((r) => r.id)).not.toContain(uncategorized);
  });

  it('reviewQueue: "uncategorized" returns only the row with no category', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const uncategorized = add({ date: '2026-03-01', description: 'SHOP A' });
    const bayesRow = add({ date: '2026-03-05', description: 'SHOP B', categoryId: groceries, source: 'bayes' });

    const page = listTransactions({ reviewOnly: true, reviewQueue: 'uncategorized' }, VIEWER);
    expect(page.rows.map((r) => r.id)).toEqual([uncategorized]);
    expect(page.rows.map((r) => r.id)).not.toContain(bayesRow);
  });

  it('reviewQueue absent returns both, same as before this task', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const uncategorized = add({ date: '2026-03-01', description: 'SHOP A' });
    const bayesRow = add({ date: '2026-03-05', description: 'SHOP B', categoryId: groceries, source: 'bayes' });

    const page = listTransactions({ reviewOnly: true }, VIEWER);
    expect(page.rows.map((r) => r.id).sort()).toEqual([uncategorized, bayesRow].sort());
  });

  it('a junk reviewQueue value falls back to both, the same as absent', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const uncategorized = add({ date: '2026-03-01', description: 'SHOP A' });
    const bayesRow = add({ date: '2026-03-05', description: 'SHOP B', categoryId: groceries, source: 'bayes' });

    // TypeScript's own union would reject this at a real call site; readFilter (page.tsx) is
    // what actually narrows a hand-edited `?queue=` to `'suggested' | 'uncategorized' |
    // undefined` before it ever reaches this function -- this proves buildWhere itself is just
    // as forgiving of anything else that slips through, not only the two named values.
    const page = listTransactions({ reviewOnly: true, reviewQueue: 'nonsense' as never }, VIEWER);
    expect(page.rows.map((r) => r.id).sort()).toEqual([uncategorized, bayesRow].sort());
  });

  it('reviewQueue is ignored when reviewOnly is not set -- it only ever narrows the review filter', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const uncategorized = add({ date: '2026-03-01', description: 'SHOP A' });
    add({ date: '2026-03-02', description: 'SHOP B', categoryId: groceries, source: 'manual' });

    // Not reviewOnly: reviewQueue: 'suggested' must not silently narrow the plain list to
    // bayes-only rows -- with no bayes rows in scope at all, a leaking clause would return
    // nothing; the real (unfiltered) answer is both rows.
    const page = listTransactions({ reviewQueue: 'suggested' }, VIEWER);
    expect(page.total).toBe(2);
    expect(page.rows.map((r) => r.id)).toContain(uncategorized);
  });

  /**
   * The genuine-narrowing property: a row REVIEW_WHERE excludes for a reason unrelated to
   * categoryId/source (a transfer) must stay excluded under every chip, even though it has no
   * category and would therefore satisfy "uncategorized" if that clause were ever used alone
   * instead of AND'd onto REVIEW_WHERE.
   */
  it('a transfer (excluded by REVIEW_WHERE itself) stays excluded under every reviewQueue value', () => {
    const { add } = setup();
    const transfer = add({ date: '2026-03-01', description: 'PAYMENT - THANK YOU', isTransfer: true });
    const control = add({ date: '2026-03-02', description: 'SHOP A' });

    for (const reviewQueue of [undefined, 'suggested', 'uncategorized'] as const) {
      const page = listTransactions({ reviewOnly: true, reviewQueue }, VIEWER);
      expect(page.rows.map((r) => r.id)).not.toContain(transfer);
    }
    // Sanity: the control row (genuinely uncategorized, not a transfer) IS found by "uncategorized".
    expect(
      listTransactions({ reviewOnly: true, reviewQueue: 'uncategorized' }, VIEWER).rows.map((r) => r.id),
    ).toEqual([control]);
  });
});

describe('review queue and merchant counting', () => {
  it('returns uncategorized and unconfirmed bayes rows oldest first', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const older = add({ date: '2026-03-01', description: 'SHOP A' });
    const bayesRow = add({ date: '2026-03-05', description: 'SHOP B', categoryId: groceries, source: 'bayes' });
    add({ date: '2026-03-06', description: 'SHOP C', categoryId: groceries, source: 'manual' });

    const queue = listReviewQueue();
    expect(queue.map((r) => r.id)).toEqual([older, bayesRow]);
    expect(queue[0].categoryName).toBeNull();
    expect(queue[1].source).toBe('bayes');
  });

  it('counts other transactions sharing a normalized merchant', () => {
    const { add } = setup();
    add({ description: 'POS PURCHASE TIM HORTONS #4821 TORONTO ON' });
    add({ description: 'POS PURCHASE TIM HORTONS #1099 OAKVILLE ON' });
    add({ description: 'LOBLAWS #1042 BURLINGTON ON' });
    expect(countMatchingMerchant('TIM HORTONS')).toBe(2);
    expect(countMatchingMerchant('LOBLAWS')).toBe(1);
    expect(countMatchingMerchant('NOBODY')).toBe(0);
  });

  /**
   * 2026-08-30 fix: REVIEW_WHERE (src/lib/categorize/engine.ts) gained a "no loan_payments link"
   * clause -- a loan link is a decision about the row, made without ever touching its category, so
   * without this clause a loan-linked row kept nagging the review queue forever. This file's
   * listReviewQueue and listTransactions' own reviewOnly filter both import REVIEW_WHERE rather
   * than restating it (see the ruling R1 comment above), so this is the proof that both actually
   * follow the new clause rather than assuming they do.
   */
  it('a loan-linked row is absent from listReviewQueue AND the reviewOnly filter alike', () => {
    const { db, alice, add } = setup();
    const linked = add({ date: '2026-03-01', description: 'CAR LOAN PAYMENT' });
    const control = add({ date: '2026-03-02', description: 'SOME NEW SHOP' });

    const now = nowIso();
    // migration 0004 seeds a default 'Loan' item type on every fresh db, so this looks it up
    // rather than inserting a second, colliding row (warranty_item_types_name_uq is COLLATE
    // NOCASE) -- the same lookup tests/lib/categorize/engine.test.ts's own fixture uses.
    const typeId = db.get<{ id: number }>(sql`select id from warranty_item_types where name = 'Loan' collate nocase limit 1`).id;
    const itemId = db.get<{ id: number }>(sql`
      insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, loan_direction, created_at, updated_at)
      values ('Car Loan', '2026-01-01', 0, ${alice}, ${typeId}, 'owed', ${now}, ${now}) returning id`).id;
    db.run(sql`insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at)
               values (${linked}, ${itemId}, 1000, 1000, 'manual', ${now})`);

    expect(listReviewQueue().map((r) => r.id)).toEqual([control]);
    expect(listTransactions({ reviewOnly: true }, VIEWER).rows.map((r) => r.id)).toEqual([control]);
  });
});

describe('display names (spec v1.4)', () => {
  it('falls back to the raw description until something sets a display name', () => {
    const { add } = setup();
    const id = add({ description: 'POS PURCHASE MCDONALDS #4821 TORONTO ON' });
    const row = getTransaction(id, VIEWER)!;
    expect(row).toMatchObject({ displayDescription: null, displaySource: null });
    expect(displayNameOf(row)).toBe('POS PURCHASE MCDONALDS #4821 TORONTO ON');
  });

  it('surfaces a rule-applied rename and a manual rename through the row', () => {
    const { alice, add } = setup();
    const ruled = add({ description: 'POS PURCHASE MCDONALDS #4821 TORONTO ON' });
    const manual = add({ description: 'POS PURCHASE MCDONALDS #1099 OAKVILLE ON' });

    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId: alice, actorRole: 'admin' });
    setTransactionDisplayName({ transactionId: manual, displayDescription: 'Lunch with Bob', userId: alice });

    expect(getTransaction(ruled, VIEWER)).toMatchObject({ displayDescription: "McDonald's", displaySource: 'rename' });
    expect(getTransaction(manual, VIEWER)).toMatchObject({ displayDescription: 'Lunch with Bob', displaySource: 'manual' });
    expect(displayNameOf(getTransaction(manual, VIEWER)!)).toBe('Lunch with Bob');
  });

  it('keeps the raw description available alongside the display name', () => {
    const { alice, add } = setup();
    const id = add({ description: 'SQ *BLUE BOTTLE COFFEE' });
    setTransactionDisplayName({ transactionId: id, displayDescription: 'Blue Bottle', userId: alice });
    const row = getTransaction(id, VIEWER)!;
    expect(row.rawDescription).toBe('SQ *BLUE BOTTLE COFFEE');
    expect(row.displayDescription).toBe('Blue Bottle');
  });

  it('search matches the display name as well as the raw text', () => {
    const { alice, add } = setup();
    const id = add({ description: 'SQ *BLUE BOTTLE COFFEE' });
    add({ description: 'LOBLAWS #1042 BURLINGTON ON' });
    setTransactionDisplayName({ transactionId: id, displayDescription: 'Morning ritual', userId: alice });

    expect(listTransactions({ search: 'morning' }, VIEWER).rows.map((r) => r.id)).toEqual([id]);
    expect(listTransactions({ search: 'blue bottle' }, VIEWER).rows.map((r) => r.id)).toEqual([id]);
    expect(listTransactions({ search: 'loblaws' }, VIEWER).rows.map((r) => r.id)).not.toContain(id);
  });
});

describe('notes and single reads', () => {
  it('reads one row and updates its note', () => {
    const { add } = setup();
    const id = add();
    expect(getTransaction(id, VIEWER)?.notes).toBeNull();
    updateTransactionNotes(id, 'split with Bob');
    expect(getTransaction(id, VIEWER)?.notes).toBe('split with Bob');
    updateTransactionNotes(id, null);
    expect(getTransaction(id, VIEWER)?.notes).toBeNull();
    expect(getTransaction(999999, VIEWER)).toBeNull();
  });
});

/**
 * v1.13.0 ruling R4 fix round 2 (controller finding): bulkSetCategory/bulkSetTransfer used to
 * hard-code `actorRole: 'admin'` at their own confirmCategory/setTransferFlag call sites, so ANY
 * member's bulk action silently overwrote a household rule someone else owned. Both functions now
 * take the real actor's role and refuse the WHOLE batch -- rolling back every row this call
 * already wrote -- the moment any id in it would overwrite a rule it does not own.
 */
describe('bulkSetCategory / bulkSetTransfer — ruling R4 fix round 2: a member cannot overwrite another owner\'s rule', () => {
  it('bulkSetCategory: a member batch spanning an owned merchant and a fresh one refuses and rolls back BOTH rows', () => {
    const { db, sqlite, alice, add } = setup();
    const charlie = insertTestUser(db, { name: 'Charlie', username: 'charlie', role: 'member' });
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');

    // Alice (admin) already owns the rule for OWNER MERCHANT.
    const owned = add({ description: 'OWNER MERCHANT' });
    expect(bulkSetCategory([owned], groceries, alice, true, 'admin')).toEqual({ ok: true, changed: 1, skipped: 0 });

    const fresh = add({ description: 'FRESH MERCHANT' });
    const result = bulkSetCategory([fresh, owned], coffee, charlie, true, 'member');

    expect(result).toEqual({ ok: false, reason: 'owned_by_another', ownerName: 'Alice' });
    // Neither row moved -- not even `fresh`, which had no conflict of its own.
    const rows = sqlite
      .prepare('select id, category_id as categoryId from transactions where id in (?, ?)')
      .all(fresh, owned) as { id: number; categoryId: number | null }[];
    expect(rows.find((r) => r.id === fresh)?.categoryId).toBeNull();
    expect(rows.find((r) => r.id === owned)?.categoryId).toBe(groceries);
    // No rule was created for FRESH MERCHANT by the rolled-back attempt.
    expect(listRules('category').map((r) => r.pattern)).not.toContain(normalizeMerchant('FRESH MERCHANT'));
  });

  it('bulkSetCategory: an admin CAN overwrite the same rule', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const owned = add({ description: 'OWNER MERCHANT 2' });
    expect(bulkSetCategory([owned], groceries, alice, true, 'admin')).toEqual({ ok: true, changed: 1, skipped: 0 });
    expect(bulkSetCategory([owned], coffee, alice, true, 'admin')).toEqual({ ok: true, changed: 1, skipped: 0 });
  });

  it('bulkSetTransfer: a member batch spanning an owned merchant and a fresh one refuses and rolls back BOTH rows', () => {
    const { db, sqlite, alice, add } = setup();
    const charlie = insertTestUser(db, { name: 'Charlie', username: 'charlie', role: 'member' });

    const owned = add({ description: 'E-TRANSFER OWNER' });
    expect(bulkSetTransfer([owned], true, alice, 'admin')).toEqual({ ok: true, changed: 1, skipped: 0 });

    const fresh = add({ description: 'E-TRANSFER FRESH' });
    const result = bulkSetTransfer([fresh, owned], true, charlie, 'member');

    expect(result).toEqual({ ok: false, reason: 'owned_by_another', ownerName: 'Alice' });
    const rows = sqlite
      .prepare('select id, is_transfer as isTransfer from transactions where id in (?, ?)')
      .all(fresh, owned) as { id: number; isTransfer: number }[];
    expect(rows.find((r) => r.id === fresh)?.isTransfer).toBe(0);
    expect(rows.find((r) => r.id === owned)?.isTransfer).toBe(1);
  });
});

describe('transactionOwners (item BL)', () => {
  function seedTwo() {
    const { alice, add } = setup();
    const aliceTxn = add({ attributedUserId: alice });
    const unattributedTxn = add({ attributedUserId: null });
    return { aliceTxn, unattributedTxn, aliceId: alice };
  }

  it('returns one entry per existing id, owner only', () => {
    const { aliceTxn, unattributedTxn, aliceId } = seedTwo();
    const owners = transactionOwners([aliceTxn, unattributedTxn]);
    expect(owners.get(aliceTxn)).toBe(aliceId);
    expect(owners.get(unattributedTxn)).toBeNull();
    expect(owners.size).toBe(2);
  });

  it('omits an id that does not exist, so a caller can still tell the two apart', () => {
    const { aliceTxn } = seedTwo();
    const owners = transactionOwners([aliceTxn, 999999]);
    expect(owners.has(999999)).toBe(false);
  });

  it('returns an empty map for no ids', () => {
    expect(transactionOwners([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// v1.26.0 Lane 2 -- the import-audit data layer.
//
// Why any of this exists: rules auto-categorize on import and a rule-assigned row NEVER enters the
// review queue (REVIEW_WHERE is `category IS NULL OR source = 'bayes'`), so before this release
// there was no surface anywhere that showed what the rules had done to an import. The owner:
// "i dont just want to auto apply rules and never see what happened on my import."
// ---------------------------------------------------------------------------------------------

/** An imports row, so a transaction can belong to a real batch. */
function addImport(db: TestDb['db'], accountId: number, userId: number, filename: string): number {
  return db.get<{ id: number }>(sql`
    insert into imports (account_id, profile_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
    values (${accountId}, null, ${filename}, ${userId}, 0, 0, 0, ${nowIso()})
    returning id`).id;
}

describe('groupTransactionsByCategory (v1.26.0 Lane 2 item 3)', () => {
  it('SPLIT-AWARE: a split lands in its parts categories at their own amounts, never double-counted', () => {
    const { db, alice, add } = setup();
    const pharmacy = categoryIdByName(db, 'Pharmacy');
    const groceries = categoryIdByName(db, 'Groceries');

    // The failure this test exists to catch: a naive LEFT JOIN onto transaction_splits with
    // sum(amount_cents) puts the parent's FULL -5000 into both categories (total -10000) and looks
    // entirely plausible in every test that has no split in it.
    const splitTxn = add({ description: 'BIG BOX', amountCents: -5000 });
    setTransactionSplits({
      txnId: splitTxn,
      parts: [
        { categoryId: pharmacy, amountCents: -3000 },
        { categoryId: groceries, amountCents: -2000 },
      ],
      userId: alice,
    });
    // A control row with no splits at all, so the coalesce fallback is exercised in the same call.
    add({ description: 'CORNER MARKET', amountCents: -1500, categoryId: groceries, source: 'manual' });

    const page = groupTransactionsByCategory({}, VIEWER);
    const byName = new Map(page.groups.map((group) => [group.categoryName, group]));

    expect(byName.get('Pharmacy')).toMatchObject({ categoryId: pharmacy, count: 1, totalCents: -3000 });
    expect(byName.get('Groceries')).toMatchObject({ categoryId: groceries, count: 2, totalCents: -3500 });
    // Nothing anywhere carries the parent's lump amount, and nothing carries it twice.
    expect(page.groups.map((group) => group.totalCents)).not.toContain(-5000);
    expect(page.totalCents).toBe(-6500);
    // Two transactions in the list; three (transaction, category) memberships across the groups.
    expect(page.totalCount).toBe(2);
    expect(page.groups.reduce((sum, group) => sum + group.count, 0)).toBe(3);
    // And the list agrees about the size of the set the groups describe.
    expect(listTransactions({}, VIEWER).total).toBe(page.totalCount);
  });

  it('counts two parts filed under the SAME category as one transaction, but sums both', () => {
    const { db, alice, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    const txn = add({ description: 'CAFE TWICE', amountCents: -900 });
    setTransactionSplits({
      txnId: txn,
      parts: [
        { categoryId: coffee, amountCents: -400 },
        { categoryId: coffee, amountCents: -300 },
        { categoryId: groceries, amountCents: -200 },
      ],
      userId: alice,
    });

    const group = groupTransactionsByCategory({}, VIEWER).groups.find((row) => row.categoryName === 'Coffee')!;
    // count(distinct transactions.id), not count(*): one transaction, even though two parts land here.
    expect(group.count).toBe(1);
    // The money really is doubled up in this category, so the sum adds both parts.
    expect(group.totalCents).toBe(-700);
  });

  it('orders by largest ABSOLUTE total first, so a misfiled deposit is not buried', () => {
    const { db, add } = setup();
    const salary = categoryIdByName(db, 'Salary');
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    add({ description: 'PAYROLL', amountCents: 400000, categoryId: salary, source: 'rule' });
    add({ description: 'CAFE', amountCents: -500, categoryId: coffee, source: 'rule' });
    add({ description: 'MARKET', amountCents: -9000, categoryId: groceries, source: 'rule' });

    const page = groupTransactionsByCategory({ source: 'rule' }, VIEWER);
    expect(page.groups.map((group) => group.categoryName)).toEqual(['Salary', 'Groceries', 'Coffee']);
    expect(page.groups[0].totalCents).toBe(400000);
  });

  it('gives uncategorized rows their own group, labelled the way categoryBreakdown labels them', () => {
    const { db, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    add({ description: 'MYSTERY A', amountCents: -2000 });
    add({ description: 'MYSTERY B', amountCents: -3000 });
    add({ description: 'CAFE', amountCents: -100, categoryId: coffee, source: 'manual' });

    const page = groupTransactionsByCategory({}, VIEWER);
    const none = page.groups.find((group) => group.categoryId === null)!;
    // 'Uncategorized', not a bare 'None' -- the same string categoryBreakdown (src/lib/reports.ts)
    // already prints for this edge case.
    expect(none).toEqual({ categoryId: null, categoryName: 'Uncategorized', parentId: null, count: 2, totalCents: -5000 });
  });

  it('labels direct spend on a parent that has children, and leaves a childless top-level alone', () => {
    const { db, add } = setup();
    const health = categoryIdByName(db, 'Health'); // has Pharmacy/Dental/Fitness
    const kids = categoryIdByName(db, 'Kids'); // seeded with no children
    add({ description: 'CLINIC', amountCents: -4000, categoryId: health, source: 'rule' });
    add({ description: 'TOY STORE', amountCents: -1000, categoryId: kids, source: 'rule' });

    const names = groupTransactionsByCategory({ source: 'rule' }, VIEWER).groups.map((group) => group.categoryName);
    // A bucket keyed by a PARENT id is only the money filed DIRECTLY on it -- printing its bare name
    // next to that figure reads exactly like the parent's total (v1.21.0 item 2, same vocabulary).
    expect(names).toContain('Health — not in a sub-category');
    // Nothing to disambiguate a childless top-level category from, so it keeps its plain name.
    expect(names).toContain('Kids');
  });

  it('honours EVERY existing filter, and always describes the same set as the list', () => {
    const { db, alice, bob, joint, aliceVisa, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    const importA = addImport(db, joint, alice, 'march.csv');
    const importB = addImport(db, joint, alice, 'april.csv');

    add({ description: 'CAFE ONE', date: '2026-03-01', amountCents: -300, categoryId: coffee, source: 'rule', attributedUserId: alice, importId: importA });
    add({ description: 'MARKET ONE', date: '2026-03-05', amountCents: -4000, categoryId: groceries, source: 'rule', attributedUserId: bob, importId: importA });
    add({ description: 'MARKET TWO', date: '2026-04-02', amountCents: -2500, categoryId: groceries, source: 'bayes', attributedUserId: alice, importId: importB });
    add({ description: 'CARD PAYMENT', date: '2026-04-03', amountCents: -9000, isTransfer: true, attributedUserId: alice, importId: importB });
    add({ description: 'VISA CAFE', date: '2026-04-04', amountCents: -700, accountId: aliceVisa, categoryId: coffee, source: 'manual', attributedUserId: alice });
    add({ description: 'NO IDEA', date: '2026-04-05', amountCents: -1200, attributedUserId: bob });

    const filters: TransactionFilter[] = [
      {},
      { accountId: aliceVisa },
      { attributedUserId: bob },
      { attributedUserId: 'unattributed' },
      { from: '2026-04-01', to: '2026-04-30' },
      { search: 'MARKET' },
      { transferView: 'none' },
      { transferView: 'only' },
      { categoryId: coffee },
      { categoryId: 'uncategorized' },
      { uncategorizedOnly: true },
      { reviewOnly: true },
      { reviewOnly: true, reviewQueue: 'uncategorized' },
      { reviewOnly: true, reviewQueue: 'suggested' },
      { source: 'rule' },
      { importId: importA },
      { source: 'rule', importId: importA },
      { source: 'rule', importId: importB },
    ];

    for (const filter of filters) {
      const label = JSON.stringify(filter);
      const list = listTransactions({ ...filter, pageSize: 200 }, VIEWER);
      const groups = groupTransactionsByCategory(filter, VIEWER);
      // If the groups and the list could ever describe different sets, the numbers on screen would
      // be a lie. Same buildWhere, same count query -- asserted for every filter, not just the new
      // ones, because the failure mode is a filter somebody adds LATER reaching only one of them.
      expect({ label, total: groups.totalCount }).toEqual({ label, total: list.total });
      // No split anywhere in this fixture, so group memberships and rows are one-to-one and the
      // category keys must match exactly.
      const fromList = [...new Set(list.rows.map((row) => row.categoryId))].sort((a, b) => (a ?? -1) - (b ?? -1));
      const fromGroups = groups.groups.map((group) => group.categoryId).sort((a, b) => (a ?? -1) - (b ?? -1));
      expect({ label, ids: fromGroups }).toEqual({ label, ids: fromList });
      expect({ label, rows: groups.groups.reduce((sum, group) => sum + group.count, 0) }).toEqual({ label, rows: list.total });
      expect({ label, cents: groups.totalCents }).toEqual({
        label,
        cents: list.rows.reduce((sum, row) => sum + row.amountCents, 0),
      });
    }
  });

  it('pages by GROUP, ignoring the row filter own page/pageSize', () => {
    const { db, add } = setup();
    for (const name of ['Coffee', 'Groceries', 'Restaurants', 'Clothing', 'Pharmacy']) {
      add({ description: name.toUpperCase(), amountCents: -1000 * name.length, categoryId: categoryIdByName(db, name), source: 'rule' });
    }

    const first = groupTransactionsByCategory({ source: 'rule' }, VIEWER, { pageSize: 2, page: 1 });
    expect(first.groupCount).toBe(5);
    expect(first.pageCount).toBe(3);
    expect(first.groups).toHaveLength(2);
    const second = groupTransactionsByCategory({ source: 'rule' }, VIEWER, { pageSize: 2, page: 2 });
    const third = groupTransactionsByCategory({ source: 'rule' }, VIEWER, { pageSize: 2, page: 3 });
    expect(second.groups).toHaveLength(2);
    expect(third.groups).toHaveLength(1);
    // A total order over the groups, so paging cannot repeat one or drop one.
    const paged = [...first.groups, ...second.groups, ...third.groups].map((group) => group.categoryName);
    expect(new Set(paged).size).toBe(5);
    expect(paged).toEqual(groupTransactionsByCategory({ source: 'rule' }, VIEWER, { pageSize: 200 }).groups.map((g) => g.categoryName));

    // The filter's OWN paging fields page ROWS and must not reach the groups: the caller passes one
    // filter object to both reads, and the row page it happens to be showing must not decide which
    // clusters it is told about.
    const rowPaged = groupTransactionsByCategory({ source: 'rule', page: 3, pageSize: 1 }, VIEWER, { pageSize: 200 });
    expect(rowPaged.groups.map((group) => group.categoryName)).toEqual(paged);
    expect(rowPaged.groupCount).toBe(5);
  });

  it('THE BOUNDARY CASE: a cluster larger than one row page still reports its whole count and subtotal', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    // 60 rows in one category -- more than the row list's 50-per-page default, which is exactly the
    // situation that defeats row pagination: the household would see half the cluster with no sign
    // there was more.
    for (let i = 0; i < 60; i += 1) add({ description: `MARKET ${i}`, amountCents: -100, categoryId: groceries, source: 'rule' });
    add({ description: 'CAFE', amountCents: -250, categoryId: coffee, source: 'rule' });

    expect(listTransactions({ source: 'rule' }, VIEWER).rows).toHaveLength(50);
    const groups = groupTransactionsByCategory({ source: 'rule' }, VIEWER);
    const bulk = groups.groups.find((group) => group.categoryName === 'Groceries')!;
    expect(bulk.count).toBe(60);
    expect(bulk.totalCents).toBe(-6000);
    // One page of groups holds the whole answer; both clusters are whole.
    expect(groups.groupCount).toBe(2);
    expect(groups.pageCount).toBe(1);
    expect(groups.totalCount).toBe(61);
  });

  it('is empty, not broken, for a filter that matches nothing', () => {
    setup();
    const page = groupTransactionsByCategory({ source: 'rule', importId: 999999 }, VIEWER);
    expect(page).toEqual({ groups: [], page: 1, pageSize: 25, pageCount: 1, groupCount: 0, totalCount: 0, totalCents: 0 });
  });
});

describe('listTransactions sorting (v1.26.0 Lane 2 item 1)', () => {
  it('leaves both existing default orders exactly as they were when no sort is asked for', () => {
    const { add } = setup();
    add({ date: '2026-03-01', description: 'OLDEST' });
    add({ date: '2026-03-09', description: 'NEWEST' });
    // Newest first, unchanged.
    expect(listTransactions({}, VIEWER).rows.map((row) => row.rawDescription)).toEqual(['NEWEST', 'OLDEST']);
    // Oldest first while working the queue (v1.14.1 ruling R1), unchanged.
    expect(listTransactions({ reviewOnly: true }, VIEWER).rows.map((row) => row.rawDescription)).toEqual(['OLDEST', 'NEWEST']);
    // A direction with no sort changes nothing -- `sort` is the switch.
    expect(listTransactions({ direction: 'asc' }, VIEWER).rows.map((row) => row.rawDescription)).toEqual(['NEWEST', 'OLDEST']);
  });

  it('sorts by date, both directions', () => {
    const { add } = setup();
    add({ date: '2026-03-05', description: 'MID' });
    add({ date: '2026-03-01', description: 'EARLY' });
    add({ date: '2026-03-09', description: 'LATE' });
    expect(listTransactions({ sort: 'date', direction: 'asc' }, VIEWER).rows.map((r) => r.rawDescription)).toEqual(['EARLY', 'MID', 'LATE']);
    expect(listTransactions({ sort: 'date', direction: 'desc' }, VIEWER).rows.map((r) => r.rawDescription)).toEqual(['LATE', 'MID', 'EARLY']);
  });

  it('sorts by amount, both directions, signed (a deposit is the largest amount, not the largest spend)', () => {
    const { add } = setup();
    add({ description: 'SMALL', amountCents: -300 });
    add({ description: 'BIG SPEND', amountCents: -90000 });
    add({ description: 'DEPOSIT', amountCents: 250000 });
    expect(listTransactions({ sort: 'amount', direction: 'asc' }, VIEWER).rows.map((r) => r.rawDescription)).toEqual(['BIG SPEND', 'SMALL', 'DEPOSIT']);
    expect(listTransactions({ sort: 'amount', direction: 'desc' }, VIEWER).rows.map((r) => r.rawDescription)).toEqual(['DEPOSIT', 'SMALL', 'BIG SPEND']);
  });

  it('sorts by category NAME and not by category id, both directions', () => {
    const { db, add } = setup();
    // Two categories inserted so that id order is the REVERSE of name order. Without this, a test
    // over the seeded tree could pass on an id sort and prove nothing.
    const zebra = db.get<{ id: number }>(sql`insert into categories (name, sort_order) values ('Zebra Fund', 900) returning id`).id;
    const aardvark = db.get<{ id: number }>(sql`insert into categories (name, sort_order) values ('Aardvark Fund', 901) returning id`).id;
    expect(zebra).toBeLessThan(aardvark);
    add({ description: 'Z ROW', categoryId: zebra, source: 'manual' });
    add({ description: 'A ROW', categoryId: aardvark, source: 'manual' });

    expect(listTransactions({ sort: 'category', direction: 'asc' }, VIEWER).rows.map((r) => r.categoryName)).toEqual(['Aardvark Fund', 'Zebra Fund']);
    expect(listTransactions({ sort: 'category', direction: 'desc' }, VIEWER).rows.map((r) => r.categoryName)).toEqual(['Zebra Fund', 'Aardvark Fund']);
  });

  it('puts an uncategorized row LAST under a category sort in BOTH directions', () => {
    const { db, add } = setup();
    add({ description: 'CAFE', categoryId: categoryIdByName(db, 'Coffee'), source: 'manual' });
    add({ description: 'MARKET', categoryId: categoryIdByName(db, 'Groceries'), source: 'manual' });
    add({ description: 'MYSTERY' });

    // "No category" is not a name and belongs at neither end of an alphabet. Left to SQLite, NULL
    // sorts low and the reader's first screenful under ASC would be rows with nothing in the column
    // they just asked to sort by.
    expect(listTransactions({ sort: 'category', direction: 'asc' }, VIEWER).rows.map((r) => r.rawDescription)).toEqual(['CAFE', 'MARKET', 'MYSTERY']);
    expect(listTransactions({ sort: 'category', direction: 'desc' }, VIEWER).rows.map((r) => r.rawDescription)).toEqual(['MARKET', 'CAFE', 'MYSTERY']);
  });

  it('a split row sorts by the category the LIST shows for it, which is its own column', () => {
    const { db, alice, add } = setup();
    add({ description: 'CAFE', categoryId: categoryIdByName(db, 'Coffee'), source: 'manual' });
    const splitTxn = add({ description: 'SPLIT ROW', amountCents: -5000 });
    setTransactionSplits({
      txnId: splitTxn,
      parts: [
        { categoryId: categoryIdByName(db, 'Pharmacy'), amountCents: -3000 },
        { categoryId: categoryIdByName(db, 'Groceries'), amountCents: -2000 },
      ],
      userId: alice,
    });
    // setTransactionSplits never invents or overwrites the parent's own category_id, so the list
    // shows nothing in that cell -- and the sort must put the row where the reader can account for
    // it, i.e. with the other rows showing nothing there. groupTransactionsByCategory is the
    // surface that decomposes it across its parts.
    const rows = listTransactions({ sort: 'category', direction: 'asc' }, VIEWER).rows;
    expect(rows.map((row) => row.rawDescription)).toEqual(['CAFE', 'SPLIT ROW']);
    expect(rows[1].categoryName).toBeNull();
  });

  it('THE STABLE TIEBREAKER: two rows with the same date AND the same amount page deterministically', () => {
    const { add } = setup();
    const first = add({ date: '2026-03-04', description: 'TWIN A', amountCents: -450 });
    const second = add({ date: '2026-03-04', description: 'TWIN B', amountCents: -450 });

    const cases: TransactionFilter[] = [
      { sort: 'date', direction: 'asc' },
      { sort: 'date', direction: 'desc' },
      { sort: 'amount', direction: 'asc' },
      { sort: 'amount', direction: 'desc' },
      { sort: 'category', direction: 'asc' },
      { sort: 'category', direction: 'desc' },
      {},
    ];
    const bothIds = [first, second].sort((a, b) => a - b);
    for (const filter of cases) {
      const label = JSON.stringify(filter);
      // Same query twice: without a unique final key SQLite may return equal-keyed rows in any
      // order and need not pick the same one twice.
      const once = listTransactions(filter, VIEWER).rows.map((row) => row.id);
      const twice = listTransactions(filter, VIEWER).rows.map((row) => row.id);
      expect({ label, once }).toEqual({ label, once: twice });
      expect({ label, ids: [...once].sort((a, b) => a - b) }).toEqual({ label, ids: bothIds });

      // And the real failure mode: page 1 then page 2 must not show the same row twice and drop the
      // other, which is what LIMIT/OFFSET does over an order that is not total.
      const pageOne = listTransactions({ ...filter, pageSize: 1, page: 1 }, VIEWER).rows.map((row) => row.id);
      const pageTwo = listTransactions({ ...filter, pageSize: 1, page: 2 }, VIEWER).rows.map((row) => row.id);
      expect({ label, seen: [...pageOne, ...pageTwo].sort((a, b) => a - b) }).toEqual({ label, seen: bothIds });
      expect({ label, ordered: [...pageOne, ...pageTwo] }).toEqual({ label, ordered: once });
    }
  });
});

describe('listTransactions source and importId filters (v1.26.0 Lane 2 item 2)', () => {
  function seedBatches() {
    const seeded = setup();
    const { db, alice, joint, add } = seeded;
    const importA = addImport(db, joint, alice, 'march.csv');
    const importB = addImport(db, joint, alice, 'april.csv');
    const ruleA = add({ description: 'CORNER MARKET', source: 'rule', categoryId: categoryIdByName(db, 'Groceries'), importId: importA });
    const bayesA = add({ description: 'ODD SHOP', source: 'bayes', categoryId: categoryIdByName(db, 'General'), importId: importA });
    const noneA = add({ description: 'MYSTERY', source: 'none', importId: importA });
    const ruleB = add({ description: 'CORNER MARKET', date: '2026-04-02', source: 'rule', categoryId: categoryIdByName(db, 'Groceries'), importId: importB });
    const manual = add({ description: 'HAND TYPED', source: 'manual', categoryId: categoryIdByName(db, 'Coffee') });
    return { ...seeded, importA, importB, ruleA, bayesA, noneA, ruleB, manual };
  }

  it('filters by every value categorization_source can hold', () => {
    const { ruleA, bayesA, noneA, ruleB, manual } = seedBatches();
    const ids = (source: 'rule' | 'bayes' | 'manual' | 'none') =>
      listTransactions({ source }, VIEWER).rows.map((row) => row.id).sort((a, b) => a - b);
    expect(ids('rule')).toEqual([ruleA, ruleB].sort((a, b) => a - b));
    expect(ids('bayes')).toEqual([bayesA]);
    expect(ids('none')).toEqual([noneA]);
    expect(ids('manual')).toEqual([manual]);
  });

  it('filters by import batch', () => {
    const { importA, importB, ruleA, bayesA, noneA, ruleB } = seedBatches();
    expect(listTransactions({ importId: importA }, VIEWER).rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([ruleA, bayesA, noneA].sort((a, b) => a - b));
    expect(listTransactions({ importId: importB }, VIEWER).rows.map((r) => r.id)).toEqual([ruleB]);
    expect(listTransactions({ importId: 999999 }, VIEWER).total).toBe(0);
  });

  it('composes the two into the audit view own query: what did the rules do to THAT import', () => {
    const { importA, ruleA } = seedBatches();
    const page = listTransactions({ source: 'rule', importId: importA }, VIEWER);
    expect(page.rows.map((row) => row.id)).toEqual([ruleA]);
    expect(page.total).toBe(1);
    // And it still composes with everything else -- a date window that excludes the row.
    expect(listTransactions({ source: 'rule', importId: importA, from: '2026-06-01' }, VIEWER).total).toBe(0);
  });

  it('reads transactions.import_id, NOT transaction_imports, and the two can disagree', () => {
    const { db, importA, importB, ruleA } = seedBatches();
    // What commitImport does for an overlapping re-import: the already-present row is recognised as
    // a duplicate and linked into the SECOND import too (that association is what makes undo safe
    // for overlapping date-range exports), while its import_id still names the import that first
    // brought it in.
    db.run(sql`insert into transaction_imports (transaction_id, import_id, created_at) values (${ruleA}, ${importA}, ${nowIso()})`);
    db.run(sql`insert into transaction_imports (transaction_id, import_id, created_at) values (${ruleA}, ${importB}, ${nowIso()})`);
    const links = db.all<{ importId: number }>(
      sql`select import_id as importId from transaction_imports where transaction_id = ${ruleA} order by import_id`,
    );
    expect(links.map((row) => row.importId)).toEqual([importA, importB].sort((a, b) => a - b));

    // import_id wins: the row was ADDED by A, and re-showing it under B would show the household a
    // row they had already dismissed.
    expect(listTransactions({ importId: importA }, VIEWER).rows.map((r) => r.id)).toContain(ruleA);
    expect(listTransactions({ importId: importB }, VIEWER).rows.map((r) => r.id)).not.toContain(ruleA);
  });

  it('narrows the grouped aggregate identically', () => {
    const { db, importA } = seedBatches();
    const groups = groupTransactionsByCategory({ source: 'rule', importId: importA }, VIEWER);
    expect(groups.groups).toEqual([
      {
        categoryId: categoryIdByName(db, 'Groceries'),
        categoryName: 'Groceries',
        parentId: categoryIdByName(db, 'Food'),
        count: 1,
        totalCents: -1000,
      },
    ]);
    expect(groups.totalCount).toBe(1);
  });
});
