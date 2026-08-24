import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { onboardingSteps } from '@/lib/onboarding';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/**
 * A user row exists in every one of these fixtures because imports.imported_by is NOT NULL,
 * not because onboardingSteps() looks at users: a household always has its first admin before
 * it can reach any of these screens, so "empty database" here means no accounts and no imports.
 */
function setup() {
  current = createSeededTestDb();
  const admin = insertTestUser(current.db, { name: 'Ada', username: 'ada' });
  const db = current.db;

  const addAccount = () => insertTestAccount(db, { name: 'Everyday Chequing' });

  const addImport = (accountId: number) => {
    db.run(sql`insert into imports (account_id, profile_id, filename, imported_by, created_at)
               values (${accountId}, ${null}, ${'statement.csv'}, ${admin}, ${nowIso()})`);
  };

  /** categoryId null + source 'none' is exactly what REVIEW_WHERE selects, so this row queues. */
  const addUnreviewedTxn = (accountId: number) => addTxn(accountId, null, 'none');
  /** A confirmed row: categorized and manually sourced, so REVIEW_WHERE skips it. */
  const addReviewedTxn = (accountId: number) => addTxn(accountId, categoryIdByName(db, 'Coffee'), 'manual');

  const addTxn = (accountId: number, categoryId: number | null, source: string) => {
    const description = 'CORNER BAKERY';
    db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents,
                                category_id, categorization_source, is_transfer, created_by, created_at, updated_at)
      values (${accountId}, ${'2026-03-02'}, ${description}, ${normalizeMerchant(description)}, ${-1200},
              ${categoryId}, ${source}, 0, ${admin}, ${nowIso()}, ${nowIso()})`);
  };

  return { addAccount, addImport, addUnreviewedTxn, addReviewedTxn };
}

const keysOf = () => onboardingSteps().map((step) => step.key);

describe('onboardingSteps', () => {
  it('returns both steps in dependency order for an empty database', () => {
    setup();
    expect(keysOf()).toEqual(['account', 'import']);
  });

  it('carries the copy each step needs to render its own call to action', () => {
    setup();
    const [account] = onboardingSteps();
    expect(account).toMatchObject({ key: 'account', href: '/settings/accounts', cta: 'Add an account' });
    expect(account.title.length).toBeGreaterThan(0);
    expect(account.body.length).toBeGreaterThan(0);
    for (const step of onboardingSteps()) {
      expect(step.href.startsWith('/')).toBe(true);
    }
  });

  it('drops the account step once one account exists', () => {
    const { addAccount } = setup();
    addAccount();
    expect(keysOf()).toEqual(['import']);
  });

  it('returns no steps once an account and an import both exist', () => {
    const { addAccount, addImport } = setup();
    const account = addAccount();
    addImport(account);
    expect(onboardingSteps()).toEqual([]);
  });

  /**
   * The regression guard for the defect this module was rewritten to fix.
   *
   * A third step keyed on an empty review queue made setup un-finish itself: the queue refills
   * on every import, so the card came back -- still headed "Getting started" -- in month
   * fourteen, above the banner that already reports the same count. Ruling A9 justified having
   * no dismiss control on the promise that the card disappears for good, so a step that can
   * un-complete breaks the reason the card has no dismiss button, not merely its wording.
   *
   * Both remaining signals latch. A dirty queue must therefore change nothing here.
   */
  it('stays finished when the review queue refills after setup, so the card cannot return', () => {
    const { addAccount, addImport, addUnreviewedTxn } = setup();
    const account = addAccount();
    addImport(account);
    expect(onboardingSteps()).toEqual([]);

    addUnreviewedTxn(account);
    expect(onboardingSteps()).toEqual([]);
  });

  it('keeps the import step while an account exists but nothing has been imported', () => {
    const { addAccount, addReviewedTxn } = setup();
    const account = addAccount();
    // Transactions can exist without an import row (added by hand, or synced), and an empty
    // review queue must not be mistaken for a finished import either way.
    addReviewedTxn(account);
    expect(keysOf()).toEqual(['import']);
  });
});
