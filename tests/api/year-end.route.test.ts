import { describe, it, expect, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { GET as yearEndGet } from '@/app/api/reports/year-end/route';
import { GET as taxDetailGet } from '@/app/api/reports/tax-detail/route';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { setUserVisibility } from '@/lib/auth/users';
import { planYearEndPack } from '@/lib/year-end';
import { buildYearEndFixture, type YearEndFixture } from '../helpers/year-end-fixture';
import { readZip } from '../helpers/zip-read';

/**
 * v1.63.0 (plan 2026-11-12, B5). The two year-end downloads: /api/reports/year-end (the zip) and
 * /api/reports/tax-detail (the detail CSV). Guards in the tax-export route's order, then a read
 * scoped to the viewer.
 *
 * The pack's receipt cap is injected through the module: the mock below passes every call through
 * to the real planYearEndPack, with `maxReceiptBytes` replaced while a test sets `cap.value`.
 */
const cap = vi.hoisted(() => ({ value: null as number | null }));
vi.mock('@/lib/year-end', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/year-end')>();
  return {
    ...actual,
    planYearEndPack: (...args: Parameters<typeof actual.planYearEndPack>) =>
      actual.planYearEndPack(args[0], args[1], cap.value === null ? args[2] : { ...args[2], maxReceiptBytes: cap.value }),
  };
});

let fx: YearEndFixture | null = null;
afterEach(() => {
  cap.value = null;
  fx?.cleanup();
  fx = null;
});

function get(route: 'year-end' | 'tax-detail', query: string, token: string | null, origin: string | null = 'http://nas.local:3000') {
  const headers: Record<string, string> = { host: 'nas.local:3000' };
  if (origin) headers.origin = origin;
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  const request = new Request(`http://nas.local:3000/api/reports/${route}${query}`, { headers });
  return route === 'year-end' ? yearEndGet(request) : taxDetailGet(request);
}

function tokenFor(userId: number): string {
  return createSession(userId).token;
}

describe.each(['year-end', 'tax-detail'] as const)('GET /api/reports/%s guards', (route) => {
  it('403s a cross-origin request before anything else', async () => {
    fx = buildYearEndFixture();
    const response = await get(route, '?year=2026', tokenFor(fx.admin), 'http://evil.example');
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('CLINIC');
  });

  it('401s without a session', async () => {
    fx = buildYearEndFixture();
    expect((await get(route, '?year=2026', null)).status).toBe(401);
  });

  it('400s a bad or missing year, after the session check', async () => {
    fx = buildYearEndFixture();
    const token = tokenFor(fx.admin);
    for (const query of ['', '?year=abcd', '?year=2026.5', '?year=-2026', '?year=9999']) {
      expect((await get(route, query, token)).status, query).toBe(400);
    }
    expect((await get(route, '?year=abcd', null)).status).toBe(401);
  });

  it('serves a header-less request, the plain-HTTP LAN default', async () => {
    fx = buildYearEndFixture();
    expect((await get(route, '?year=2026', tokenFor(fx.admin), null)).status).toBe(200);
  });
});

