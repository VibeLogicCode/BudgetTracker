import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import type { Viewer } from '@/lib/auth/viewer';
import { nowIso } from '@/lib/clock';
import { addDaysIso } from '@/lib/dates';
import { assignTransactionToLoan, saveLoanRule } from '@/lib/loans';
import { RECURRING_MAX_ROWS, recurringCharges, recurringLoad } from '@/lib/recurring';
import { createManualTransaction } from '@/lib/transactions';
import { createTestDb, type TestDb } from '../helpers/db';

/**
 * F-05 (2026-09-02 review, v1.31.0). Every assertion here is about what a person would read on
 * the Recurring charges card and the two figures beside it -- a merchant's name, a cadence, an
 * amount, whether the app already knows about it.
 *
 * The one thing this suite asserts NEGATIVELY, repeatedly, is what the card is allowed to claim:
 * it lists cadences, it does not identify subscriptions. So there is no test here for "correctly
 * identifies Netflix as a subscription" -- there is no such judgement in the code to test.
 */
const TODAY = '2026-08-27';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

interface Ctx {
  adultId: number;
  childId: number;
  accountId: number;
  /** One merchant, `count` charges, `gapDays` apart, newest `endsDaysAgo` before TODAY. */
  cadence(input: {
    merchant: string;
    count?: number;
    gapDays?: number;
    endsDaysAgo?: number;
    cents?: number;
    person?: number;
  }): number[];
  spend(input: { merchant: string; date: string; cents: number; person?: number; isTransfer?: boolean }): number;
  itemType(name: string, kind: 'subscription' | 'contract' | 'loan' | 'bill' | 'warranty'): number;
  item(input: {
    name: string;
    typeId: number;
    ownerUserId?: number;
    expiryDate?: string | null;
    billingCycle?: 'monthly' | 'annual' | null;
    billingAmountCents?: number | null;
    balanceCents?: number | null;
    vendor?: string | null;
  }): number;
}

async function setup(): Promise<Ctx> {
  current = createTestDb();
  const t = current;
  const adultId = (await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' })).id;
  const childId = (await createUser({ name: 'Person Two', username: 'user-2', password: 'correct horse 9', role: 'member' })).id;
  const accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adultId });

  const spend: Ctx['spend'] = (input) =>
    createManualTransaction({
      accountId,
      date: input.date,
      description: input.merchant,
      amountCents: input.cents,
      categoryId: null,
      attributedUserId: input.person ?? adultId,
      userId: adultId,
      actorRole: 'admin',
    });

  return {
    adultId,
    childId,
    accountId,
    spend: (input) => {
      const id = spend(input);
      if (input.isTransfer) t.db.run(sql`update transactions set is_transfer = 1 where id = ${id}`);
      return id;
    },
    cadence: (input) => {
      const count = input.count ?? 13;
      const gapDays = input.gapDays ?? 30;
      const endsDaysAgo = input.endsDaysAgo ?? 3;
      return Array.from({ length: count }, (_unused, index) =>
        spend({
          merchant: input.merchant,
          date: addDaysIso(TODAY, -endsDaysAgo - (count - 1 - index) * gapDays),
          cents: -(input.cents ?? 1649),
          person: input.person,
        }),
      );
    },
    // The migrations already ship default types called Subscription/Contract/Loan, and the
    // name is UNIQUE -- so every type this suite makes gets its own suffix.
    itemType: (name, kind) =>
      t.db.get<{ id: number }>(sql`
        insert into warranty_item_types (name, is_subscription, kind, created_at)
        values (${`${name} ${Math.random().toString(36).slice(2, 8)}`}, ${kind === 'subscription' ? 1 : 0}, ${kind}, ${nowIso()})
        returning id`).id,
    item: (input) =>
      t.db.get<{ id: number }>(sql`
        insert into warranty_items
          (name, vendor, purchase_date, is_lifetime, warranty_months, expiry_date, owner_user_id, type_id,
           billing_cycle, billing_amount_cents, current_balance_cents, balance_updated_at, created_at, updated_at)
        -- warranty_months and expiry_date are set or NULL together (a table CHECK), so a term
        -- is supplied whenever the fixture asks for an end date.
        values (${input.name}, ${input.vendor ?? null}, '2024-01-01', 0,
                ${input.expiryDate === undefined || input.expiryDate === null ? null : 12},
                ${input.expiryDate ?? null},
                ${input.ownerUserId ?? adultId}, ${input.typeId}, ${input.billingCycle ?? null},
                ${input.billingAmountCents ?? null}, ${input.balanceCents ?? null},
                ${input.balanceCents === undefined || input.balanceCents === null ? null : nowIso()},
                ${nowIso()}, ${nowIso()})
        returning id`).id,
  };
}

