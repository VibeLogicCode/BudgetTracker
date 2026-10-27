import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { deleteSetting, getSetting, setSetting } from '@/lib/settings';
import { countUsers } from '@/lib/auth/users';
import { readEnv, type AppEnv } from '@/lib/env';

/**
 * v1.58.1: first-run setup token. While no user exists, boot issues a one-time token, keeps only
 * its SHA-256 hash in `settings`, and prints the token once. /setup requires it, so reaching the
 * page first is not enough to become the administrator. An operator SETUP_TOKEN is accepted too.
 * The hash is removed once the first admin exists.
 */
export const SETUP_TOKEN_SETTING = 'setup.token_hash';
export const SETUP_TOKEN_LINE_PREFIX = 'Budget Tracker setup token: ';
export const MIN_CONFIGURED_SETUP_TOKEN_LENGTH = 16;

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

function configuredToken(env: AppEnv): string | null {
  if (env.setupToken === null) return null;
  if (env.setupToken.length < MIN_CONFIGURED_SETUP_TOKEN_LENGTH) {
    console.warn(
      `[setup] SETUP_TOKEN is shorter than ${MIN_CONFIGURED_SETUP_TOKEN_LENGTH} characters and will be treated as unset.`,
    );
    return null;
  }
  return env.setupToken;
}

export function clearSetupToken(): void {
  deleteSetting(SETUP_TOKEN_SETTING);
}

export function issueSetupTokenOnBoot(env: AppEnv = readEnv()): void {
  if (countUsers() > 0) {
    clearSetupToken();
    return;
  }
  if (configuredToken(env) !== null) {
    clearSetupToken();
    console.log('[setup] First-run setup accepts the SETUP_TOKEN value from the environment.');
    return;
  }
  const token = randomBytes(24).toString('base64url');
  setSetting(SETUP_TOKEN_SETTING, sha256(token).toString('hex'));
  const bar = '='.repeat(78);
  console.log('');
  console.log(bar);
  console.log(` ${SETUP_TOKEN_LINE_PREFIX}${token}`);
  console.log('');
  console.log(' Open /setup in your browser and enter this token to create the first account.');
  console.log(' A new token is printed each time the app starts until that account exists.');
  console.log(bar);
  console.log('');
}

function matches(input: Buffer, expected: Buffer): boolean {
  return input.length === expected.length && timingSafeEqual(input, expected);
}

export function verifySetupToken(input: string, env: AppEnv = readEnv()): boolean {
  const trimmed = input.trim();
  if (trimmed.length === 0) return false;
  const digest = sha256(trimmed);
  let ok = false;
  const stored = getSetting(SETUP_TOKEN_SETTING);
  if (stored !== null && /^[0-9a-f]{64}$/.test(stored)) {
    ok = matches(digest, Buffer.from(stored, 'hex'));
  }
  const configured = configuredToken(env);
  if (configured !== null && matches(digest, sha256(configured))) ok = true;
  return ok;
}
