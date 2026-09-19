import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { GET } from '@/app/api/loans/[id]/ledger.csv/route';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { listItemTypes } from '@/lib/warranty/types';
import { createWarrantyItem } from '@/lib/warranty/items';
import { setUserVisibility } from '@/lib/auth/users';

/**
 * The ledger download (ledger spec U7). Same origin and session guard as every other CSV route in
 * the app -- a loan's ledger is the most private table it has, so it gets no weaker a gate.
 */
let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup(): { token: string; itemId: number; userId: number } {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'admin' });
  const typeId = listItemTypes().find((type) => type.kind === 'loan')!.id;
  const itemId = createWarrantyItem(
    {
      name: 'Car loan',
      vendor: null,
      model: null,
      serial: null,
      purchaseDate: '2026-07-01',
      warrantyMonths: null,
      isLifetime: false,
      priceCents: null,
      ownerUserId: userId,
      transactionId: null,
      typeId,
      notes: null,
      principalCents: 1_000_000,
      interestRateBps: 1000,
      interestRateBasis: 'apr_monthly',
      currentBalanceCents: 1_000_000,
    } as Parameters<typeof createWarrantyItem>[0],
    [],
    '2026-09-18T12:00:00.000Z',
  );
  return { token: createSession(userId).token, itemId, userId };
}

function request(itemId: number, token: string | null, origin: string | null = 'http://nas.local:3000') {
  const headers: Record<string, string> = { host: 'nas.local:3000' };
  if (origin !== null) headers.origin = origin;
  if (token !== null) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  return new Request(`http://nas.local:3000/api/loans/${itemId}/ledger.csv`, { headers });
}

const params = (itemId: number) => ({ params: Promise.resolve({ id: String(itemId) }) });

describe('GET /api/loans/[id]/ledger.csv', () => {
  it('returns the ledger as a CSV attachment', async () => {
    const { token, itemId } = setup();
    const response = await GET(request(itemId, token), params(itemId));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/csv/);
    expect(response.headers.get('content-disposition')).toContain(`loan-${itemId}-ledger.csv`);
  });

  /*
    No byte-order mark: every other CSV this app writes goes without one, and one export behaving
    differently from the rest is a worse trade than a spreadsheet nicety is worth.
  */
  it('leads with its column headings', async () => {
    const { token, itemId } = setup();
    const text = await (await GET(request(itemId, token), params(itemId))).text();
    expect(text.startsWith('Date,Description,Payment,Interest,Principal,Balance')).toBe(true);
  });

  it('carries the postings, in dollars', async () => {
    const { token, itemId } = setup();
    const text = await (await GET(request(itemId, token), params(itemId))).text();
    expect(text).toContain('2026-08-01');
    expect(text).toContain('83.33');
    expect(text).toContain('10083.33');
  });

  it('refuses a request with no session', async () => {
    const { itemId } = setup();
    expect((await GET(request(itemId, null), params(itemId))).status).toBe(401);
  });

  it('refuses a cross-origin request', async () => {
    const { token, itemId } = setup();
    expect((await GET(request(itemId, token, 'http://evil.example'), params(itemId))).status).toBe(403);
  });

  /** A loan somebody else owns is not readable by a self-scoped member. */
  it('refuses a loan the viewer cannot see', async () => {
    const { itemId } = setup();
    const other = insertTestUser(current!.db, { name: 'Bob', username: 'bob', role: 'member' });
    setUserVisibility(other, 'self');
    const token = createSession(other).token;
    expect((await GET(request(itemId, token), params(itemId))).status).toBe(404);
  });

  it('is a 404 for an item that has no ledger', async () => {
    const { token } = setup();
    expect((await GET(request(9999, token), params(9999))).status).toBe(404);
  });
});

/**
 * Review F7. The card explains a charge by opening a row; a spreadsheet has no rows to open, so
 * what had accrued by the day a payment landed -- the figure that explains why a $500 payment took
 * $437 off the balance -- gets a column of its own.
 */
describe('F7: the accrued-to-date column', () => {
  it('carries seven columns, the last one named', async () => {
    const { token, itemId } = setup();
    const response = await GET(request(itemId, token), params(itemId));
    const header = (await response.text()).split('\n')[0]!.trim();
    expect(header.split(',')).toHaveLength(7);
    expect(header).toContain('Interest accrued to date');
  });
});
