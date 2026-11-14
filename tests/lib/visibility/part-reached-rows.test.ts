import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { HOUSEHOLD_VIEWER } from '@/lib/auth/viewer';
import { categoryTransactions } from '@/lib/budgets';
import { assignTransactionToLoan } from '@/lib/loans';
import { largestPurchases, transactionsCsv } from '@/lib/reports';
import { taxDetailRows } from '@/lib/tax';
import { groupTransactionsByCategory, groupTransactionsByMerchant, listTransactions, updateTransactionNotes } from '@/lib/transactions';
import { planYearEndPack, yearEndDetailCsv, yearEndPackEstimate } from '@/lib/year-end';
import { buildSplitPersonFixture, type SplitPersonFixture } from '../../helpers/split-person-fixture';
import { buildYearEndFixture, type YearEndFixture } from '../../helpers/year-end-fixture';

/**
 * v1.64.1. What a self viewer reads of a row they reach only through a part of theirs, and of a row
 * of theirs linked to a loan they do not hold: one description fragment behind every reader
 * (displayDescriptionFor, src/lib/transactions.ts), the notes search held to their own rows, and the
 * year-end pack's receipts held to their own rows.
 *
 * The split-person fixture: MAPLE GROCER is Alex's, with a Dining part set to Sam; FUEL STOP 12 is
 * Sam's. Sam is the self viewer throughout.
 */

const MARCH = { from: '2026-03-01', to: '2026-03-31' };
const LOAN_NAME = 'Alex car loan';

let split: SplitPersonFixture | null = null;
let yearEnd: YearEndFixture | null = null;
afterEach(() => {
  split?.t.cleanup();
  split = null;
  yearEnd?.cleanup();
  yearEnd = null;
});

/** A loan Alex holds, with a balance, so a link moves it as the app's own link path does. */
function seedLoan(f: SplitPersonFixture, owner: number, name: string): number {
  const now = '2026-03-01T00:00:00.000Z';
  const type = f.t.db.get<{ id: number }>(sql`
    insert into warranty_item_types (name, is_subscription, kind, created_at)
    values (${`${name} type`}, 0, 'loan', ${now}) returning id`);
  return f.t.db.get<{ id: number }>(sql`
    insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, loan_direction, principal_cents,
      current_balance_cents, created_at, updated_at)
    values (${name}, '2025-01-15', 0, ${owner}, ${type.id}, 'owed', 1000000, 1000000, ${now}, ${now})
    returning id`).id;
}

function labelOf(f: SplitPersonFixture, txnId: number): { text: string | null; source: string | null } {
  return f.t.db.get<{ text: string | null; source: string | null }>(
    sql`select display_description as text, display_source as source from transactions where id = ${txnId}`,
  );
}

/** Alex's charge, labelled by a link to Alex's own loan, split with Sam. */
function labelledSharedCharge(): SplitPersonFixture {
  const f = buildSplitPersonFixture();
  split = f;
  const loan = seedLoan(f, f.alex, LOAN_NAME);
  expect(assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId: f.maple, itemId: loan }).linked).toBe(true);
  expect(labelOf(f, f.maple)).toMatchObject({ source: 'loan' });
  expect(labelOf(f, f.maple).text).toContain(LOAN_NAME);
  return f;
}

describe('a row reached only through a part reads as its bank text', () => {
  it('in the list, both grouped views, Budgets, largest purchases, the tax rows and the year-end pack', () => {
    const f = labelledSharedCharge();
    const sam = f.self(f.sam);
    f.t.db.run(sql`update categories set tax_relevant = 1 where id = ${f.dining}`);

    const listed = listTransactions({}, sam).rows.find((row) => row.id === f.maple);
    expect(listed).toMatchObject({ rawDescription: 'MAPLE GROCER', displayDescription: null, displaySource: null });

    const byCategory = groupTransactionsByCategory({}, sam);
    const categoryPreview = byCategory.groups.flatMap((group) => group.preview).find((row) => row.id === f.maple);
    expect(categoryPreview?.description).toBe('MAPLE GROCER');

    const byMerchant = groupTransactionsByMerchant({}, sam).groups.find((group) => group.merchant === 'MAPLE GROCER');
    expect(byMerchant).toMatchObject({ displayName: 'MAPLE GROCER', newest: { displayDescription: null, displaySource: null } });
    expect(byMerchant?.preview.map((row) => row.description)).toEqual(['MAPLE GROCER']);

    const budgetRows = categoryTransactions('2026-03', f.dining, { scope: 'personal', attributedUserId: f.sam }, sam);
    expect(budgetRows.map((row) => row.merchant)).toEqual(['MAPLE GROCER']);

    const largest = largestPurchases(MARCH, sam).find((row) => row.id === f.maple);
    expect(largest?.description).toBe('MAPLE GROCER');

    const taxRows = taxDetailRows(2026, sam);
    expect(taxRows.map((row) => row.description)).toEqual(['MAPLE GROCER']);

    const pack = planYearEndPack(2026, sam, { today: '2026-12-31' });
    const detail = pack.entries.find((entry) => entry.name === 'tax-detail-2026.csv');
    expect(Buffer.isBuffer(detail?.source) ? detail.source.toString('utf8') : '').toContain('MAPLE GROCER');

    const everything = JSON.stringify({
      listed,
      byCategory,
      byMerchant,
      budgetRows,
      largest,
      taxRows,
      names: pack.entries.map((entry) => entry.name),
      texts: pack.entries.map((entry) => (Buffer.isBuffer(entry.source) ? entry.source.toString('utf8') : '')),
    });
    expect(everything).not.toContain(LOAN_NAME);
  });

  it("the charge's own person, and a household viewer, still read its label", () => {
    const f = labelledSharedCharge();
    const label = labelOf(f, f.maple).text;
    f.t.db.run(sql`update categories set tax_relevant = 1 where id = ${f.groceries}`);

    for (const viewer of [f.admin, f.self(f.alex)]) {
      expect(listTransactions({}, viewer).rows.find((row) => row.id === f.maple)).toMatchObject({ displayDescription: label, displaySource: 'loan' });
      expect(taxDetailRows(2026, viewer).find((row) => row.txnId === f.maple)?.description).toBe(label);
    }
    expect(groupTransactionsByMerchant({}, f.admin).groups.find((group) => group.merchant === 'MAPLE GROCER')?.displayName).toBe(label);
    expect(largestPurchases(MARCH, f.admin).find((row) => row.id === f.maple)?.description).toBe(label);
  });

  it('a name typed for the row is not read through a part either', () => {
    const f = buildSplitPersonFixture();
    split = f;
    f.t.db.run(sql`update transactions set display_description = 'Alex birthday dinner', display_source = 'manual' where id = ${f.maple}`);
    const sam = f.self(f.sam);
    expect(listTransactions({}, sam).rows.find((row) => row.id === f.maple)).toMatchObject({ displayDescription: null, displaySource: null });
    expect(JSON.stringify(groupTransactionsByCategory({}, sam))).not.toContain('birthday');
    expect(listTransactions({}, f.self(f.alex)).rows.find((row) => row.id === f.maple)?.displayDescription).toBe('Alex birthday dinner');
  });
});

