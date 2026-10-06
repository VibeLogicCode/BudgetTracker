import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import type { Viewer } from '@/lib/auth/viewer';
import { nowIso } from '@/lib/clock';
import { addDaysIso } from '@/lib/dates';
import { assignTransactionToLoan, saveLoanRule } from '@/lib/loans';
import { listRules, setRecurringMarks, setRuleDisabledFlag } from '@/lib/categorize/rules';
import { RECURRING_MAX_ROWS, recurringCharges, recurringLoad, type RecurringCharges } from '@/lib/recurring';
import { createManualTransaction } from '@/lib/transactions';
import { createTestDb, type TestDb } from '../helpers/db';
import { HOUSEHOLD_VIEWER } from '@/lib/auth/viewer';

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
  visaId: number;
  /** One merchant, `count` charges, `gapDays` apart, newest `endsDaysAgo` before TODAY. */
  cadence(input: {
    merchant: string;
    count?: number;
    gapDays?: number;
    endsDaysAgo?: number;
    cents?: number;
    person?: number;
    accountId?: number;
  }): number[];
  spend(input: { merchant: string; date: string; cents: number; person?: number; isTransfer?: boolean; accountId?: number }): number;
  mark(merchant: string, mark: 'recurring' | 'not_recurring' | null): void;
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
  const visaId = createAccount({ name: 'Travel Visa', type: 'credit', ownerUserId: adultId });

  const spend: Ctx['spend'] = (input) =>
    createManualTransaction({
      accountId: input.accountId ?? accountId,
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
    visaId,
    mark: (merchant, mark) => {
      const result = setRecurringMarks({ merchants: [merchant], mark, userId: adultId, actorRole: 'admin' });
      if (!result.ok) throw new Error('unexpected refusal');
    },
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
          accountId: input.accountId,
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
const rowsOf = (result: RecurringCharges) => [...result.known, ...result.looks];
const read = (ctx: Ctx, over: Partial<Parameters<typeof recurringCharges>[0]> = {}) =>
  recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null, ...over });

describe('recurringCharges: what a person reads on the card', () => {
  it('names the merchant, the cadence, the last charge and how many charges it read', async () => {
    const ctx = await setup();
    const ids = ctx.cadence({ merchant: 'NETFLIX', cents: 1649 });
    const result = recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null });
    expect(result.known).toEqual([]);
    expect(result.looks).toEqual([
      {
        merchant: 'NETFLIX',
        tier: 'looks',
        knownBy: null,
        cadence: 'monthly',
        chargeCount: 13,
        typicalCents: 1649,
        lastAmountCents: 1649,
        lastDate: addDaysIso(TODAY, -3),
        // What Track prefills from: the NEWEST charge, not the first one found.
        transactionId: ids[ids.length - 1],
        tracked: null,
        accounts: [{ id: ctx.accountId, name: 'Chequing' }],
      },
    ]);
  });

  it('lists a yearly cadence too, which needs more history than the proposal 12 months allowed', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'DOMAIN HOST', count: 3, gapDays: 365, endsDaysAgo: 6, cents: 2200 });
    const rows = rowsOf(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null }));
    expect(rows.map((row) => [row.merchant, row.cadence])).toEqual([['DOMAIN HOST', 'yearly']]);
  });

  it('says nothing about a merchant with no cadence, however often it is used', async () => {
    const ctx = await setup();
    for (let week = 0; week < 30; week += 1) {
      ctx.spend({ merchant: 'GROCERY STORE', date: addDaysIso(TODAY, -week * 7), cents: -8500 });
    }
    expect(rowsOf(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null }))).toEqual([]);
  });

  it('drops a cadence that stopped: a cancelled subscription is not a current commitment', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'OLD GYM', endsDaysAgo: 400 });
    expect(rowsOf(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null }))).toEqual([]);
  });

  it('puts a recorded rhythm under Known, and the rest under Looks by the biggest charge', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'SMALL THING', cents: 500 });
    ctx.cadence({ merchant: 'BIG THING', cents: 9900 });
    ctx.cadence({ merchant: 'RECORDED THING', cents: 20000 });
    ctx.item({ name: 'Recorded Thing', typeId: ctx.itemType('Subscription', 'subscription') });
    const result = read(ctx);
    expect(result.known.map((row) => [row.merchant, row.knownBy])).toEqual([['RECORDED THING', 'tracked']]);
    expect(result.looks.map((row) => row.merchant)).toEqual(['BIG THING', 'SMALL THING']);
  });

  it('caps the list, because the card is an audit list and not a second ledger', async () => {
    const ctx = await setup();
    for (let n = 0; n < RECURRING_MAX_ROWS + 4; n += 1) {
      ctx.cadence({ merchant: `MERCHANT ${String(n).padStart(2, '0')}`, count: 4, cents: 1000 + n });
    }
    expect(read(ctx).looks).toHaveLength(RECURRING_MAX_ROWS);
    expect(read(ctx).known).toEqual([]);
  });
});

