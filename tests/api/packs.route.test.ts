import { describe, it, expect, afterEach, vi } from 'vitest';
import { createSeededTestDb, categoryIdByName, insertTestUser, type TestDb } from '../helpers/db';
import { GET as rulesExport } from '@/app/api/packs/rules/export/route';
import { POST as rulesImport } from '@/app/api/packs/rules/import/route';
import { GET as profilesExport } from '@/app/api/packs/profiles/export/route';
import { POST as profilesImport } from '@/app/api/packs/profiles/import/route';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { upsertRuleFromCorrection, listRules } from '@/lib/categorize/rules';
import { BUILTIN_PRESET_NAMES, listProfiles } from '@/lib/import/presets';
import { MAX_FILE_BYTES } from '@/lib/import/parse';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const admin = insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'admin' });
  const member = insertTestUser(current.db, { name: 'Bob', username: 'bob', role: 'member' });
  upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: categoryIdByName(current.db, 'Coffee'), createdBy: admin, actorRole: 'admin' });
  upsertRuleFromCorrection({ pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: admin, actorRole: 'admin' });
  return { adminToken: createSession(admin).token, memberToken: createSession(member).token };
}

const headers = (token: string | null, origin = 'http://nas.local:3000') => ({
  origin,
  host: 'nas.local:3000',
  ...(token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}),
});

/**
 * What a plain-HTTP LAN install actually sends on a download link: no Origin
 * (same-origin navigation) and no Sec-Fetch-* (browsers omit fetch metadata on
 * non-trustworthy origins). Controller ruling: allowed on read-only download
 * GETs; a present-but-mismatched header is still refused.
 */
const headerlessHeaders = (token: string | null) => ({
  host: 'nas.local:3000',
  ...(token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}),
});

