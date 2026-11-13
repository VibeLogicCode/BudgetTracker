import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import type { Viewer } from '@/lib/auth/viewer';
import { safeToSpend } from '@/lib/bills';
import { budgetProgress, upsertBudget } from '@/lib/budgets';
import { setRecurringMarks } from '@/lib/categorize/rules';
import { nowIso } from '@/lib/clock';
import { saveLoanRule } from '@/lib/loans';
import { monthCheckIn, recurringCountLine, type MonthCheckIn } from '@/lib/month-checkin';
import { expectedRecurringCharges } from '@/lib/recurring';

/**
 * v1.62.0, the month check-in: spent so far + bills and marked recurring charges still due + the
 * usual rest of the month (the median of the day-aligned stretch in the last three complete
 * months). Unless a test says otherwise, today is 2026-03-07 (31 days, 24 left) and the oldest row
 * sits in a partial November, so the window is December, January and February.
 */
const TODAY = '2026-03-07';
const MONTH = '2026-03';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const household = (id: number): Viewer => ({ id, role: 'admin', visibility: 'household' });
const selfOnly = (id: number): Viewer => ({ id, role: 'member', visibility: 'self' });

function setup(opts: { firstRow?: string } = {}) {
  current = createSeededTestDb();
  const db = current.db;
  const alex = insertTestUser(db, { name: 'Alex', username: 'alex' });
  const sam = insertTestUser(db, { name: 'Sam', username: 'sam', role: 'member' });
  const account = insertTestAccount(db, { name: 'Joint Chequing' });
  const cat = (name: string) => categoryIdByName(db, name);

  const row = (over: { date: string; cents: number; category?: string | null; merchant?: string; person?: number | null }) =>
    db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${account}, ${over.date}, ${over.merchant ?? 'MAPLE GROCER'}, ${over.merchant ?? 'MAPLE GROCER'}, ${over.cents},
              ${over.category ? cat(over.category) : null}, 'manual', 0, ${over.person ?? null}, ${alex}, ${nowIso()}, ${nowIso()})
      returning id`).id;
  // The partial first month: never read (checkInHistoryMonths starts after it).
  row({ date: opts.firstRow ?? '2025-11-20', cents: -1234, category: 'Coffee', merchant: 'CORNER CAFE' });

  const itemType = (name: string, kind: 'subscription' | 'contract' | 'bill' | 'loan') =>
    db.get<{ id: number }>(sql`
      insert into warranty_item_types (name, kind, is_subscription, created_at)
      values (${name}, ${kind}, ${kind === 'subscription' ? 1 : 0}, ${nowIso()}) returning id`).id;
  const item = (over: {
    name: string;
    typeId: number;
    owner: number;
    purchaseDate?: string;
    billingCycle?: 'monthly' | 'annual' | null;
    billingAmountCents?: number | null;
    category?: string | null;
    balanceCents?: number | null;
    vendor?: string | null;
  }) =>
    db.get<{ id: number }>(sql`
      insert into warranty_items (name, vendor, purchase_date, is_lifetime, owner_user_id, type_id, billing_cycle, billing_amount_cents, budget_category_id, current_balance_cents, balance_updated_at, created_at, updated_at)
      values (${over.name}, ${over.vendor ?? null}, ${over.purchaseDate ?? '2025-01-20'}, 0, ${over.owner}, ${over.typeId}, ${over.billingCycle ?? null},
              ${over.billingAmountCents ?? null}, ${over.category ? cat(over.category) : null}, ${over.balanceCents ?? null},
              ${over.balanceCents === undefined || over.balanceCents === null ? null : nowIso()}, ${nowIso()}, ${nowIso()})
      returning id`).id;
  const installment = (itemId: number, dueDate: string, amountCents: number, paidTxnId: number | null = null) =>
    db.run(sql`
      insert into bill_installments (item_id, due_date, amount_cents, paid_at, paid_txn_id, created_at)
      values (${itemId}, ${dueDate}, ${amountCents}, ${paidTxnId === null ? null : nowIso()}, ${paidTxnId}, ${nowIso()})`);
  const mark = (merchant: string) => {
    if (!setRecurringMarks({ merchants: [merchant], mark: 'recurring', userId: alex, actorRole: 'admin' }).ok) throw new Error('refused');
  };
  const limit = (name: string, cents: number, scope: 'household' | 'personal' = 'household', userId: number | null = null, month = MONTH) =>
    upsertBudget({ scope, userId, categoryId: cat(name), month, amountCents: cents });

  const read = (over: { viewer?: Viewer; scope?: 'household' | 'personal'; userId?: number | null; today?: string; spentTotalCents?: number } = {}) => {
    const today = over.today ?? TODAY;
    const month = today.slice(0, 7);
    const scope = over.scope ?? 'household';
    const userId = over.userId ?? null;
    const rows = scope === 'household' ? budgetProgress(month, 'household', null) : budgetProgress(month, 'personal', userId);
    return monthCheckIn({
      month,
      today,
      scope,
      userId,
      rows,
      viewer: over.viewer ?? household(alex),
      spentTotalCents: over.spentTotalCents ?? 0,
    }) as MonthCheckIn;
  };
  return { db, alex, sam, account, cat, row, itemType, item, installment, mark, limit, read };
}

describe('v1.62.0: the month check-in through the database', () => {
  it('rent paid on the 1st reads as one rent on the 7th, not several', () => {
    const { cat, row, limit, read } = setup();
    for (const date of ['2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01']) {
      row({ date, cents: -200000, category: 'Rent/Mortgage', merchant: 'CEDAR PROPERTY MGMT' });
    }
    limit('Rent/Mortgage', 210000);
    const checkIn = read().byCategory.get(cat('Rent/Mortgage'));
    expect(checkIn).toEqual({ spentCents: 200000, dueCents: 0, everydayCents: 0, projectedCents: 200000 });
  });

  it('groceries: spent so far plus the median month after the 7th', () => {
    const { cat, row, limit, read } = setup();
    row({ date: '2026-03-03', cents: -15000, category: 'Groceries' });
    row({ date: '2025-12-12', cents: -48000, category: 'Groceries' });
    row({ date: '2026-01-20', cents: -52000, category: 'Groceries' });
    row({ date: '2026-02-09', cents: -40000, category: 'Groceries' });
    // Before the 8th, so never part of the rest of a month.
    row({ date: '2026-01-05', cents: -99900, category: 'Groceries' });
    limit('Groceries', 50000);
    const checkIn = read({ spentTotalCents: 15000 });
    // Dec 48000 and Jan 52000 over 24 days, Feb 40000 over 21 days -> 45714: the median is 48000.
    expect(checkIn.byCategory.get(cat('Groceries'))).toEqual({
      spentCents: 15000,
      dueCents: 0,
      everydayCents: 48000,
      projectedCents: 63000,
    });
    expect(checkIn.monthsUsed).toBe(3);
    expect(checkIn.total).toEqual({ spentCents: 15000, dueCents: 0, everydayCents: 48000, projectedCents: 63000 });
  });

  it('an Insurance bill due on the 20th counts once: last month’s paid installment is not usual spending', () => {
    const { alex, cat, row, itemType, item, installment, limit, read } = setup();
    const billId = item({ name: 'Insurance', typeId: itemType('Insurance bill', 'bill'), owner: alex, category: 'Home Insurance' });
    const paid = row({ date: '2026-02-20', cents: -18000, category: 'Home Insurance', merchant: 'HARBOUR INSURANCE' });
    installment(billId, '2026-02-20', 18000, paid);
    installment(billId, '2026-03-20', 18000);
    limit('Home Insurance', 20000);
    const checkIn = read();
    expect(checkIn.byCategory.get(cat('Home Insurance'))).toEqual({
      spentCents: 0,
      dueCents: 18000,
      everydayCents: 0,
      projectedCents: 18000,
    });
    expect(checkIn.total?.dueCents).toBe(18000);
  });

  it('STREAMBOX marked recurring on the 15th counts 16.99 as due and nothing as usual spending, not 33.98', () => {
    const { cat, row, mark, limit, read } = setup();
    for (const date of ['2025-12-15', '2026-01-15', '2026-02-15']) {
      row({ date, cents: -1699, category: 'Subscriptions', merchant: 'STREAMBOX' });
    }
    mark('STREAMBOX');
    limit('Subscriptions', 1000);
    expect(read().byCategory.get(cat('Subscriptions'))).toEqual({
      spentCents: 0,
      dueCents: 1699,
      everydayCents: 0,
      projectedCents: 1699,
    });
  });

  it('STREAMBOX already charged on the 2nd is not due again', () => {
    const { cat, row, mark, limit, read } = setup();
    for (const date of ['2025-12-02', '2026-01-02', '2026-02-02', '2026-03-02']) {
      row({ date, cents: -1699, category: 'Subscriptions', merchant: 'STREAMBOX' });
    }
    mark('STREAMBOX');
    limit('Subscriptions', 1000);
    expect(read().byCategory.get(cat('Subscriptions'))?.projectedCents).toBe(1699);
    expect(read().total?.dueCents).toBe(0);
  });

  it('a mortgage paid on the 1st is not due again on the 31st, though its median gap points there', () => {
    // Charges on Sep 1, Oct 1, Nov 1 and Dec 1: gaps 30, 31, 30, so the next is expected Dec 31.
    const { cat, row, mark, limit, read } = setup({ firstRow: '2025-07-20' });
    for (const date of ['2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01']) {
      row({ date, cents: -240000, category: 'Rent/Mortgage', merchant: 'CEDAR MORTGAGE' });
    }
    mark('CEDAR MORTGAGE');
    limit('Rent/Mortgage', 250000, 'household', null, '2025-12');
    const today = '2025-12-07';
    // The trap: the expected-charge reader alone still lists it inside December.
    expect(expectedRecurringCharges({ today, days: 24, viewer: household(1) }).map((charge) => charge.expectedDate)).toEqual([
      '2025-12-31',
    ]);
    const checkIn = read({ today, spentTotalCents: 240000 });
    expect(checkIn.total?.dueCents).toBe(0);
    expect(checkIn.byCategory.get(cat('Rent/Mortgage'))?.projectedCents).toBe(240000);
  });

  it('a marked mortgage not yet posted on the 4th is still due', () => {
    // Aug 2 to Nov 2: the median gap is 31, so December's is expected on the 3rd and is a day late.
    const { cat, row, mark, limit, read } = setup({ firstRow: '2025-07-20' });
    for (const date of ['2025-08-02', '2025-09-02', '2025-10-02', '2025-11-02']) {
      row({ date, cents: -240000, category: 'Rent/Mortgage', merchant: 'CEDAR MORTGAGE' });
    }
    mark('CEDAR MORTGAGE');
    limit('Rent/Mortgage', 250000, 'household', null, '2025-12');
    const checkIn = read({ today: '2025-12-04' });
    expect(checkIn.total?.dueCents).toBe(240000);
    expect(checkIn.byCategory.get(cat('Rent/Mortgage'))).toEqual({
      spentCents: 0,
      dueCents: 240000,
      everydayCents: 0,
      projectedCents: 240000,
    });
  });

  it('a bill claims only the charges inside its amount band: a 60.00 membership leaves the groceries alone', () => {
    const { alex, cat, row, itemType, item, installment, limit, read } = setup();
    const membership = item({
      name: 'Warehouse membership',
      vendor: 'MAPLE GROCER',
      typeId: itemType('Membership bill', 'bill'),
      owner: alex,
      category: 'Groceries',
    });
    installment(membership, '2026-03-20', 6000);
    for (const month of ['2025-12', '2026-01', '2026-02']) {
      row({ date: `${month}-12`, cents: -40000, category: 'Groceries', merchant: 'MAPLE GROCER WHOLESALE' });
      // Last months' memberships, paid but never linked: inside the 60.00 band, so they are that bill.
      row({ date: `${month}-20`, cents: -6000, category: 'Groceries', merchant: 'MAPLE GROCER WHOLESALE' });
    }
    limit('Groceries', 50000);
    const checkIn = read();
    // 400.00 a month after the 7th is the usual rest of the month; the 60.00 is counted once, as due.
    expect(checkIn.total).toEqual({ spentCents: 0, dueCents: 6000, everydayCents: 40000, projectedCents: 46000 });
    expect(checkIn.byCategory.get(cat('Groceries'))?.projectedCents).toBe(46000);
  });

  it('a marked mortgage paid on the 2nd that posts on the 1st this month is counted once, not twice', () => {
    const { alex, row, mark, limit, read } = setup();
    for (const date of ['2025-12-02', '2026-01-02', '2026-02-02', '2026-03-01']) {
      row({ date, cents: -240000, category: 'Rent/Mortgage', merchant: 'CEDAR MORTGAGE' });
    }
    mark('CEDAR MORTGAGE');
    limit('Rent/Mortgage', 250000);
    const checkIn = read({ today: '2026-03-01', spentTotalCents: 240000 });
    // Already in the spent figure; its 2nd-of-the-month rows in earlier months are not projected again.
    expect(checkIn.total).toEqual({ spentCents: 240000, dueCents: 0, everydayCents: 0, projectedCents: 240000 });
    expect(checkIn.dueCount).toBe(0);
    expect(recurringCountLine({ checkIn, today: '2026-03-01', ownerUserId: null, viewer: household(alex) })?.counted).toBe(1);
  });

  it('the usual case: the same mortgage not posted yet on the 1st is due once, and its history stays out', () => {
    const { row, mark, limit, read } = setup();
    for (const date of ['2025-12-02', '2026-01-02', '2026-02-02']) {
      row({ date, cents: -240000, category: 'Rent/Mortgage', merchant: 'CEDAR MORTGAGE' });
    }
    mark('CEDAR MORTGAGE');
    limit('Rent/Mortgage', 250000);
    expect(read({ today: '2026-03-01' }).total).toEqual({ spentCents: 0, dueCents: 240000, everydayCents: 0, projectedCents: 240000 });
  });

  it('a merchant only a loan rule covers stays in the history, since the due side cannot count it', () => {
    const { alex, cat, row, itemType, item, limit, read } = setup();
    const loanId = item({ name: 'Mortgage', typeId: itemType('Home loan', 'loan'), owner: alex, balanceCents: 30_000_000 });
    saveLoanRule({ itemId: loanId, merchantContains: 'CEDAR MORTGAGE', accountId: null, enabled: true });
    for (const date of ['2025-12-15', '2026-01-15', '2026-02-15']) {
      row({ date, cents: -150000, category: 'Rent/Mortgage', merchant: 'CEDAR MORTGAGE' });
    }
    limit('Rent/Mortgage', 160000);
    const checkIn = read();
    // Feb's 150000 over 21 days scales to 171429; the median is 150000.
    expect(checkIn.byCategory.get(cat('Rent/Mortgage'))).toEqual({
      spentCents: 0,
      dueCents: 0,
      everydayCents: 150000,
      projectedCents: 150000,
    });
  });

  it('Sam’s bill is absent from Alex’s personal check-in, and the household has both', () => {
    const { alex, sam, row, itemType, item, read } = setup();
    row({ date: '2026-01-10', cents: -1000, category: 'Groceries', person: alex });
    row({ date: '2026-01-10', cents: -1000, category: 'Groceries', person: sam });
    const typeId = itemType('Streaming plan', 'subscription');
    item({ name: 'Alex streaming', typeId, owner: alex, purchaseDate: '2026-01-20', billingCycle: 'monthly', billingAmountCents: 1500 });
    item({ name: 'Sam streaming', typeId, owner: sam, purchaseDate: '2026-01-25', billingCycle: 'monthly', billingAmountCents: 2500 });
    expect(read({ scope: 'personal', userId: alex }).total?.dueCents).toBe(1500);
    expect(read({ scope: 'personal', userId: sam }).total?.dueCents).toBe(2500);
    expect(read().total?.dueCents).toBe(4000);
    // Ruling R2: a self viewer asking for the household gets their own figures only.
    expect(read({ viewer: selfOnly(sam), scope: 'household' }).total?.dueCents).toBe(2500);
  });

  it('the bills part equals safeToSpend.billsDueCents for the same viewer', () => {
    const { alex, sam, row, itemType, item, installment, read } = setup();
    row({ date: '2026-01-10', cents: -1000, category: 'Groceries' });
    // Sam's own history (a personal check-in reads from the person's own first month).
    row({ date: '2026-01-10', cents: -1000, category: 'Groceries', person: sam });
    const typeId = itemType('Streaming plan', 'subscription');
    item({ name: 'Alex streaming', typeId, owner: alex, purchaseDate: '2026-01-20', billingCycle: 'monthly', billingAmountCents: 1500 });
    item({ name: 'Next month', typeId, owner: alex, purchaseDate: '2026-01-05', billingCycle: 'monthly', billingAmountCents: 777 });
    const billId = item({ name: 'Sam phone', typeId: itemType('Phone bill', 'bill'), owner: sam });
    installment(billId, '2026-03-28', 6200);
    installment(billId, '2026-02-28', 6200); // overdue: neither counts it
    expect(read().total?.dueCents).toBe(safeToSpend({ month: MONTH, today: TODAY, viewer: household(alex) }).billsDueCents);
    expect(read().total?.dueCents).toBe(1500 + 6200);
    expect(read({ viewer: selfOnly(sam) }).total?.dueCents).toBe(
      safeToSpend({ month: MONTH, today: TODAY, viewer: selfOnly(sam) }).billsDueCents,
    );
  });

  it('gives no check-in before one complete month of history', () => {
    const { row, read } = setup({ firstRow: '2026-02-10' });
    row({ date: '2026-03-02', cents: -5000, category: 'Groceries' });
    expect(read()).toEqual({ total: null, byCategory: new Map(), monthsUsed: 0, dueCount: 0, recurringCount: 0 });
  });

  it('gives nothing at all for a month that is not the current one', () => {
    const { alex } = setup();
    expect(
      monthCheckIn({
        month: '2026-02',
        today: TODAY,
        scope: 'household',
        userId: null,
        rows: budgetProgress('2026-02'),
        viewer: household(alex),
        spentTotalCents: 0,
      }),
    ).toBeNull();
  });
});

describe('v1.62.0 (plan item E4): Counting N recurring charges · M more look recurring', () => {
  it('counts the charges the check-in counts as due, and the Looks merchants for the same scope', () => {
    const { alex, row, mark, itemType, item, read } = setup();
    for (const date of ['2025-12-15', '2026-01-15', '2026-02-15']) {
      row({ date, cents: -1699, category: 'Subscriptions', merchant: 'STREAMBOX' });
    }
    mark('STREAMBOX');
    item({
      name: 'Alex streaming',
      typeId: itemType('Streaming plan', 'subscription'),
      owner: alex,
      purchaseDate: '2026-01-20',
      billingCycle: 'monthly',
      billingAmountCents: 1500,
    });
    // An unmarked monthly rhythm: Looks recurring.
    for (const date of ['2025-12-10', '2026-01-10', '2026-02-10']) {
      row({ date, cents: -4500, category: 'Fitness', merchant: 'RIVERSIDE GYM' });
    }
    const checkIn = read();
    expect(checkIn.dueCount).toBe(2);
    expect(recurringCountLine({ checkIn, today: TODAY, ownerUserId: null, viewer: household(alex) })).toEqual({
      counted: 2,
      looks: 1,
      href: '/insights#sharper',
    });
  });

  it('is hidden when there is nothing to count and nothing looks recurring, or no check-in', () => {
    const { alex, row, read } = setup();
    row({ date: '2026-01-10', cents: -1000, category: 'Groceries' });
    expect(recurringCountLine({ checkIn: read(), today: TODAY, ownerUserId: null, viewer: household(alex) })).toBeNull();
    expect(recurringCountLine({ checkIn: null, today: TODAY, ownerUserId: null, viewer: household(alex) })).toBeNull();
  });

  it('a self viewer counts only their own', () => {
    const { alex, sam, row, read } = setup();
    for (const date of ['2025-12-10', '2026-01-10', '2026-02-10']) {
      row({ date, cents: -4500, category: 'Fitness', merchant: 'RIVERSIDE GYM', person: alex });
    }
    const viewer = selfOnly(sam);
    expect(recurringCountLine({ checkIn: read({ viewer }), today: TODAY, ownerUserId: sam, viewer })).toBeNull();
    expect(
      recurringCountLine({ checkIn: read({ scope: 'personal', userId: alex }), today: TODAY, ownerUserId: alex, viewer: household(alex) }),
    ).toEqual({ counted: 0, looks: 1, href: `/insights?person=${alex}#sharper` });
  });

  it('counts a marked charge that already came this month as well as the ones still due', () => {
    const { alex, row, mark, read } = setup();
    for (const date of ['2025-12-02', '2026-01-02', '2026-02-02', '2026-03-02']) {
      row({ date, cents: -1699, category: 'Subscriptions', merchant: 'STREAMBOX' });
    }
    for (const date of ['2025-12-15', '2026-01-15', '2026-02-15']) {
      row({ date, cents: -6200, category: 'Utilities', merchant: 'CEDAR PHONE CO' });
    }
    mark('STREAMBOX');
    mark('CEDAR PHONE CO');
    const checkIn = read();
    expect(checkIn.dueCount).toBe(1);
    expect(recurringCountLine({ checkIn, today: TODAY, ownerUserId: null, viewer: household(alex) })?.counted).toBe(2);
  });

  it("a self viewer's link carries no person: their own scope wins on Insights", () => {
    const { sam, row, read } = setup();
    for (const date of ['2025-12-10', '2026-01-10', '2026-02-10']) {
      row({ date, cents: -4500, category: 'Fitness', merchant: 'RIVERSIDE GYM', person: sam });
    }
    const viewer = selfOnly(sam);
    expect(recurringCountLine({ checkIn: read({ viewer }), today: TODAY, ownerUserId: sam, viewer })?.href).toBe('/insights#sharper');
  });
});
