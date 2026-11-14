// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { sql } from 'drizzle-orm';
import { nowIso } from '@/lib/clock';
import { setRecurringMarks } from '@/lib/categorize/rules';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { captureBulkBefore, recordBulkUndo } from '@/lib/bulk-undo';
import { localTimeLabel } from '@/lib/dates';
import { readEnv } from '@/lib/env';
import { bulkSetAttribution } from '@/lib/transactions';
import { recordLocalAiFailure, saveLocalAiConfig, turnOffLocalAi } from '@/lib/ai/config';
import { ignoreAiSuggestion, recordMerchantSuggestion } from '@/lib/ai/suggestions';
import { setSetting } from '@/lib/settings';
import { buildAiFixture, type AiFixture } from '../helpers/ai-fixture';

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
// v1.64.0: with local AI active the page renders Ask in words, whose useRouter needs the App
// Router mounted. A test render has none, so the router is a stand-in here.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));

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
 * Item 2 (a report): a saved note used to vanish from the row entirely -- nothing said one
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
 * Bug fix (a report): categoryChipHref used to build every chip's href from `currentSearch`,
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
 * v1.24.0 Lane A item 2 (reported: once a transfer is applied it is hard to find that
 * data again). readFilter (page.tsx, not exported) parses `?transfers=` into
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

/**
 * v1.25.0 Lane R item R1 (deferred from v1.20.0). readFilter (page.tsx, not exported) parses
 * `?queue=` into TransactionFilter.reviewQueue -- proven end-to-end through the real page, same
 * idiom as the `?transfers=` describe block above. Requires `?review=1`: `?queue=` composes with
 * the review filter and does nothing on its own (readFilter forces `reviewQueue: undefined`'s
 * meaning "both" the same way whether or not review mode is active, but the two chip rows only
 * ever narrow rows REVIEW_WHERE already selects, so a plain, non-review list is unaffected by it
 * either way -- the point proven here is the review-mode composition, which is the only place a
 * person can ever reach `?queue=` from the UI).
 */
describe('TransactionsPage: ?queue= parses to reviewQueue (Lane R item R1)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function renderWithQueue(searchParams: Record<string, string>) {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };
    const groceries = categoryIdByName(t.db, 'Groceries');
    // Suggested: categoryId set, source = 'bayes'.
    t.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, confidence, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'GUESSED SHOP', 'GUESSED SHOP', -500, ${groceries}, 'bayes', 3.1, ${admin}, ${nowIso()}, ${nowIso()})
    `);
    // Not categorized: categoryId null, source = 'none'.
    t.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'UNKNOWN SHOP', 'UNKNOWN SHOP', -700, null, 'none', ${admin}, ${nowIso()}, ${nowIso()})
    `);
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    return render(await TransactionsPage({ searchParams: Promise.resolve({ review: '1', ...searchParams }) }));
  }

  it("'queue=suggested' shows the guessed row and hides the uncategorized one", async () => {
    const { container } = await renderWithQueue({ queue: 'suggested' });
    expect(container.textContent).toContain('GUESSED SHOP');
    expect(container.textContent).not.toContain('UNKNOWN SHOP');
  });

  it("'queue=uncategorized' shows the uncategorized row and hides the guessed one", async () => {
    const { container } = await renderWithQueue({ queue: 'uncategorized' });
    expect(container.textContent).toContain('UNKNOWN SHOP');
    expect(container.textContent).not.toContain('GUESSED SHOP');
  });

  it('an absent queue param shows both rows -- the default is "both"', async () => {
    const { container } = await renderWithQueue({});
    expect(container.textContent).toContain('GUESSED SHOP');
    expect(container.textContent).toContain('UNKNOWN SHOP');
  });

  it('a hand-edited junk value falls back to "both", not a refusal or an empty page', async () => {
    const { container } = await renderWithQueue({ queue: 'nonsense' });
    expect(container.textContent).toContain('GUESSED SHOP');
    expect(container.textContent).toContain('UNKNOWN SHOP');
  });
});

/**
 * v1.26.0 Lane 1 (reported: a row showed a merchant name with no way to see the original
 * entry, so it was impossible to tell whether the rename was right). Proves renameRules (page.tsx's own prop -- see its doc comment) actually
 * reaches the client end-to-end: a real rename rule in the database, matched against a real
 * renamed row's normalizedMerchant the SAME way applyRenameRules/resolveRename
 * (src/lib/categorize/engine.ts) already do, surfaced in the bank-text dialog's "Rule: …" line
 * and its Edit/Delete links -- proven through the real page and a real rule row, the same idiom
 * Item 2 above uses for the note indicator rather than unit-testing readFilter/renameRules
 * directly.
 */