const household = (id: number): Viewer => ({ id, role: 'admin', visibility: 'household' });
const selfOnly = (id: number): Viewer => ({ id, role: 'member', visibility: 'self' });

describe('recurringCharges: what a person reads on the card', () => {
  it('names the merchant, the cadence, the last charge and how many charges it read', async () => {
    const ctx = await setup();
    const ids = ctx.cadence({ merchant: 'NETFLIX', cents: 1649 });
    const rows = recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) });
    expect(rows).toEqual([
      {
        merchant: 'NETFLIX',
        cadence: 'monthly',
        chargeCount: 13,
        typicalCents: 1649,
        lastAmountCents: 1649,
        lastDate: addDaysIso(TODAY, -3),
        // What Track prefills from: the NEWEST charge, not the first one found.
        transactionId: ids[ids.length - 1],
        tracked: null,
      },
    ]);
  });

  it('lists a yearly cadence too, which needs more history than the proposal 12 months allowed', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'DOMAIN HOST', count: 3, gapDays: 365, endsDaysAgo: 6, cents: 2200 });
    const rows = recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) });
    expect(rows.map((row) => [row.merchant, row.cadence])).toEqual([['DOMAIN HOST', 'yearly']]);
  });

  it('says nothing about a merchant with no cadence, however often it is used', async () => {
    const ctx = await setup();
    for (let week = 0; week < 30; week += 1) {
      ctx.spend({ merchant: 'GROCERY STORE', date: addDaysIso(TODAY, -week * 7), cents: -8500 });
    }
    expect(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) })).toEqual([]);
  });

  it('drops a cadence that stopped: a cancelled subscription is not a current commitment', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'OLD GYM', endsDaysAgo: 400 });
    expect(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) })).toEqual([]);
  });

  it('puts what nobody has recorded first, then the biggest charge', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'SMALL THING', cents: 500 });
    ctx.cadence({ merchant: 'BIG THING', cents: 9900 });
    ctx.cadence({ merchant: 'RECORDED THING', cents: 20000 });
    const typeId = ctx.itemType('Subscription', 'subscription');
    ctx.item({ name: 'Recorded Thing', typeId });

    const rows = recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) });
    expect(rows.map((row) => row.merchant)).toEqual(['BIG THING', 'SMALL THING', 'RECORDED THING']);
  });

  it('caps the list, because the card is an audit list and not a second ledger', async () => {
    const ctx = await setup();
    for (let n = 0; n < RECURRING_MAX_ROWS + 4; n += 1) {
      ctx.cadence({ merchant: `MERCHANT ${String(n).padStart(2, '0')}`, count: 4, cents: 1000 + n });
    }
    expect(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) })).toHaveLength(
      RECURRING_MAX_ROWS,
    );
  });
});

describe('recurringCharges: what counts as a charge (SPEND_ROW_WHERE)', () => {
  it('a transfer between our own accounts is not a recurring charge', async () => {
    const ctx = await setup();
    for (let n = 12; n >= 0; n -= 1) {
      ctx.spend({ merchant: 'SAVINGS SWEEP', date: addDaysIso(TODAY, -3 - n * 30), cents: -50000, isTransfer: true });
    }
    expect(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) })).toEqual([]);
  });

  it('a loan principal movement is not a recurring charge, however regular it is', async () => {
    const ctx = await setup();
    const typeId = ctx.itemType('Loan', 'loan');
    // 'lent' -- money going OUT to a loan we hold is cash becoming a receivable, never spend
    // (NOT_PRINCIPAL_MOVEMENT, src/lib/spend-where.ts). A standing monthly transfer to a
    // relative is exactly the shape a naive cadence scan would call a subscription.
    const loanId = ctx.item({ name: 'Loan to a relative', typeId, balanceCents: 5_000_000 });
    current!.db.run(sql`update warranty_items set loan_direction = 'lent' where id = ${loanId}`);
    for (const txnId of ctx.cadence({ merchant: 'E TRANSFER', cents: 40000 })) {
      assignTransactionToLoan({ txnId, itemId: loanId });
    }
    expect(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) })).toEqual([]);
  });

  it('a car payment IS a recurring charge -- money out on a loan we owe is real consumption', async () => {
    const ctx = await setup();
    const typeId = ctx.itemType('Loan', 'loan');
    const loanId = ctx.item({ name: 'Car loan', typeId, balanceCents: 5_000_000 });
    for (const txnId of ctx.cadence({ merchant: 'CAR LOAN CO', cents: 40000 })) {
      assignTransactionToLoan({ txnId, itemId: loanId });
    }
    const rows = recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) });
    expect(rows.map((row) => row.merchant)).toEqual(['CAR LOAN CO']);
  });
});

