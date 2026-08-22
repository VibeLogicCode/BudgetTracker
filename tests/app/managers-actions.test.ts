import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, categoryIdByName, insertTestUser, type TestDb } from '../helpers/db';
import { nowIso } from '@/lib/clock';
import { listRules, upsertRuleFromCorrection } from '@/lib/categorize/rules';

let currentUser = { id: 1, name: 'Admin', username: 'admin', role: 'admin' as const };

vi.mock('@/lib/auth/session', () => ({
  requireAdmin: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { requireAdmin } from '@/lib/auth/session';
import { revalidatePath } from 'next/cache';
import {
  archiveCategoryAction,
  createCategoryAction,
  deleteProfileAction,
  deleteRuleAction,
  renameCategoryAction,
  setProfileActiveAction,
} from '@/app/(app)/settings/managers/actions';
import { CATEGORY_RENDERING_ROUTES, PROFILE_RENDERING_ROUTES } from '@/app/(app)/settings/managers/revalidation-routes';
import { createProfile, getBuiltinPreset, getProfile, getProfileByName, listProfiles } from '@/lib/import/presets';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Admin', username: 'admin' });
  currentUser = { id: userId, name: 'Admin', username: 'admin', role: 'admin' };
  return { db: current.db, userId };
}

describe('deleteRuleAction — missing input validation (finding 2)', () => {
  it('returns a clean error for a non-numeric ruleId instead of a silent no-op success', async () => {
    setup();
    const result = await deleteRuleAction({}, formData({ ruleId: 'nope' }));
    expect(result.error).toBeTruthy();
  });

  it('returns an error when the rule does not exist instead of claiming success', async () => {
    setup();
    const result = await deleteRuleAction({}, formData({ ruleId: '999999' }));
    expect(result.error).toBeTruthy();
  });

  it('still deletes a real rule', async () => {
    const { db, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const ruleId = upsertRuleFromCorrection({
      pattern: 'TIM HORTONS',
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: coffee,
      createdBy: userId,
    });
    const result = await deleteRuleAction({}, formData({ ruleId: String(ruleId) }));
    expect(result.message).toBeTruthy();
    expect(listRules().find((r) => r.id === ruleId)).toBeUndefined();
  });
});

describe('deleteProfileAction (a mapping could not previously be deleted by anyone)', () => {
  it('refuses to delete a built-in profile', async () => {
    setup();
    const builtin = getProfileByName('TD Visa')!;
    const result = await deleteProfileAction({}, formData({ profileId: String(builtin.id) }));
    expect(result.error).toMatch(/built-in/i);
    expect(listProfiles()).toHaveLength(4);
  });

  it('deletes an unused custom profile and revalidates the managers page', async () => {
    setup();
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    vi.mocked(revalidatePath).mockClear();
    const result = await deleteProfileAction({}, formData({ profileId: String(id) }));
    expect(result.message).toBeTruthy();
    expect(getProfile(id)).toBeNull();
    expect(vi.mocked(revalidatePath).mock.calls.map((call) => call[0])).toContain('/settings/managers');
  });

  it('deletes a profile an account still uses, clearing the reference and reporting it in the message', async () => {
    const { db } = setup();
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    const accountId = insertTestAccount(db, { name: 'Joint Chequing', importProfileId: id });
    const result = await deleteProfileAction({}, formData({ profileId: String(id) }));
    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/account/i);
    expect(getProfile(id)).toBeNull();
    const row = current!.sqlite.prepare('select import_profile_id from accounts where id = ?').get(accountId) as {
      import_profile_id: number | null;
    };
    expect(row.import_profile_id).toBeNull();
  });

  it('deletes a profile a past import still references, clearing the reference and reporting it in the message', async () => {
    const { db, userId } = setup();
    const accountId = insertTestAccount(db, { name: 'Old Account' });
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    current!.sqlite
      .prepare(
        `insert into imports (account_id, profile_id, filename, imported_by, created_at) values (?, ?, ?, ?, ?)`,
      )
      .run(accountId, id, 'old.csv', userId, nowIso());

    const result = await deleteProfileAction({}, formData({ profileId: String(id) }));
    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/import/i);
    expect(getProfile(id)).toBeNull();
  });

  it('refuses a non-admin caller', async () => {
    setup();
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error('not admin'));
    await expect(deleteProfileAction({}, formData({ profileId: String(id) }))).rejects.toThrow(/not admin/);
    expect(getProfile(id)).not.toBeNull();
  });
});