describe("a self viewer's own row linked to a loan they do not hold", () => {
  it('reads as its bank text, and the loan name is not found by search', () => {
    const f = buildSplitPersonFixture();
    split = f;
    const loan = seedLoan(f, f.alex, LOAN_NAME);
    expect(assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId: f.fuel, itemId: loan }).linked).toBe(true);
    const sam = f.self(f.sam);

    expect(listTransactions({}, sam).rows.find((row) => row.id === f.fuel)).toMatchObject({
      rawDescription: 'FUEL STOP 12',
      displayDescription: null,
      displaySource: null,
    });
    expect(listTransactions({ search: 'car loan' }, sam).rows).toEqual([]);
    expect(JSON.stringify(groupTransactionsByMerchant({}, sam))).not.toContain(LOAN_NAME);
    // A household viewer still reads and finds the label.
    expect(listTransactions({ search: 'car loan' }, f.admin).rows.map((row) => row.id)).toEqual([f.fuel]);
  });
});

describe('notes search', () => {
  it("a self viewer's search reads notes on their own rows only", () => {
    const f = buildSplitPersonFixture();
    split = f;
    updateTransactionNotes(f.maple, 'reimburse from the trip fund');
    updateTransactionNotes(f.fuel, 'work trip');
    const sam = f.self(f.sam);

    expect(listTransactions({ search: 'trip fund' }, sam).rows).toEqual([]);
    expect(groupTransactionsByCategory({ search: 'trip fund' }, sam).totalCount).toBe(0);
    expect(groupTransactionsByMerchant({ search: 'trip fund' }, sam).totalCount).toBe(0);
    expect(transactionsCsv({ search: 'trip fund' }, sam)).not.toContain('MAPLE GROCER');
    expect(listTransactions({ search: 'work trip' }, sam).rows.map((row) => row.id)).toEqual([f.fuel]);

    // The charge's own person and a household viewer still find it by its note.
    expect(listTransactions({ search: 'trip fund' }, f.self(f.alex)).rows.map((row) => row.id)).toEqual([f.maple]);
    expect(listTransactions({ search: 'trip fund' }, f.admin).rows.map((row) => row.id)).toEqual([f.maple]);
  });
});

describe('year-end receipts on rows that are not the viewer’s own', () => {
  it('carry no receipt, no count and no holder line for a self viewer', () => {
    const fx = buildYearEndFixture();
    yearEnd = fx;
    // COMMUNITY FUND is Alex's; its Dining part is Sam's. Dining counts for tax here.
    fx.t.db.run(sql`update categories set tax_relevant = 1 where id = ${fx.dining}`);
    const alexItem = fx.addReceipt({ owner: fx.alex, txnId: fx.txn.fund, itemName: 'Donation letter' });
    const samItem = fx.addReceipt({ owner: fx.sam, txnId: fx.txn.fund, itemName: 'Gift receipt' });
    const sam = fx.viewers.self(fx.sam);

    const lines = yearEndDetailCsv(2026, sam).trim().split('\r\n');
    const fund = lines.find((line) => line.includes('COMMUNITY FUND'));
    expect(fund).toBe('2026-06-01,—,COMMUNITY FUND,Dining,Dining,Sam,-40.00,,,');

    const estimate = yearEndPackEstimate(2026, sam);
    expect(estimate).toMatchObject({ receiptCount: 1, heldByOthers: 0 });
    const names = planYearEndPack(2026, sam, { today: '2026-12-31' }).entries.map((entry) => entry.name);
    expect(names.some((name) => name.endsWith(`_r${samItem.id}.pdf`))).toBe(false);
    expect(names.some((name) => name.endsWith(`_r${alexItem.id}.pdf`))).toBe(false);

    // A household viewer's pack is unchanged: both receipts sit on the charge.
    const household = yearEndDetailCsv(2026, fx.viewers.admin);
    expect(household).toContain(`_r${alexItem.id}.pdf`);
    expect(household).toContain(`_r${samItem.id}.pdf`);
  });
});
