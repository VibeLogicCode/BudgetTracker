import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import { listItemTypes } from '@/lib/warranty/types';
import { createWarrantyItem, updateWarrantyItem } from '@/lib/warranty/items';
import { listLoanAnchors, listRateHistory } from '@/lib/loans';

let t: TestDb | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const loanTypeId = (): number => listItemTypes().find((type) => type.kind === 'loan')!.id;

function loanInput(ownerUserId: number, over: Record<string, unknown> = {}) {
  return {
    name: 'Personal loan',
    vendor: null,
    model: null,
    serial: null,
    purchaseDate: '2026-07-01',
    warrantyMonths: null,
    isLifetime: false,
    priceCents: null,
    ownerUserId,
    transactionId: null,
    typeId: loanTypeId(),
    notes: null,
    principalCents: 1_000_000,
    interestRateBps: 1000,
    interestRateBasis: 'apr_monthly',
    currentBalanceCents: 1_000_000,
    ...over,
  } as Parameters<typeof createWarrantyItem>[0];
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    let walked: unknown = error;
    while (walked instanceof Error && walked.cause !== undefined) walked = walked.cause;
    return walked instanceof Error ? walked.message : String(walked);
  }
  return '';
}

/**
 * D1/D3 (ledger spec). Two defects the owner met on a real loan:
 *   - a rate could be saved with no basis, so nothing was ever computed from it
 *   - the item form never wrote a first anchor, so even WITH a basis the engine had no figure to
 *     start from and the loan page stayed blank
 */
describe('D1: a rate cannot be saved without saying how it is charged', () => {
  it('refuses a rate with no basis', () => {
    t = createSeededTestDb();
    const user = insertTestUser(t.db, { role: 'admin' });
    expect(refusal(() => createWarrantyItem(loanInput(user, { interestRateBasis: null })))).toMatch(
      /how the rate is charged/i,
    );
  });

  it('accepts no rate at all', () => {
    t = createSeededTestDb();
    const user = insertTestUser(t.db, { role: 'admin' });
    const id = createWarrantyItem(loanInput(user, { interestRateBps: null, interestRateBasis: null }));
    expect(id).toBeGreaterThan(0);
  });

  /** A rate of zero says nothing needs charging, which is what interest-free means. */
  it('accepts a zero rate with no basis', () => {
    t = createSeededTestDb();
    const user = insertTestUser(t.db, { role: 'admin' });
    expect(createWarrantyItem(loanInput(user, { interestRateBps: 0, interestRateBasis: null }))).toBeGreaterThan(0);
  });

  it('refuses the same way on an edit', () => {
    t = createSeededTestDb();
    const user = insertTestUser(t.db, { role: 'admin' });
    const id = createWarrantyItem(loanInput(user));
    expect(refusal(() => updateWarrantyItem(id, loanInput(user, { interestRateBasis: null })))).toMatch(
      /how the rate is charged/i,
    );
  });
});

describe('D3: the form writes the loan’s first statement', () => {
  it('anchors at the borrowed date by default, and records the rate from then', () => {
    t = createSeededTestDb();
    const user = insertTestUser(t.db, { role: 'admin' });
    const id = createWarrantyItem(loanInput(user), [], '2026-09-18T12:00:00.000Z');

    const anchors = listLoanAnchors(id);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ asOfDate: '2026-07-01', balanceCents: 1_000_000, source: 'form' });
    expect(listRateHistory(id)).toEqual([{ effectiveFrom: '2026-07-01', rateBps: 1000, basis: 'apr_monthly' }]);
  });

  /** The whole point: two months of interest are already there when the loan is saved. */
  it('posts every period that has already closed', () => {
    t = createSeededTestDb();
    const user = insertTestUser(t.db, { role: 'admin' });
    const id = createWarrantyItem(loanInput(user), [], '2026-09-18T12:00:00.000Z');

    const rows = t.sqlite
      .prepare('select period_end, interest_cents from loan_postings where item_id = ? order by id')
      .all(id);
    expect(rows).toEqual([
      { period_end: '2026-08-01', interest_cents: 8_333 },
      { period_end: '2026-09-01', interest_cents: 8_403 },
    ]);
    expect(t.sqlite.prepare('select current_balance_cents as b from warranty_items where id = ?').get(id)).toEqual({
      b: 1_016_736,
    });
  });

  it('takes an as-of date when the balance is not the original amount', () => {
    t = createSeededTestDb();
    const user = insertTestUser(t.db, { role: 'admin' });
    const id = createWarrantyItem(
      loanInput(user, { currentBalanceCents: 900_000, balanceAsOfDate: '2026-09-01' }),
      [],
      '2026-09-18T12:00:00.000Z',
    );
    expect(listLoanAnchors(id)[0]).toMatchObject({ asOfDate: '2026-09-01', balanceCents: 900_000 });
    expect(t.sqlite.prepare('select count(*) as n from loan_postings where item_id = ?').get(id)).toEqual({ n: 0 });
  });

  it('writes no anchor for a loan with no balance', () => {
    t = createSeededTestDb();
    const user = insertTestUser(t.db, { role: 'admin' });
    const id = createWarrantyItem(loanInput(user, { currentBalanceCents: null }), [], '2026-09-18T12:00:00.000Z');
    expect(listLoanAnchors(id)).toEqual([]);
  });

  /** Nothing about this applies to a warranty: it has no balance and no rate. */
  it('writes nothing for a non-loan item', () => {
    t = createSeededTestDb();
    const user = insertTestUser(t.db, { role: 'admin' });
    const warrantyType = listItemTypes().find((type) => type.kind === 'warranty')!.id;
    const id = createWarrantyItem(
      loanInput(user, {
        typeId: warrantyType,
        principalCents: null,
        interestRateBps: null,
        interestRateBasis: null,
        currentBalanceCents: null,
      }),
      [],
      '2026-09-18T12:00:00.000Z',
    );
    expect(listLoanAnchors(id)).toEqual([]);
    expect(listRateHistory(id)).toEqual([]);
  });
});

