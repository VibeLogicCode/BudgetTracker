import { describe, it, expect, afterEach } from 'vitest';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { listAudit } from '@/lib/audit';
import { NOT_YOURS_ERROR, type Viewer } from '@/lib/auth/viewer';
import {
  BULK_UNDO_EXPIRED_ERROR,
  BULK_UNDO_MAX_ROWS,
  BULK_UNDO_NOTHING_ERROR,
  BULK_UNDO_STALE_ERROR,
  captureBulkBefore,
  lastBulkUndo,
  recordBulkUndo,
  undoLastBulkAction,
  type BulkUndoKind,
} from '@/lib/bulk-undo';
import { getVocabSize, train } from '@/lib/categorize/bayes';
import { confirmCategory, setTransferFlag } from '@/lib/categorize/engine';
import { tokenize } from '@/lib/categorize/normalize';
import { setRecurringMarks, setRuleDisabledFlag, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { saveLoanRule } from '@/lib/loans';
import { getSetting } from '@/lib/settings';
import { bulkSetAttribution } from '@/lib/transactions';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const CREATED = '2026-03-01T09:00:00.000Z';
/** The bulk change. */
const AT = new Date('2026-03-10T14:17:00.000Z');
const SOON = new Date('2026-03-10T14:22:00.000Z');
const LAST_MOMENT = new Date('2026-03-10T14:32:00.000Z');
const TOO_LATE = new Date('2026-03-10T14:32:01.000Z');

const household = (id: number): Viewer => ({ id, role: 'admin', visibility: 'household' });

interface RowOver {
  categoryId?: number | null;
  source?: 'rule' | 'bayes' | 'manual' | 'none';
  confidence?: number | null;
  person?: number | null;
  isTransfer?: boolean;
}

function setup() {
  current = createSeededTestDb();
  const t = current;
  const alex = insertTestUser(t.db, { name: 'Alex', username: 'alex', role: 'admin' });
  const sam = insertTestUser(t.db, { name: 'Sam', username: 'sam', role: 'member' });
  const account = insertTestAccount(t.db, { name: 'Joint Chequing' });
  const insert = t.sqlite.prepare(
    `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id,
       categorization_source, confidence, is_transfer, attributed_user_id, created_by, created_at, updated_at)
     values (?, '2026-03-09', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
  );
  const add = (merchant: string, amountCents: number, over: RowOver = {}): number =>
    (
      insert.get(
        account,
        merchant,
        merchant,
        amountCents,
        over.categoryId ?? null,
        over.source ?? 'none',
        over.confidence ?? null,
        over.isTransfer === true ? 1 : 0,
        over.person === undefined ? null : over.person,
        alex,
        CREATED,
        CREATED,
      ) as { id: number }
    ).id;
  const rows = () =>
    t.sqlite
      .prepare(
        `select id, category_id as categoryId, categorization_source as source, confidence, is_transfer as isTransfer,
                attributed_user_id as person from transactions order by id`,
      )
      .all();
  const row = (id: number) =>
    t.sqlite
      .prepare(
        `select category_id as categoryId, categorization_source as source, confidence, is_transfer as isTransfer,
                attributed_user_id as person from transactions where id = ?`,
      )
      .get(id) as { categoryId: number | null; source: string; confidence: number | null; isTransfer: number; person: number | null };
  const rules = () => t.sqlite.prepare('select * from merchant_rules order by id').all() as Array<Record<string, unknown>>;
  const bayes = () => ({
    tokens: t.sqlite.prepare('select token, category_id as categoryId, count from bayes_tokens order by token, category_id').all(),
    totals: t.sqlite
      .prepare('select category_id as categoryId, doc_count as docCount, token_total as tokenTotal from bayes_category_totals order by category_id')
      .all(),
    vocab: getVocabSize(),
  });
  const groceries = categoryIdByName(t.db, 'Groceries');
  const restaurants = categoryIdByName(t.db, 'Restaurants');
  return { t, alex, sam, account, add, rows, row, rules, bayes, groceries, restaurants };
}

/** The bulk Categorize bar's loop, with an explicit clock: confirmCategory per row, rules on. */
function categorize(ids: number[], categoryId: number, userId: number, at: Date = AT): void {
  for (const id of ids) {
    const result = confirmCategory({ transactionId: id, categoryId, userId, createRule: true, actorRole: 'admin', at });
    expect(result.ok).toBe(true);
  }
}

function recorded(userId: number, kind: BulkUndoKind, label: string, ids: number[], change: () => void, merchants?: string[]) {
  const before = captureBulkBefore({ ids, merchants });
  change();
  return recordBulkUndo({ userId, kind, label, before, at: AT });
}

describe('bulk undo: what an undo puts back', () => {
  it('categorizing three MAPLE GROCER rows, then undoing, restores the rows, removes the new rule and leaves Bayes as it was', () => {
    const { alex, add, rows, rules, bayes, groceries } = setup();
    // Earlier hand-filing taught Groceries the merchant, which is why one row carries a guess.
    train(tokenize('MAPLE GROCER'), groceries);
    const a = add('MAPLE GROCER', -4217);
    const b = add('MAPLE GROCER', -1805);
    const c = add('MAPLE GROCER', -6340, { categoryId: groceries, source: 'bayes', confidence: 0.62 });
    const rowsBefore = rows();
    const rulesBefore = rules();
    const bayesBefore = bayes();

    const outcome = recorded(alex, 'categorize', 'Categorized 3 transactions as Groceries.', [a, b, c], () =>
      categorize([a, b, c], groceries, alex),
    );

    expect(outcome).toBe('recorded');
    expect(rules()).toHaveLength(1);
    expect(bayes()).not.toEqual(bayesBefore);
    expect(lastBulkUndo(alex, SOON)).toEqual({
      label: 'Categorized 3 transactions as Groceries.',
      rows: 3,
      expiresAt: '2026-03-10T14:32:00.000Z',
    });

    expect(undoLastBulkAction({ viewer: household(alex), now: SOON })).toEqual({ ok: true, rows: 3, rulesRemoved: 1, rulesRestored: 0 });
    expect(rows()).toEqual(rowsBefore);
    expect(rules()).toEqual(rulesBefore);
    expect(bayes()).toEqual(bayesBefore);
    expect(lastBulkUndo(alex, SOON)).toBeNull();
  });

  it('writes exactly one audit row naming the smallest restored id', () => {
    const { alex, add, groceries } = setup();
    const a = add('MAPLE GROCER', -4217);
    const b = add('MAPLE GROCER', -1805);
    recorded(alex, 'categorize', 'Categorized 2 transactions as Groceries.', [b, a], () => categorize([b, a], groceries, alex));

    undoLastBulkAction({ viewer: household(alex), now: SOON });

    expect(listAudit()).toEqual([
      {
        id: expect.any(Number),
        at: '2026-03-10T14:22:00.000Z',
        userId: alex,
        userName: 'Alex',
        action: 'undo_bulk_action',
        entity: 'transactions',
        entityId: a,
        detail: 'Undid: Categorized 2 transactions as Groceries (1 rule removed)',
      },
    ]);
  });

  it('a row already filed by hand as Restaurants and moved to Groceries untrains Groceries and trains Restaurants back', () => {
    const { alex, add, row, bayes, groceries, restaurants } = setup();
    const id = add('MAPLE GROCER', -4217, { categoryId: restaurants, source: 'manual' });
    train(tokenize('MAPLE GROCER'), restaurants);
    // Groceries has seen other merchants. (untrain keeps a category's totals row at zero rather
    // than deleting it, so a never-trained category would come back as a 0/0 row.)
    train(tokenize('CORNER MARKET'), groceries);
    const bayesBefore = bayes();

    recorded(alex, 'categorize', 'Categorized 1 transaction as Groceries.', [id], () => {
      expect(confirmCategory({ transactionId: id, categoryId: groceries, userId: alex, createRule: false, actorRole: 'admin', at: AT }).ok).toBe(true);
    });
    expect(bayes()).not.toEqual(bayesBefore);

    expect(undoLastBulkAction({ viewer: household(alex), now: SOON })).toMatchObject({ ok: true, rows: 1, rulesRemoved: 0 });
    expect(row(id)).toMatchObject({ categoryId: restaurants, source: 'manual' });
    expect(bayes()).toEqual(bayesBefore);
  });

  it('a bulk transfer over a merchant with a not_transfer rule: undo re-inserts that rule with its id and columns and removes the learned transfer rule', () => {
    const { t, alex, sam, add, rows, rules } = setup();
    const override = upsertRuleFromCorrection({
      pattern: 'FUEL STOP 12',
      matchType: 'exact',
      ruleKind: 'not_transfer',
      categoryId: null,
      createdBy: sam,
      actorRole: 'member',
      at: new Date('2026-02-02T10:00:00.000Z'),
    });
    if (!override.ok) throw new Error('fixture');
    t.sqlite
      .prepare("update merchant_rules set hit_count = 4, last_used_at = '2026-02-20T08:00:00.000Z' where id = ?")
      .run(override.ruleId);
    const a = add('FUEL STOP 12', -6130);
    const b = add('FUEL STOP 12', -5500);
    const rowsBefore = rows();
    const rulesBefore = rules();

    recorded(alex, 'transfer', 'Marked 2 transactions as transfers.', [a, b], () => {
      for (const id of [a, b]) {
        expect(setTransferFlag({ transactionId: id, isTransfer: true, userId: alex, actorRole: 'admin', learnRule: true, at: AT }).ok).toBe(true);
      }
    });
    expect(rules().map((rule) => rule.rule_kind)).toEqual(['transfer']);

    expect(undoLastBulkAction({ viewer: household(alex), now: SOON })).toEqual({ ok: true, rows: 2, rulesRemoved: 1, rulesRestored: 1 });
    expect(rules()).toEqual(rulesBefore);
    expect(rows()).toEqual(rowsBefore);
    expect(listAudit()[0]?.detail).toBe('Undid: Marked 2 transactions as transfers (1 rule removed, 1 rule restored)');
  });

  it('a teach that rewrote a bounded exact rule: undo writes its category and author back', () => {
    const { alex, sam, add, row, rules, groceries, restaurants } = setup();
    const bounded = upsertRuleFromCorrection({
      pattern: 'MAPLE GROCER',
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: restaurants,
      amountMinCents: 4000,
      amountMaxCents: 5000,
      createdBy: sam,
      actorRole: 'member',
      at: new Date('2026-02-02T10:00:00.000Z'),
    });
    if (!bounded.ok) throw new Error('fixture');
    const id = add('MAPLE GROCER', -4217, { categoryId: restaurants, source: 'rule' });
    const rulesBefore = rules();

    recorded(alex, 'categorize', 'Categorized 1 transaction as Groceries.', [id], () => categorize([id], groceries, alex));
    expect(rules()).toEqual([expect.objectContaining({ id: bounded.ruleId, category_id: groceries, last_modified_by: alex })]);

    expect(undoLastBulkAction({ viewer: household(alex), now: SOON })).toEqual({ ok: true, rows: 1, rulesRemoved: 0, rulesRestored: 1 });
    expect(rules()).toEqual(rulesBefore);
    expect(row(id)).toMatchObject({ categoryId: restaurants, source: 'rule' });
  });

  it('a person change is restored, to and from Household', () => {
    const { alex, sam, add, row } = setup();
    const ofAlex = add('MAPLE GROCER', -4217, { person: alex });
    const shared = add('MAPLE GROCER', -1805, { person: null });
    const ofSam = add('FUEL STOP 12', -6130, { person: sam });

    recorded(alex, 'person', 'Set Household on 2 transactions.', [ofAlex, ofSam], () => bulkSetAttribution([ofAlex, ofSam], null));
    expect(row(ofAlex).person).toBeNull();
    expect(undoLastBulkAction({ viewer: household(alex), now: SOON })).toMatchObject({ ok: true, rows: 2 });
    expect([row(ofAlex).person, row(ofSam).person]).toEqual([alex, sam]);

    recorded(alex, 'person', 'Set Sam on 1 transaction.', [shared], () => bulkSetAttribution([shared], sam));
    expect(row(shared).person).toBe(sam);
    expect(undoLastBulkAction({ viewer: household(alex), now: SOON })).toMatchObject({ ok: true, rows: 1 });
    expect(row(shared).person).toBeNull();
  });

  it('recurring marks are restored, and a rules-only undo audits the smallest rule id', () => {
    const { alex, sam, rules } = setup();
    const notRecurring = upsertRuleFromCorrection({
      pattern: 'STREAMBOX',
      matchType: 'exact',
      ruleKind: 'not_recurring',
      categoryId: null,
      createdBy: sam,
      actorRole: 'member',
      at: new Date('2026-02-02T10:00:00.000Z'),
    });
    if (!notRecurring.ok) throw new Error('fixture');
    const rulesBefore = rules();

    const outcome = recorded(
      alex,
      'recurring',
      'Marked 1 merchant as recurring.',
      [],
      () => {
        expect(setRecurringMarks({ merchants: [' streambox'], mark: 'recurring', userId: alex, actorRole: 'admin', at: AT }).ok).toBe(true);
      },
      [' streambox'],
    );
    expect(outcome).toBe('recorded');
    expect(rules().map((rule) => rule.rule_kind)).toEqual(['recurring']);

    expect(undoLastBulkAction({ viewer: household(alex), now: SOON })).toEqual({ ok: true, rows: 0, rulesRemoved: 1, rulesRestored: 1 });
    expect(rules()).toEqual(rulesBefore);
    expect(listAudit()).toEqual([
      expect.objectContaining({
        entity: 'merchant_rules',
        entityId: notRecurring.ruleId,
        detail: 'Undid: Marked 1 merchant as recurring (1 rule removed, 1 rule restored)',
      }),
    ]);
  });

  it('a loan rule link made by a re-confirm is removed, and the loan balance is as before', () => {
    const { t, alex, add, row } = setup();
    const general = categoryIdByName(t.db, 'General');
    const type = t.sqlite
      .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Car loan', 0, 'loan', ?) returning id`)
      .get(CREATED) as { id: number };
    const loan = t.sqlite
      .prepare(
        `insert into warranty_items
           (name, purchase_date, is_lifetime, owner_user_id, type_id, principal_cents, current_balance_cents, balance_updated_at, created_at, updated_at)
         values ('Hatchback', '2025-01-15', 0, ?, ?, null, 2000000, ?, ?, ?) returning id`,
      )
      .get(alex, type.id, CREATED, CREATED, CREATED) as { id: number };
    const balance = () => (t.sqlite.prepare('select current_balance_cents as b from warranty_items where id = ?').get(loan.id) as { b: number }).b;
    // Filed by hand before the loan rule existed, so only a re-confirm picks the payment up.
    const id = add('MAPLE AUTO FIN', -45000, { categoryId: general, source: 'manual' });
    saveLoanRule({ itemId: loan.id, merchantContains: 'MAPLE AUTO FIN', accountId: null, enabled: true, at: AT });

    const outcome = recorded(alex, 'categorize', 'Categorized 1 transaction as General.', [id], () => categorize([id], general, alex));
    expect(outcome).toBe('recorded');
    expect(balance()).toBe(1955000);
    expect(lastBulkUndo(alex, SOON)?.rows).toBe(1);

    expect(undoLastBulkAction({ viewer: household(alex), now: SOON })).toEqual({ ok: true, rows: 1, rulesRemoved: 0, rulesRestored: 0 });
    expect(t.sqlite.prepare('select count(*) as n from loan_payments').get()).toEqual({ n: 0 });
    expect(balance()).toBe(2000000);
    expect(row(id)).toMatchObject({ categoryId: general, source: 'manual' });
  });
});

