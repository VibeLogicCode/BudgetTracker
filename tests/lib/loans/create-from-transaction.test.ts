import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { createLoanFromTransaction, paymentLinksForTransaction } from '@/lib/loans';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import type { Viewer } from '@/lib/auth/viewer';

const NOW = '2026-08-28T12:00:00.000Z';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/**
 * A fresh, seeded db with one user and one account -- with the migration's own default 'Loan'
 * item type (drizzle/0004_item_type_kinds.sql inserts one, unconditionally, into every
 * migrated database) removed again, so this starts genuinely at "the household has none" --
 * the state rulings A5/A6 describe -- for every test that does not set one up itself.
 */
function setup(): { db: TestDb; userId: number; accountId: number; viewer: Viewer } {
  const db = createSeededTestDb();
  db.sqlite.prepare("delete from warranty_item_types where kind = 'loan'").run();
  const userId = insertTestUser(db.db, { username: 'owner' });
  const accountId = insertTestAccount(db.db, { name: 'Chequing' });
  current = db;
  return { db, userId, accountId, viewer: { id: userId, role: 'admin', visibility: 'household' } };
}

function addTxn(
  db: TestDb,
  accountId: number,
  userId: number,
  amountCents: number,
  over: { attributedUserId?: number | null; description?: string } = {},
): number {
  const description = over.description ?? 'E-TRANSFER SAM';
  const row = db.db.get<{ id: number }>(
    sql`insert into transactions
          (account_id, date, raw_description, normalized_merchant, amount_cents, attributed_user_id, created_by, created_at, updated_at)
        values (${accountId}, '2026-08-20', ${description}, ${normalizeMerchant(description)}, ${amountCents},
                ${over.attributedUserId ?? null}, ${userId}, ${NOW}, ${NOW})
        returning id`,
  );
  return row.id;
}

function loanItems(db: TestDb): { id: number; name: string; balance: number | null; direction: string; typeId: number; ownerUserId: number }[] {
  return db.sqlite
    .prepare(
      `select i.id, i.name, i.current_balance_cents as balance, i.loan_direction as direction, i.type_id as typeId, i.owner_user_id as ownerUserId
         from warranty_items i join warranty_item_types t on t.id = i.type_id
        where t.kind = 'loan' order by i.id`,
    )
    .all() as never;
}

function loanTypeCount(db: TestDb): number {
  return (db.sqlite.prepare("select count(*) as n from warranty_item_types where kind = 'loan'").get() as { n: number }).n;
}

function paymentCount(db: TestDb): number {
  return (db.sqlite.prepare('select count(*) as n from loan_payments').get() as { n: number }).n;
}

describe('createLoanFromTransaction — seed table (Addendum A, ruling A3)', () => {
  it('lends: money out on a new lent loan leaves the balance at exactly |amount|', () => {
    const { db, accountId, userId, viewer } = setup();
    const txnId = addTxn(db, accountId, userId, -50_000);
    const result = createLoanFromTransaction({ txnId, name: 'Loan to Sam', direction: 'lent' }, viewer);
    expect(result.balanceAfterCents).toBe(50_000);
    expect(result.appliedCents).toBe(50_000);
    const [loan] = loanItems(db);
    expect(loan!.direction).toBe('lent');
    expect(loan!.balance).toBe(50_000);
  });

  it('borrows, money in: the deposit that arrived becomes the opening balance', () => {
    const { db, accountId, userId, viewer } = setup();
    const txnId = addTxn(db, accountId, userId, 50_000);
    const result = createLoanFromTransaction({ txnId, name: 'Bank loan', direction: 'owed' }, viewer);
    expect(result.balanceAfterCents).toBe(50_000);
    expect(loanItems(db)[0]!.balance).toBe(50_000);
  });

  it('borrows, money out: a first payment still leaves |amount| owing (seed 2m)', () => {
    const { db, accountId, userId, viewer } = setup();
    const txnId = addTxn(db, accountId, userId, -50_000);
    const result = createLoanFromTransaction({ txnId, name: 'Family loan', direction: 'owed' }, viewer);
    // Seeded at 2m so link()'s repayment of m lands on m -- link() is the only mover (ruling A3).
    expect(result.balanceAfterCents).toBe(50_000);
    expect(loanItems(db)[0]!.balance).toBe(50_000);
  });

  it('refuses a lent loan opened by money coming IN, and writes nothing at all', () => {
    const { db, accountId, userId, viewer } = setup();
    const txnId = addTxn(db, accountId, userId, 50_000);
    expect(() => createLoanFromTransaction({ txnId, name: 'Loan to Sam', direction: 'lent' }, viewer)).toThrow(
      'A loan you lent out starts with money going out.',
    );
    expect(loanItems(db)).toEqual([]);
    expect(loanTypeCount(db)).toBe(0);
    expect(paymentCount(db)).toBe(0);
  });
});