describe('recurringCharges: what counts as a charge (SPEND_ROW_WHERE)', () => {
  it('a transfer between our own accounts is not a recurring charge', async () => {
    const ctx = await setup();
    for (let n = 12; n >= 0; n -= 1) {
      ctx.spend({ merchant: 'SAVINGS SWEEP', date: addDaysIso(TODAY, -3 - n * 30), cents: -50000, isTransfer: true });
    }
    expect(rowsOf(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null }))).toEqual([]);
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
      assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId: loanId });
    }
    expect(rowsOf(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null }))).toEqual([]);
  });

  it('a car payment IS a recurring charge -- money out on a loan we owe is real consumption', async () => {
    const ctx = await setup();
    const typeId = ctx.itemType('Loan', 'loan');
    const loanId = ctx.item({ name: 'Car loan', typeId, balanceCents: 5_000_000 });
    for (const txnId of ctx.cadence({ merchant: 'CAR LOAN CO', cents: 40000 })) {
      assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId: loanId });
    }
    const rows = rowsOf(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null }));
    expect(rows.map((row) => row.merchant)).toEqual(['CAR LOAN CO']);
  });
});

describe('recurringCharges: ruling R2, a self viewer sees only their own money', () => {
  it('a self-scoped member never receives another member recurring charge', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'ADULT SUBSCRIPTION', person: ctx.adultId });
    ctx.cadence({ merchant: 'CHILD SUBSCRIPTION', person: ctx.childId, cents: 999 });

    expect(
      rowsOf(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null })).map((row) => row.merchant).sort(),
    ).toEqual(['ADULT SUBSCRIPTION', 'CHILD SUBSCRIPTION']);
    expect(
      rowsOf(recurringCharges({ today: TODAY, ownerUserId: null, viewer: selfOnly(ctx.childId), accountId: null })).map((row) => row.merchant),
    ).toEqual(['CHILD SUBSCRIPTION']);
  });

  it('a self viewer own scope wins over the person the URL asks for (the S-01 shape)', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'ADULT SUBSCRIPTION', person: ctx.adultId });
    ctx.cadence({ merchant: 'CHILD SUBSCRIPTION', person: ctx.childId, cents: 999 });

    expect(
      rowsOf(recurringCharges({ today: TODAY, ownerUserId: ctx.adultId, viewer: selfOnly(ctx.childId), accountId: null })).map((row) => row.merchant),
    ).toEqual(['CHILD SUBSCRIPTION']);
  });

  it('a household viewer may still follow the dashboard person pill', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'ADULT SUBSCRIPTION', person: ctx.adultId });
    ctx.cadence({ merchant: 'CHILD SUBSCRIPTION', person: ctx.childId, cents: 999 });

    expect(
      rowsOf(recurringCharges({ today: TODAY, ownerUserId: ctx.childId, viewer: household(ctx.adultId), accountId: null })).map((row) => row.merchant),
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

    const rows = rowsOf(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null }));
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

    const rows = rowsOf(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null }));
    expect(rows[0].tracked).toBeNull();
  });

  it('an item whose name or vendor matches the merchant counts, and is named so it can be checked', async () => {
    const ctx = await setup();
    const typeId = ctx.itemType('Subscription', 'subscription');
    const itemId = ctx.item({ name: 'Netflix Premium', typeId });
    ctx.cadence({ merchant: 'NETFLIX' });

    const rows = rowsOf(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null }));
    expect(rows[0].tracked).toEqual({ kind: 'item', itemId, itemName: 'Netflix Premium' });
  });

  it('an item that has already ENDED does not: the charge outliving the contract is the finding', async () => {
    const ctx = await setup();
    const typeId = ctx.itemType('Contract', 'contract');
    ctx.item({ name: 'Netflix Premium', typeId, expiryDate: '2025-01-01' });
    ctx.cadence({ merchant: 'NETFLIX' });

    expect(rowsOf(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null }))[0].tracked).toBeNull();
  });

  it('a warranty on a thing never marks a merchant tracked -- a fridge does not charge monthly', async () => {
    const ctx = await setup();
    const typeId = ctx.itemType('Appliance', 'warranty');
    ctx.item({ name: 'Netflix Premium', typeId });
    ctx.cadence({ merchant: 'NETFLIX' });

    expect(rowsOf(recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null }))[0].tracked).toBeNull();
  });

  it('another member item never marks a self viewer charge tracked', async () => {
    const ctx = await setup();
    const typeId = ctx.itemType('Subscription', 'subscription');
    ctx.item({ name: 'Netflix Premium', typeId, ownerUserId: ctx.adultId });
    ctx.cadence({ merchant: 'NETFLIX', person: ctx.childId });

    expect(rowsOf(recurringCharges({ today: TODAY, ownerUserId: null, viewer: selfOnly(ctx.childId), accountId: null }))[0].tracked).toBeNull();
  });
});