describe('bulk undo: refusals write nothing', () => {
  function categorized() {
    const s = setup();
    const ids = [s.add('MAPLE GROCER', -4217), s.add('MAPLE GROCER', -1805), s.add('MAPLE GROCER', -6340)];
    recorded(s.alex, 'categorize', 'Categorized 3 transactions as Groceries.', ids, () => categorize(ids, s.groceries, s.alex));
    return { ...s, ids };
  }

  it('can still be undone at exactly 15 minutes, and is refused at 15:01', () => {
    const { alex, rows, rules, bayes } = categorized();
    expect(lastBulkUndo(alex, LAST_MOMENT)).not.toBeNull();
    const state = { rows: rows(), rules: rules(), bayes: bayes() };

    expect(undoLastBulkAction({ viewer: household(alex), now: TOO_LATE })).toEqual({ ok: false, error: BULK_UNDO_EXPIRED_ERROR });
    expect({ rows: rows(), rules: rules(), bayes: bayes() }).toEqual(state);
    expect(listAudit()).toEqual([]);

    // Reading an expired record clears it.
    expect(lastBulkUndo(alex, TOO_LATE)).toBeNull();
    expect(getSetting(`bulk_undo:${alex}`)).toBeNull();
  });

  it('is refused, with nothing changed, when a row was recategorized after the action', () => {
    const { alex, ids, rows, rules, bayes, restaurants } = categorized();
    expect(
      confirmCategory({ transactionId: ids[0] as number, categoryId: restaurants, userId: alex, createRule: false, actorRole: 'admin', at: SOON }).ok,
    ).toBe(true);
    const state = { rows: rows(), rules: rules(), bayes: bayes() };

    expect(undoLastBulkAction({ viewer: household(alex), now: SOON })).toEqual({ ok: false, error: BULK_UNDO_STALE_ERROR });
    expect({ rows: rows(), rules: rules(), bayes: bayes() }).toEqual(state);
    expect(listAudit()).toEqual([]);
    expect(lastBulkUndo(alex, SOON)).not.toBeNull();
  });

  it('is refused, with nothing changed, when a rule it wrote was edited after it', () => {
    const { alex, rows, rules, bayes } = categorized();
    setRuleDisabledFlag(rules()[0]?.id as number, true, SOON);
    const state = { rows: rows(), rules: rules(), bayes: bayes() };

    expect(undoLastBulkAction({ viewer: household(alex), now: SOON })).toEqual({ ok: false, error: BULK_UNDO_STALE_ERROR });
    expect({ rows: rows(), rules: rules(), bayes: bayes() }).toEqual(state);
  });

  it('is refused when a recorded row was deleted after the action', () => {
    const { t, alex, ids, rows, rules } = categorized();
    t.sqlite.prepare('delete from transactions where id = ?').run(ids[1]);
    const state = { rows: rows(), rules: rules() };

    expect(undoLastBulkAction({ viewer: household(alex), now: SOON })).toEqual({ ok: false, error: BULK_UNDO_STALE_ERROR });
    expect({ rows: rows(), rules: rules() }).toEqual(state);
  });

  it('rolls back whole when a rule it would re-insert collides with one written since', () => {
    const { t, alex, sam, add, rows, rules } = setup();
    upsertRuleFromCorrection({ pattern: 'FUEL STOP 12', matchType: 'exact', ruleKind: 'not_transfer', categoryId: null, createdBy: sam, actorRole: 'member', at: AT });
    const id = add('FUEL STOP 12', -6130);
    recorded(alex, 'transfer', 'Marked 1 transaction as a transfer.', [id], () => {
      expect(setTransferFlag({ transactionId: id, isTransfer: true, userId: alex, actorRole: 'admin', learnRule: true, at: AT }).ok).toBe(true);
    });
    // A new override on the same merchant, with a new id, written straight to the table.
    t.sqlite
      .prepare(
        `insert into merchant_rules (pattern, match_type, rule_kind, created_by, hit_count, created_at)
         values ('FUEL STOP 12', 'exact', 'not_transfer', ?, 0, ?)`,
      )
      .run(sam, SOON.toISOString());
    const state = { rows: rows(), rules: rules() };

    expect(undoLastBulkAction({ viewer: household(alex), now: SOON })).toEqual({ ok: false, error: BULK_UNDO_STALE_ERROR });
    expect({ rows: rows(), rules: rules() }).toEqual(state);
    expect(listAudit()).toEqual([]);
  });
});