describe('recurringCharges: ruling R2, a self viewer sees only their own money', () => {
  it('a self-scoped member never receives another member recurring charge', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'ADULT SUBSCRIPTION', person: ctx.adultId });
    ctx.cadence({ merchant: 'CHILD SUBSCRIPTION', person: ctx.childId, cents: 999 });

    expect(
      recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) }).map((row) => row.merchant).sort(),
    ).toEqual(['ADULT SUBSCRIPTION', 'CHILD SUBSCRIPTION']);
    expect(
      recurringCharges({ today: TODAY, ownerUserId: null, viewer: selfOnly(ctx.childId) }).map((row) => row.merchant),
    ).toEqual(['CHILD SUBSCRIPTION']);
  });

  it('a self viewer own scope wins over the person the URL asks for (the S-01 shape)', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'ADULT SUBSCRIPTION', person: ctx.adultId });
    ctx.cadence({ merchant: 'CHILD SUBSCRIPTION', person: ctx.childId, cents: 999 });

    expect(
      recurringCharges({ today: TODAY, ownerUserId: ctx.adultId, viewer: selfOnly(ctx.childId) }).map((row) => row.merchant),
    ).toEqual(['CHILD SUBSCRIPTION']);
  });

  it('a household viewer may still follow the dashboard person pill', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'ADULT SUBSCRIPTION', person: ctx.adultId });
    ctx.cadence({ merchant: 'CHILD SUBSCRIPTION', person: ctx.childId, cents: 999 });

    expect(
      recurringCharges({ today: TODAY, ownerUserId: ctx.childId, viewer: household(ctx.adultId) }).map((row) => row.merchant),
    ).toEqual(['CHILD SUBSCRIPTION']);
  });
});

describe('recurringCharges: the tracked badge names what covers the merchant', () => {
  it('an enabled payment-matching rule counts, and names its item', async () => {
    const ctx = await setup();
    const typeId = ctx.itemType('Loan', 'loan');
    const loanId = ctx.item({ name: 'Car loan', typeId, balanceCents: 5_000_000 });
    // Charges first, THEN the rule: createManualTransaction runs applyPaymentMatchers, so a rule
    // that already existed would have linked every one of these to the loan as it was written.
    ctx.cadence({ merchant: 'CAR LOAN CO', cents: 40000 });
    saveLoanRule({ itemId: loanId, merchantContains: 'CAR LOAN', accountId: null, enabled: true });

    const rows = recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) });
    // The item is ALSO called 'Car loan', so its name would match this merchant on its own.
    // A rule wins the tie deliberately: it says what the app will do with the next charge,
    // where a name match only says two strings resemble each other.
    expect(rows[0].tracked).toEqual({ kind: 'rule', itemId: loanId, itemName: 'Car loan' });
  });

  it('a DISABLED rule does not: it would never match the charge either', async () => {
    const ctx = await setup();
    const typeId = ctx.itemType('Loan', 'loan');
    // Named 'Civic', not 'Car loan': with the rule disabled, the ONLY thing that could cover
    // this merchant is the rule, so the item's own name must not read as the merchant too.
    const loanId = ctx.item({ name: 'Civic', typeId, balanceCents: 5_000_000 });
    ctx.cadence({ merchant: 'CAR LOAN CO', cents: 40000 });
    saveLoanRule({ itemId: loanId, merchantContains: 'CAR LOAN', accountId: null, enabled: false });

    const rows = recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) });
    expect(rows[0].tracked).toBeNull();
  });

  it('an item whose name or vendor matches the merchant counts, and is named so it can be checked', async () => {
    const ctx = await setup();
    const typeId = ctx.itemType('Subscription', 'subscription');
    const itemId = ctx.item({ name: 'Netflix Premium', typeId });
    ctx.cadence({ merchant: 'NETFLIX' });

    const rows = recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) });
    expect(rows[0].tracked).toEqual({ kind: 'item', itemId, itemName: 'Netflix Premium' });
  });

  it('an item that has already ENDED does not: the charge outliving the contract is the finding', async () => {
    const ctx = await setup();
    const typeId = ctx.itemType('Contract', 'contract');
    ctx.item({ name: 'Netflix Premium', typeId, expiryDate: '2025-01-01' });
    ctx.cadence({ merchant: 'NETFLIX' });

    expect(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) })[0].tracked).toBeNull();
  });

  it('a warranty on a thing never marks a merchant tracked -- a fridge does not charge monthly', async () => {
    const ctx = await setup();
    const typeId = ctx.itemType('Appliance', 'warranty');
    ctx.item({ name: 'Netflix Premium', typeId });
    ctx.cadence({ merchant: 'NETFLIX' });

    expect(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) })[0].tracked).toBeNull();
  });

  it('another member item never marks a self viewer charge tracked', async () => {
    const ctx = await setup();
    const typeId = ctx.itemType('Subscription', 'subscription');
    ctx.item({ name: 'Netflix Premium', typeId, ownerUserId: ctx.adultId });
    ctx.cadence({ merchant: 'NETFLIX', person: ctx.childId });

    expect(recurringCharges({ today: TODAY, ownerUserId: null, viewer: selfOnly(ctx.childId) })[0].tracked).toBeNull();
  });
});

