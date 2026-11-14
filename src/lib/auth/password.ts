import argon2 from 'argon2';
import { z } from '@/lib/zod';

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 1024;

/** Spec section 6: argon2id, 64 MiB memory, time cost 3. */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

/**
 * v1.64.1: every argon2 hash and verify in the process shares one line. At most this many run at
 * once; the rest wait their turn in order, so password work never takes every worker thread the
 * server also needs for files and the database.
 */
export const ARGON2_MAX_IN_FLIGHT = 2;
/** Sign-in does not join a line already this long; it is answered busy instead (see attemptLogin). */
export const ARGON2_MAX_WAITING = 8;

/** What verifyPasswordForSignIn answers when the line is full. Never a wrong-password result. */
export const PASSWORD_WORK_BUSY = 'busy' as const;

interface PasswordWorkLine {
  inFlight: number;
  waiting: Array<() => void>;
}

/**
 * Kept on globalThis under a Symbol.for key so every copy of this module in the server process
 * (actions, routes, the scheduler) shares the one line.
 */
const LINE_KEY = Symbol.for('budget-tracker.password-work-line');

function line(): PasswordWorkLine {
  const store = globalThis as unknown as Record<symbol, PasswordWorkLine | undefined>;
  store[LINE_KEY] ??= { inFlight: 0, waiting: [] };
  return store[LINE_KEY];
}

function acquire(): Promise<void> {
  const state = line();
  if (state.inFlight < ARGON2_MAX_IN_FLIGHT) {
    state.inFlight += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => state.waiting.push(resolve));
}

/** Hands the slot straight to the next in line, so a newcomer cannot overtake anyone waiting. */
function release(): void {
  const state = line();
  const next = state.waiting.shift();
  if (next) next();
  else state.inFlight -= 1;
}

async function withPasswordWork<T>(work: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await work();
  } finally {
    release();
  }
}

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, 'Password is too long');

export function validatePasswordStrength(plain: string): { ok: true } | { ok: false; error: string } {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (plain.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: 'Password is too long' };
  }
  return { ok: true };
}

export async function hashPassword(plain: string): Promise<string> {
  const check = validatePasswordStrength(plain);
  if (!check.ok) throw new Error(check.error);
  return withPasswordWork(() => argon2.hash(plain, ARGON2_OPTIONS));
}

/** For a signed-in caller or a setup step past its token check: waits its turn however long the line. */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return withPasswordWork(async () => {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  });
}

/**
 * For sign-in: refuses to join a full line rather than wait in it. The check and the place in line
 * are taken in the same synchronous step, so no other request can slip between them.
 */
export function verifyPasswordForSignIn(hash: string, plain: string): Promise<boolean | typeof PASSWORD_WORK_BUSY> {
  if (line().waiting.length >= ARGON2_MAX_WAITING) return Promise.resolve(PASSWORD_WORK_BUSY);
  return verifyPassword(hash, plain);
}