describe('bulk undo: one record per person', () => {
  it('a second action replaces the first', () => {
    const { alex, add, row, groceries } = setup();
    const maple = add('MAPLE GROCER', -4217);
    const fuel = add('FUEL STOP 12', -6130);
    recorded(alex, 'categorize', 'Categorized 1 transaction as Groceries.', [maple], () => categorize([maple], groceries, alex));
    recorded(alex, 'transfer', 'Marked 1 transaction as a transfer.', [fuel], () => {
      setTransferFlag({ transactionId: fuel, isTransfer: true, userId: alex, actorRole: 'admin', learnRule: true, at: AT });
    });

    expect(lastBulkUndo(alex, SOON)?.label).toBe('Marked 1 transaction as a transfer.');
    expect(undoLastBulkAction({ viewer: household(alex), now: SOON }).ok).toBe(true);
    expect(row(fuel).isTransfer).toBe(0);
    expect(row(maple)).toMatchObject({ categoryId: groceries, source: 'manual' });
    // A second click (or a second tab still showing the bar): nothing is old, there is just nothing.
    expect(undoLastBulkAction({ viewer: household(alex), now: SOON })).toEqual({ ok: false, error: BULK_UNDO_NOTHING_ERROR });
  });

  it("Sam's action leaves Alex's record alone, and Sam cannot undo Alex's change", () => {
    const { alex, sam, add, row, groceries } = setup();
    const maple = add('MAPLE GROCER', -4217);
    const fuel = add('FUEL STOP 12', -6130);
    recorded(alex, 'categorize', 'Categorized 1 transaction as Groceries.', [maple], () => categorize([maple], groceries, alex));
    const samViewer: Viewer = { id: sam, role: 'member', visibility: 'household' };

    expect(undoLastBulkAction({ viewer: samViewer, now: SOON })).toEqual({ ok: false, error: BULK_UNDO_NOTHING_ERROR });
    expect(row(maple)).toMatchObject({ categoryId: groceries, source: 'manual' });

    recorded(sam, 'person', 'Set Sam on 1 transaction.', [fuel], () => bulkSetAttribution([fuel], sam));
    expect(lastBulkUndo(alex, SOON)?.label).toBe('Categorized 1 transaction as Groceries.');
    expect(undoLastBulkAction({ viewer: samViewer, now: SOON }).ok).toBe(true);
    expect(row(fuel).person).toBeNull();
    expect(row(maple)).toMatchObject({ categoryId: groceries, source: 'manual' });
    expect(lastBulkUndo(alex, SOON)?.label).toBe('Categorized 1 transaction as Groceries.');
  });

  it('an action that changed nothing keeps the previous record', () => {
    const { alex, add, groceries } = setup();
    const maple = add('MAPLE GROCER', -4217);
    const fuel = add('FUEL STOP 12', -6130, { person: alex });
    recorded(alex, 'categorize', 'Categorized 1 transaction as Groceries.', [maple], () => categorize([maple], groceries, alex));

    expect(recorded(alex, 'person', 'Set Alex on 1 transaction.', [fuel], () => bulkSetAttribution([fuel], alex))).toBe('unchanged');
    expect(lastBulkUndo(alex, SOON)?.label).toBe('Categorized 1 transaction as Groceries.');
  });

  it(`${BULK_UNDO_MAX_ROWS + 1} rows are too large to record, and the previous record goes`, () => {
    const { t, alex, add, groceries } = setup();
    const maple = add('MAPLE GROCER', -4217);
    recorded(alex, 'categorize', 'Categorized 1 transaction as Groceries.', [maple], () => categorize([maple], groceries, alex));
    const many = t.sqlite.transaction(() => Array.from({ length: BULK_UNDO_MAX_ROWS + 1 }, (_, n) => add('FUEL STOP 12', -100 - n)))();

    const before = captureBulkBefore({ ids: many });
    expect(before).toEqual({ tooLarge: true });
    bulkSetAttribution(many, alex);
    expect(recordBulkUndo({ userId: alex, kind: 'person', label: 'Set Alex on 2,001 transactions.', before, at: AT })).toBe('too_large');
    expect(lastBulkUndo(alex, SOON)).toBeNull();
    expect(getSetting(`bulk_undo:${alex}`)).toBeNull();
  });
});

