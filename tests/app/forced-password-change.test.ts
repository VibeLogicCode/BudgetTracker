import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSeededTestDb, type TestDb } from '../helpers/db';

/**
 * v1.64.1: the forced password change is a boundary for every action and page, not only the app
 * layout. requireUser() (and requireAdmin() through it) sends a person who still has to choose
 * their own password to /change-password before the caller runs; requireUserForPasswordChange() is
 * the one way to obtain that person, used by the change-password page and its action. Real session
 * rows and the real helpers run here; only Next's request plumbing is stood in for.
 */
const cookieJar = new Map<string, string>();
const cookieStore = {
  get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name)! } : undefined),
  set: (name: string, value: string) => {
    cookieJar.set(name, value);
  },
  delete: (name: string) => {
    cookieJar.delete(name);
  },
};

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }),
  cookies: async () => cookieStore,
}));

class RedirectError extends Error {
  constructor(public readonly location: string) {
    super(`NEXT_REDIRECT:${location}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (location: string) => {
    throw new RedirectError(location);
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

import ChangePasswordPage from '@/app/(auth)/change-password/page';
import { forcedChangePasswordAction } from '@/app/(auth)/change-password/actions';
import { saveWizardProfileAction } from '@/app/(app)/import/actions';
import { turnOffLocalAiAction } from '@/app/(app)/settings/connections/ai-actions';
import { changePasswordAction } from '@/app/(app)/settings/actions';
import { POST as logoutPost } from '@/app/api/auth/logout/route';
import {
  SESSION_COOKIE_NAME,
  createSession,
  requireAdmin,
  requireUser,
  requireUserForPasswordChange,
  userFromRequest,
  validateSession,
} from '@/lib/auth/session';
import { createUser, mustChangePassword, setMustChangePassword } from '@/lib/auth/users';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  cookieJar.clear();
});

const PASSWORD = 'correct horse battery';

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

/** An admin who still has to choose their own password, signed in on this browser. */
async function flaggedAdmin() {
  current = createSeededTestDb();
  const alex = await createUser({ name: 'Alex', username: 'alex', password: PASSWORD, role: 'admin', mustChangePassword: true });
  const session = createSession(alex.id);
  cookieJar.set(SESSION_COOKIE_NAME, session.token);
  return { alex, token: session.token };
}

async function redirectFrom(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof RedirectError) return error.location;
    throw error;
  }
}

function count(table: string): number {
  return (current!.sqlite.prepare(`select count(*) as c from ${table}`).get() as { c: number }).c;
}

function snapshot(): Record<string, unknown> {
  const s = current!.sqlite;
  return {
    profiles: count('import_profiles'),
    audit: count('audit_log'),
    settings: s.prepare('select key, value from settings order by key').all(),
    hash: (s.prepare("select password_hash as h from users where username = 'alex'").get() as { h: string }).h,
  };
}

describe('the session helpers', () => {
  it('requireUser sends a flagged person to /change-password', async () => {
    await flaggedAdmin();
    expect(await redirectFrom(() => requireUser())).toBe('/change-password');
  });

  it('requireAdmin does the same for a flagged admin', async () => {
    await flaggedAdmin();
    expect(await redirectFrom(() => requireAdmin())).toBe('/change-password');
  });

  it('requireUserForPasswordChange hands back the flagged person, and sends no one signed out anywhere but /login', async () => {
    const { alex } = await flaggedAdmin();
    expect((await requireUserForPasswordChange()).id).toBe(alex.id);
    cookieJar.clear();
    expect(await redirectFrom(() => requireUserForPasswordChange())).toBe('/login');
  });

  it('requireUser lets the same person through once the flag is clear', async () => {
    const { alex } = await flaggedAdmin();
    setMustChangePassword(alex.id, false);
    expect((await requireUser()).id).toBe(alex.id);
  });

  it('userFromRequest answers as signed out for a flagged person; validateSession still sees the session', async () => {
    const { alex, token } = await flaggedAdmin();
    const request = new Request('http://nas.local:3000/api/x', { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });
    expect(userFromRequest(request)).toBeNull();
    expect(validateSession(token)?.id).toBe(alex.id);
    setMustChangePassword(alex.id, false);
    expect(userFromRequest(request)?.id).toBe(alex.id);
  });
});

describe('actions refuse a flagged person and write nothing', () => {
  it('an import action', async () => {
    await flaggedAdmin();
    const before = snapshot();
    const location = await redirectFrom(() =>
      saveWizardProfileAction({}, formData({ name: 'Maple card', mapping: '{}', fingerprint: 'x', delimiter: ',' })),
    );
    expect(location).toBe('/change-password');
    expect(snapshot()).toEqual(before);
  });

  it('an AI settings action', async () => {
    await flaggedAdmin();
    const before = snapshot();
    expect(await redirectFrom(() => turnOffLocalAiAction({}, formData({})))).toBe('/change-password');
    expect(snapshot()).toEqual(before);
  });

  it('the Settings password change, which is not the forced one', async () => {
    await flaggedAdmin();
    const before = snapshot();
    const location = await redirectFrom(() =>
      changePasswordAction({}, formData({ currentPassword: PASSWORD, newPassword: 'a whole new password' })),
    );
    expect(location).toBe('/change-password');
    expect(snapshot()).toEqual(before);
  });
});

describe('the change-password page and action still work for the flagged person', () => {
  it('the page renders for them instead of redirecting', async () => {
    await flaggedAdmin();
    expect(await redirectFrom(() => ChangePasswordPage())).toBeNull();
  });

  it('the action clears the flag and lands on the dashboard, which then lets them in', async () => {
    const { alex } = await flaggedAdmin();
    const location = await redirectFrom(() =>
      forcedChangePasswordAction({}, formData({ currentPassword: PASSWORD, newPassword: 'a whole new password' })),
    );
    expect(location).toBe('/dashboard');
    expect(mustChangePassword(alex.id)).toBe(false);
    expect((await requireUser()).id).toBe(alex.id);
  });

  it('the page sends them on to the dashboard once the flag is clear, so nothing loops', async () => {
    const { alex } = await flaggedAdmin();
    setMustChangePassword(alex.id, false);
    expect(await redirectFrom(() => ChangePasswordPage())).toBe('/dashboard');
  });

  it('signing out still works for them', async () => {
    const { alex, token } = await flaggedAdmin();
    createSession(alex.id);
    const form = new FormData();
    form.set('scope', 'all');
    const response = await logoutPost(
      new Request('http://nas.local:3000/api/auth/logout', {
        method: 'POST',
        headers: { origin: 'http://nas.local:3000', host: 'nas.local:3000', cookie: `${SESSION_COOKIE_NAME}=${token}` },
        body: form,
      }),
    );
    expect(response.status).toBe(303);
    expect(count('sessions')).toBe(0);
  });
});
