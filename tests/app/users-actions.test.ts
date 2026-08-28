import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';

// requireAdmin is the only thing these actions need from the session module; everything
// else (users, sessions, TOTP) runs against a real test database so the writes are real.
const ADMIN = { id: 1, name: 'Alice', username: 'alice', role: 'admin' as const };

vi.mock('@/lib/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/session')>();
  return { ...actual, requireAdmin: vi.fn(async () => ADMIN) };
});

let originHeaders = { origin: 'http://nas.local:3000', host: 'nas.local:3000' };

vi.mock('next/headers', () => ({
  headers: async () => new Headers(originHeaders),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  createPersonAction,
  createUserAction,
  resetMfaAction,
  resetPasswordAction,
  setCanSignInAction,
  setVisibilityAction,
} from '@/app/(app)/settings/users/actions';
import { CROSS_ORIGIN_ERROR } from '@/lib/auth/csrf';
import { createSession } from '@/lib/auth/session';
import { createUser, findUserById, findUserByUsername, listUsers, mustChangePassword } from '@/lib/auth/users';
import { enableTotpForUser, generateTotpSecret } from '@/lib/auth/totp';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  originHeaders = { origin: 'http://nas.local:3000', host: 'nas.local:3000' };
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function sessionCount(userId: number): number {
  return (
    current!.db.get<{ c: number }>(sql`select count(*) as c from sessions where user_id = ${userId}`)?.c ?? 0
  );
}

describe('createUserAction — forced password change (spec v1.5)', () => {
  it('flags the new user: the admin typed their password, so they must replace it', async () => {
    current = createTestDb();
    const result = await createUserAction(
      {},
      formData({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' }),
    );
    expect(result.error).toBeUndefined();
    const bob = findUserByUsername('bob');
    expect(bob).not.toBeNull();
    expect(bob!.mustChangePassword).toBe(true);
    expect(result.message).toMatch(/change it at first sign-in/i);
  });
});

describe('resetPasswordAction — forced password change (spec v1.5)', () => {
  it('flags the target and destroys every one of their sessions', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    createSession(bob.id);
    createSession(bob.id);
    expect(sessionCount(bob.id)).toBe(2);

    const result = await resetPasswordAction({}, formData({ userId: String(bob.id), password: 'a whole new password' }));
    expect(result.error).toBeUndefined();
    expect(mustChangePassword(bob.id)).toBe(true);
    expect(sessionCount(bob.id)).toBe(0);
  });
});

describe('resetMfaAction — polish item 12', () => {
  it('destroys the target user’s sessions, mirroring resetPasswordAction', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    enableTotpForUser(bob.id, generateTotpSecret());
    createSession(bob.id);
    createSession(bob.id);
    expect(sessionCount(bob.id)).toBe(2);

    const result = await resetMfaAction({}, formData({ userId: String(bob.id) }));
    expect(result.error).toBeUndefined();
    expect(findUserByUsername('bob')?.totpEnabled).toBe(false);
    // A live session opened under the old MFA must not outlive it.
    expect(sessionCount(bob.id)).toBe(0);
  });

  it('does not touch anyone else’s sessions', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    const carol = await createUser({ name: 'Carol', username: 'carol', password: 'correct horse battery', role: 'member' });
    createSession(bob.id);
    createSession(carol.id);

    await resetMfaAction({}, formData({ userId: String(bob.id) }));
    expect(sessionCount(bob.id)).toBe(0);
    expect(sessionCount(carol.id)).toBe(1);
  });
});

describe('MFA reset does not raise the password flag', () => {
  it('clearing MFA is not a password event', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    await resetMfaAction({}, formData({ userId: String(bob.id) }));
    expect(mustChangePassword(bob.id)).toBe(false);
  });
});

describe('createPersonAction — ruling R5: a person without a login', () => {
  it('adds a person with no password at all', async () => {
    current = createTestDb();
    const result = await createPersonAction({}, formData({ name: 'Person Three', username: 'user-3' }));
    expect(result.message).toMatch(/added/i);
    const person = listUsers().find((row) => row.username === 'user-3');
    expect(person).not.toBeUndefined();
    expect(person?.canSignIn).toBe(false);
    expect(person?.role).toBe('member');
  });

  it('rejects a duplicate username with a clean error', async () => {
    current = createTestDb();
    await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    const result = await createPersonAction({}, formData({ name: 'Robin', username: 'bob' }));
    expect(result.error).toMatch(/taken/i);
  });
});