describe('TransactionsPage: the bank-text dialog resolves which rule renamed a row (v1.26.0 Lane 1)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('matches the rename rule against the row and surfaces it in the dialog, with Edit/Delete links to Settings', async () => {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };
    t.db.run(sql`
      insert into merchant_rules (pattern, match_type, rule_kind, rename_to, created_at)
      values ('AMAZON', 'contains', 'rename', 'Amazon', ${nowIso()})
    `);
    t.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, display_description, display_source, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'AMZN MKTP CA*5H1CF8BE0', 'AMAZON', -2599, 'Amazon', 'rename', ${admin}, ${nowIso()}, ${nowIso()})
    `);

    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    const { container } = render(await TransactionsPage({ searchParams: Promise.resolve({}) }));

    const table = container.querySelector('table')!;
    fireEvent.click(within(table).getByRole('button', { name: 'Why AMAZON shows this name' }));

    expect(screen.getByRole('dialog', { name: /Renamed by a rule/ })).toBeTruthy();
    expect(screen.getByText('Rule: contains AMAZON → "Amazon"')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit the rule' }).getAttribute('href')).toBe(
      '/settings/merchant-rules?kind=rename&q=AMAZON',
    );
  });

  it('omits the rule line and links when the row is renamed but no rule resolves it any more (edited or deleted since)', async () => {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };
    // No merchant_rules row at all: display_source = 'rename' with nothing left in the table to
    // resolve it -- exactly the "the rule was deleted since" case renameRules' own doc comment
    // (page.tsx) argues for treating like "the rule list was never available".
    t.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, display_description, display_source, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'AMZN MKTP CA*5H1CF8BE0', 'AMAZON', -2599, 'Amazon', 'rename', ${admin}, ${nowIso()}, ${nowIso()})
    `);

    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    const { container } = render(await TransactionsPage({ searchParams: Promise.resolve({}) }));

    const table = container.querySelector('table')!;
    fireEvent.click(within(table).getByRole('button', { name: 'Why AMAZON shows this name' }));

    expect(screen.getByText('AMZN MKTP CA*5H1CF8BE0')).toBeTruthy();
    expect(screen.queryByText(/^Rule:/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit the rule' })).toBeNull();
  });
});

/**
 * v1.26.0 Lane 3a item 1. `?sort=` / `?dir=` reach TransactionFilter.sort/direction through the
 * real page and change the real ORDER -- proven the same way the `?transfers=` and `?queue=` blocks
 * above prove their params, end to end against a real database rather than by unit-testing
 * readFilter (filter-params.ts) directly.
 *
 * The absent-sort case is the one that matters most and is asserted twice (absent, and a junk
 * value): `sort` undefined is the ONLY value that leaves this page's ordering byte-identical to
 * what it was before this release, so a regression there silently reorders every existing bookmark
 * rather than failing visibly.
 */