describe('D6/R2: posting day and a rate that changes', () => {
  it('stores a posting day and uses it for the cycle', () => {
    t = createSeededTestDb();
    const user = insertTestUser(t.db, { role: 'admin' });
    const id = createWarrantyItem(loanInput(user, { postingDay: 15 }), [], '2026-09-18T12:00:00.000Z');
    const rows = t.sqlite.prepare('select period_end from loan_postings where item_id = ? order by id').all(id);
    expect(rows).toEqual([{ period_end: '2026-07-15' }, { period_end: '2026-08-15' }, { period_end: '2026-09-15' }]);
  });

  it('records a rate change from the date given, leaving the closed period alone', () => {
    t = createSeededTestDb();
    const user = insertTestUser(t.db, { role: 'admin' });
    const id = createWarrantyItem(loanInput(user), [], '2026-09-18T12:00:00.000Z');
    updateWarrantyItem(
      id,
      loanInput(user, { interestRateBps: 1200, rateEffectiveFrom: '2026-09-01' }),
      '2026-09-18T13:00:00.000Z',
    );
    expect(listRateHistory(id)).toEqual([
      { effectiveFrom: '2026-07-01', rateBps: 1000, basis: 'apr_monthly' },
      { effectiveFrom: '2026-09-01', rateBps: 1200, basis: 'apr_monthly' },
    ]);
    const rows = t.sqlite.prepare('select interest_cents from loan_postings where item_id = ? order by id').all(id);
    expect(rows).toEqual([{ interest_cents: 8_333 }, { interest_cents: 8_403 }]);
  });

  it('records nothing new when the rate did not move', () => {
    t = createSeededTestDb();
    const user = insertTestUser(t.db, { role: 'admin' });
    const id = createWarrantyItem(loanInput(user), [], '2026-09-18T12:00:00.000Z');
    updateWarrantyItem(id, loanInput(user, { name: 'Renamed' }), '2026-09-18T13:00:00.000Z');
    expect(listRateHistory(id)).toHaveLength(1);
  });

  /**
   * D4 as built (reversed from the spec, see the note in items.ts): the edit form still sets a
   * balance, and doing so writes a statement rather than quietly overwriting a column.
   */
  it('turns a balance typed into the edit form into a new statement', () => {
    t = createSeededTestDb();
    const user = insertTestUser(t.db, { role: 'admin' });
    const id = createWarrantyItem(loanInput(user), [], '2026-09-18T12:00:00.000Z');
    updateWarrantyItem(
      id,
      loanInput(user, { currentBalanceCents: 900_000, balanceAsOfDate: '2026-09-18' }),
      '2026-09-18T13:00:00.000Z',
    );
    const anchors = listLoanAnchors(id);
    expect(anchors).toHaveLength(2);
    expect(anchors[1]).toMatchObject({ asOfDate: '2026-09-18', balanceCents: 900_000, source: 'form' });
    expect(t.sqlite.prepare('select current_balance_cents as b from warranty_items where id = ?').get(id)).toEqual({
      b: 900_000,
    });
  });

  it('writes no new statement when the balance was not touched', () => {
    t = createSeededTestDb();
    const user = insertTestUser(t.db, { role: 'admin' });
    const id = createWarrantyItem(loanInput(user), [], '2026-09-18T12:00:00.000Z');
    updateWarrantyItem(id, loanInput(user, { currentBalanceCents: 1_016_736 }), '2026-09-18T13:00:00.000Z');
    expect(listLoanAnchors(id)).toHaveLength(1);
  });
});