/** Spec 2026-10-05 §2.3. Known is what the household said; Looks is what the dates show. */
describe('recurringCharges: two tiers', () => {
  /** Review Focus 5. */
  it('lists a merchant the household marked under Known, after a single charge', async () => {
    const ctx = await setup();
    const id = ctx.spend({ merchant: 'RIVERSIDE GYM', date: addDaysIso(TODAY, -4), cents: -4500 });
    ctx.mark('RIVERSIDE GYM', 'recurring');
    expect(read(ctx).known).toEqual([
      {
        merchant: 'RIVERSIDE GYM',
        tier: 'known',
        knownBy: 'mark',
        cadence: null,
        chargeCount: 1,
        // One charge has no "usually"; the card prints an em dash.
        typicalCents: null,
        lastAmountCents: 4500,
        lastDate: addDaysIso(TODAY, -4),
        transactionId: id,
        tracked: null,
        accounts: [{ id: ctx.accountId, name: 'Chequing' }],
      },
    ]);
  });

  it('gives a marked merchant with two charges the median of both', async () => {
    const ctx = await setup();
    ctx.spend({ merchant: 'RIVERSIDE GYM', date: addDaysIso(TODAY, -34), cents: -4000 });
    ctx.spend({ merchant: 'RIVERSIDE GYM', date: addDaysIso(TODAY, -4), cents: -5000 });
    ctx.mark('RIVERSIDE GYM', 'recurring');
    expect(read(ctx).known[0]).toMatchObject({ chargeCount: 2, typicalCents: 4500, cadence: null });
  });

  it('keeps the detected cadence on a marked merchant that also has a rhythm', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'MAPLE STREAMING', cents: 1349 });
    ctx.mark('MAPLE STREAMING', 'recurring');
    const result = read(ctx);
    expect(result.known.map((row) => [row.merchant, row.knownBy, row.cadence])).toEqual([['MAPLE STREAMING', 'mark', 'monthly']]);
    expect(result.looks).toEqual([]);
  });

  /** Review Focus 4. */
  it('drops a not_recurring merchant from both tiers and from the forming count', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'CEDAR PHONE CO', cents: 6200 });
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 2, cents: 13400 });
    ctx.mark('CEDAR PHONE CO', 'not_recurring');
    ctx.mark('HARBOUR INSURANCE', 'not_recurring');
    expect(read(ctx)).toEqual({ known: [], looks: [], forming: { monthly: 0, yearly: 0 }, accounts: [], accountId: null });
    ctx.mark('CEDAR PHONE CO', null);
    expect(read(ctx).looks.map((row) => row.merchant)).toEqual(['CEDAR PHONE CO']);
  });

  it('ignores a disabled mark', async () => {
    const ctx = await setup();
    ctx.spend({ merchant: 'RIVERSIDE GYM', date: addDaysIso(TODAY, -4), cents: -4500 });
    ctx.mark('RIVERSIDE GYM', 'recurring');
    setRuleDisabledFlag(listRules('recurring')[0]!.id, true);
    expect(read(ctx).known).toEqual([]);
  });

  it('a mark is household-wide, but a self viewer sees Known rows only for their own charges', async () => {
    const ctx = await setup();
    ctx.spend({ merchant: 'RIVERSIDE GYM', date: addDaysIso(TODAY, -4), cents: -4500, person: ctx.adultId });
    ctx.mark('RIVERSIDE GYM', 'recurring');
    expect(read(ctx, { viewer: selfOnly(ctx.childId) }).known).toEqual([]);
  });

  it('lists Known by merchant name, so a long list reads like a checklist', async () => {
    const ctx = await setup();
    ctx.spend({ merchant: 'ZED CO', date: addDaysIso(TODAY, -4), cents: -9900 });
    ctx.spend({ merchant: 'ALPHA CO', date: addDaysIso(TODAY, -5), cents: -100 });
    ctx.mark('ZED CO', 'recurring');
    ctx.mark('ALPHA CO', 'recurring');
    expect(read(ctx).known.map((row) => row.merchant)).toEqual(['ALPHA CO', 'ZED CO']);
  });
});

