import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { listItemTypes } from '@/lib/warranty/types';
import { createWarrantyItem } from '@/lib/warranty/items';
import { createManualTransaction } from '@/lib/transactions';
import { assignTransactionToLoan } from '@/lib/loans';
import { HOUSEHOLD_VIEWER } from '@/lib/auth/viewer';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const columns = (table: string): string[] =>
  current!.sqlite
    .prepare(`pragma table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);

/** The seeded database already ships a loan type; creating a second one is refused by name. */
const loanTypeId = (): number => listItemTypes().find((type) => type.kind === 'loan')!.id;

/** WarrantyInput is wide and mostly non-optional; a loan only cares about a handful of it. */
const loan = (ownerUserId: number, typeId: number, over: Record<string, unknown> = {}) =>
  createWarrantyItem({
    name: 'Mortgage',
    vendor: null,
    model: null,
    serial: null,
    purchaseDate: '2026-01-01',
    warrantyMonths: null,
    isLifetime: false,
    priceCents: null,
    ownerUserId,
    transactionId: null,
    typeId,
    notes: null,
    ...over,
  } as Parameters<typeof createWarrantyItem>[0]);

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
 * drizzle/0025_loan_interest.sql. Two additions and one seed, all additive:
 *   - warranty_items.interest_rate_basis, so a rate finally says HOW it is charged (ruling I3)
 *   - loan_anchors, one append-only row per figure a person confirmed (ruling A1)
 *   - one 'migrated' anchor per loan that already has a balance (ruling A3)
 *
 * The seeding property in the last describe is the one that matters most: every household upgrading
 * to this release has loans with balances on screen, and not one of those figures may move.
 */
describe('0025: the migration records itself', () => {
  /**
   * The "I am the newest" claim moved on to 0026's suite, exactly as this suite took it from
   * 0024's. What stays here is the ordering claim, which is true of 0025 for good.
   */
  it('sits immediately after 0024 in the journal', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const journal = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((row) => row.tag === '0025_loan_interest')).toMatchObject({ idx: 25 });
    const idxs = journal.entries.map((entry) => entry.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(25)).toBe(idxs.indexOf(24) + 1);
  });
});

describe('0025: the rate basis column', () => {
  it('exists, nullable, on warranty_items', () => {
    current = createSeededTestDb();
    expect(columns('warranty_items')).toContain('interest_rate_basis');
  });

  /**
   * Ruling I5 said every existing rate was typed under a promise that nothing was computed from it,
   * so a rate could be saved with no basis. v1.48.0's D1 withdrew that for NEW saves -- a rate with
   * no period cannot be multiplied, so the form insists. What 0025 still has to guarantee is the
   * half that matters: the column is nullable, and a row that already holds NULL keeps it.
   */
  it('is NULL for a loan with no rate, and stays NULL where a row already has it', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const typeId = loanTypeId();
    const itemId = loan(user, typeId, { principalCents: 30_000_000 });
    const basisOf = () =>
      (current!.sqlite.prepare('select interest_rate_basis as basis from warranty_items where id = ?').get(itemId) as {
        basis: string | null;
      }).basis;
    expect(basisOf()).toBeNull();
    current.sqlite.prepare('update warranty_items set interest_rate_bps = 500 where id = ?').run(itemId);
    expect(basisOf()).toBeNull();
  });

  it('refuses a value outside the six the app knows', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const typeId = loanTypeId();
    const itemId = loan(user, typeId);
    const message = refusal(() =>
      current!.sqlite.prepare('update warranty_items set interest_rate_basis = ? where id = ?').run('weekly', itemId),
    );
    expect(message).toMatch(/CHECK constraint failed/i);
  });

  it('accepts each of the six', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const typeId = loanTypeId();
    const itemId = loan(user, typeId);
    for (const basis of ['none', 'apr_monthly', 'apr_semiannual', 'per_month', 'simple_on_principal', 'apr_daily']) {
      expect(
        refusal(() =>
          current!.sqlite.prepare('update warranty_items set interest_rate_basis = ? where id = ?').run(basis, itemId),
        ),
      ).toBe('');
    }
  });
});

describe('0025: the loan_anchors table', () => {
  it('carries every column the design names', () => {
    current = createSeededTestDb();
    const present = columns('loan_anchors');
    for (const column of [
      'id',
      'item_id',
      'as_of_date',
      'balance_cents',
      'source',
      'created_at',
      'created_by_user_id',
      'note',
      'interest_rate_bps',
      'interest_rate_basis',
      'payments_between_cents',
      'estimated_interest_cents',
      'app_balance_cents',
      'difference_cents',
      'stated_interest_cents',
      'prefilled_from',
      'prefill_balance_cents',
      'receipt_id',
    ]) {
      expect({ column, present: present.includes(column) }).toEqual({ column, present: true });
    }
  });

  /** LIKE, not GLOB: GLOB treats _ as a literal underscore, so a GLOB of them matches nothing. */
  it('refuses a date that is not YYYY-MM-DD', () => {
    current = createSeededTestDb();
    const message = refusal(() =>
      current!.sqlite
        .prepare('insert into loan_anchors (item_id, as_of_date, balance_cents, source, created_at) values (1, ?, 0, ?, ?)')
        .run('01/09/2026', 'reconcile', '2026-09-18T00:00:00.000Z'),
    );
    expect(message).toMatch(/CHECK constraint failed/i);
  });

  it('refuses a negative balance and an unknown source', () => {
    current = createSeededTestDb();
    const insert = (balance: number, source: string) =>
      refusal(() =>
        current!.sqlite
          .prepare('insert into loan_anchors (item_id, as_of_date, balance_cents, source, created_at) values (1, ?, ?, ?, ?)')
          .run('2026-09-01', balance, source, '2026-09-18T00:00:00.000Z'),
      );
    expect(insert(-1, 'reconcile')).toMatch(/CHECK constraint failed/i);
    expect(insert(0, 'guessed')).toMatch(/CHECK constraint failed/i);
  });

  /**
   * Correcting a statement is a second row, not an edit (ruling R8) -- so there is deliberately no
   * unique index on (item_id, as_of_date). A guard against one being added later.
   */
  it('allows two rows for the same date, because a correction is a new row', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const typeId = loanTypeId();
    const itemId = loan(user, typeId);
    const add = () =>
      refusal(() =>
        current!.sqlite
          .prepare('insert into loan_anchors (item_id, as_of_date, balance_cents, source, created_at) values (?, ?, ?, ?, ?)')
          .run(itemId, '2026-09-01', 100, 'reconcile', '2026-09-18T00:00:00.000Z'),
      );
    expect(add()).toBe('');
    expect(add()).toBe('');
  });

  it('goes away with the loan it belongs to', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const typeId = loanTypeId();
    const itemId = loan(user, typeId);
    current.sqlite
      .prepare('insert into loan_anchors (item_id, as_of_date, balance_cents, source, created_at) values (?, ?, ?, ?, ?)')
      .run(itemId, '2026-09-01', 100, 'reconcile', '2026-09-18T00:00:00.000Z');
    current.sqlite.prepare('delete from warranty_items where id = ?').run(itemId);
    const left = current.sqlite.prepare('select count(*) as n from loan_anchors where item_id = ?').get(itemId) as { n: number };
    expect(left.n).toBe(0);
  });
});

/**
 * Ruling A3, and the property that protects every existing install: the seed recovers what the
 * ledger implies, so replaying the seeded anchor forward through the payments linked after it
 * reproduces the balance that is on screen today. Nobody's figure moves on upgrade.
 *
 * The seed cannot run inside these tests -- the migration has already been applied by the time a
 * loan exists here -- so this asserts the ARITHMETIC the seed uses, against a loan built through
 * the app's own writers, which is the thing that could be wrong.
 */
describe('0025: seeding recovers the anchor the ledger implies', () => {
  function loanWithPayments() {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const accountId = insertTestAccount(current.db, { name: 'Chequing' });
    const typeId = loanTypeId();
    const itemId = loan(user, typeId, { currentBalanceCents: 30_000_000, balanceUpdatedAt: '2026-01-01T00:00:00.000Z' });
    for (const date of ['2026-02-15', '2026-03-15']) {
      const txnId = createManualTransaction({
        accountId,
        date,
        description: 'MORTGAGE PAYMENT',
        amountCents: -180_000,
        categoryId: null,
        attributedUserId: user,
        userId: user,
        actorRole: 'admin',
      });
      assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId });
    }
    return { itemId, user };
  }

  it('the stored balance is the typed figure minus what was linked after it', () => {
    const { itemId } = loanWithPayments();
    const row = current!.sqlite
      .prepare('select current_balance_cents as balance from warranty_items where id = ?')
      .get(itemId) as { balance: number };
    expect(row.balance).toBe(30_000_000 - 360_000);
  });

  /** Adding back the movements dated after the as-of date recovers the figure a person typed. */
  it('adding the later movements back recovers the anchor', () => {
    const { itemId } = loanWithPayments();
    const recovered = current!.sqlite
      .prepare(
        `select wi.current_balance_cents + coalesce((
           select sum(lp.applied_cents)
             from loan_payments lp
             join transactions t on t.id = lp.txn_id
            where lp.item_id = wi.id
              and t.date > substr(wi.balance_updated_at, 1, 10)
         ), 0) as anchor
           from warranty_items wi
          where wi.id = ?`,
      )
      .get(itemId) as { anchor: number };
    expect(recovered.anchor).toBe(30_000_000);
  });
});
