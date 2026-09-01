import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { assignTransactionToLoan, debtOverTime, unassignTransactionFromLoan } from '@/lib/loans';

let t: TestDb;
let userId = 0;
let accountId = 0;
let typeId = 0;

beforeEach(() => {
  t = createSeededTestDb();
  userId = insertTestUser(t.db, { username: 'loans' });
  accountId = insertTestAccount(t.db, { name: 'Chequing' });
  const type = t.sqlite
    .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Car loan', 0, 'loan', ?) returning id`)
    .get('2020-01-01T00:00:00.000Z') as { id: number };
  typeId = type.id;
});
afterEach(() => {
  t.cleanup();
  vi.restoreAllMocks();
});

/** A loan-kind warranty_items row, with full control over created_at (item existence) and
 *  balance_updated_at (the human anchor) -- the two dates debtOverTime's clauses key off. */
function seedItem(over: {
  name?: string;
  createdAt?: string;
  balanceCents?: number | null;
  balanceUpdatedAt?: string | null;
  /** v1.14.0. Omitted => the INSERT does not name loan_direction at all, so the row takes the
   *  column DEFAULT exactly as every pre-migration row does (ruling P5's byte-identical proof). */
  direction?: 'owed' | 'lent';
}): number {
  const createdAt = over.createdAt ?? '2020-01-01T00:00:00.000Z';
  const row =
    over.direction === undefined
      ? (t.sqlite
          .prepare(
            `insert into warranty_items
               (name, purchase_date, is_lifetime, owner_user_id, type_id, current_balance_cents, balance_updated_at, created_at, updated_at)
             values (?, '2020-01-01', 0, ?, ?, ?, ?, ?, ?) returning id`,
          )
          .get(
            over.name ?? 'Loan',
            userId,
            typeId,
            over.balanceCents === undefined ? null : over.balanceCents,
            over.balanceUpdatedAt ?? null,
            createdAt,
            createdAt,
          ) as { id: number })
      : (t.sqlite
          .prepare(
            `insert into warranty_items
               (name, purchase_date, is_lifetime, owner_user_id, type_id, current_balance_cents, balance_updated_at, loan_direction, created_at, updated_at)
             values (?, '2020-01-01', 0, ?, ?, ?, ?, ?, ?, ?) returning id`,
          )
          .get(
            over.name ?? 'Loan',
            userId,
            typeId,
            over.balanceCents === undefined ? null : over.balanceCents,
            over.balanceUpdatedAt ?? null,
            over.direction,
            createdAt,
            createdAt,
          ) as { id: number });
  return row.id;
}

/** Moves one item's balance_updated_at (the human anchor) directly, by name -- used to make a
 *  SECOND loan's balance unknown as of an earlier month without touching the first loan's own
 *  anchor. Local to this file, not fixtures.ts, which lane A shares across four other suites. */
function anchorBalanceAt(name: string, at: string): void {
  t.sqlite.prepare('update warranty_items set balance_updated_at = ? where name = ?').run(at, name);
}

/** Inserts a transaction and its linked loan_payments row. `createdAt` is when the LINK ROW was
 *  written (the import wall-clock); `txnDate` -- the column debtOverTime now groups by (v1.25.0)
 *  -- is the transaction's own real date and defaults to `createdAt`'s own day, so every
 *  pre-existing call site (which never distinguished the two) is unaffected. Passing a `txnDate`
 *  that differs from `createdAt` is exactly how the late-import regression tests below simulate
 *  a statement imported months after the payment it carries actually happened. A negative
 *  `signedAmountCents` is a payment (a decrement, undone by adding applied_cents back); a
 *  positive one is a disbursement (an increment, undone by subtracting it), mirroring
 *  reverseLoanLinksForTransactions's own sign recovery. */
function link(itemId: number, opts: { signedAmountCents: number; appliedCents: number; createdAt: string; txnDate?: string }): void {
  const txnDate = opts.txnDate ?? opts.createdAt.slice(0, 10);
  const txn = t.sqlite
    .prepare(
      `insert into transactions
         (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
       values (?, ?, 'Payment', 'PAYMENT', ?, 0, ?, ?, ?) returning id`,
    )
    .get(accountId, txnDate, opts.signedAmountCents, userId, opts.createdAt, opts.createdAt) as { id: number };
  t.sqlite
    .prepare(`insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at) values (?, ?, ?, ?, 'manual', ?)`)
    .run(txn.id, itemId, Math.abs(opts.signedAmountCents), opts.appliedCents, opts.createdAt);
}

/** A direct balance edit -- both fields move together, the same pairing MUST-11.7/11.8 hold
 *  in the write path this test file does not otherwise exercise. */