describe('setProfileActiveAction (spec 2026-08-22 v1.6.0, MUST-4.1-4.4: mapping deactivation)', () => {
  it('deactivates a BUILT-IN profile -- deleteProfileAction refuses built-ins, this must not (MUST-4.2)', async () => {
    setup();
    const builtin = getProfileByName('Scotiabank Chequing/Debit')!;
    const result = await setProfileActiveAction({}, formData({ profileId: String(builtin.id), isActive: '0' }));
    expect(result.error).toBeUndefined();
    expect(getProfile(builtin.id)?.isActive).toBe(false);
    expect(getProfile(builtin.id)?.isBuiltin).toBe(true);
  });

  it('reactivates a deactivated profile', async () => {
    setup();
    const builtin = getProfileByName('TD Visa')!;
    await setProfileActiveAction({}, formData({ profileId: String(builtin.id), isActive: '0' }));
    const result = await setProfileActiveAction({}, formData({ profileId: String(builtin.id), isActive: '1' }));
    expect(result.error).toBeUndefined();
    expect(getProfile(builtin.id)?.isActive).toBe(true);
  });

  it('warns with the REAL pinned-account count in the deactivate message (MUST-4.3), and leaves the pin in the database', async () => {
    const { db } = setup();
    const builtin = getProfileByName('Scotiabank Chequing/Debit')!;
    const accountId = insertTestAccount(db, { name: 'Joint Chequing', importProfileId: builtin.id });
    insertTestAccount(db, { name: 'Solo Chequing', importProfileId: builtin.id });

    const result = await setProfileActiveAction({}, formData({ profileId: String(builtin.id), isActive: '0' }));

    expect(result.message).toMatch(/2 account/i);
    const row = current!.sqlite.prepare('select import_profile_id from accounts where id = ?').get(accountId) as {
      import_profile_id: number | null;
    };
    expect(row.import_profile_id).toBe(builtin.id); // nothing nulled, unlike deleteProfileAction
  });

  it('says nothing about accounts when none are pinned', async () => {
    setup();
    const builtin = getProfileByName('TD Chequing/Debit')!;
    const result = await setProfileActiveAction({}, formData({ profileId: String(builtin.id), isActive: '0' }));
    expect(result.message).not.toMatch(/account/i);
  });

  it('rejects an invalid profileId', async () => {
    setup();
    const result = await setProfileActiveAction({}, formData({ profileId: 'nope', isActive: '0' }));
    expect(result.error).toBeTruthy();
  });

  it('errors for an unknown profile instead of silently no-op-ing', async () => {
    setup();
    const result = await setProfileActiveAction({}, formData({ profileId: '999999', isActive: '0' }));
    expect(result.error).toBeTruthy();
  });

  it('refuses a non-admin caller', async () => {
    setup();
    const builtin = getProfileByName('TD Visa')!;
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error('not admin'));
    await expect(setProfileActiveAction({}, formData({ profileId: String(builtin.id), isActive: '0' }))).rejects.toThrow(/not admin/);
    expect(getProfile(builtin.id)?.isActive).toBe(true);
  });

  it('revalidates every route that renders a profile list', async () => {
    setup();
    const builtin = getProfileByName('TD Visa')!;
    vi.mocked(revalidatePath).mockClear();
    await setProfileActiveAction({}, formData({ profileId: String(builtin.id), isActive: '0' }));
    const calls = vi.mocked(revalidatePath).mock.calls.map((call) => call[0]);
    for (const route of PROFILE_RENDERING_ROUTES) expect(calls).toContain(route);
  });
});

// A new child category left /budgets, /reports, the dashboard and /review looking stale for
// up to ~30s (Next's client router cache) because the category
// mutations only ever revalidated /settings/managers (and, for rules, /transactions). Every
// one of these three tests reads CATEGORY_RENDERING_ROUTES straight from the same module the
// actions import it from -- not a copy-pasted literal list -- so a route added to the constant
// without a matching revalidatePath call in the action fails here, and a route removed from the
// constant without updating this test still passes (there is nothing left here to duplicate
// wrongly).
describe('category mutations revalidate every route that renders categories (finding 3)', () => {
  it('createCategoryAction revalidates every route that renders categories', async () => {
    setup();
    vi.mocked(revalidatePath).mockClear();
    const result = await createCategoryAction({}, formData({ name: 'Education', parentId: '' }));
    expect(result.message).toBeTruthy();
    const calls = vi.mocked(revalidatePath).mock.calls.map((call) => call[0]);
    for (const route of CATEGORY_RENDERING_ROUTES) expect(calls).toContain(route);
  });

  it('renameCategoryAction revalidates every route that renders categories', async () => {
    const { db } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    vi.mocked(revalidatePath).mockClear();
    const result = await renameCategoryAction({}, formData({ categoryId: String(coffee), name: 'Coffee Shops' }));
    expect(result.message).toBeTruthy();
    const calls = vi.mocked(revalidatePath).mock.calls.map((call) => call[0]);
    for (const route of CATEGORY_RENDERING_ROUTES) expect(calls).toContain(route);
  });

  it('archiveCategoryAction revalidates every route that renders categories', async () => {
    const { db } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    vi.mocked(revalidatePath).mockClear();
    const result = await archiveCategoryAction({}, formData({ categoryId: String(coffee), archived: '1' }));
    expect(result.message).toBeTruthy();
    const calls = vi.mocked(revalidatePath).mock.calls.map((call) => call[0]);
    for (const route of CATEGORY_RENDERING_ROUTES) expect(calls).toContain(route);
  });
});
