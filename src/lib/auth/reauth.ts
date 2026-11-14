import { KNOWN_DEVICE_COOKIE_NAME, knownDeviceFor } from './known-device';
import { verifyPassword } from './password';
import { checkLockout, clientIpFromHeaders, lockoutMessage, recordLoginAttempt } from './ratelimit';
import { readCookieFromHeader, type SessionUser } from './session';
import { findUserByUsername } from './users';

/**
 * v1.64.1: re-checking the current password of a signed-in person (change password, replace or turn
 * off two-factor, the forced change) is counted through the sign-in lockout, in the same buckets a
 * sign-in from this browser would use.
 *
 * - checkLockout runs first; while it reports locked nothing is verified and the answer is the
 *   sign-in lockout's own wording.
 * - A wrong password is recorded as a failed attempt for that username.
 * - A right one writes nothing: no success row, so a re-check never resets the sign-in window.
 */
export const WRONG_CURRENT_PASSWORD = 'Current password is incorrect.';

export type ReauthResult = { ok: true } | { ok: false; error: string };

interface ReauthContext {
  user: SessionUser;
  /** The request's headers: the client address (TRUST_PROXY rules) and the known-device cookie. */
  headers: Headers;
  at?: Date;
}

/** The bucket this re-check falls in: the browser's verified known-device id when it has one. */
function bucketFor(context: ReauthContext): { username: string; ip: string; deviceId: string | null } {
  const deviceCookie = readCookieFromHeader(context.headers.get('cookie'), KNOWN_DEVICE_COOKIE_NAME) ?? undefined;
  return {
    username: context.user.username,
    ip: clientIpFromHeaders(context.headers, null),
    deviceId: knownDeviceFor(deviceCookie, context.user.username),
  };
}

export async function verifyCurrentPassword(input: ReauthContext & { password: string }): Promise<ReauthResult> {
  const at = input.at ?? new Date();
  const bucket = bucketFor(input);
  const lock = checkLockout({ ...bucket, at });
  if (lock.locked) return { ok: false, error: lockoutMessage(lock.retryAfterMs) };

  const record = findUserByUsername(input.user.username);
  const matches = record !== null && (await verifyPassword(record.passwordHash, input.password));
  if (!matches) {
    recordLoginAttempt({ ...bucket, success: false, at });
    return { ok: false, error: WRONG_CURRENT_PASSWORD };
  }

  // Failures recorded by other requests while this verify ran still count, as at sign-in.
  const lockAfterVerify = checkLockout({ ...bucket, at });
  if (lockAfterVerify.locked) return { ok: false, error: lockoutMessage(lockAfterVerify.retryAfterMs) };
  return { ok: true };
}

/** A wrong or already-used current two-factor code during a re-check: counted like a wrong password. */
export function recordFailedReauth(context: ReauthContext): void {
  recordLoginAttempt({ ...bucketFor(context), success: false, at: context.at ?? new Date() });
}
