// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';

/**
 * Item BO. No transactions-page test existed before this task -- transactions-client.test.tsx
 * covers the client and transactions-actions.test.ts the writes, but nothing asserted what the
 * SERVER page hands the client, which is where the roster leaked.
 */
const currentUser = vi.hoisted(() => ({
  value: {
    id: 0,
    name: '',
    username: '',
    role: 'member' as 'admin' | 'member',
    visibility: 'household' as 'household' | 'self',
  },
}));

vi.mock('@/lib/auth/session', () => ({ requireUser: async () => currentUser.value }));

afterEach(cleanup);

describe('TransactionsPage (item BO)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function renderPage() {
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    return render(await TransactionsPage({ searchParams: Promise.resolve({}) }));
  }

  it('does not serialize another household member to a self viewer', async () => {
    t = createSeededTestDb();
    const child = insertTestUser(t.db, { name: 'Robin', username: 'robin', role: 'member' });
    insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: child, name: 'Robin', username: 'robin', role: 'member', visibility: 'self' };

    const { container } = await renderPage();
    expect(container.innerHTML).not.toContain('Alice');
  });

  it('still hands a household viewer the roster', async () => {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    insertTestUser(t.db, { name: 'Bob', username: 'bob', role: 'member' });
    insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };

    const { container } = await renderPage();
    expect(container.innerHTML).toContain('Bob');
  });
});

/**
 * Review round (fold /review in), ruling R2: `?review=1` is a household-wide filter, so a self
 * viewer's own request for it is silently ignored -- forced off server-side in page.tsx, not
 * refused -- and a household viewer gets the real thing. The review-only teaching paragraph
 * ("Every import runs each new transaction past the categorizer…", ported from the deleted
 * review-client.tsx) is the cheapest reliable marker of which PageGuide branch actually rendered.
 */
describe('TransactionsPage: ?review=1 (ruling R2)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function renderPage(searchParams: Record<string, string>) {
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    return render(await TransactionsPage({ searchParams: Promise.resolve(searchParams) }));
  }

  it('is silently ignored for a self viewer -- no redirect, no refusal, just their ordinary list', async () => {
    t = createSeededTestDb();
    const kid = insertTestUser(t.db, { name: 'Kid', username: 'kid', role: 'member' });
    insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: kid, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };

    const { container } = await renderPage({ review: '1' });
    expect(container.textContent).not.toContain('Every import runs each new transaction past the categorizer');
  });

  it('narrows a household viewer to the review filter and its own teaching copy', async () => {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };

    const { container } = await renderPage({ review: '1' });
    expect(container.textContent).toContain('Every import runs each new transaction past the categorizer');
  });

  it('a household viewer with no ?review param gets the ordinary Transactions guide', async () => {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };

    const { container } = await renderPage({});
    expect(container.textContent).not.toContain('Every import runs each new transaction past the categorizer');
  });
});