function updateBalance(itemId: number, balanceCents: number, at: string): void {
  t.sqlite.prepare(`update warranty_items set current_balance_cents = ?, balance_updated_at = ? where id = ?`).run(balanceCents, at, itemId);
}

/** A bare transaction row, with no loan_payments row of its own -- for tests that link it
 *  through the real write path (assignTransactionToLoan) rather than seeding the link row
 *  directly, so the write path's own dating and clamping behavior is what's under test. */
function insertTxn(opts: { signedAmountCents: number; date: string }): number {
  const row = t.sqlite
    .prepare(
      `insert into transactions
         (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
       values (?, ?, 'Payment', 'PAYMENT', ?, 0, ?, ?, ?) returning id`,
    )
    .get(accountId, opts.date, opts.signedAmountCents, userId, `${opts.date}T00:00:00.000Z`, `${opts.date}T00:00:00.000Z`) as { id: number };
  return row.id;
}

function balanceOf(itemId: number): number | null {
  return (t.sqlite.prepare('select current_balance_cents as b from warranty_items where id = ?').get(itemId) as { b: number | null }).b;
}

/** better-sqlite3 exposes no counter, so count prepares through the driver's own hook. */
let prepared = 0;
beforeEach(() => {
  prepared = 0;
  const original = t.sqlite.prepare.bind(t.sqlite);
  vi.spyOn(t.sqlite, 'prepare').mockImplementation(((sqlText: string) => {
    prepared += 1;
    return original(sqlText);
  }) as typeof t.sqlite.prepare);
});
function queryCount(): number {
  return prepared;
}