describe('createLoanFromTransaction — idempotency (ruling A7)', () => {
  it('refuses a second create against the same transaction, leaving exactly one loan', () => {
    const { db, accountId, userId, viewer } = setup();
    const txnId = addTxn(db, accountId, userId, -50_000);
    createLoanFromTransaction({ txnId, name: 'Loan to Sam', direction: 'lent' }, viewer);
    expect(() => createLoanFromTransaction({ txnId, name: 'Loan to Sam (again)', direction: 'lent' }, viewer)).toThrow(
      'That transaction is already assigned to a loan.',
    );
    expect(loanItems(db)).toHaveLength(1);
    expect(loanItems(db)[0]!.balance).toBe(50_000);
    expect(paymentLinksForTransaction(txnId).loans).toBe(1);
  });
});

describe('createLoanFromTransaction — implicit item type (rulings A5, A6)', () => {
  it('creates the Loan item type when the household has none, and reuses it next time', () => {
    const { db, accountId, userId, viewer } = setup();
    createLoanFromTransaction({ txnId: addTxn(db, accountId, userId, -50_000), name: 'First', direction: 'lent' }, viewer);
    const types = db.sqlite.prepare("select id, name from warranty_item_types where kind = 'loan'").all() as {
      id: number;
      name: string;
    }[];
    expect(types.map((t) => t.name)).toEqual(['Loan']);
    createLoanFromTransaction({ txnId: addTxn(db, accountId, userId, -25_000), name: 'Second', direction: 'lent' }, viewer);
    expect(loanTypeCount(db)).toBe(1);
    expect(loanItems(db).map((loan) => loan.balance)).toEqual([50_000, 25_000]);
  });

  it('uses the first loan-kind type in name order when more than one already exists', () => {
    const { db, accountId, userId, viewer } = setup();
    db.sqlite.prepare("insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Zebra loan', 0, 'loan', ?)").run(NOW);
    const alpha = db.sqlite
      .prepare("insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Alpha loan', 0, 'loan', ?) returning id")
      .get(NOW) as { id: number };
    const txnId = addTxn(db, accountId, userId, -50_000);
    createLoanFromTransaction({ txnId, name: 'Loan to Sam', direction: 'lent' }, viewer);
    expect(loanItems(db)[0]!.typeId).toBe(alpha.id);
    expect(loanTypeCount(db)).toBe(2); // no third type was created
  });
});