describe('TransactionsPage: ?sort= and ?dir= change the order (Lane 3a item 1)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  /** The merchant text of each rendered table row, top to bottom. The Description cell also holds
   *  this row's badges, so these are matched with `toContain` rather than equality -- what is being
   *  asserted is the ORDER of the rows, never the rest of the cell's contents. */
  function order(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('table tbody td[data-label="Description"]')).map((cell) =>
      (cell.textContent ?? '').trim(),
    );
  }

  async function renderSorted(searchParams: Record<string, string>) {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };
    const restaurants = categoryIdByName(t.db, 'Restaurants');
    const groceries = categoryIdByName(t.db, 'Groceries');
    // Three rows chosen so date, amount and category each produce a DIFFERENT order, and so no two
    // orders can pass by coincidence: oldest/least-negative/'Groceries', middle/most-negative/
    // 'Restaurants', newest/middling/no category at all.
    t.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-01', 'AAA CORNER', 'AAA CORNER', -100, ${groceries}, 'rule', ${admin}, ${nowIso()}, ${nowIso()})
    `);
    t.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'BBB DINER', 'BBB DINER', -900, ${restaurants}, 'rule', ${admin}, ${nowIso()}, ${nowIso()})
    `);
    t.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-03', 'CCC KIOSK', 'CCC KIOSK', -500, null, 'none', ${admin}, ${nowIso()}, ${nowIso()})
    `);
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    return render(await TransactionsPage({ searchParams: Promise.resolve(searchParams) }));
  }

  it('an absent sort leaves the default order untouched -- newest first, exactly as before this release', async () => {
    const { container } = await renderSorted({});
    const rows = order(container);
    expect(rows[0]).toContain('CCC KIOSK');
    expect(rows[1]).toContain('BBB DINER');
    expect(rows[2]).toContain('AAA CORNER');
  });

  it('a junk sort value behaves exactly as absent, not as an arbitrary column', async () => {
    const { container } = await renderSorted({ sort: 'nonsense', dir: 'sideways' });
    const rows = order(container);
    expect(rows[0]).toContain('CCC KIOSK');
    expect(rows[2]).toContain('AAA CORNER');
  });

  it('sort=date&dir=asc puts the oldest row first', async () => {
    const { container } = await renderSorted({ sort: 'date', dir: 'asc' });
    const rows = order(container);
    expect(rows[0]).toContain('AAA CORNER');
    expect(rows[1]).toContain('BBB DINER');
    expect(rows[2]).toContain('CCC KIOSK');
  });

  it('sort=date with no dir defaults to desc -- newest first', async () => {
    const { container } = await renderSorted({ sort: 'date' });
    expect(order(container)[0]).toContain('CCC KIOSK');
  });

  it('sort=amount orders by the SIGNED amount: desc is the least-negative row first', async () => {
    const { container } = await renderSorted({ sort: 'amount' });
    const rows = order(container);
    expect(rows[0]).toContain('AAA CORNER');
    expect(rows[1]).toContain('CCC KIOSK');
    expect(rows[2]).toContain('BBB DINER');
  });

  it('sort=amount&dir=asc is the biggest spend first -- the other end of the same signed column', async () => {
    const { container } = await renderSorted({ sort: 'amount', dir: 'asc' });
    const rows = order(container);
    expect(rows[0]).toContain('BBB DINER');
    expect(rows[2]).toContain('AAA CORNER');
  });

  it('sort=category orders by category NAME and keeps the uncategorized row last in BOTH directions', async () => {
    const ascending = await renderSorted({ sort: 'category', dir: 'asc' });
    const asc = order(ascending.container);
    expect(asc[0]).toContain('AAA CORNER'); // Groceries
    expect(asc[1]).toContain('BBB DINER'); // Restaurants
    expect(asc[2]).toContain('CCC KIOSK'); // no category -- last
    cleanup();
    t?.cleanup();
    t = null;

    const descending = await renderSorted({ sort: 'category', dir: 'desc' });
    const desc = order(descending.container);
    expect(desc[0]).toContain('BBB DINER'); // Restaurants
    expect(desc[1]).toContain('AAA CORNER'); // Groceries
    expect(desc[2]).toContain('CCC KIOSK'); // still last, not first
  });
});

/**
 * v1.26.0 Lane 3a items 2 and 3, and the audit URL a sibling lane links to. Everything here runs
 * through the real page, the real groupTransactionsByCategory and a real `transactions.import_id`,
 * because the point of the feature is that the numbers on a group header describe the same set the
 * list underneath them would.
 */
describe('TransactionsPage: ?group=category, ?source= and the audit URL (Lane 3a items 2-4)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  /** Two rule-filed clusters inside one import, plus one row a person filed by hand and one row
   *  from a DIFFERENT import -- so `?source=`, `?import=` and their combination each have something
   *  to exclude rather than passing vacuously. */
  async function renderAudit(searchParams: Record<string, string>) {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };
    const groceries = categoryIdByName(t.db, 'Groceries');
    const coffee = categoryIdByName(t.db, 'Coffee');
    const marchImport = t.db.get<{ id: number }>(sql`
      insert into imports (account_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
      values (${accountId}, 'march.csv', ${admin}, 4, 0, 0, ${nowIso()})
      returning id
    `);
    const aprilImport = t.db.get<{ id: number }>(sql`
      insert into imports (account_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
      values (${accountId}, 'april.csv', ${admin}, 1, 0, 0, ${nowIso()})
      returning id
    `);
    // The audit URL is written by hand in the tests below, so these ids have to be the ones those
    // URLs name. Asserted rather than assumed: a schema change that shifted them would otherwise
    // turn every assertion below into a test of an empty batch that still passed.
    expect([marchImport.id, aprilImport.id]).toEqual([1, 2]);
    // Groceries: two rows filed by a rule, -4000 and -2000 => -6000, the bigger cluster.
    t.db.run(sql`
      insert into transactions (account_id, import_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, ${marchImport.id}, '2026-03-01', 'GREENFIELD MARKET', 'GREENFIELD MARKET', -4000, ${groceries}, 'rule', ${admin}, ${nowIso()}, ${nowIso()})
    `);
    t.db.run(sql`
      insert into transactions (account_id, import_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, ${marchImport.id}, '2026-03-02', 'GREENFIELD MARKET', 'GREENFIELD MARKET', -2000, ${groceries}, 'rule', ${admin}, ${nowIso()}, ${nowIso()})
    `);
    // Coffee: one rule row, -1500 -- the smaller cluster, so ordering by absolute total is testable.
    t.db.run(sql`
      insert into transactions (account_id, import_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, ${marchImport.id}, '2026-03-03', 'HARBOUR ROAST', 'HARBOUR ROAST', -1500, ${coffee}, 'rule', ${admin}, ${nowIso()}, ${nowIso()})
    `);
    // Same import, but a person filed this one -- excluded by ?source=rule.
    t.db.run(sql`
      insert into transactions (account_id, import_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, ${marchImport.id}, '2026-03-04', 'BY HAND SHOP', 'BY HAND SHOP', -700, ${groceries}, 'manual', ${admin}, ${nowIso()}, ${nowIso()})
    `);
    // A rule row from the OTHER import -- excluded by ?import=1.
    t.db.run(sql`
      insert into transactions (account_id, import_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, ${aprilImport.id}, '2026-04-01', 'OTHER BATCH CO', 'OTHER BATCH CO', -9900, ${groceries}, 'rule', ${admin}, ${nowIso()}, ${nowIso()})
    `);
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    return render(await TransactionsPage({ searchParams: Promise.resolve(searchParams) }));
  }

  function groupHeaders(container: HTMLElement): string[] {
    // Scoped to the group list: PageGuide is a <details>/<summary> of its own ("What is this page
    // for?"), so an unscoped `summary` query finds the guide as well as the clusters.
    return Array.from(container.querySelectorAll('ul[data-category-groups] summary')).map((node) =>
      (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
  }

  it('?source=rule narrows the list to rule-filed rows', async () => {
    const { container } = await renderAudit({ source: 'rule' });
    expect(container.textContent).toContain('GREENFIELD MARKET');
    expect(container.textContent).not.toContain('BY HAND SHOP');
  });

  it('?source=manual is the other half of the same filter', async () => {
    const { container } = await renderAudit({ source: 'manual' });
    expect(container.textContent).toContain('BY HAND SHOP');
    expect(container.textContent).not.toContain('HARBOUR ROAST');
  });

  it('a junk ?source= value shows everything, rather than refusing or emptying the page', async () => {
    const { container } = await renderAudit({ source: 'nonsense' });
    expect(container.textContent).toContain('GREENFIELD MARKET');
    expect(container.textContent).toContain('BY HAND SHOP');
  });

  it('?group=category renders one header per cluster, each with its own count and subtotal', async () => {
    const { container } = await renderAudit({ group: 'category' });
    const headers = groupHeaders(container);
    const groceries = headers.find((text) => text.includes('Groceries'));
    const coffee = headers.find((text) => text.includes('Coffee'));
    // Groceries: the two rule rows PLUS the by-hand row and the other import's row -- no source or
    // import filter here, so the cluster is every Groceries row in view.
    expect(groceries).toContain('4 transactions');
    expect(groceries).toContain('$166.00');
    expect(coffee).toContain('1 transaction');
    expect(coffee).toContain('$15.00');
  });

  it('?group=category orders clusters by largest absolute total first', async () => {
    const { container } = await renderAudit({ group: 'category' });
    const headers = groupHeaders(container);
    expect(headers[0]).toContain('Groceries');
    expect(headers[1]).toContain('Coffee');
  });

  it('?group=category shows the clusters INSTEAD of the rows -- there is no transactions table', async () => {
    const { container } = await renderAudit({ group: 'category' });
    expect(container.querySelector('table')).toBeNull();
    expect(groupHeaders(container).length).toBeGreaterThan(0);
  });

  it('a junk ?group= value falls back to the flat list', async () => {
    const { container } = await renderAudit({ group: 'nonsense' });
    expect(container.querySelector('table')).toBeTruthy();
    expect(groupHeaders(container)).toEqual([]);
  });

  it('the full audit URL renders exactly the clusters that import’s rules produced', async () => {
    const { container } = await renderAudit({ import: '1', source: 'rule', group: 'category' });
    const headers = groupHeaders(container);
    expect(headers).toHaveLength(2);
    // Groceries here is the TWO rule rows of import 1 only: not the by-hand row (source), not the
    // other import's -$99 row (import) -- either leak would show up as a bigger count or subtotal.
    expect(headers[0]).toContain('Groceries');
    expect(headers[0]).toContain('2 transactions');
    expect(headers[0]).toContain('$60.00');
    expect(headers[1]).toContain('Coffee');
    expect(headers[1]).toContain('1 transaction');
    expect(container.textContent).toContain('3 transactions in this view');
  });

  it('the audit URL offers a way back out of the batch it put the household into', async () => {
    const { container } = await renderAudit({ import: '1', source: 'rule', group: 'category' });
    const chip = Array.from(container.querySelectorAll('a')).find((a) => (a.textContent ?? '').includes('Import #1'));
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute('href')).not.toContain('import=');
    expect(chip?.getAttribute('href')).toContain('source=rule');
  });

  it('a group header links through to the same cluster in the flat list, exactly and un-grouped', async () => {
    const { container } = await renderAudit({ import: '1', source: 'rule', group: 'category' });
    const link = Array.from(container.querySelectorAll('a')).find((a) =>
      (a.textContent ?? '').startsWith('See all 2 in the list'),
    );
    const href = link?.getAttribute('href') ?? '';
    expect(href).toContain(`category=${categoryIdByName(t!.db, 'Groceries')}`);
    expect(href).toContain('exact=1');
    expect(href).toContain('import=1');
    expect(href).toContain('source=rule');
    expect(href).not.toContain('group=');
  });
});

/**
 * v1.26.0 Lane 3a item 2, the pager. `?gpage=` pages by GROUP, and its label has to be unmistakable
 * about that: "Page 2 of 2" under a list of categories reads as rows to anybody who has used the
 * rest of this page, and the household is here specifically to judge how big a batch the rules
 * touched. 26 clusters against a 25-group page is the smallest fixture that proves the slice and
 * the wording at once.
 */
describe('TransactionsPage: ?gpage= pages by GROUP, and says so (Lane 3a item 2)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function renderManyGroups(searchParams: Record<string, string>) {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };
    // One transaction in each of 26 seeded categories: 26 clusters, so the default page of 25
    // groups leaves exactly one for page 2. Amounts descend so the ordering is deterministic.
    const ids = t.db.all<{ id: number }>(sql`select id from categories order by id limit 26`).map((row) => row.id);
    expect(ids).toHaveLength(26);
    ids.forEach((categoryId, index) => {
      t!.db.run(sql`
        insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
        values (${accountId}, '2026-03-01', ${`SHOP ${index}`}, ${`SHOP ${index}`}, ${-100000 + index * 1000}, ${categoryId}, 'rule', ${admin}, ${nowIso()}, ${nowIso()})
      `);
    });
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    return render(await TransactionsPage({ searchParams: Promise.resolve({ group: 'category', ...searchParams }) }));
  }

  it('shows 25 clusters on the first page and labels the range as GROUPS, not rows', async () => {
    const { container } = await renderManyGroups({});
    expect(container.querySelectorAll('ul[data-category-groups] summary')).toHaveLength(25);
    expect(container.textContent).toContain('Groups 1–25 of 26');
    // The wording that must never be a bare page number, and never call the 26 "transactions".
    expect(container.textContent).toContain('26 transactions in this view');
    expect(container.textContent).not.toContain('Page 1 of 2');
  });

  it('?gpage=2 advances by a page of GROUPS, not of rows', async () => {
    const { container } = await renderManyGroups({ gpage: '2' });
    expect(container.querySelectorAll('ul[data-category-groups] summary')).toHaveLength(1);
    expect(container.textContent).toContain('Groups 26–26 of 26');
  });

  it('a junk ?gpage= value is page one, not an empty view', async () => {
    const { container } = await renderManyGroups({ gpage: 'nonsense' });
    expect(container.textContent).toContain('Groups 1–25 of 26');
  });

  it('the pager links change gpage and nothing else', async () => {
    const { container } = await renderManyGroups({ gpage: '2' });
    const previous = Array.from(container.querySelectorAll('a')).find(
      (a) => (a.textContent ?? '').trim() === 'Previous groups',
    );
    expect(previous?.getAttribute('href')).toContain('gpage=1');
    expect(previous?.getAttribute('href')).toContain('group=category');
  });
});

/**
 * v1.26.0 Lane 3a item 3. The badge, end to end -- and specifically that it stays tellable apart
 * from the blue `rule` badge a RENAMED row carries, which is the one confusion this badge could
 * cause. One row carries BOTH here on purpose: a rename rule set its display text AND a category
 * rule filed it, which is exactly the row where the two badges sit side by side.
 */
describe('TransactionsPage: the category-source badge, and how it stays apart from the rename badge (Lane 3a item 3)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function renderBadges() {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };
    const groceries = categoryIdByName(t.db, 'Groceries');
    t.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, display_description, display_source, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-01', 'GRNFLD MKT #22', 'GRNFLD MKT #22', -4000, ${groceries}, 'rule', 'Greenfield Market', 'rename', ${admin}, ${nowIso()}, ${nowIso()})
    `);
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    return render(await TransactionsPage({ searchParams: Promise.resolve({}) }));
  }

  it('a rule-filed, rule-renamed row carries both badges, and neither can be mistaken for the other', async () => {
    const { container } = await renderBadges();
    const table = container.querySelector('table')!;

    // The category-source badge: quiet (badge--muted), a plain span, and worded as an act.
    const source = Array.from(table.querySelectorAll('span.badge')).find(
      (node) => (node.textContent ?? '').trim() === 'set by rule',
    );
    expect(source).toBeTruthy();
    expect(source?.className).toContain('badge--muted');
    expect(source?.tagName).toBe('SPAN');

    // The rename badge: the bare word `rule`, filled blue, and a real BUTTON that opens the
    // bank-text dialog. Three differences -- wording, tone, affordance -- not one.
    const rename = within(table).getByRole('button', { name: 'Why GRNFLD MKT #22 shows this name' });
    expect(rename.textContent).toBe('rule');
    expect(rename.className).toContain('badge--blue');
    expect(rename.tagName).toBe('BUTTON');
  });
});