describe('GET /api/reports/year-end', () => {
  it('streams the planned zip, with an exact content-length', async () => {
    fx = buildYearEndFixture();
    const response = await get('year-end', '?year=2026', tokenFor(fx.admin));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="budget-year-end-2026.zip"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.length).toBe(Number(response.headers.get('content-length')));

    const plan = planYearEndPack(2026, fx.viewers.admin, { today: '2026-01-01' });
    const entries = readZip(body);
    expect(entries.map((entry) => entry.name)).toEqual(plan.entries.map((entry) => entry.name));
    for (const [index, entry] of entries.entries()) {
      const planned = plan.entries[index];
      if (Buffer.isBuffer(planned.source)) {
        // The README carries the day it was made; every other text entry is byte for byte the plan's.
        if (planned.name !== 'README.txt') expect(entry.data.equals(planned.source), planned.name).toBe(true);
      } else {
        expect(entry.data.length).toBe(planned.size);
      }
    }
    expect(entries.find((entry) => entry.name.endsWith(`_r${fx!.receipts.r2.id}.jpg`))?.data.equals(fx.receipts.r2.bytes)).toBe(true);
  });

  it("a self viewer's zip holds only his own rows and receipts", async () => {
    fx = buildYearEndFixture();
    setUserVisibility(fx.alex, 'self');
    const response = await get('year-end', '?year=2026', tokenFor(fx.alex));
    expect(response.status).toBe(200);
    const entries = readZip(Buffer.from(await response.arrayBuffer()));
    expect(entries.map((entry) => entry.name)).toEqual([
      'README.txt',
      'tax-detail-2026.csv',
      'tax-totals-2026.csv',
      `receipts/2026-02-03_PHARMACY-PLUS_r${fx.receipts.r1.id}.pdf`,
    ]);
    for (const entry of entries) {
      const body = entry.data.toString('utf8');
      for (const forbidden of ['Sam', 'CITY CLINIC', 'clinic visit', 'Dining']) expect(body, entry.name).not.toContain(forbidden);
    }
    expect(entries[0].data.toString('utf8')).toContain('Rows for Alex only.');
  });

  it('answers 413 with the written reason, and no zip, when the receipts pass the cap', async () => {
    fx = buildYearEndFixture();
    cap.value = 1;
    const response = await get('year-end', '?year=2026', tokenFor(fx.admin));
    expect(response.status).toBe(413);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const bytes = fx.receipts.r1.bytes.length + fx.receipts.r2.bytes.length;
    expect(await response.text()).toBe(
      `This year's receipts come to ${bytes} bytes, more than the 1 byte one pack can carry. Download the detail CSV, and the receipts from each item.`,
    );
  });

  it('a year with no rows is still a valid zip, holding no receipts', async () => {
    fx = buildYearEndFixture();
    const response = await get('year-end', '?year=2020', tokenFor(fx.admin));
    expect(response.status).toBe(200);
    expect(readZip(Buffer.from(await response.arrayBuffer())).map((entry) => entry.name)).toEqual([
      'README.txt',
      'tax-detail-2020.csv',
      'tax-totals-2020.csv',
    ]);
  });
});

describe('GET /api/reports/tax-detail', () => {
  it('serves the detail CSV as an attachment named for the year', async () => {
    fx = buildYearEndFixture();
    const response = await get('tax-detail', '?year=2026', tokenFor(fx.admin));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="budget-tax-detail-2026.csv"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const lines = (await response.text()).trim().split('\r\n');
    expect(lines[0]).toBe('Date,Account,Description,Category,Tax category,Person,Amount,Notes,Receipt files,Receipts not included');
    expect(lines).toHaveLength(5);
  });

  it("a self viewer's CSV holds his rows only", async () => {
    fx = buildYearEndFixture();
    setUserVisibility(fx.sam, 'self');
    const body = await (await get('tax-detail', '?year=2026', tokenFor(fx.sam))).text();
    const lines = body.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`2026-04-14,Joint chequing,CITY CLINIC,Medical,Medical,Sam,-120.00,,receipts/2026-04-14_CITY-CLINIC_r${fx.receipts.r2.id}.jpg,`);
    expect(body).not.toContain('Alex');
  });

  it('a household member sees who holds a receipt he cannot open', async () => {
    fx = buildYearEndFixture();
    const body = await (await get('tax-detail', '?year=2026', tokenFor(fx.alex))).text();
    expect(body).toContain('CITY CLINIC,Medical,Medical,Sam,-120.00,,,1 held by Sam');
    // The 2025 visit stays out of 2026 until it is dated inside it: the year runs to Dec 31.
    expect(body).not.toContain('2025-11-20');
    fx.t.db.run(sql`update transactions set date = '2026-12-31' where id = ${fx.txn.lastYear}`);
    expect(await (await get('tax-detail', '?year=2026', tokenFor(fx.alex))).text()).toContain('2026-12-31');
  });
});