describe('MUST-15.7: the reconstruction, clause by clause', () => {
  it('a month before the item existed contributes 0', () => {
    seedItem({ name: 'New loan', createdAt: '2026-04-01T00:00:00.000Z', balanceCents: 100_000, balanceUpdatedAt: '2026-04-01T00:00:00.000Z' });
    const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.find((p) => p.month === '2026-03')!.owedCents).toBe(0);
  });

  it('a month before balance_updated_at makes the whole point null', () => {
    // anchor set 2026-06-10; the balance before that was discarded.
    seedItem({ name: 'Loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 1_000_000, balanceUpdatedAt: '2026-06-10T00:00:00.000Z' });
    const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.find((p) => p.month === '2026-05')!.owedCents).toBeNull();
    expect(series.find((p) => p.month === '2026-06')!.owedCents).not.toBeNull();
  });

  it('a month after the anchor equals the balance plus the payments made since', () => {
    const itemId = seedItem({ name: 'Loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 1_955_000, balanceUpdatedAt: '2026-06-10T00:00:00.000Z' });
    link(itemId, { signedAmountCents: -45_000, appliedCents: 45_000, createdAt: '2026-07-15T00:00:00.000Z' });
    link(itemId, { signedAmountCents: -45_000, appliedCents: 45_000, createdAt: '2026-08-15T00:00:00.000Z' });
    const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.find((p) => p.month === '2026-06')!.owedCents).toBe(1_955_000 + 45_000 + 45_000);
    expect(series.find((p) => p.month === '2026-08')!.owedCents).toBe(1_955_000);
  });

  it('two loans where one is unknown makes the whole point null, not a partial total', () => {
    const itemId = seedItem({ name: 'Loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 1_955_000, balanceUpdatedAt: '2026-06-10T00:00:00.000Z' });
    link(itemId, { signedAmountCents: -45_000, appliedCents: 45_000, createdAt: '2026-07-15T00:00:00.000Z' });
    link(itemId, { signedAmountCents: -45_000, appliedCents: 45_000, createdAt: '2026-08-15T00:00:00.000Z' });
    // Second loan anchored in 2026-07.
    seedItem({ name: 'Second loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 455_000, balanceUpdatedAt: '2026-07-10T00:00:00.000Z' });
    const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.find((p) => p.month === '2026-06')!.owedCents).toBeNull();
    expect(series.find((p) => p.month === '2026-07')!.owedCents).toBe(2_455_000);
  });

  it('a loan with no balance being tracked contributes 0 rather than unknown', () => {
    seedItem({ name: 'Untracked', createdAt: '2020-01-01T00:00:00.000Z', balanceCents: null, balanceUpdatedAt: null });
    const series = debtOverTime(3, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.every((p) => p.owedCents !== null)).toBe(true);
  });

  it('a direct balance edit today truncates the series — the older months become null', () => {
    const itemId = seedItem({ name: 'Loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 1_955_000, balanceUpdatedAt: '2026-06-10T00:00:00.000Z' });
    updateBalance(itemId, 1_000_000, '2026-08-18T00:00:00.000Z');
    const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.slice(0, 5).every((p) => p.owedCents === null)).toBe(true);
    expect(series.at(-1)!.owedCents).toBe(1_000_000);
  });

  it('a disbursement after the anchor is undone by SUBTRACTING it back, not added like a payment', () => {
    // Task 10's fix-round sign trap: applied_cents is unsigned, so a positive (disbursement)
    // link must not be summed as if it were a payment when walking backwards.
    const itemId = seedItem({ name: 'Loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 1_000_000, balanceUpdatedAt: '2026-06-10T00:00:00.000Z' });
    link(itemId, { signedAmountCents: 200_000, appliedCents: 200_000, createdAt: '2026-08-01T00:00:00.000Z' });
    const series = debtOverTime(3, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.find((p) => p.month === '2026-07')!.owedCents).toBe(800_000);
    expect(series.find((p) => p.month === '2026-08')!.owedCents).toBe(1_000_000);
  });

  it('MUST-15.8: the whole series is computed from exactly TWO queries', () => {
    seedItem({ name: 'Loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 1_955_000, balanceUpdatedAt: '2026-06-10T00:00:00.000Z' });
    const before = queryCount();
    debtOverTime(24, { endMonth: '2026-08', today: '2026-08-18' });
    expect(queryCount() - before).toBe(2);
  });

  it('with no loans at all, every point is null', () => {
    const series = debtOverTime(3, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.every((p) => p.owedCents === null)).toBe(true);
    expect(series.map((p) => p.month)).toEqual(['2026-06', '2026-07', '2026-08']);
  });
});

describe('v1.25.0: buckets by the linked transaction date, not loan_payments.created_at', () => {
  it('a payment imported two months late still lands in its transaction month -- the owner-reported regression', () => {
    // Anchor is well before every month this test inspects, so none of MAY through AUGUST reads
    // as "unknown" (MUST-15.7's own anchor clause, exercised separately above) -- the only thing
    // this test is isolating is which month the PAYMENT lands in.
    const itemId = seedItem({ name: 'Loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 1_000_000, balanceUpdatedAt: '2024-01-01T00:00:00.000Z' });
    // The payment happened in June; the statement carrying it wasn't imported (the loan_payments
    // row wasn't written) until August -- two months later.
    link(itemId, { signedAmountCents: -45_000, appliedCents: 45_000, txnDate: '2026-06-15', createdAt: '2026-08-15T00:00:00.000Z' });
    const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
    // Before the fix, bucketing by created_at (August) meant June and July were reconstructed as
    // though the payment hadn't happened yet (1,045,000), only "catching up" in August. June and
    // July must already show the post-payment balance; only May (truly before the payment) shows
    // the pre-payment figure.
    expect(series.find((p) => p.month === '2026-05')!.owedCents).toBe(1_045_000);
    expect(series.find((p) => p.month === '2026-06')!.owedCents).toBe(1_000_000);
    expect(series.find((p) => p.month === '2026-07')!.owedCents).toBe(1_000_000);
    expect(series.find((p) => p.month === '2026-08')!.owedCents).toBe(1_000_000);
  });

  it('two payments landing in the same transaction month, imported at different times, sum together in that month', () => {
    const itemId = seedItem({ name: 'Loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 1_000_000, balanceUpdatedAt: '2024-01-01T00:00:00.000Z' });
    // One imported the same day; one imported six weeks later. Both are transactions dated in June.
    link(itemId, { signedAmountCents: -20_000, appliedCents: 20_000, txnDate: '2026-06-05', createdAt: '2026-06-05T00:00:00.000Z' });
    link(itemId, { signedAmountCents: -25_000, appliedCents: 25_000, txnDate: '2026-06-20', createdAt: '2026-08-10T00:00:00.000Z' });
    const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.find((p) => p.month === '2026-05')!.owedCents).toBe(1_045_000);
    expect(series.find((p) => p.month === '2026-06')!.owedCents).toBe(1_000_000);
  });
});

describe('Task 10 carry (a): the documented drift after a clamped unassign', () => {
  it('the exact probe: 10,000 +60,000 disb June -> 70,000; -70,000 payment July -> 0; unassign disb clamps -- pre-June reconstructs 70,000, not the true 10,000, while the CURRENT month stays exact', () => {
    const itemId = seedItem({ name: 'Drift loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 10_000, balanceUpdatedAt: '2024-01-01T00:00:00.000Z' });

    const disbTxn = insertTxn({ signedAmountCents: 60_000, date: '2026-06-15' });
    expect(assignTransactionToLoan({ txnId: disbTxn, itemId, at: new Date('2026-06-15T00:00:00.000Z') })).toEqual({
      linked: true,
      appliedCents: 60_000,
    });
    expect(balanceOf(itemId)).toBe(70_000);

    const paymentTxn = insertTxn({ signedAmountCents: -70_000, date: '2026-07-15' });
    expect(assignTransactionToLoan({ txnId: paymentTxn, itemId, at: new Date('2026-07-15T00:00:00.000Z') })).toEqual({
      linked: true,
      appliedCents: 70_000,
    });
    expect(balanceOf(itemId)).toBe(0);

    // The clamp: naively this restore asks for 0 - 60,000 = -60,000. It clamps at zero instead
    // of crashing (NEW-1 fix-round) -- and the June link row is deleted along with it, so its
    // effect leaves no trace for debtOverTime's backward walk to re-add.
    expect(unassignTransactionFromLoan({ txnId: disbTxn, itemId })).toBe(true);
    expect(balanceOf(itemId)).toBe(0);

    const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
    // Documented drift, not a bug to fix here: the deleted June row can no longer be added back
    // on the walk backwards, so every month before the clamped event reconstructs as if the
    // disbursement had never happened at all -- 70,000 (the July payment's own undo, with
    // nothing left to cancel it), not the true pre-disbursement balance of 10,000.
    expect(series.find((p) => p.month === '2026-04')!.owedCents).toBe(70_000);
    expect(series.find((p) => p.month === '2026-05')!.owedCents).toBe(70_000);
    // The CURRENT month is exact: it anchors on current_balance_cents directly, which the
    // clamp kept honestly at zero rather than fabricating a negative number.
    expect(series.find((p) => p.month === '2026-08')!.owedCents).toBe(0);
  });
});

describe('debtOverTime splits the two directions (rulings P5, P6)', () => {
  it('an owed loan reconstructs exactly as before and contributes nothing to lentCents', () => {
    // The byte-identical proof. seedItem() with no `direction` does not name loan_direction in
    // its INSERT at all, so this row is shaped exactly like every pre-1.14.0 row on disk.
    const itemId = seedItem({ name: 'Civic', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 200_000, balanceUpdatedAt: '2024-01-01T00:00:00.000Z' });
    const payment = insertTxn({ signedAmountCents: -50_000, date: '2026-08-05' });
    assignTransactionToLoan({ txnId: payment, itemId, at: new Date('2026-08-05T00:00:00.000Z') });

    const points = debtOverTime(3, { endMonth: '2026-08', today: '2026-08-18' });
    expect(points.map((p) => p.owedCents)).toEqual([200_000, 200_000, 150_000]);
    expect(points.map((p) => p.lentCents)).toEqual([null, null, null]);
  });

  it('a lent loan is excluded from owedCents and reconstructed as its own series', () => {
    const itemId = seedItem({
      name: 'Loan to a friend',
      createdAt: '2024-01-01T00:00:00.000Z',
      balanceCents: 50_000,
      balanceUpdatedAt: '2024-01-01T00:00:00.000Z',
      direction: 'lent',
    });
    // A repayment in the current month: walking BACKWARDS, it is added back on.
    const repayment = insertTxn({ signedAmountCents: 20_000, date: '2026-08-05' });
    assignTransactionToLoan({ txnId: repayment, itemId, at: new Date('2026-08-05T00:00:00.000Z') });

    const points = debtOverTime(3, { endMonth: '2026-08', today: '2026-08-18' });
    expect(points.map((p) => p.owedCents)).toEqual([null, null, null]);
    expect(points.map((p) => p.lentCents)).toEqual([50_000, 50_000, 30_000]);
  });

  it('the two series are computed independently: one unknown lent loan does not break the debt line', () => {
    seedItem({ name: 'Civic', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 200_000, balanceUpdatedAt: '2024-01-01T00:00:00.000Z' });
    seedItem({
      name: 'Loan to a friend',
      createdAt: '2024-01-01T00:00:00.000Z',
      balanceCents: 50_000,
      balanceUpdatedAt: '2024-01-01T00:00:00.000Z',
      direction: 'lent',
    });
    // Anchored in the FUTURE relative to the earlier months, which is what makes it unknown there.
    anchorBalanceAt('Loan to a friend', '2026-08-10T00:00:00.000Z');

    const points = debtOverTime(3, { endMonth: '2026-08', today: '2026-08-18' });
    expect(points.map((p) => p.owedCents)).toEqual([200_000, 200_000, 200_000]);
    expect(points.map((p) => p.lentCents)).toEqual([null, null, 50_000]);
  });

  it('a household with no loans at all still returns both series as null', () => {
    const points = debtOverTime(2, { endMonth: '2026-08', today: '2026-08-18' });
    expect(points).toEqual([
      { month: '2026-07', owedCents: null, lentCents: null },
      { month: '2026-08', owedCents: null, lentCents: null },
    ]);
  });
});