/** Spec 2026-10-05 §2.4. The accounts a merchant charged, and the filter that makes the card-replacement list. */
describe('recurringCharges: accounts and the account filter', () => {
  const movedCard = (ctx: Ctx) => {
    // Three charges on Chequing, then the newest on Travel Visa -- still 30 days apart.
    ctx.cadence({ merchant: 'MAPLE STREAMING', count: 3, endsDaysAgo: 33, cents: 1349 });
    ctx.spend({ merchant: 'MAPLE STREAMING', date: addDaysIso(TODAY, -3), cents: -1349, accountId: ctx.visaId });
  };

  it('names every account the merchant charged, newest charge first', async () => {
    const ctx = await setup();
    movedCard(ctx);
    expect(read(ctx).looks[0]!.accounts).toEqual([
      { id: ctx.visaId, name: 'Travel Visa' },
      { id: ctx.accountId, name: 'Chequing' },
    ]);
  });

  /** Review Focus 1. */
  it('keeps a row whose older charges were on the chosen account', async () => {
    const ctx = await setup();
    movedCard(ctx);
    expect(read(ctx, { accountId: ctx.accountId }).looks.map((row) => row.merchant)).toEqual(['MAPLE STREAMING']);
  });

  it('keeps only rows that charged the chosen account, in both tiers', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'CEDAR PHONE CO', cents: 6200 });
    ctx.spend({ merchant: 'RIVERSIDE GYM', date: addDaysIso(TODAY, -4), cents: -4500, accountId: ctx.visaId });
    ctx.mark('RIVERSIDE GYM', 'recurring');
    const visa = read(ctx, { accountId: ctx.visaId });
    expect(visa.known.map((row) => row.merchant)).toEqual(['RIVERSIDE GYM']);
    expect(visa.looks).toEqual([]);
  });

  it('applies the Looks cap after the filter, so other accounts never crowd a filtered list out', async () => {
    const ctx = await setup();
    for (let n = 0; n < RECURRING_MAX_ROWS + 2; n += 1) {
      ctx.cadence({ merchant: `BIG SHOP ${String(n).padStart(2, '0')}`, count: 4, cents: 50000 + n });
    }
    // The smallest charges, so a cap taken BEFORE the filter would cut both.
    ctx.cadence({ merchant: 'TINY ONE', count: 4, cents: 100, accountId: ctx.visaId });
    ctx.cadence({ merchant: 'TINY TWO', count: 4, cents: 101, accountId: ctx.visaId });
    expect(read(ctx, { accountId: ctx.visaId }).looks.map((row) => row.merchant)).toEqual(['TINY TWO', 'TINY ONE']);
  });

  it('offers every account a listed row charged, in both tiers, by name, whatever the filter', async () => {
    const ctx = await setup();
    movedCard(ctx);
    ctx.spend({ merchant: 'RIVERSIDE GYM', date: addDaysIso(TODAY, -4), cents: -4500, accountId: ctx.visaId });
    ctx.mark('RIVERSIDE GYM', 'recurring');
    const everyAccount = [
      { id: ctx.accountId, name: 'Chequing' },
      { id: ctx.visaId, name: 'Travel Visa' },
    ];
    expect(read(ctx).accounts).toEqual(everyAccount);
    expect(read(ctx, { accountId: ctx.visaId }).accounts).toEqual(everyAccount);
  });

  it('reads an account no listed row charged as every account', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'CEDAR PHONE CO', cents: 6200 });
    for (const asked of [ctx.visaId, 99999]) {
      const result = read(ctx, { accountId: asked });
      expect(result.accountId).toBeNull();
      expect(result.looks.map((row) => row.merchant)).toEqual(['CEDAR PHONE CO']);
    }
    expect(read(ctx, { accountId: ctx.accountId }).accountId).toBe(ctx.accountId);
  });

  it('offers an account whose only rows the Looks cap cut', async () => {
    const ctx = await setup();
    for (let n = 0; n < RECURRING_MAX_ROWS + 2; n += 1) {
      ctx.cadence({ merchant: `BIG SHOP ${String(n).padStart(2, '0')}`, count: 4, cents: 50000 + n });
    }
    ctx.cadence({ merchant: 'TINY ONE', count: 4, cents: 100, accountId: ctx.visaId });
    const all = read(ctx);
    expect(all.looks.map((row) => row.merchant)).not.toContain('TINY ONE');
    expect(all.accounts.map((account) => account.name)).toContain('Travel Visa');
    expect(read(ctx, { accountId: ctx.visaId }).looks.map((row) => row.merchant)).toEqual(['TINY ONE']);
  });

  it('a self viewer is offered an account their own charges landed on, though they do not own it', async () => {
    const ctx = await setup();
    // Travel Visa belongs to the adult; the child's own charges landed on it (a joint card).
    ctx.cadence({ merchant: 'MAPLE STREAMING', cents: 1349, person: ctx.childId, accountId: ctx.visaId });
    ctx.cadence({ merchant: 'CEDAR PHONE CO', cents: 6200, person: ctx.adultId });
    const result = read(ctx, { viewer: selfOnly(ctx.childId), accountId: ctx.visaId });
    expect(result.accounts).toEqual([{ id: ctx.visaId, name: 'Travel Visa' }]);
    expect(result.accountId).toBe(ctx.visaId);
    expect(result.looks.map((row) => row.merchant)).toEqual(['MAPLE STREAMING']);
  });
});

