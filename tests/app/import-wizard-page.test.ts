import { describe, it, expect, afterEach, vi } from 'vitest';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';

/**
 * v1.13.0 Task 14 fix round 1, CRITICAL 2: the wizard is part of Import (a new-bank mapping
 * wizard reachable from the Import page), gated the same way import/page.tsx is -- nav hiding
 * alone is insufficient for a self viewer.
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

describe('ImportWizardPage', () => {
  it('redirects a self-scoped viewer to /dashboard', async () => {
    current = createSeededTestDb();
    const kid = insertTestUser(current.db, { name: 'Kid', username: 'kid', role: 'member' });
    currentUser.value = { id: kid, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };

    const { default: ImportWizardPage } = await import('@/app/(app)/import/wizard/page');
    await expect(ImportWizardPage()).rejects.toThrow('NEXT_REDIRECT:/dashboard');
  });

  it('does not redirect a household viewer', async () => {
    current = createSeededTestDb();
    const admin = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
    currentUser.value = { id: admin, name: 'Admin', username: 'admin', role: 'admin', visibility: 'household' };

    const { default: ImportWizardPage } = await import('@/app/(app)/import/wizard/page');
    await expect(ImportWizardPage()).resolves.toBeTruthy();
    expect(redirected).toEqual([]);
  });
});
