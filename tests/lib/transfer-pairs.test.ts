import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { listAudit } from '@/lib/audit';
import { NOT_YOURS_ERROR, type Viewer } from '@/lib/auth/viewer';
import { captureBulkBefore, lastBulkUndo, recordBulkUndo, undoLastBulkAction } from '@/lib/bulk-undo';
import { nowIso } from '@/lib/clock';
import { getSetting } from '@/lib/settings';
import {
  confirmTransferPair,
  dismissTransferPair,
  dismissalKey,
  suggestTransferPairs,
  TRANSFER_PAIR_STALE_ERROR,
} from '@/lib/transfer-pairs';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const AT = new Date('2026-03-12T14:00:00.000Z');
const household = (id: number): Viewer => ({ id, role: 'admin', visibility: 'household' });

interface RowOver {
  date?: string;
  categoryId?: number | null;
  source?: 'rule' | 'bayes' | 'manual' | 'none';
  isTransfer?: boolean;
  description?: string;
}

function setup() {
  current = createSeededTestDb();
  const t = current;
  const alex = insertTestUser(t.db, { name: 'Alex', username: 'alex', role: 'admin' });
  const sam = insertTestUser(t.db, { name: 'Sam', username: 'sam', role: 'member' });
  const chequing = insertTestAccount(t.db, { name: 'Everyday Chequing', type: 'chequing' });
  const savings = insertTestAccount(t.db, { name: 'Rainy Day Savings', type: 'savings' });
  const insert = t.sqlite.prepare(
    `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id,
       categorization_source, is_transfer, created_by, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
  );
  const add = (accountId: number, amountCents: number, over: RowOver = {}): number =>
    (
      insert.get(
        accountId,
        over.date ?? '2026-03-09',
        over.description ?? 'E-TRANSFER 4417',
        (over.description ?? 'E-TRANSFER 4417').toLowerCase(),
        amountCents,
        over.categoryId ?? null,
        over.source ?? 'none',
        over.isTransfer ? 1 : 0,
        alex,
        nowIso(AT),
        nowIso(AT),
      ) as { id: number }
    ).id;
  const owner = (accountId: number, userId: number | null) =>
    t.sqlite.prepare('update accounts set owner_user_id = ? where id = ?').run(userId, accountId);
  const flag = (id: number) => (t.sqlite.prepare('select is_transfer as v from transactions where id = ?').get(id) as { v: number }).v;
  return { t, alex, sam, chequing, savings, add, owner, flag, viewer: household(alex) };
}

describe('suggestTransferPairs', () => {
  it('pairs equal and opposite amounts three days apart', () => {
    const { add, chequing, savings, viewer } = setup();
    const out = add(chequing, -50000, { date: '2026-03-09' });
    const inc = add(savings, 50000, { date: '2026-03-12' });
    const { pairs, total } = suggestTransferPairs(viewer);
    expect(total).toBe(1);
    expect(pairs[0].out.id).toBe(out);
    expect(pairs[0].in.id).toBe(inc);
    expect(pairs[0].out.accountName).toBe('Everyday Chequing');
    expect(pairs[0].in.accountName).toBe('Rainy Day Savings');
  });

  it('does not pair on the fourth day', () => {
    const { add, chequing, savings, viewer } = setup();
    add(chequing, -50000, { date: '2026-03-09' });
    add(savings, 50000, { date: '2026-03-13' });
    expect(suggestTransferPairs(viewer)).toEqual({ pairs: [], total: 0 });
  });

  it('does not pair one cent off, the same account, or an inactive account', () => {
    const { t, add, chequing, savings, viewer } = setup();
    add(chequing, -50000);
    add(savings, 50001);
    add(chequing, 50000);
    expect(suggestTransferPairs(viewer).total).toBe(0);
    add(savings, 50000);
    expect(suggestTransferPairs(viewer).total).toBe(1);
    t.sqlite.prepare('update accounts set is_active = 0 where id = ?').run(savings);
    expect(suggestTransferPairs(viewer).total).toBe(0);
  });

  it('returns nothing for a self-scoped viewer', () => {
    const { add, chequing, savings, alex } = setup();
    add(chequing, -50000);
    add(savings, 50000);
    const member: Viewer = { id: alex, role: 'member', visibility: 'self' };
    expect(suggestTransferPairs(member)).toEqual({ pairs: [], total: 0 });
  });

  describe('the scope rule, with Alex self-scoped', () => {
    function scoped() {
      const s = setup();
      s.t.sqlite.prepare("update users set role = 'member', visibility = 'self' where id = ?").run(s.alex);
      s.add(s.chequing, -50000);
      s.add(s.savings, 50000);
      return s;
    }
    it('pairs Alex chequing with Alex savings', () => {
      const s = scoped();
      s.owner(s.chequing, s.alex);
      s.owner(s.savings, s.alex);
      expect(suggestTransferPairs(household(s.sam)).total).toBe(1);
    });
    it('does not pair Alex with Sam', () => {
      const s = scoped();
      s.owner(s.chequing, s.alex);
      s.owner(s.savings, s.sam);
      expect(suggestTransferPairs(household(s.sam)).total).toBe(0);
    });
    it('does not pair Alex with a shared account', () => {
      const s = scoped();
      s.owner(s.chequing, s.alex);
      s.owner(s.savings, null);
      expect(suggestTransferPairs(household(s.sam)).total).toBe(0);
    });
    it('pairs Sam (household) with a shared account', () => {
      const s = scoped();
      s.owner(s.chequing, s.sam);
      s.owner(s.savings, null);
      expect(suggestTransferPairs(household(s.sam)).total).toBe(1);
    });
  });

  it('suggests a pair with one side already a transfer, and confirm marks only the other', () => {
    const { add, chequing, savings, viewer, flag } = setup();
    const out = add(chequing, -50000);
    const inc = add(savings, 50000, { isTransfer: true });
    expect(suggestTransferPairs(viewer).pairs[0].in.isTransfer).toBe(true);
    const result = confirmTransferPair({ outId: out, inId: inc, viewer, at: AT });
    expect(result).toEqual({ ok: true, marked: 1 });
    expect([flag(out), flag(inc)]).toEqual([1, 1]);
  });

  it('never pairs a hand-filed, loan-linked or split row', () => {
    const { t, add, chequing, savings, alex, viewer } = setup();
    const groceries = categoryIdByName(t.db, 'Groceries');
    const out = add(chequing, -50000);
    add(savings, 50000, { categoryId: groceries, source: 'manual' });
    expect(suggestTransferPairs(viewer).total).toBe(0);

    const split = add(savings, 50000, { date: '2026-03-10' });
    t.sqlite
      .prepare('insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (?, ?, ?, ?)')
      .run(split, groceries, 50000, nowIso(AT));
    expect(suggestTransferPairs(viewer).total).toBe(0);

    const linked = add(savings, 50000, { date: '2026-03-11' });
    const typeId = t.db.get<{ id: number }>(sql`insert into warranty_item_types (name, is_subscription, kind, created_at)
      values (${'Loan type'}, 0, 'loan', ${nowIso(AT)}) returning id`).id;
    const itemId = t.db.get<{ id: number }>(sql`insert into warranty_items
      (name, purchase_date, is_lifetime, owner_user_id, type_id, loan_direction, current_balance_cents, balance_updated_at, created_at, updated_at)
      values (${'Test loan'}, '2026-01-01', 0, ${alex}, ${typeId}, 'owed', 5000000, ${nowIso(AT)}, ${nowIso(AT)}, ${nowIso(AT)}) returning id`).id;
    t.sqlite
      .prepare("insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at) values (?, ?, 50000, 50000, 'manual', ?)")
      .run(linked, itemId, nowIso(AT));
    expect(suggestTransferPairs(viewer).total).toBe(0);
    expect(confirmTransferPair({ outId: out, inId: linked, viewer })).toEqual({ ok: false, error: TRANSFER_PAIR_STALE_ERROR });
  });

  it('matches one to one, the nearest first and the lower id on a tie', () => {
    const { add, chequing, savings, viewer } = setup();
    const out1 = add(chequing, -50000, { date: '2026-03-09' });
    const out2 = add(chequing, -50000, { date: '2026-03-10' });
    const far = add(savings, 50000, { date: '2026-03-12' });
    const near = add(savings, 50000, { date: '2026-03-09' });
    const { pairs } = suggestTransferPairs(viewer);
    expect(pairs.map((p) => [p.out.id, p.in.id])).toEqual([
      [out2, far],
      [out1, near],
    ]);

    const tie = setup();
    const o = tie.add(tie.chequing, -70000, { date: '2026-03-10' });
    const low = tie.add(tie.savings, 70000, { date: '2026-03-09' });
    tie.add(tie.savings, 70000, { date: '2026-03-11' });
    expect(suggestTransferPairs(tie.viewer).pairs[0]).toMatchObject({ out: { id: o }, in: { id: low } });
  });

  it('remembers a dismissal while both rows still pair elsewhere, and prunes the dead ones', () => {
    const { t, add, chequing, savings, viewer } = setup();
    const out = add(chequing, -50000, { date: '2026-03-09' });
    const first = add(savings, 50000, { date: '2026-03-09' });
    const second = add(savings, 50000, { date: '2026-03-11' });
    expect(dismissTransferPair({ outId: out, inId: first, viewer, on: '2026-03-12' })).toEqual({ ok: true });
    expect(getSetting(dismissalKey(out, first))).toBe('2026-03-12');
    expect(suggestTransferPairs(viewer).pairs.map((p) => [p.out.id, p.in.id])).toEqual([[out, second]]);
    expect(suggestTransferPairs(viewer).pairs.map((p) => [p.out.id, p.in.id])).toEqual([[out, second]]);

    t.sqlite.prepare('delete from transactions where id = ?').run(first);
    const other = add(savings, 50000, { date: '2026-03-10' });
    dismissTransferPair({ outId: out, inId: other, viewer, on: '2026-03-12' });
    expect(getSetting(dismissalKey(out, first))).toBeNull();
    expect(getSetting(dismissalKey(out, other))).toBe('2026-03-12');
  });
});

describe('confirmTransferPair', () => {
  it('writes no merchant rule, and an undo restores both sides', () => {
    const { t, add, chequing, savings, viewer, flag } = setup();
    const out = add(chequing, -50000);
    const inc = add(savings, 50000);
    const before = captureBulkBefore({ ids: [out, inc] });
    expect(confirmTransferPair({ outId: out, inId: inc, viewer, at: AT })).toEqual({ ok: true, marked: 2 });
    recordBulkUndo({ userId: viewer.id, kind: 'transfer_pair', label: 'Marked 2 transactions as a transfer pair.', before, at: AT });
    expect([flag(out), flag(inc)]).toEqual([1, 1]);
    expect(t.sqlite.prepare('select count(*) as n from merchant_rules').get()).toEqual({ n: 0 });
    expect(listAudit()).toHaveLength(0);
    expect(lastBulkUndo(viewer.id, AT)).not.toBeNull();
    expect(undoLastBulkAction({ viewer, now: AT }).ok).toBe(true);
    expect([flag(out), flag(inc)]).toEqual([0, 0]);
    expect(listAudit().map((row) => row.action)).toEqual(['undo_bulk_action']);
  });

  it('refuses a stale pair and writes nothing', () => {
    const { t, add, chequing, savings, viewer, flag } = setup();
    const out = add(chequing, -50000);
    const inc = add(savings, 50000);
    t.sqlite.prepare("update transactions set date = '2026-03-20' where id = ?").run(inc);
    expect(confirmTransferPair({ outId: out, inId: inc, viewer })).toEqual({ ok: false, error: TRANSFER_PAIR_STALE_ERROR });
    expect([flag(out), flag(inc)]).toEqual([0, 0]);
  });

  it('refuses a self viewer, and lets a member confirm', () => {
    const { add, chequing, savings, sam, alex } = setup();
    const out = add(chequing, -50000);
    const inc = add(savings, 50000);
    const self: Viewer = { id: alex, role: 'member', visibility: 'self' };
    expect(confirmTransferPair({ outId: out, inId: inc, viewer: self })).toEqual({ ok: false, error: NOT_YOURS_ERROR });
    expect(confirmTransferPair({ outId: out, inId: inc, viewer: { id: sam, role: 'member', visibility: 'household' } })).toEqual({
      ok: true,
      marked: 2,
    });
  });
});