describe('createLoanFromTransaction — self-scope (rulings A10, A12)', () => {
  it('a self viewer\'s loan is owned by them, never by the row\'s attribution', () => {
    const { db, accountId, userId } = setup();
    const selfViewer: Viewer = { id: userId, role: 'member', visibility: 'self' };
    // getTransaction(id, selfViewer) only ever resolves rows already scoped to this viewer --
    // attributed_user_id = userId is the only row a self viewer could see at all -- so this is
    // the one case the self-scope table describes: ownerUserId is set from viewer.id DIRECTLY,
    // never re-derived from txn.attributedUserId, even though the two happen to agree here.
    const txnId = addTxn(db, accountId, userId, -50_000, { attributedUserId: userId });
    const result = createLoanFromTransaction({ txnId, name: 'Loan to Sam', direction: 'lent' }, selfViewer);
    expect(result).toBeTruthy();
    expect(loanItems(db)[0]!.ownerUserId).toBe(userId);
  });

  it('a self viewer cannot open a loan against a transaction outside their own scope', () => {
    const { db, accountId, userId } = setup();
    const other = insertTestUser(db.db, { username: 'other' });
    const selfViewer: Viewer = { id: userId, role: 'member', visibility: 'self' };
    const txnId = addTxn(db, accountId, userId, -50_000, { attributedUserId: other });
    // getTransaction(id, selfViewer) resolves this row through the OTHER user's attribution,
    // so it is outside this viewer's scope and getTransaction returns null -- same refusal as
    // "no such row" (ruling A10, spec Self-scope table).
    expect(() => createLoanFromTransaction({ txnId, name: 'Loan to Sam', direction: 'lent' }, selfViewer)).toThrow();
    expect(loanItems(db)).toEqual([]);
  });

  it('a household transaction with no attribution becomes the acting viewer\'s own loan', () => {
    const { db, accountId, userId, viewer } = setup();
    const txnId = addTxn(db, accountId, userId, -50_000);
    createLoanFromTransaction({ txnId, name: 'Loan to Sam', direction: 'lent' }, viewer);
    expect(loanItems(db)[0]!.ownerUserId).toBe(viewer.id);
  });

  it('a household MEMBER is refused a row attributed to someone else', () => {
    const { db, accountId, userId } = setup();
    const other = insertTestUser(db.db, { username: 'other' });
    const member: Viewer = { id: userId, role: 'member', visibility: 'household' };
    const txnId = addTxn(db, accountId, userId, -50_000, { attributedUserId: other });
    expect(() => createLoanFromTransaction({ txnId, name: 'Loan to Sam', direction: 'lent' }, member)).toThrow(
      'That belongs to someone else in the household.',
    );
    expect(loanItems(db)).toEqual([]);
  });

  it('a household ADMIN may act on a row attributed to someone else, and the loan is owned by that person', () => {
    const { db, accountId, userId, viewer } = setup();
    const other = insertTestUser(db.db, { username: 'other' });
    const txnId = addTxn(db, accountId, userId, -50_000, { attributedUserId: other });
    createLoanFromTransaction({ txnId, name: 'Loan to Sam', direction: 'lent' }, viewer);
    expect(loanItems(db)[0]!.ownerUserId).toBe(other);
  });
});

describe('createLoanFromTransaction — rollback (ruling A4)', () => {
  it('a refused create leaves no item, no implicit type, and no link behind', () => {
    const { db, accountId, userId, viewer } = setup();
    const txnId = addTxn(db, accountId, userId, 0);
    expect(() => createLoanFromTransaction({ txnId, name: 'Zero', direction: 'owed' }, viewer)).toThrow();
    expect(loanItems(db)).toEqual([]);
    expect(loanTypeCount(db)).toBe(0);
    expect(paymentCount(db)).toBe(0);
  });

  it('refuses a blank name and writes nothing', () => {
    const { db, accountId, userId, viewer } = setup();
    const txnId = addTxn(db, accountId, userId, -50_000);
    expect(() => createLoanFromTransaction({ txnId, name: '   ', direction: 'lent' }, viewer)).toThrow();
    expect(loanItems(db)).toEqual([]);
    expect(loanTypeCount(db)).toBe(0);
  });

  it('a transaction that no longer exists is refused and writes nothing', () => {
    const { db, viewer } = setup();
    expect(() => createLoanFromTransaction({ txnId: 999_999, name: 'Ghost', direction: 'lent' }, viewer)).toThrow();
    expect(loanItems(db)).toEqual([]);
  });
});

describe('createLoanFromTransaction — no literal direction value (ruling P4)', () => {
  it('never spells the direction value itself in src/lib/loans.ts', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const source = fs.readFileSync(path.join(root, 'src/lib/loans.ts'), 'utf8');
    expect(source).not.toMatch(/'lent'|"lent"/);
  });
});