/** Spec 2026-10-05 §2.2. The page tells each row the mark its merchant carries. */
describe('TransactionsPage: the recurring mark rides with the row', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('offers Unmark recurring on a row whose merchant is marked', async () => {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    t.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'RIVERSIDE GYM', 'RIVERSIDE GYM', -4500, ${admin}, ${nowIso()}, ${nowIso()})`);
    setRecurringMarks({ merchants: ['RIVERSIDE GYM'], mark: 'recurring', userId: admin, actorRole: 'admin' });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };

    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    const { container } = render(await TransactionsPage({ searchParams: Promise.resolve({}) }));
    fireEvent.click(within(container.querySelector('table') as HTMLElement).getByRole('button', { name: /^Actions for RIVERSIDE GYM/ }));
    expect(screen.getByRole('menuitem', { name: 'Unmark recurring' })).toBeTruthy();
  });
});

/**
 * v1.61.0 item 4a. A row the bank sync held as a possible duplicate shows in Needs review: the
 * chip with its count, and the card with the held copy beside the row it may duplicate.
 */
describe('TransactionsPage: possible duplicates (v1.61.0)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('shows the chip and the card, with both choices, to an admin', async () => {
    t = createSeededTestDb();
    const alex = insertTestUser(t.db, { name: 'Alex', username: 'alex', role: 'admin' });
    const accountId = insertTestAccount(t.db, { name: 'Joint chequing', type: 'chequing', ownerUserId: alex });
    const { createManualTransaction } = await import('@/lib/transactions');
    const { commitImport } = await import('@/lib/import/commit');
    const { computeRowHashes } = await import('@/lib/import/dedup');
    createManualTransaction({
      accountId,
      date: '2026-03-09',
      description: 'FUEL STOP 12',
      amountCents: -6130,
      categoryId: categoryIdByName(t.db, 'Groceries'),
      attributedUserId: alex,
      userId: alex,
      actorRole: 'admin',
    });
    const synced = commitImport({
      accountId,
      profileId: null,
      filename: 'simplefin 2026-03-10 09:15',
      importedBy: alex,
      rows: [
        {
          ...computeRowHashes(accountId, [
            { rowIndex: 0, rawDate: '2026-03-10', date: '2026-03-10', rawDescription: 'FUEL STOP 12 TORONTO', amountCents: -6130, balanceCents: null, cells: [] },
          ])[0]!,
          dedupHash: '',
          externalId: 'sf-fuel-1',
        },
      ],
      errors: [],
      origin: 'simplefin',
      at: new Date('2026-03-10T13:15:00.000Z'),
    });
    expect(synced.rowsHeld).toBe(1);
    currentUser.value = { id: alex, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };

    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    render(await TransactionsPage({ searchParams: Promise.resolve({ review: '1', queue: 'duplicates' }) }));

    expect(screen.getByRole('link', { name: 'Possible duplicates (1)' })).toBeTruthy();
    expect(screen.getByText('Needs review (1)')).toBeTruthy();
    const item = screen.getByText('FUEL STOP 12 TORONTO').closest('li') as HTMLElement;
    expect(item.textContent).toContain('from SimpleFIN');
    expect(item.textContent).toMatch(/Looks like: FUEL STOP 12 -61\.30 on Mar 9(, \d{4})?, added by hand, Alex/);
    expect(within(item).getByRole('button', { name: /^Keep both/ })).toBeTruthy();
    expect(within(item).getByRole('button', { name: /^Delete this one/ })).toBeTruthy();
  });
});

/**
 * v1.62.0 (plan items 1, 2 and 3). Needs review by merchant, the suggested transfer pairs and the
 * Undo bar, as the server page hands them to the client. Alex is the household admin, Sam a member.
 */
describe('TransactionsPage: review by merchant, transfer pairs and Undo (v1.62.0)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    vi.useRealTimers();
    t?.cleanup();
    t = null;
  });

  async function renderPage(searchParams: Record<string, string>) {
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    return render(await TransactionsPage({ searchParams: Promise.resolve(searchParams) }));
  }

  function household() {
    t = createSeededTestDb();
    const alex = insertTestUser(t.db, { name: 'Alex', username: 'alex', role: 'admin' });
    const sam = insertTestUser(t.db, { name: 'Sam', username: 'sam', role: 'member' });
    const chequing = insertTestAccount(t.db, { name: 'Joint Chequing', type: 'chequing', ownerUserId: null });
    const savings = insertTestAccount(t.db, { name: 'Joint Savings', type: 'chequing', ownerUserId: null });
    const add = (accountId: number, merchant: string, amountCents: number, date: string, person: number | null = null) =>
      t!.db.get<{ id: number }>(sql`
        insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, attributed_user_id, created_by, created_at, updated_at)
        values (${accountId}, ${date}, ${merchant}, ${merchant}, ${amountCents}, ${person}, ${alex}, '2026-03-14T09:00:00.000Z', '2026-03-14T09:00:00.000Z')
        returning id`).id;
    currentUser.value = { id: alex, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    return { alex, sam, chequing, savings, add };
  }

  it('offers List / By merchant as the View pill in review mode, and List / By category in the list', async () => {
    household();
    await renderPage({ review: '1' });
    const review = screen.getByRole('navigation', { name: 'How to show the transactions' });
    expect(within(review).getAllByRole('link').map((link) => link.textContent)).toEqual(['List', 'By merchant']);
    expect(within(review).getByRole('link', { name: 'By merchant' }).getAttribute('href')).toContain('group=merchant');
    cleanup();

    await renderPage({});
    const list = screen.getByRole('navigation', { name: 'How to show the transactions' });
    expect(within(list).getAllByRole('link').map((link) => link.textContent)).toEqual(['List', 'By category']);
  });

  it('?review=1&group=merchant renders one card per merchant, with its count and decisions', async () => {
    const s = household();
    s.add(s.chequing, 'MAPLE GROCER', -4217, '2026-03-02');
    s.add(s.chequing, 'MAPLE GROCER', -1805, '2026-03-09');
    s.add(s.chequing, 'MAPLE GROCER', -6340, '2026-03-14');
    s.add(s.chequing, 'FUEL STOP 12', -6130, '2026-03-05');

    const { container } = await renderPage({ review: '1', group: 'merchant' });
    const cards = Array.from(container.querySelectorAll('[data-merchant-group]'));
    expect(cards.map((card) => card.querySelector('h3')?.textContent)).toEqual(['MAPLE GROCER', 'FUEL STOP 12']);
    expect(cards[0]?.textContent).toContain('3 transactions');
    expect(screen.getByRole('button', { name: 'File all 3 (MAPLE GROCER)' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'By merchant' }).getAttribute('aria-current')).toBe('page');
  });

  it("a self viewer's ?review=1&group=merchant serializes no queue group", async () => {
    const s = household();
    s.add(s.chequing, 'FUEL STOP 12', -6130, '2026-03-05', s.alex);
    currentUser.value = { id: s.sam, name: 'Sam', username: 'sam', role: 'member', visibility: 'self' };

    const { container } = await renderPage({ review: '1', group: 'merchant' });
    expect(container.innerHTML).not.toContain('FUEL STOP 12');
    expect(container.querySelector('[data-merchant-group]')).toBeNull();
    expect(screen.queryByRole('button', { name: /^File all/ })).toBeNull();
  });

  it('an admin sees the suggested transfer pairs in review mode, in both views', async () => {
    const s = household();
    s.add(s.chequing, 'TFR TO SAVINGS', -50000, '2026-03-09');
    s.add(s.savings, 'TFR FROM CHEQUING', 50000, '2026-03-10');

    await renderPage({ review: '1' });
    expect(screen.getByText('Possible transfers (1)')).toBeTruthy();
    cleanup();

    await renderPage({ review: '1', group: 'merchant' });
    expect(screen.getByText('Possible transfers (1)')).toBeTruthy();
  });

  it("a self viewer's ?review=1 serializes no pair", async () => {
    const s = household();
    s.add(s.chequing, 'TFR TO SAVINGS', -50000, '2026-03-09', s.sam);
    s.add(s.savings, 'TFR FROM CHEQUING', 50000, '2026-03-10', s.sam);
    currentUser.value = { id: s.sam, name: 'Sam', username: 'sam', role: 'member', visibility: 'self' };

    const { container } = await renderPage({ review: '1' });
    expect(container.textContent).not.toContain('Possible transfers');
    expect(screen.queryByRole('button', { name: /^Mark both as a transfer/ })).toBeNull();
  });

  it("shows the viewer's own last bulk change with the time it can be undone until, and nobody else's", async () => {
    const s = household();
    const acted = new Date('2026-03-14T15:00:00.000Z');
    const mine = s.add(s.chequing, 'MAPLE GROCER', -4217, '2026-03-02');
    const theirs = s.add(s.chequing, 'FUEL STOP 12', -6130, '2026-03-05', s.sam);
    const record = (userId: number, label: string, id: number, person: number | null) => {
      const before = captureBulkBefore({ ids: [id] });
      bulkSetAttribution([id], person);
      recordBulkUndo({ userId, kind: 'person', label, before, at: acted });
    };
    record(s.alex, 'Attribution updated for 1 transactions.', mine, s.sam);
    record(s.sam, 'Set Household on 1 transaction.', theirs, null);
    const now = new Date('2026-03-14T15:04:00.000Z');
    vi.useFakeTimers({ now, toFake: ['Date'] });

    const { container } = await renderPage({});
    const bar = container.querySelector('[data-undo-bar]') as HTMLElement;
    expect(bar.textContent).toContain('Attribution updated for 1 transactions.');
    expect(bar.textContent).toContain(`Until ${localTimeLabel('2026-03-14T15:15:00.000Z', now, readEnv().tz)}.`);
    expect(within(bar).getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(container.textContent).not.toContain('Set Household on 1 transaction.');
  });

  it('shows no Undo once the change is over 15 minutes old', async () => {
    const s = household();
    const id = s.add(s.chequing, 'MAPLE GROCER', -4217, '2026-03-02');
    const before = captureBulkBefore({ ids: [id] });
    bulkSetAttribution([id], s.sam);
    recordBulkUndo({ userId: s.alex, kind: 'person', label: 'Attribution updated for 1 transactions.', before, at: new Date('2026-03-14T15:00:00.000Z') });
    vi.useFakeTimers({ now: new Date('2026-03-14T15:15:01.000Z'), toFake: ['Date'] });

    const { container } = await renderPage({});
    expect(container.querySelector('[data-undo-bar]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});

// v1.63.0 (plan 2026-11-12, D3): what the page hands the client when a split part belongs to a person.
import { buildSplitPersonFixture, type SplitPersonFixture } from '../helpers/split-person-fixture';

describe('TransactionsPage: a split part belongs to a person (v1.63.0)', () => {
  let f: SplitPersonFixture | null = null;
  afterEach(() => {
    f?.t.cleanup();
    f = null;
  });

  async function pageProps(searchParams: Record<string, string> = {}) {
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    const element = (await TransactionsPage({ searchParams: Promise.resolve(searchParams) })) as { props: Record<string, any> };
    return element.props;
  }

  it('hands a self viewer his share only: MAPLE GROCER at -40.00 with one part, and no -150.00 anywhere', async () => {
    f = buildSplitPersonFixture();
    currentUser.value = { id: f.sam, name: 'Sam', username: 'sam', role: 'member', visibility: 'self' };
    const props = await pageProps();
    const maple = props.page.rows.find((row: { id: number }) => row.id === f!.maple);
    expect(maple).toMatchObject({ amountCents: -4000, partial: true, parentAmountCents: null });
    expect(props.splits[f.maple]).toHaveLength(1);
    expect(props.splits[f.maple][0]).toMatchObject({ amountCents: -4000, attributedUserId: f.sam });
    const serialized = JSON.stringify(props);
    expect(serialized).not.toContain('-15000');
    expect(serialized).not.toContain('-8000');
  });

  it('hands a household viewer all three parts with their people', async () => {
    f = buildSplitPersonFixture();
    currentUser.value = { id: f.alex, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const props = await pageProps();
    expect(props.splits[f.maple].map((p: { personSet: boolean; attributedUserId: number | null }) => [p.personSet, p.attributedUserId])).toEqual([
      [false, null],
      [true, f.sam],
      [true, null],
    ]);
  });

  it('a person filter reads the share, with the whole charge and the person it belongs to', async () => {
    f = buildSplitPersonFixture();
    currentUser.value = { id: f.alex, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const props = await pageProps({ person: String(f.sam) });
    const maple = props.page.rows.find((row: { id: number }) => row.id === f!.maple);
    expect(maple).toMatchObject({ amountCents: -4000, parentAmountCents: -15000, partial: true });
    expect(props.scopePersonName).toBe('Sam');
  });
});

describe('TransactionsPage: loan links on a row reached through a part (v1.63.0 fix round)', () => {
  let f: SplitPersonFixture | null = null;
  afterEach(() => {
    f?.t.cleanup();
    f = null;
  });

  async function pageProps() {
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    const element = (await TransactionsPage({ searchParams: Promise.resolve({}) })) as { props: Record<string, any> };
    return element.props;
  }

  it("hands a self viewer no loan link, name or amount on a charge that is someone else's", async () => {
    f = buildSplitPersonFixture();
    const { createLoanFromTransaction } = await import('@/lib/loans');
    // A name of the row's own, so the loan does not relabel it: this test is about the links.
    f.t.sqlite.prepare("update transactions set display_description = 'Maple Grocer', display_source = 'manual' where id = ?").run(f.maple);
    createLoanFromTransaction({ txnId: f.maple, name: 'Boat loan', direction: 'owed' }, f.admin);

    currentUser.value = { id: f.sam, name: 'Sam', username: 'sam', role: 'member', visibility: 'self' };
    const sam = await pageProps();
    expect(sam.page.rows.map((row: { id: number }) => row.id)).toContain(f.maple);
    expect(sam.loanLinks[f.maple]).toBeUndefined();
    const serialized = JSON.stringify(sam);
    expect(serialized).not.toContain('Boat loan');
    expect(serialized).not.toContain('15000');

    // The transaction's own person still sees the link.
    currentUser.value = { id: f.alex, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const alex = await pageProps();
    expect(alex.loanLinks[f.maple]).toMatchObject([{ itemName: 'Boat loan', amountCents: 15000 }]);
  });
});

/**
 * v1.64.0 (plan lane C2). The local AI's suggestions reach Review only for the merchants of rows
 * waiting there, only while the helper is on, and never for a self viewer.
 */
describe('TransactionsPage: AI suggestions in Review (v1.64.0)', () => {
  let fx: AiFixture | null = null;
  afterEach(() => {
    fx?.t.cleanup();
    fx = null;
  });
  const AT = new Date('2026-03-10T09:00:00.000Z');

  function setup(on = true): AiFixture {
    fx = buildAiFixture();
    currentUser.value = { id: fx.alex, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    recordMerchantSuggestion({ merchant: 'MAPLE GROCER', categoryId: fx.groceries, cleanName: 'Maple Grocer', model: 'test-model:1b', at: AT });
    recordMerchantSuggestion({ merchant: 'FUEL STOP 12', categoryId: fx.groceries, cleanName: 'Fuel Stop', model: 'test-model:1b', at: AT });
    if (on) saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434/v1', model: 'test-model:1b', userId: fx.alex, at: AT });
    return fx;
  }

  async function renderPage(searchParams: Record<string, string>) {
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    return render(await TransactionsPage({ searchParams: Promise.resolve(searchParams) }));
  }

  it("carries MAPLE GROCER's suggestion on an admin's review page, and never looks up a guessed row's merchant", async () => {
    setup();
    await renderPage({ review: '1' });
    expect(screen.getAllByText('AI suggests:').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^Use .*Groceries for MAPLE GROCER$/ }).length).toBeGreaterThan(0);
    // FUEL STOP 12 is a Bayes guess, so its stored suggestion is not read.
    expect(screen.queryByRole('button', { name: /^Use .* for FUEL STOP 12$|Ignore the AI suggestion for FUEL STOP 12/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Use the name Fuel Stop/ })).toBeNull();
  });

  it('carries none with AI off, with the suggestion ignored, or outside review', async () => {
    setup();
    turnOffLocalAi({ userId: fx!.alex, at: AT });
    await renderPage({ review: '1' });
    expect(screen.queryByText('AI suggests:')).toBeNull();
    cleanup();

    saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434/v1', model: 'test-model:1b', userId: fx!.alex, at: AT });
    await renderPage({});
    expect(screen.queryByText('AI suggests:')).toBeNull();
    cleanup();

    ignoreAiSuggestion({ merchant: 'MAPLE GROCER', userId: fx!.alex, at: AT });
    await renderPage({ review: '1' });
    expect(screen.queryByText('AI suggests:')).toBeNull();
  });

  it('carries none while switched on with a saved address that no longer passes, as the Settings card reads it', async () => {
    setup(false);
    // fd::1 is 00fd::1, a public address an earlier check let through.
    setSetting('local_ai_enabled', '1');
    setSetting('local_ai_base_url', 'http://[fd::1]:11434');
    setSetting('local_ai_model', 'test-model:1b');
    const { container } = await renderPage({ review: '1' });
    expect(screen.queryByText('AI suggests:')).toBeNull();
    expect(container.textContent).not.toContain('Maple Grocer');
  });

  it('serializes none to a self viewer asking for ?review=1', async () => {
    const f = setup();
    currentUser.value = { id: f.sam, name: 'Sam', username: 'sam', role: 'member', visibility: 'self' };
    const { container } = await renderPage({ review: '1' });
    expect(container.textContent).not.toContain('AI suggests');
    expect(container.innerHTML).not.toContain('Maple Grocer');
  });

  it('seeds the merchant groups view from the suggestion', async () => {
    setup();
    const { container } = await renderPage({ review: '1', group: 'merchant' });
    expect((screen.getByRole('combobox', { name: /^Category for .*MAPLE GROCER/ }) as HTMLInputElement).value).toMatch(/Groceries$/);
    expect(container.textContent).toContain('Use the name Maple Grocer for all');
  });
});

/**
 * v1.64.0 (plan E4). Ask in words is on the page only while local AI is active (on, set up and not
 * waiting after failures) and only outside review mode. A self viewer gets it too: what they may
 * ask about is narrowed in src/lib/ai/ask.ts, and readFilter forces their own person scope.
 */
describe('TransactionsPage: Ask in words (v1.64.0)', () => {
  let fx: AiFixture | null = null;
  const AT = new Date('2026-03-10T09:00:00.000Z');
  afterEach(() => {
    vi.useRealTimers();
    fx?.t.cleanup();
    fx = null;
  });

  function setup(on = true): AiFixture {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT);
    fx = buildAiFixture();
    currentUser.value = { id: fx.alex, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    if (on) saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId: fx.alex, at: AT });
    return fx;
  }

  async function renderPage(searchParams: Record<string, string>) {
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    return render(await TransactionsPage({ searchParams: Promise.resolve(searchParams) }));
  }

  const box = () => screen.queryByRole('textbox', { name: 'Ask in words' });

  it('is on the plain list while local AI is active, outside the filter form', async () => {
    setup();
    const { container } = await renderPage({});
    const field = box() as HTMLInputElement;
    expect(field).toBeTruthy();
    expect(field.maxLength).toBe(200);
    expect((container.querySelector('form[method="get"]') as HTMLFormElement).contains(field)).toBe(false);
    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy();
  });

  it('is absent in review mode', async () => {
    setup();
    await renderPage({ review: '1' });
    expect(box()).toBeNull();
  });

  it('is absent with local AI off or never set up', async () => {
    const f = setup(false);
    await renderPage({});
    expect(box()).toBeNull();
    cleanup();
    saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId: f.alex, at: AT });
    turnOffLocalAi({ userId: f.alex, at: AT });
    await renderPage({});
    expect(box()).toBeNull();
  });

  it('is absent while waiting after a server failure', async () => {
    setup();
    recordLocalAiFailure(AT, 'Could not reach the model server at 192.168.1.50:11434.');
    await renderPage({});
    expect(box()).toBeNull();
  });

  it('is there for a self viewer on their own list', async () => {
    const f = setup();
    currentUser.value = { id: f.sam, name: 'Sam', username: 'sam', role: 'member', visibility: 'self' };
    await renderPage({});
    expect(box()).toBeTruthy();
  });
});
