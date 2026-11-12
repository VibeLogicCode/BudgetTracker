// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { sql } from 'drizzle-orm';

const currentUser = vi.hoisted(() => ({
  value: { id: 0, name: '', username: '', role: 'member' as 'admin' | 'member', visibility: 'household' as 'household' | 'self' },
}));
const captured = vi.hoisted(() => ({
  reviewCount: -1,
  possibleDuplicateCount: -1,
  possibleDuplicates: null as unknown[] | null,
}));

vi.mock('@/lib/auth/session', () => ({ requireUser: async () => currentUser.value }));
vi.mock('@/app/(app)/transactions/transactions-client', () => ({
  TransactionsClient: (props: { reviewCount?: number; possibleDuplicateCount?: number; possibleDuplicates?: unknown[] }) => {
    captured.reviewCount = props.reviewCount ?? -1;
    captured.possibleDuplicateCount = props.possibleDuplicateCount ?? -1;
    captured.possibleDuplicates = props.possibleDuplicates ?? null;
    return null;
  },
}));

afterEach(cleanup);

/** v1.58.1: the needs-review figure is household-wide, so a self-scoped viewer's page props carry 0. */
describe('TransactionsPage reviewCount prop', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  function seedUncategorized(accountId: number, creator: number): void {
    t!.db.run(
      sql`insert into transactions
            (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
             attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
          values (${accountId}, ${'2026-08-12'}, ${-1500}, ${'MAPLE GROCER'}, ${'MAPLE GROCER'}, ${null},
                  ${null}, 0, ${'h-review-count'}, ${creator}, ${'2026-08-05T00:00:00.000Z'}, ${'2026-08-05T00:00:00.000Z'})`,
    );
  }

  async function renderPage() {
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    render(await TransactionsPage({ searchParams: Promise.resolve({}) }));
  }

  it('is 0 for a self viewer and the real count for a household viewer', async () => {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alex', username: 'alex', role: 'admin' });
    const member = insertTestUser(t.db, { name: 'Sam', username: 'sam', role: 'member' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    seedUncategorized(accountId, admin);

    currentUser.value = { id: member, name: 'Sam', username: 'sam', role: 'member', visibility: 'self' };
    await renderPage();
    expect(captured.reviewCount).toBe(0);

    currentUser.value = { id: admin, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    await renderPage();
    expect(captured.reviewCount).toBe(1);
  });

  /**
   * v1.60.0: reviewQueueCount is wrapped in React `cache` so the layout and the page share one
   * count per server request. Outside a server render that cache must hold nothing, or a page
   * rendered after an import would show the count from before it.
   */
  it('counts afresh on every call outside a server render', async () => {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alex', username: 'alex', role: 'admin' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    const { reviewQueueCount } = await import('@/lib/categorize/engine');
    expect(reviewQueueCount()).toBe(0);
    seedUncategorized(accountId, admin);
    expect(reviewQueueCount()).toBe(1);

    currentUser.value = { id: admin, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    await renderPage();
    expect(captured.reviewCount).toBe(1);
  });
});

/**
 * v1.61.0 item 4b. Needs review holds the queue and the rows an import or the sync held as possible
 * duplicates, so the chip counts both. Item 4a: the held rows themselves reach the client in review
 * mode only, and never for a self viewer -- not even under a hand-typed `?queue=duplicates`.
 */
describe('TransactionsPage: possible duplicates in the review count (v1.61.0)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  function seed() {
    t = createSeededTestDb();
    const alex = insertTestUser(t.db, { name: 'Alex', username: 'alex', role: 'admin' });
    const sam = insertTestUser(t.db, { name: 'Sam', username: 'sam', role: 'member' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    // Three rows in the queue (uncategorized), two held as possible duplicates.
    for (const [index, description] of ['MAPLE GROCER', 'FUEL STOP 12', 'CORNER BAKERY'].entries()) {
      t.db.run(
        sql`insert into transactions
              (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
               attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
            values (${accountId}, ${'2026-03-0' + (index + 2)}, ${-1500 - index}, ${description}, ${description}, ${null},
                    ${null}, 0, ${'h-queue-' + index}, ${alex}, ${'2026-03-05T00:00:00.000Z'}, ${'2026-03-05T00:00:00.000Z'})`,
      );
    }
    for (const externalId of ['sf-held-1', 'sf-held-2']) {
      t.db.run(
        sql`insert into set_aside_rows
              (account_id, state, reason, origin, date, amount_cents, raw_description, external_id, created_at)
            values (${accountId}, 'waiting', 'possible_duplicate', 'simplefin', '2026-03-10', -4217, 'MAPLE GROCER', ${externalId},
                    '2026-03-10T13:15:00.000Z')`,
      );
    }
    return { alex, sam };
  }

  async function renderPage(searchParams: Record<string, string>) {
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    render(await TransactionsPage({ searchParams: Promise.resolve(searchParams) }));
  }

  it('3 queue rows and 2 held rows show 5, and a self viewer gets 0 of either', async () => {
    const { alex, sam } = seed();
    currentUser.value = { id: alex, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    await renderPage({});
    expect(captured.reviewCount).toBe(5);
    expect(captured.possibleDuplicateCount).toBe(2);

    currentUser.value = { id: sam, name: 'Sam', username: 'sam', role: 'member', visibility: 'self' };
    await renderPage({});
    expect(captured.reviewCount).toBe(0);
    expect(captured.possibleDuplicateCount).toBe(0);
  });

  it('hands the held rows over in review mode only', async () => {
    const { alex } = seed();
    currentUser.value = { id: alex, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    await renderPage({});
    expect(captured.possibleDuplicates).toEqual([]);

    await renderPage({ review: '1', queue: 'duplicates' });
    expect(captured.possibleDuplicates).toHaveLength(2);
  });

  it("a self viewer's ?review=1&queue=duplicates serializes no held row", async () => {
    const { sam } = seed();
    currentUser.value = { id: sam, name: 'Sam', username: 'sam', role: 'member', visibility: 'self' };
    await renderPage({ review: '1', queue: 'duplicates' });
    expect(captured.possibleDuplicates).toEqual([]);
    expect(captured.possibleDuplicateCount).toBe(0);
    expect(captured.reviewCount).toBe(0);
  });
});
