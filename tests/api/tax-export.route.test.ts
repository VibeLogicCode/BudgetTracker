import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { GET } from '@/app/api/reports/tax-export/route';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { setCategoryTaxRelevant } from '@/lib/categories';
import { setUserVisibility } from '@/lib/auth/users';
import { nowIso } from '@/lib/clock';

/**
 * Task 15b (spec 2026-08-22, v1.7.0): the tax-year CSV download route. Modelled directly on
 * tests/api/export.route.test.ts for /api/reports/export -- same origin/session guard, same
 * header-less-request ruling -- because the task requires this route to match that one's guard
 * exactly rather than invent a weaker (or stricter) one.
 */

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const account = insertTestAccount(current.db, { name: 'Joint Chequing' });
  const groceries = categoryIdByName(current.db, 'Groceries');
  setCategoryTaxRelevant(groceries, true);
  current.db.run(sql`
    insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
    values (${account}, '2026-03-05', 'GENERIC MERCHANT', 'GENERIC MERCHANT', -4000, ${groceries}, 'manual', 0, ${alice}, ${alice}, ${nowIso()}, ${nowIso()})`);
  return { token: createSession(alice).token };
}

/** Same-origin by default; the CSV route refuses anything else, exactly like its sibling. */
function taxExportRequest(url: string, token: string | null, origin: string | null = 'http://nas.local:3000') {
  const headers: Record<string, string> = { host: 'nas.local:3000' };
  if (origin) headers.origin = origin;
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  return new Request(url, { headers });
}

describe('GET /api/reports/tax-export', () => {
  it('streams a CSV attachment for an authenticated user, filename carrying the year', async () => {
    const { token } = setup();
    const response = await GET(taxExportRequest('http://nas.local:3000/api/reports/tax-export?year=2026', token));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('attachment; filename="budget-tax-year-2026.csv"');
    const body = await response.text();
    expect(body.split('\r\n')[0]).toBe('Category,Person,Amount');
    expect(body).toContain('Groceries,Alice,40.00');
  });

  it('a different year is reflected in both the filename and the rows', async () => {
    const { token } = setup();
    const response = await GET(taxExportRequest('http://nas.local:3000/api/reports/tax-export?year=2020', token));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('budget-tax-year-2020.csv');
    const body = await response.text();
    // The seeded transaction is dated 2026-03-05, so a 2020 export has header only.
    expect(body.trim().split('\r\n')).toHaveLength(1);
  });

  it('401s without a session', async () => {
    setup();
    const response = await GET(taxExportRequest('http://nas.local:3000/api/reports/tax-export?year=2026', null));
    expect(response.status).toBe(401);
  });

  it('403s a cross-origin request even with a valid session cookie (m1)', async () => {
    const { token } = setup();
    const response = await GET(
      taxExportRequest('http://nas.local:3000/api/reports/tax-export?year=2026', token, 'http://evil.example'),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('Groceries');
  });

  it('403s before the session is even considered when the origin is wrong', async () => {
    setup();
    const response = await GET(
      taxExportRequest('http://nas.local:3000/api/reports/tax-export?year=2026', null, 'http://evil.example'),
    );
    expect(response.status).toBe(403);
  });

  it('serves a header-less request -- the plain-HTTP LAN default deployment', async () => {
    const { token } = setup();
    const response = await GET(taxExportRequest('http://nas.local:3000/api/reports/tax-export?year=2026', token, null));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Groceries');
  });

  it('still 401s a header-less request with no session', async () => {
    setup();
    expect(
      (await GET(taxExportRequest('http://nas.local:3000/api/reports/tax-export?year=2026', null, null))).status,
    ).toBe(401);
  });

  it('403s a header-less request that declares a cross-site fetch', async () => {
    const { token } = setup();
    const response = await GET(
      new Request('http://nas.local:3000/api/reports/tax-export?year=2026', {
        headers: { host: 'nas.local:3000', 'sec-fetch-site': 'cross-site', cookie: `${SESSION_COOKIE_NAME}=${token}` },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('rejects a missing year without a 500', async () => {
    const { token } = setup();
    const response = await GET(taxExportRequest('http://nas.local:3000/api/reports/tax-export', token));
    expect(response.status).toBe(400);
  });

  it('rejects a non-numeric year without a 500', async () => {
    const { token } = setup();
    const response = await GET(taxExportRequest('http://nas.local:3000/api/reports/tax-export?year=abcd', token));
    expect(response.status).toBe(400);
  });

  it('rejects a fractional year without a 500', async () => {
    const { token } = setup();
    const response = await GET(taxExportRequest('http://nas.local:3000/api/reports/tax-export?year=2026.5', token));
    expect(response.status).toBe(400);
  });

  it('rejects a negative year without a 500', async () => {
    const { token } = setup();
    const response = await GET(taxExportRequest('http://nas.local:3000/api/reports/tax-export?year=-2026', token));
    expect(response.status).toBe(400);
  });

  it('rejects an out-of-range four-digit year without a 500', async () => {
    const { token } = setup();
    const response = await GET(taxExportRequest('http://nas.local:3000/api/reports/tax-export?year=9999', token));
    expect(response.status).toBe(400);
  });

  it('the origin/session guard is checked before the year, so a bad year never leaks which guard would have failed', async () => {
    setup();
    const response = await GET(taxExportRequest('http://nas.local:3000/api/reports/tax-export?year=abcd', null));
    expect(response.status).toBe(401);
  });

  it('v1.13.0 ruling R2: refuses a self-scoped viewer -- taxYearReport has no owner scoping of its own', async () => {
    setup();
    const kid = insertTestUser(current!.db, { name: 'Kid', username: 'kid', role: 'member' });
    setUserVisibility(kid, 'self');
    const { token } = createSession(kid);
    const response = await GET(taxExportRequest('http://nas.local:3000/api/reports/tax-export?year=2026', token));
    expect(response.status).toBe(403);
  });
});