describe('recurringLoad: the figure on the header line and the dashboard tile', () => {
  it('totals the monthly and the annual cycles separately, and counts the items behind them', async () => {
    const ctx = await setup();
    const subs = ctx.itemType('Subscription', 'subscription');
    ctx.item({ name: 'Streaming', typeId: subs, billingCycle: 'monthly', billingAmountCents: 1649 });
    ctx.item({ name: 'Music', typeId: subs, billingCycle: 'monthly', billingAmountCents: 1099 });
    ctx.item({ name: 'Cloud storage', typeId: subs, billingCycle: 'annual', billingAmountCents: 11999 });

    expect(recurringLoad({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) })).toEqual({
      monthlyCents: 2748,
      annualCents: 11999,
      itemCount: 3,
    });
  });

  it('ignores an item with only half of the billing pair -- the same rule the Billing column uses', async () => {
    const ctx = await setup();
    const subs = ctx.itemType('Subscription', 'subscription');
    ctx.item({ name: 'Cycle but no amount', typeId: subs, billingCycle: 'monthly', billingAmountCents: null });
    ctx.item({ name: 'Amount but no cycle', typeId: subs, billingCycle: null, billingAmountCents: 4999 });

    expect(recurringLoad({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) })).toEqual({
      monthlyCents: 0,
      annualCents: 0,
      itemCount: 0,
    });
  });

  it('leaves out an item that has already ended', async () => {
    const ctx = await setup();
    const subs = ctx.itemType('Subscription', 'subscription');
    ctx.item({ name: 'Cancelled', typeId: subs, billingCycle: 'monthly', billingAmountCents: 5000, expiryDate: '2025-01-01' });
    ctx.item({ name: 'Live', typeId: subs, billingCycle: 'monthly', billingAmountCents: 1649 });

    expect(recurringLoad({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) })).toMatchObject({
      monthlyCents: 1649,
      itemCount: 1,
    });
  });

  it('scopes to a self viewer own items', async () => {
    const ctx = await setup();
    const subs = ctx.itemType('Subscription', 'subscription');
    ctx.item({ name: 'Adult streaming', typeId: subs, billingCycle: 'monthly', billingAmountCents: 5000, ownerUserId: ctx.adultId });
    ctx.item({ name: 'Child music', typeId: subs, billingCycle: 'monthly', billingAmountCents: 599, ownerUserId: ctx.childId });

    expect(recurringLoad({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) }).monthlyCents).toBe(5599);
    expect(recurringLoad({ today: TODAY, ownerUserId: null, viewer: selfOnly(ctx.childId) }).monthlyCents).toBe(599);
  });

  it('is all zeroes on a household that has recorded nothing, rather than an invented estimate', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'NETFLIX' });
    expect(recurringLoad({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId) })).toEqual({
      monthlyCents: 0,
      annualCents: 0,
      itemCount: 0,
    });
  });
});
