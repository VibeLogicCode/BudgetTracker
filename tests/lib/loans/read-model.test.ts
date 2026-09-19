import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupLoanTest, type LoanTestContext } from './fixtures';
import { HOUSEHOLD_VIEWER } from '@/lib/auth/viewer';
import { listLoanRows, listLoanSummaries, loanDetail, setLoanAnchor } from '@/lib/loans';

let ctx: LoanTestContext;
beforeEach(() => {
  ctx = setupLoanTest();
});
afterEach(() => {
  ctx.t.cleanup();
});

const TODAY = '2026-09-18';

/** A loan that charges interest, so the engine has something to do for it. */
function interestBearing(name: string): number {
  const { itemId } = ctx.seedLoan({ name, balanceCents: 2_000_000, principalCents: 2_000_000 });
  ctx.t.sqlite
    .prepare("update warranty_items set interest_rate_bps = 600, interest_rate_basis = 'apr_monthly' where id = ?")
    .run(itemId);
  setLoanAnchor({
    itemId,
    asOfDate: '2026-06-01',
    balanceCents: 2_000_000,
    source: 'reconcile',
    actorUserId: ctx.userId,
    at: new Date('2026-06-01T12:00:00.000Z'),
  });
  return itemId;
}

/** Statements prepared while `run` executes. better-sqlite3 exposes no counter of its own. */
function statements(run: () => void): number {
  let prepared = 0;
  const original = ctx.t.sqlite.prepare.bind(ctx.t.sqlite);
  const spy = vi.spyOn(ctx.t.sqlite, 'prepare').mockImplementation(((text: string) => {
    prepared += 1;
    return original(text);
  }) as typeof ctx.t.sqlite.prepare);
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return prepared;
}

/**
 * Review C1 and C2. One read model served every caller, and it built a full ledger per loan
 * whether or not anything rendered one: a dropdown of loan names on the transactions page cost
 * roughly a hundred queries, and the loan page built the same loan's ledger three times over while
 * building every other loan's once.
 */
describe('C1: a loan row costs one query', () => {
  it('reads ten loans in a handful of statements', () => {
    for (let index = 0; index < 10; index += 1) interestBearing(`Loan ${index}`);
    let rows: ReturnType<typeof listLoanRows> = [];
    const count = statements(() => {
      rows = listLoanRows(TODAY, HOUSEHOLD_VIEWER);
    });
    expect(rows).toHaveLength(10);
    expect(count).toBeLessThanOrEqual(3);
  });

  it('still answers what a dropdown and the report flags ask of it', () => {
    const itemId = interestBearing('Civic');
    const [row] = listLoanRows(TODAY, HOUSEHOLD_VIEWER);
    expect(row).toMatchObject({ itemId, name: 'Civic', loanDirection: 'owed' });
    expect(row!.currentBalanceCents).toBeGreaterThan(0);
    expect(row!.payoffFraction).not.toBeNull();
  });

  /** And costs far less than the full read, which is the entire point of having two. */
  it('costs a fraction of the summary read', () => {
    for (let index = 0; index < 10; index += 1) interestBearing(`Loan ${index}`);
    const cheap = statements(() => void listLoanRows(TODAY, HOUSEHOLD_VIEWER));
    const full = statements(() => void listLoanSummaries(TODAY, HOUSEHOLD_VIEWER));
    expect(cheap * 10).toBeLessThan(full);
  });
});

describe('C2: the loan page reads its facts once', () => {
  it('does not touch the other loans at all', () => {
    const itemId = interestBearing('Civic');
    for (let index = 0; index < 9; index += 1) interestBearing(`Other ${index}`);

    const one = statements(() => void loanDetail(itemId, TODAY, HOUSEHOLD_VIEWER));
    const all = statements(() => void listLoanSummaries(TODAY, HOUSEHOLD_VIEWER));
    // Ten loans through the summary read; one loan here. A read that scaled with the household's
    // other loans is what this fix removed.
    expect(one * 5).toBeLessThan(all);
  });

  it('returns the ledger and the summary from the same facts', () => {
    const itemId = interestBearing('Civic');
    const detail = loanDetail(itemId, TODAY, HOUSEHOLD_VIEWER)!;
    expect(detail.ledger).not.toBeNull();
    expect(detail.summary.interest!.owingCents).toBe(detail.ledger!.owingCents);
    // And the same figure the dashboard's own read reports for that loan.
    const summary = listLoanSummaries(TODAY, HOUSEHOLD_VIEWER).find((loan) => loan.itemId === itemId)!;
    expect(summary.interest!.owingCents).toBe(detail.ledger!.owingCents);
  });

  it('is null for an item that is not a loan, and for one the viewer cannot see', () => {
    const itemId = interestBearing('Civic');
    expect(loanDetail(itemId + 999, TODAY, HOUSEHOLD_VIEWER)).toBeNull();
    const stranger = { id: 9_999, role: 'member' as const, visibility: 'self' as const };
    expect(loanDetail(itemId, TODAY, stranger)).toBeNull();
  });
});