describe('setVisibilityAction — ruling R2, micro-ruling M1', () => {
  it('limits a member to their own records', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    const result = await setVisibilityAction({}, formData({ userId: String(bob.id), visibility: 'self' }));
    expect(result.message).toBeTruthy();
    expect(findUserById(bob.id)?.visibility).toBe('self');
  });

  it('the same call against an admin is refused with a plain sentence', async () => {
    current = createTestDb();
    const root = await createUser({ name: 'Root', username: 'root', password: 'correct horse battery', role: 'admin' });
    const result = await setVisibilityAction({}, formData({ userId: String(root.id), visibility: 'self' }));
    expect(result.error).toMatch(/member first/i);
    expect(findUserById(root.id)?.visibility).toBe('household');
  });
});

describe('setCanSignInAction (item BI)', () => {
  it('turns a member into an attribution-only person', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    const result = await setCanSignInAction({}, formData({ userId: String(bob.id), canSignIn: '0' }));
    expect(result.message).toBeTruthy();
    expect(listUsers().find((u) => u.id === bob.id)?.canSignIn).toBe(false);
  });

  it('turns them back', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    await setCanSignInAction({}, formData({ userId: String(bob.id), canSignIn: '0' }));
    await setCanSignInAction({}, formData({ userId: String(bob.id), canSignIn: '1' }));
    expect(listUsers().find((u) => u.id === bob.id)?.canSignIn).toBe(true);
  });

  it('accepts AutoSaveCheckbox\'s native "on" shape', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    await setCanSignInAction({}, formData({ userId: String(bob.id), canSignIn: '0' }));
    const result = await setCanSignInAction({}, formData({ userId: String(bob.id), canSignIn: 'on' }));
    expect(result.error).toBeUndefined();
    expect(listUsers().find((u) => u.id === bob.id)?.canSignIn).toBe(true);
  });

  it('treats an absent canSignIn field as off, the unchecked-checkbox convention', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    const fd = new FormData();
    fd.set('userId', String(bob.id));
    const result = await setCanSignInAction({}, fd);
    expect(result.error).toBeUndefined();
    expect(listUsers().find((u) => u.id === bob.id)?.canSignIn).toBe(false);
  });

  it('refuses a malformed canSignIn value instead of silently coercing it to off', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    const result = await setCanSignInAction({}, formData({ userId: String(bob.id), canSignIn: 'true' }));
    expect(result.error).toBe('Invalid request.');
    expect(listUsers().find((u) => u.id === bob.id)?.canSignIn).toBe(true);
  });

  it('destroys every session when a person is switched off', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    createSession(bob.id);
    createSession(bob.id);
    expect(sessionCount(bob.id)).toBe(2);

    const result = await setCanSignInAction({}, formData({ userId: String(bob.id), canSignIn: '0' }));
    expect(result.error).toBeUndefined();
    expect(sessionCount(bob.id)).toBe(0);
  });

  it('does not touch sessions when a person is switched back on', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    await setCanSignInAction({}, formData({ userId: String(bob.id), canSignIn: '0' }));
    createSession(bob.id);
    expect(sessionCount(bob.id)).toBe(1);

    const result = await setCanSignInAction({}, formData({ userId: String(bob.id), canSignIn: '1' }));
    expect(result.error).toBeUndefined();
    expect(sessionCount(bob.id)).toBe(1);
  });

  it('refuses to lock an admin out, in the library\'s own words', async () => {
    current = createTestDb();
    const root = await createUser({ name: 'Root', username: 'root', password: 'correct horse battery', role: 'admin' });
    const result = await setCanSignInAction({}, formData({ userId: String(root.id), canSignIn: '0' }));
    expect(result.error).toBe('An admin must be able to sign in. Make them a member first.');
    expect(listUsers().find((u) => u.id === root.id)?.canSignIn).toBe(true);
  });

  it('rejects a cross-origin request before touching anything', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    originHeaders = { origin: 'http://evil.example', host: 'nas.local:3000' };
    const result = await setCanSignInAction({}, formData({ userId: String(bob.id), canSignIn: '0' }));
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
    expect(listUsers().find((u) => u.id === bob.id)?.canSignIn).toBe(true);
  });
});