describe('bulk undo: a self-scoped viewer', () => {
  it('undoes their own transfer change, and is refused once a row was reattributed to Sam', () => {
    const { t, alex, sam, add, row } = setup();
    t.sqlite.prepare("update users set role = 'member', visibility = 'self' where id = ?").run(alex);
    const self: Viewer = { id: alex, role: 'member', visibility: 'self' };
    const a = add('MAPLE SAVINGS XFER', -50000, { person: alex });
    const b = add('MAPLE SAVINGS XFER', -25000, { person: alex });
    const markBoth = () => {
      for (const id of [a, b]) {
        expect(setTransferFlag({ transactionId: id, isTransfer: true, userId: alex, actorRole: 'member', learnRule: true, at: AT }).ok).toBe(true);
      }
    };

    recorded(alex, 'transfer', 'Marked 2 transactions as transfers.', [a, b], markBoth);
    expect(undoLastBulkAction({ viewer: self, now: SOON })).toMatchObject({ ok: true, rows: 2, rulesRemoved: 1 });
    expect([row(a).isTransfer, row(b).isTransfer]).toEqual([0, 0]);

    recorded(alex, 'transfer', 'Marked 2 transactions as transfers.', [a, b], markBoth);
    bulkSetAttribution([b], sam);
    expect(undoLastBulkAction({ viewer: self, now: SOON })).toEqual({ ok: false, error: NOT_YOURS_ERROR });
    expect([row(a).isTransfer, row(b).isTransfer, row(b).person]).toEqual([1, 1, sam]);
  });
});
