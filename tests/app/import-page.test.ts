import { describe, it, expect, afterEach, vi } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';

/**
 * v1.13.0 controller ruling: hiding Import from a self viewer's nav (micro-ruling M6) is not
 * enough on its own -- the account picker this page builds is household-wide unless the caller
 * scopes it, so the page itself must refuse a self viewer server-side.
 */
const currentUser = vi.hoisted(() => ({
  value: {
    id: 0,
    name: '',
    username: '',
    role: 'admin' as 'admin' | 'member',
    visibility: 'household' as 'household' | 'self',
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireUser: async () => currentUser.value,
}));

const redirected: string[] = [];
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    redirected.push(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  redirected.length = 0;
});

describe('ImportPage', () => {
  it('redirects a self-scoped viewer to /dashboard', async () => {
    current = createSeededTestDb();
    const kid = insertTestUser(current.db, { name: 'Kid', username: 'kid', role: 'member' });
    currentUser.value = { id: kid, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };

    const { default: ImportPage } = await import('@/app/(app)/import/page');
    await expect(ImportPage()).rejects.toThrow('NEXT_REDIRECT:/dashboard');
  });

  it('does not redirect a household viewer, and excludes asset accounts from the picker (ruling R10)', async () => {
    current = createSeededTestDb();
    const admin = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
    insertTestAccount(current.db, { name: 'Joint Chequing', type: 'chequing' });
    insertTestAccount(current.db, { name: 'The House', type: 'asset' });
    currentUser.value = { id: admin, name: 'Admin', username: 'admin', role: 'admin', visibility: 'household' };

    const { default: ImportPage } = await import('@/app/(app)/import/page');
    const element = (await ImportPage()) as { props: { accounts: { name: string }[] } };
    expect(redirected).toEqual([]);
    const names = element.props.accounts.map((a) => a.name);
    expect(names).toContain('Joint Chequing');
    expect(names).not.toContain('The House');
  });
});