/** Spec 2026-10-05 §2.3, forming rhythms: what tells a new household the card is alive. */
describe('recurringCharges: rhythms one charge short', () => {
  it('counts merchants with two charges a band apart, the newest recent, per band, and lists none of them', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 2, cents: 13400 });
    ctx.cadence({ merchant: 'CEDAR PHONE CO', count: 2, cents: 6200 });
    ctx.cadence({ merchant: 'LAKESIDE DOMAIN', count: 2, gapDays: 365, endsDaysAgo: 6, cents: 2400 });
    expect(read(ctx)).toEqual({ known: [], looks: [], forming: { monthly: 2, yearly: 1 }, accounts: [], accountId: null });
  });

  it('does not count a merchant whose second charge is stale or off-band', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 2, endsDaysAgo: 200, cents: 13400 });
    ctx.cadence({ merchant: 'CEDAR PHONE CO', count: 2, gapDays: 60, cents: 6200 });
    expect(read(ctx).forming).toEqual({ monthly: 0, yearly: 0 });
  });

  it('does not count a merchant marked recurring: it is already Known', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 2, cents: 13400 });
    ctx.mark('HARBOUR INSURANCE', 'recurring');
    const result = read(ctx);
    expect(result.forming).toEqual({ monthly: 0, yearly: 0 });
    expect(result.known.map((row) => row.merchant)).toEqual(['HARBOUR INSURANCE']);
  });

  it('counts only merchants that charged the chosen account', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 2, cents: 13400 });
    ctx.cadence({ merchant: 'CEDAR PHONE CO', count: 2, cents: 6200, accountId: ctx.visaId });
    // A listed row on Travel Visa makes it a real option; forming merchants are not rows.
    ctx.cadence({ merchant: 'MAPLE STREAMING', cents: 1349, accountId: ctx.visaId });
    expect(read(ctx, { accountId: ctx.visaId }).forming).toEqual({ monthly: 1, yearly: 0 });
  });
});

