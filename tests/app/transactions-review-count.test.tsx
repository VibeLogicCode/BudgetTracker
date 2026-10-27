// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { sql } from 'drizzle-orm';

const currentUser = vi.hoisted(() => ({
  value: { id: 0, name: '', username: '', role: 'member' as 'admin' | 'member', visibility: 'household' as 'household' | 'self' },
}));
const captured = vi.hoisted(() => ({ reviewCount: -1 }));

vi.mock('@/lib/auth/session', () => ({ requireUser: async () => currentUser.value }));
vi.mock('@/app/(app)/transactions/transactions-client', () => ({
  TransactionsClient: (props: { reviewCount?: number }) => {
    captured.reviewCount = props.reviewCount ?? -1;
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
});
