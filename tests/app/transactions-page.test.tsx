// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { sql } from 'drizzle-orm';
import { nowIso } from '@/lib/clock';
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

/**
 * Item 2 (owner report): a saved note used to vanish from the row entirely -- nothing said one
 * existed until the Note… editor was reopened blind. transactions-client.tsx's own note
 * indicator renders only when `row.notes` is non-empty, with the note text as its `title` -- so
 * finding that literal title in the rendered page proves `notes` actually survived
 * listTransactions' SELECTION (src/lib/transactions.ts already selects it) and page.tsx's
 * straight `page={page}` pass-through to the client, not merely that the client COULD render it
 * if it had it.
 */
describe('Item 2: a transaction note reaches the client end-to-end', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function renderPage() {
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    return render(await TransactionsPage({ searchParams: Promise.resolve({}) }));
  }

  it('a row with a note renders the note indicator, its title carrying the note text', async () => {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };
    t.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, notes, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'TIM HORTONS', 'TIM HORTONS', -500, 'paid in cash', ${admin}, ${nowIso()}, ${nowIso()})
    `);

    const { container } = await renderPage();
    expect(container.querySelector('button[title="paid in cash"]')).toBeTruthy();
  });

  it('a row with no note renders no note indicator', async () => {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };
    t.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'TIM HORTONS', 'TIM HORTONS', -500, ${admin}, ${nowIso()}, ${nowIso()})
    `);

    const { container } = await renderPage();
    expect(container.querySelector('button[aria-label^="Note on"]')).toBeNull();
  });
});

/**
 * Bug fix (owner report): categoryChipHref used to build every chip's href from `currentSearch`,
 * a `useState('')` an effect filled in from `window.location.search` on mount. This test renders
 * the real page the way a first paint actually happens -- no `window.history.pushState`, so
 * `window.location.search` stays empty exactly as it would server-side -- while page.tsx itself
 * knows the real filter from `searchParams`. Before the fix, that mismatch meant every chip's href
 * was a bare `/transactions?category=N`, stripping account, review=1, and everything else active;
 * clicking a chip out of the review queue landed on plain Transactions with no filters, which is
 * the bug as reported. currentQuery (built server-side from the parsed params, not the browser
 * URL) is what makes the first render correct with no client effect required to fix it up after.
 */
describe('Chip filters (ruling D6) bug fix: hrefs come from the SERVER-known filter, not window.location', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function renderPage(searchParams: Record<string, string>) {
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    return render(await TransactionsPage({ searchParams: Promise.resolve(searchParams) }));
  }

  function firstCategoryChipHref(container: HTMLElement): string | null {
    const link = Array.from(container.querySelectorAll('a')).find((a) =>
      (a.getAttribute('href') ?? '').includes('category='),
    );
    return link?.getAttribute('href') ?? null;
  }

  it('a category chip still carries review=1 when clicked from the review queue', async () => {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };

    const { container } = await renderPage({ review: '1' });
    const href = firstCategoryChipHref(container);
    expect(href).not.toBeNull();
    expect(href).toContain('review=1');
  });

  it('an unrelated active filter (account) survives a category chip click', async () => {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };

    const { container } = await renderPage({ account: String(accountId) });
    const href = firstCategoryChipHref(container);
    expect(href).not.toBeNull();
    expect(href).toContain(`account=${accountId}`);
  });
});

/**
 * v1.24.0 Lane A item 2 (owner report: "currently once i apply a trasnfer its hard to find that
 * data again"). readFilter (page.tsx, not exported) parses `?transfers=` into
 * TransactionFilter.transferView -- proven here end-to-end through the real page and a real
 * transfer/non-transfer pair, the same way the note test above (Item 2) proves a value reaches
 * the client rather than unit-testing a private function directly.
 */
describe('TransactionsPage: ?transfers= parses to transferView (Lane A item 2)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function renderWithTransfers(searchParams: Record<string, string>) {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };
    t.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'TIM HORTONS', 'TIM HORTONS', -500, 0, ${admin}, ${nowIso()}, ${nowIso()})
    `);
    t.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'PAYMENT - THANK YOU', 'PAYMENT - THANK YOU', -1000, 1, ${admin}, ${nowIso()}, ${nowIso()})
    `);
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    return render(await TransactionsPage({ searchParams: Promise.resolve(searchParams) }));
  }

  it("'transfers=only' shows the transfer row and hides the ordinary one", async () => {
    const { container } = await renderWithTransfers({ transfers: 'only' });
    expect(container.textContent).toContain('PAYMENT - THANK YOU');
    expect(container.textContent).not.toContain('TIM HORTONS');
  });

  it("'transfers=0' hides the transfer -- the existing checkbox value, unchanged meaning", async () => {
    const { container } = await renderWithTransfers({ transfers: '0' });
    expect(container.textContent).toContain('TIM HORTONS');
    expect(container.textContent).not.toContain('PAYMENT - THANK YOU');
  });

  it('an absent transfers param shows both rows -- the default is "all"', async () => {
    const { container } = await renderWithTransfers({});
    expect(container.textContent).toContain('TIM HORTONS');
    expect(container.textContent).toContain('PAYMENT - THANK YOU');
  });

  it('a hand-edited junk value falls back to "all", not a refusal or an empty page', async () => {
    const { container } = await renderWithTransfers({ transfers: 'nonsense' });
    expect(container.textContent).toContain('TIM HORTONS');
    expect(container.textContent).toContain('PAYMENT - THANK YOU');
  });
});
