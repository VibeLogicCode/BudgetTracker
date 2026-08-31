import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import type { Viewer } from '@/lib/auth/viewer';
import {
  bulkSetAttribution,
  bulkSetCategory,
  bulkSetTransfer,
  countMatchingMerchant,
  createManualTransaction,
  displayNameOf,
  getTransaction,
  listReviewQueue,
  listTransactions,
  manualTransactionSchema,
  transactionOwners,
  updateTransactionNotes,
} from '@/lib/transactions';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { listRules, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { setTransactionDisplayName, upsertRenameRule } from '@/lib/categorize/engine';
import { nowIso } from '@/lib/clock';

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

  const add = (over: Partial<{ accountId: number; date: string; description: string; amountCents: number; categoryId: number | null; attributedUserId: number | null; source: string; isTransfer: boolean }> = {}) => {
    const description = over.description ?? 'TIM HORTONS';
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${over.accountId ?? joint}, ${over.date ?? '2026-03-02'}, ${description}, ${normalizeMerchant(description)},
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

  it('can exclude transfers', () => {
    const { add } = setup();
    const normal = add({ description: 'TIM HORTONS' });
    const transfer = add({ description: 'PAYMENT - THANK YOU', isTransfer: true });
    expect(listTransactions({}, VIEWER).rows.map((r) => r.id).sort()).toEqual([normal, transfer].sort());
    expect(listTransactions({ includeTransfers: false }, VIEWER).rows.map((r) => r.id)).toEqual([normal]);
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
