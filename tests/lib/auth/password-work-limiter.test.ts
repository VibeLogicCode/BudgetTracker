import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/db';

/**
 * A stand-in for argon2 whose work can be held open, so the tests can see how many operations run
 * at once and fill the waiting line on purpose. While the gate is open every call finishes on the
 * next tick, which keeps user creation and the sign-in module's start-up hash quick.
 */
const fake = vi.hoisted(() => {
  const held: Array<() => void> = [];
  const state = { open: true, active: 0, peak: 0 };
  async function work<T>(value: T): Promise<T> {
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    if (!state.open) await new Promise<void>((resolve) => held.push(resolve));
    else await Promise.resolve();
    state.active -= 1;
    return value;
  }
  return {
    state,
    held,
    work,
    close() {
      state.open = false;
      state.peak = state.active;
    },
    open() {
      state.open = true;
      for (const release of held.splice(0)) release();
    },
    releaseOne() {
      held.shift()?.();
    },
  };
});

vi.mock('argon2', () => ({
  default: {
    argon2id: 2,
    hash: (plain: string) => fake.work(`stub-hash:${plain}`),
    verify: (hash: string, plain: string) => fake.work(hash === `stub-hash:${plain}`),
  },
}));

const cookieStore = { get: () => undefined, set: vi.fn(), delete: vi.fn() };
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }),
  cookies: async () => cookieStore,
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

import {
  ARGON2_MAX_IN_FLIGHT,
  ARGON2_MAX_WAITING,
  hashPassword,
  verifyPassword,
} from '@/lib/auth/password';
import { BUSY_LOGIN_ERROR, attemptLogin } from '@/lib/auth/login';
import { createUser } from '@/lib/auth/users';
import { loginAction } from '@/app/(auth)/login/actions';

let current: TestDb | null = null;
afterEach(() => {
  fake.open();
  current?.cleanup();
  current = null;
});

const PASSWORD = 'correct horse battery';

/** Lets every pending callback and promise continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Holds the gate shut and starts enough verifies to fill both running slots and the waiting line. */
async function fillTheLine(): Promise<Promise<boolean>[]> {
  fake.close();
  const work = Array.from({ length: ARGON2_MAX_IN_FLIGHT + ARGON2_MAX_WAITING }, () => verifyPassword('stub-hash:x', 'x'));
  await settle();
  return work;
}

function loginAttemptCount(): number {
  return (current!.sqlite.prepare('select count(*) as c from login_attempts').get() as { c: number }).c;
}

describe('the password work limiter', () => {
  it('names its limits', () => {
    expect(ARGON2_MAX_IN_FLIGHT).toBe(2);
    expect(ARGON2_MAX_WAITING).toBe(8);
  });

  it('never runs more than two hashes or verifies at once, and runs the rest in order', async () => {
    fake.close();
    const order: number[] = [];
    const work = Array.from({ length: 6 }, (_, i) =>
      (i % 2 === 0 ? verifyPassword('stub-hash:x', 'x') : hashPassword('a long enough password')).then(() => order.push(i)),
    );
    await settle();
    expect(fake.state.active).toBe(2);
    for (let i = 0; i < 6; i += 1) {
      fake.releaseOne();
      await settle();
      expect(fake.state.active).toBeLessThanOrEqual(2);
    }
    await Promise.all(work);
    expect(fake.state.peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('lets a signed-in hash wait its turn past a full line and complete', async () => {
    const work = await fillTheLine();
    const late = hashPassword('a long enough password');
    await settle();
    expect(fake.state.active).toBe(2);
    fake.open();
    await expect(late).resolves.toBe('stub-hash:a long enough password');
    await Promise.all(work);
  });
});

describe('sign-in when the line is full', () => {
  it('answers busy for a known user without verifying or recording an attempt', async () => {
    current = createTestDb();
    await createUser({ name: 'Alex', username: 'alex', password: PASSWORD, role: 'admin' });
    const work = await fillTheLine();
    const before = fake.held.length;

    const result = await attemptLogin({ username: 'alex', password: PASSWORD, ip: '10.0.0.5' });

    expect(result).toEqual({ status: 'busy' });
    expect(fake.held.length).toBe(before);
    expect(loginAttemptCount()).toBe(0);
    fake.open();
    await Promise.all(work);
  });

  it('answers busy for an unknown user too, before the stand-in verify', async () => {
    current = createTestDb();
    const work = await fillTheLine();
    const before = fake.held.length;

    const result = await attemptLogin({ username: 'nobody', password: 'not a real password', ip: '10.0.0.5' });

    expect(result).toEqual({ status: 'busy' });
    expect(fake.held.length).toBe(before);
    expect(loginAttemptCount()).toBe(0);
    fake.open();
    await Promise.all(work);
  });

  it('signs in normally once the line has room again', async () => {
    current = createTestDb();
    await createUser({ name: 'Alex', username: 'alex', password: PASSWORD, role: 'admin' });
    const work = await fillTheLine();
    fake.open();
    await Promise.all(work);
    expect((await attemptLogin({ username: 'alex', password: PASSWORD, ip: '10.0.0.5' })).status).toBe('ok');
  });

  it('the sign-in form says the server is busy, never that the password was wrong', async () => {
    current = createTestDb();
    await createUser({ name: 'Alex', username: 'alex', password: PASSWORD, role: 'admin' });
    const work = await fillTheLine();
    const form = new FormData();
    form.set('username', 'alex');
    form.set('password', PASSWORD);

    const result = await loginAction({}, form);

    expect(BUSY_LOGIN_ERROR).toBe('The server is busy. Try again in a moment.');
    expect(result.error).toBe(BUSY_LOGIN_ERROR);
    expect(loginAttemptCount()).toBe(0);
    fake.open();
    await Promise.all(work);
  });
});
