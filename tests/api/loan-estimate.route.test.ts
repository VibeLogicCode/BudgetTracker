import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { GET } from '@/app/api/loans/[id]/estimate/route';
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

function request(itemId: number, token: string | null, asOf = '2026-09-18', origin: string | null = 'http://nas.local:3000') {
  const headers: Record<string, string> = { host: 'nas.local:3000' };
  if (origin !== null) headers.origin = origin;
  if (token !== null) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  return new Request(`http://nas.local:3000/api/loans/${itemId}/estimate?asOf=${asOf}`, { headers });
}

const params = (itemId: number) => ({ params: Promise.resolve({ id: String(itemId) }) });


/**
 * Review F3. The reconcile form compared what a person typed off a statement against the app's
 * estimate for TODAY, under a sentence naming the STATEMENT's date. A statement is routinely weeks
 * old, so the two figures were never for the same day -- and on a mortgage the gap is real money.
 *
 * The engine takes `today` as a parameter, so this route is that parameter and nothing else.
 */
describe('GET /api/loans/[id]/estimate', () => {
  it('answers with owing-today for the date asked for', async () => {
    const { token, itemId } = setup();
    const response = await GET(request(itemId, token, '2026-09-18'), params(itemId));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { asOf: string; owingCents: number | null };
    expect(body.asOf).toBe('2026-09-18');
    expect(body.owingCents).toBeGreaterThan(1_000_000);
  });

  /** An earlier date owes less: the interest between the two has not been charged yet. */
  it('gives a smaller figure for an earlier date', async () => {
    const { token, itemId } = setup();
    const later = (await (await GET(request(itemId, token, '2026-09-18'), params(itemId))).json()) as { owingCents: number };
    const earlier = (await (await GET(request(itemId, token, '2026-08-05'), params(itemId))).json()) as { owingCents: number };
    expect(earlier.owingCents).toBeLessThan(later.owingCents);
  });

  it('refuses a date in the future, and a date that is not one', async () => {
    const { token, itemId } = setup();
    expect((await GET(request(itemId, token, '2099-01-01'), params(itemId))).status).toBe(400);
    expect((await GET(request(itemId, token, 'last tuesday'), params(itemId))).status).toBe(400);
  });

  it('carries the same gate as the ledger download', async () => {
    const { token, itemId } = setup();
    expect((await GET(request(itemId, null), params(itemId))).status).toBe(401);
    expect((await GET(request(itemId, token, '2026-09-18', 'http://evil.example'), params(itemId))).status).toBe(403);
  });

  it('is a 404 for an item the viewer cannot see', async () => {
    const { token, itemId } = setup();
    expect((await GET(request(itemId + 999, token), params(itemId + 999))).status).toBe(404);
  });
});