describe('recurringLoad: the figure on the header line and the dashboard tile', () => {
  it('totals the monthly and the annual cycles separately, and counts the items behind them', async () => {
    const ctx = await setup();
    const subs = ctx.itemType('Subscription', 'subscription');
    ctx.item({ name: 'Streaming', typeId: subs, billingCycle: 'monthly', billingAmountCents: 1649 });
    ctx.item({ name: 'Music', typeId: subs, billingCycle: 'monthly', billingAmountCents: 1099 });
    ctx.item({ name: 'Cloud storage', typeId: subs, billingCycle: 'annual', billingAmountCents: 11999 });

    expect(recurringLoad({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null })).toEqual({
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

    expect(recurringLoad({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null })).toEqual({
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

    expect(recurringLoad({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null })).toMatchObject({
      monthlyCents: 1649,
      itemCount: 1,
    });
  });

  it('scopes to a self viewer own items', async () => {
    const ctx = await setup();
    const subs = ctx.itemType('Subscription', 'subscription');
    ctx.item({ name: 'Adult streaming', typeId: subs, billingCycle: 'monthly', billingAmountCents: 5000, ownerUserId: ctx.adultId });
    ctx.item({ name: 'Child music', typeId: subs, billingCycle: 'monthly', billingAmountCents: 599, ownerUserId: ctx.childId });

    expect(recurringLoad({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null }).monthlyCents).toBe(5599);
    expect(recurringLoad({ today: TODAY, ownerUserId: null, viewer: selfOnly(ctx.childId), accountId: null }).monthlyCents).toBe(599);
  });

  it('is all zeroes on a household that has recorded nothing, rather than an invented estimate', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'NETFLIX' });
    expect(recurringLoad({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null })).toEqual({
      monthlyCents: 0,
      annualCents: 0,
      itemCount: 0,
    });
  });
});