function uploadRequest(url: string, body: string, token: string | null, fields: Record<string, string> = {}, origin = 'http://nas.local:3000') {
  const form = new FormData();
  form.append('file', new File([body], 'pack.json', { type: 'application/json' }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request(url, { method: 'POST', headers: headers(token, origin), body: form });
}

describe('GET /api/packs/rules/export', () => {
  it('returns a JSON attachment for an admin, transfer rules excluded by default', async () => {
    const { adminToken } = setup();
    const response = await rulesExport(new Request('http://nas.local:3000/api/packs/rules/export', { headers: headers(adminToken) }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-disposition')).toMatch(/attachment; filename="budget-tracker-rules-\d{4}-\d{2}-\d{2}\.json"/);
    const pack = JSON.parse(await response.text()) as { rules: { pattern: string }[] };
    expect(pack.rules.map((r) => r.pattern)).toEqual(['TIM HORTONS']);
  });

  it('includes transfer rules when asked, and honours per-rule exclusion', async () => {
    const { adminToken } = setup();
    const withTransfers = await rulesExport(
      new Request('http://nas.local:3000/api/packs/rules/export?includeTransfers=1', { headers: headers(adminToken) }),
    );
    expect(JSON.parse(await withTransfers.text()).rules).toHaveLength(2);

    const timId = listRules('category')[0].id;
    const excluded = await rulesExport(
      new Request(`http://nas.local:3000/api/packs/rules/export?exclude=${timId}`, { headers: headers(adminToken) }),
    );
    expect(JSON.parse(await excluded.text()).rules).toHaveLength(0);
  });

  it('403s a member and 401s an anonymous caller', async () => {
    const { memberToken } = setup();
    expect((await rulesExport(new Request('http://nas.local:3000/api/packs/rules/export', { headers: headers(memberToken) }))).status).toBe(403);
    expect((await rulesExport(new Request('http://nas.local:3000/api/packs/rules/export', { headers: headers(null) }))).status).toBe(401);
  });

  // Controller ruling (b): the origin is checked on every pack route, including
  // this GET — matching the /api/backup/download precedent, since a plain
  // assertSameOrigin() is a no-op on safe methods.
  it('403s a cross-origin GET even from an authenticated admin', async () => {
    const { adminToken } = setup();
    const response = await rulesExport(
      new Request('http://nas.local:3000/api/packs/rules/export', { headers: headers(adminToken, 'http://evil.local') }),
    );
    expect(response.status).toBe(403);
  });

  it('serves a header-less GET (plain-HTTP LAN navigation) with a valid session', async () => {
    const { adminToken } = setup();
    const response = await rulesExport(
      new Request('http://nas.local:3000/api/packs/rules/export', { headers: headerlessHeaders(adminToken) }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment;');
  });

  it('still requires a session on a header-less GET', async () => {
    setup();
    const response = await rulesExport(new Request('http://nas.local:3000/api/packs/rules/export', { headers: headerlessHeaders(null) }));
    expect(response.status).toBe(401);
  });
});

describe('POST /api/packs/rules/import', () => {
  const pack = JSON.stringify({
    format: 'budget-tracker-rules',
    version: 1,
    exported_at: '2026-08-15T12:00:00.000Z',
    categories: [{ name: 'Pets', parent: null, is_income: false, icon: null, color: null }],
    rules: [{ pattern: 'PET SUPPLIES', match_type: 'contains', category: 'Pets' }],
  });

  it('previews without writing, then applies', async () => {
    const { adminToken } = setup();
    const preview = await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', pack, adminToken));
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ applied: false, newRules: 1, newCategories: ['Pets'] });
    expect(listRules('category').some((r) => r.pattern === 'PET SUPPLIES')).toBe(false);

    const applied = await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', pack, adminToken, { mode: 'apply' }));
    expect(await applied.json()).toMatchObject({ applied: true, rulesAdded: 1, categoriesCreated: 1 });
    expect(listRules('category').some((r) => r.pattern === 'PET SUPPLIES')).toBe(true);
  });

  it('400s on a newer version with the message shown to the user', async () => {
    const { adminToken } = setup();
    const newer = JSON.stringify({ ...JSON.parse(pack), version: 2 });
    const response = await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', newer, adminToken));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/newer version/i);
  });

  it('400s on an unknown format and on non-JSON', async () => {
    const { adminToken } = setup();
    const wrongFormat = JSON.stringify({ ...JSON.parse(pack), format: 'mint-export' });
    expect((await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', wrongFormat, adminToken))).status).toBe(400);
    const garbage = await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', 'not json at all', adminToken));
    expect(garbage.status).toBe(400);
    expect((await garbage.json()).error).toMatch(/valid JSON/i);
  });

  it('403s a cross-origin post and 403s a member', async () => {
    const { adminToken, memberToken } = setup();
    expect((await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', pack, adminToken, {}, 'http://evil.local'))).status).toBe(403);
    expect((await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', pack, memberToken))).status).toBe(403);
  });

  it('413s on the declared content-length alone, before formData() is ever called (controller fix — review finding 1 parity)', async () => {
    const { adminToken } = setup();
    const formDataSpy = vi.fn(async () => {
      throw new Error('formData() must not be called once content-length already exceeds the cap');
    });
    const fakeRequest = {
      method: 'POST',
      headers: new Headers({ ...headers(adminToken), 'content-length': String(MAX_FILE_BYTES + 1) }),
      formData: formDataSpy,
    } as unknown as Request;

    const response = await rulesImport(fakeRequest);
    expect(response.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
  });

  /**
   * v1.31.0 review finding R-15 (P3). The Content-Length check above is a number the CLIENT
   * supplies, and it was the ONLY size check on this route: `Number(null ?? '')` is NaN, and
   * `Number.isFinite(NaN)` is false, so a request with no Content-Length -- which is exactly what
   * chunked transfer encoding sends -- skipped the check entirely and handed an unbounded body to
   * formData(). Admin-only, hence P3, but "the cap only applies if you declare your own size" is
   * not a cap.
   *
   * The file's own size is authoritative and known without reading a byte, which is how the CSV
   * upload routes this route's comment cites as precedent already do it
   * (import/raw-preview/route.ts, import/preview/route.ts).
   */
  it('413s on the FILE size when no content-length is declared at all (R-15)', async () => {
    const { adminToken } = setup();
    const oversized = 'x'.repeat(MAX_FILE_BYTES + 1);
    const form = new FormData();
    form.append('file', new File([oversized], 'pack.json', { type: 'application/json' }));
    // No content-length header: the header check cannot fire, so only the file's own size can.
    const request = new Request('http://nas.local:3000/api/packs/rules/import', {
      method: 'POST',
      headers: headers(adminToken),
      body: form,
    });
    expect(request.headers.get('content-length')).toBeNull();

    const response = await rulesImport(request);
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('file_too_large');
  });

  it('413s the profiles route the same way -- the identical gap, one directory over (R-15)', async () => {
    const { adminToken } = setup();
    const form = new FormData();
    form.append('file', new File(['y'.repeat(MAX_FILE_BYTES + 1)], 'pack.json', { type: 'application/json' }));
    const response = await profilesImport(
      new Request('http://nas.local:3000/api/packs/profiles/import', { method: 'POST', headers: headers(adminToken), body: form }),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('file_too_large');
  });

  /**
   * R-12 at the route boundary: the whole reason skip-and-report matters is that this route
   * ingests a file somebody else's install wrote. One entry from a newer build must not cost the
   * household the rest of the pack.
   */
  it('imports the rest of a pack whose one entry names an unrecognised match_type (R-12)', async () => {
    const { adminToken } = setup();
    const pack = JSON.stringify({
      format: 'budget-tracker-rules',
      version: 1,
      categories: [],
      rules: [
        { pattern: 'FUTURE FUZZY', match_type: 'fuzzy', rule_kind: 'category', category: 'Coffee', category_parent: 'Food' },
        { pattern: 'STARBUCKS', match_type: 'contains', rule_kind: 'category', category: 'Coffee', category_parent: 'Food' },
      ],
    });

    const preview = await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', pack, adminToken));
    expect(preview.status).toBe(200);
    const plan = await preview.json();
    expect({ newRules: plan.newRules, skipped: plan.skippedRules }).toEqual({ newRules: 1, skipped: 1 });
    expect(plan.skipped.map((entry: { pattern: string }) => entry.pattern)).toEqual(['FUTURE FUZZY']);

    const applied = await rulesImport(
      uploadRequest('http://nas.local:3000/api/packs/rules/import', pack, adminToken, { mode: 'apply' }),
    );
    expect(applied.status).toBe(200);
    expect((await applied.json()).rulesAdded).toBe(1);
    expect(listRules().some((rule) => rule.pattern === 'STARBUCKS')).toBe(true);
  });

  // Controller ruling (a) — revised 2026-08-31: rename is importable now. not_transfer is the
  // kind that stays permanently unsupported on import (it describes this install's own account
  // wiring), so it is what exercises the "skip gracefully, don't 400 the whole pack" path here.
  it('skips a rule with an unsupported rule_kind (e.g. not_transfer) rather than 400ing the whole pack', async () => {
    const { adminToken } = setup();
    const withNotTransfer = JSON.stringify({
      format: 'budget-tracker-rules',
      version: 1,
      exported_at: '2026-08-15T12:00:00.000Z',
      categories: [],
      rules: [{ pattern: 'ACME PAYROLL CO', match_type: 'exact', rule_kind: 'not_transfer', category: null }],
    });
    const response = await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', withNotTransfer, adminToken));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ applied: false, skippedRules: 1, newRules: 0 });
  });

  it('imports a rename rule (no longer skipped) and applies it retroactively', async () => {
    const { adminToken } = setup();
    const withRename = JSON.stringify({
      format: 'budget-tracker-rules',
      version: 1,
      exported_at: '2026-08-15T12:00:00.000Z',
      categories: [],
      rules: [{ pattern: 'MCDONALDS', match_type: 'exact', rule_kind: 'rename', category: null, rename_to: "McDonald's" }],
    });
    const applied = await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', withRename, adminToken, { mode: 'apply' }));
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ applied: true, rulesAdded: 1, rulesSkipped: 0 });
    expect(listRules('rename').find((r) => r.pattern === 'MCDONALDS')?.renameTo).toBe("McDonald's");
  });

  /**
   * v1.31.0 R-04. An unexpected failure used to be rethrown, which Next turns into a 500 with an
   * HTML body -- and the panel's `await response.json()` then threw on that HTML from inside a
   * floating `void send('apply')`, so the person who chose the file saw nothing happen at all.
   * The import is atomic now, so "Nothing was changed" is a true sentence and the route says it.
   */
  it('500s with a readable JSON error, not an HTML rethrow, when a write fails unexpectedly', async () => {
    const { adminToken } = setup();
    // A failure that is neither a format error nor predictable up front: the database itself
    // refusing the insert. No module is mocked -- the real route and the real importRulesPack run.
    current!.sqlite.exec(
      "create trigger boom before insert on merchant_rules when new.pattern = 'BOOM' begin select raise(abort, 'boom'); end",
    );
    const pack = JSON.stringify({
      format: 'budget-tracker-rules',
      version: 1,
      categories: [],
      rules: [
        { pattern: 'FIRST OK', match_type: 'exact', category: 'Coffee', category_parent: 'Food' },
        { pattern: 'BOOM', match_type: 'exact', category: 'Coffee', category_parent: 'Food' },
      ],
    });
    const before = listRules().length;

    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args));
    const response = await rulesImport(
      uploadRequest('http://nas.local:3000/api/packs/rules/import', pack, adminToken, { mode: 'apply' }),
    );
    spy.mockRestore();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Import failed. Nothing was changed.' });
    // The detail goes to the server log, not to a person holding user-supplied JSON.
    expect(errors).toHaveLength(1);
    // ...and the claim the message makes is true: the earlier rule is not there.
    expect(listRules().length).toBe(before);
    expect(listRules().map((row) => row.pattern)).not.toContain('FIRST OK');
  });

  it('400s a pack whose parent is already a child here, with the reason and no writes', async () => {
    const { adminToken } = setup();
    // The seed has Food > Coffee, so "Coffee" cannot be a parent in this database. This used to
    // throw a raw Error mid-loop -- a 500 with an HTML body -- after earlier rows were written.
    const pack = JSON.stringify({
      format: 'budget-tracker-rules',
      version: 1,
      categories: [{ name: 'Latte', parent: 'Coffee' }],
      rules: [{ pattern: 'BREVILLE', match_type: 'exact', category: 'Latte', category_parent: 'Coffee' }],
    });
    const before = listRules().length;
    const response = await rulesImport(
      uploadRequest('http://nas.local:3000/api/packs/rules/import', pack, adminToken, { mode: 'apply' }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/two levels deep/);
    expect(listRules().length).toBe(before);
  });

});

describe('profiles pack routes', () => {
  it('exports and re-imports with an auto-rename', async () => {
    const { adminToken } = setup();
    const exported = await profilesExport(new Request('http://nas.local:3000/api/packs/profiles/export', { headers: headers(adminToken) }));
    expect(exported.status).toBe(200);
    const body = await exported.text();
    // v1.13.0 Task 9 grew the built-in count from 4 to 7 -- derived rather than a literal.
    expect(JSON.parse(body).profiles).toHaveLength(BUILTIN_PRESET_NAMES.length);

    const preview = await profilesImport(uploadRequest('http://nas.local:3000/api/packs/profiles/import', body, adminToken));
    expect(await preview.json()).toMatchObject({ applied: false, totalProfiles: BUILTIN_PRESET_NAMES.length });
    expect(listProfiles()).toHaveLength(BUILTIN_PRESET_NAMES.length);

    const applied = await profilesImport(uploadRequest('http://nas.local:3000/api/packs/profiles/import', body, adminToken, { mode: 'apply' }));
    const result = (await applied.json()) as { added: { name: string }[] };
    expect(result.added.map((a) => a.name)).toEqual(BUILTIN_PRESET_NAMES.map((name) => `${name} (2)`));
    expect(listProfiles()).toHaveLength(BUILTIN_PRESET_NAMES.length * 2);
  });

  it('403s a member on export and import', async () => {
    const { memberToken } = setup();
    expect((await profilesExport(new Request('http://nas.local:3000/api/packs/profiles/export', { headers: headers(memberToken) }))).status).toBe(403);
    expect((await profilesImport(uploadRequest('http://nas.local:3000/api/packs/profiles/import', '{}', memberToken))).status).toBe(403);
  });

  it('403s a cross-origin GET on export', async () => {
    const { adminToken } = setup();
    const response = await profilesExport(
      new Request('http://nas.local:3000/api/packs/profiles/export', { headers: headers(adminToken, 'http://evil.local') }),
    );
    expect(response.status).toBe(403);
  });

  it('serves a header-less GET on export with a valid session, and still 401s without one', async () => {
    const { adminToken } = setup();
    expect(
      (await profilesExport(new Request('http://nas.local:3000/api/packs/profiles/export', { headers: headerlessHeaders(adminToken) }))).status,
    ).toBe(200);
    expect(
      (await profilesExport(new Request('http://nas.local:3000/api/packs/profiles/export', { headers: headerlessHeaders(null) }))).status,
    ).toBe(401);
  });

  it('413s on the declared content-length alone, before formData() is ever called (controller fix — review finding 1 parity)', async () => {
    const { adminToken } = setup();
    const formDataSpy = vi.fn(async () => {
      throw new Error('formData() must not be called once content-length already exceeds the cap');
    });
    const fakeRequest = {
      method: 'POST',
      headers: new Headers({ ...headers(adminToken), 'content-length': String(MAX_FILE_BYTES + 1) }),
      formData: formDataSpy,
    } as unknown as Request;

    const response = await profilesImport(fakeRequest);
    expect(response.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
  });
});
