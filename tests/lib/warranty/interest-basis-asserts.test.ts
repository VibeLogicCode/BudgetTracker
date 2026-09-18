import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import { listItemTypes } from '@/lib/warranty/types';
import { createWarrantyItem, updateWarrantyItem } from '@/lib/warranty/items';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const typeOfKind = (kind: string): number => listItemTypes().find((type) => type.kind === kind)!.id;

function base(user: number, typeId: number, over: Record<string, unknown> = {}) {
  return {
    name: 'Mortgage',
    vendor: null,
    model: null,
    serial: null,
    purchaseDate: '2026-01-01',
    warrantyMonths: null,
    isLifetime: false,
    priceCents: null,
    ownerUserId: user,
    transactionId: null,
    typeId,
    notes: null,
    ...over,
  } as Parameters<typeof createWarrantyItem>[0];
}

const make = (over: Record<string, unknown> = {}) => {
  current = createSeededTestDb();
  const user = insertTestUser(current.db, { role: 'admin' });
  return { user, create: (o: Record<string, unknown> = {}) => createWarrantyItem(base(user, typeOfKind('loan'), { ...over, ...o })) };
};

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

/**
 * Ruling I6. SQLite cannot add a CHECK to an existing table and have it re-validate the rows
 * already there (0007's argument), so every cross-column rule about the basis lives here, beside
 * the asserts that were already doing the same job for the other loan columns.
 */
describe('the rate basis and the rate belong together', () => {
  it('refuses a basis with no rate to apply it to', () => {
    const { create } = make();
    expect(refusal(() => create({ interestRateBasis: 'apr_monthly', interestRateBps: null }))).toMatch(
      /needs an interest rate/i,
    );
  });

  it('accepts a basis with a rate', () => {
    const { create } = make();
    expect(refusal(() => create({ interestRateBasis: 'apr_monthly', interestRateBps: 500 }))).toBe('');
  });

  /** Interest-free is a positive claim, and a non-zero rate would contradict it. */
  it('refuses interest-free with a rate above zero', () => {
    const { create } = make();
    expect(refusal(() => create({ interestRateBasis: 'none', interestRateBps: 500 }))).toMatch(/interest-free/i);
  });

  it('accepts interest-free with no rate, and with a zero rate', () => {
    const { create } = make();
    expect(refusal(() => create({ interestRateBasis: 'none', interestRateBps: null }))).toBe('');
    expect(refusal(() => create({ interestRateBasis: 'none', interestRateBps: 0, name: 'Second' }))).toBe('');
  });

  /** Charging on the original amount needs an original amount to charge on. */
  it('refuses flat-on-principal without a principal', () => {
    const { create } = make();
    expect(
      refusal(() => create({ interestRateBasis: 'simple_on_principal', interestRateBps: 500, principalCents: null })),
    ).toMatch(/original amount/i);
  });

  it('accepts flat-on-principal with one', () => {
    const { create } = make();
    expect(
      refusal(() =>
        create({ interestRateBasis: 'simple_on_principal', interestRateBps: 500, principalCents: 1_000_000 }),
      ),
    ).toBe('');
  });
});

describe('the basis belongs to loans only', () => {
  it('refuses a basis on an item that is not a loan', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const message = refusal(() =>
      createWarrantyItem(base(user, typeOfKind('warranty'), { interestRateBasis: 'apr_monthly', interestRateBps: 500 })),
    );
    expect(message).toBeTruthy();
  });

  /** MUST-12.5: the loan columns are cleared together when a type stops being a loan. */
  it('is cleared along with the other loan columns on update', () => {
    const { user, create } = make();
    const itemId = create({ interestRateBasis: 'apr_monthly', interestRateBps: 500 });
    updateWarrantyItem(itemId, base(user, typeOfKind('loan'), { interestRateBasis: null, interestRateBps: null }));
    const row = current!.sqlite
      .prepare('select interest_rate_basis as basis from warranty_items where id = ?')
      .get(itemId) as { basis: string | null };
    expect(row.basis).toBeNull();
  });
});
