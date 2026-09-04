'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { passwordSchema, verifyPassword } from '@/lib/auth/password';
import {
  clearSessionCookie,
  destroyOtherSessionsForUser,
  destroySessionForUser,
  hashSessionToken,
  requireAdmin,
  requireUser,
} from '@/lib/auth/session';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session-constants';
import {
  clearTotpEnrollment,
  consumeTotpCounter,
  decryptTotpSecret,
  enableTotpForUser,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  storeRecoveryCodes,
  totpKeyUri,
  totpQrDataUri,
  verifyTotpCounter,
} from '@/lib/auth/totp';
import { findUserByUsername, setUserPassword } from '@/lib/auth/users';
import { parseChangelog } from '@/lib/changelog';
import type { ChangelogRelease } from '@/lib/changelog';
import { raiseAccountSecurityEvent } from '@/lib/notify/raise';
import { applyUpdate, runUpdateCheck } from '@/lib/update/check';
import { boundRelease, fetchRemoteChangelog } from '@/lib/update/github';
import { checkUpdateCheckNow, checkUpdateReview } from '@/lib/update/ratelimit';
import { classify, parseSemver, type UpdateSeverity } from '@/lib/update/semver';
import { dismissVersion, readUpdateState, setAutoApply, setUpdateChecksEnabled } from '@/lib/update/state';
import { watchtowerConfig } from '@/lib/update/watchtower';
import { APP_VERSION } from '@/lib/version';

export interface ProfileFormState {
  error?: string;
  message?: string;
  enrollment?: { secret: string; qrDataUri: string };
  recoveryCodes?: string[];
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

// Ruling (d): the candidate secret is held out-of-band, server-side, and
// enableTotpForUser is only ever called with the secret this server generated —
// never with whatever a client resubmits in a form field. totp.ts deliberately
// has no pending-enrollment storage of its own, so this module owns it: the
// candidate is AES-GCM-encrypted with the same encryptTotpSecret/decryptTotpSecret
// helpers used for the at-rest secret, stashed in a short-lived httpOnly cookie,
// and discarded once enrollment is confirmed (or abandoned past its TTL).
const PENDING_TOTP_COOKIE = 'bt_pending_totp';
const PENDING_TOTP_TTL_SECONDS = 10 * 60;

const confirmTotpSchema = z.object({
  code: z.string().trim().regex(/^\d{6,8}$/, 'Enter the code from your authenticator app.'),
});

async function stashPendingTotpSecret(secret: string): Promise<void> {
  const store = await cookies();
  store.set(PENDING_TOTP_COOKIE, encryptTotpSecret(secret), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: PENDING_TOTP_TTL_SECONDS,
  });
}

async function readPendingTotpSecret(): Promise<string | null> {
  const store = await cookies();
  const raw = store.get(PENDING_TOTP_COOKIE)?.value;
  if (!raw) return null;
  try {
    return decryptTotpSecret(raw);
  } catch {
    // Expired/corrupt/rotated-SECRET_KEY: treat as "no pending enrollment", not a crash.
    return null;
  }
}

async function clearPendingTotpSecret(): Promise<void> {
  const store = await cookies();
  store.delete(PENDING_TOTP_COOKIE);
}

export async function changePasswordAction(_prev: ProfileFormState, formData: FormData): Promise<ProfileFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const parsed = z
    .object({ currentPassword: z.string().min(1), newPassword: passwordSchema })
    .safeParse({ currentPassword: formData.get('currentPassword') ?? '', newPassword: formData.get('newPassword') ?? '' });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };

  const record = findUserByUsername(user.username);
  if (!record || !(await verifyPassword(record.passwordHash, parsed.data.currentPassword))) {
    return { error: 'Current password is incorrect.' };
  }
  await setUserPassword(user.id, parsed.data.newPassword);

  // v1.12.1 (item Z / SEC-3). The two lines src/app/(auth)/change-password/actions.ts:55-56 has
  // always had, and this action never did. A captured session cookie -- a shared laptop, a lent
  // phone, plain HTTP on the LAN -- kept working for up to 30 more days after the victim's
  // instinctive remedy, because nothing deleted it. There is no session list in the UI, so this
  // was the only escape and it did not exist.
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (token) destroyOtherSessionsForUser(user.id, token);

  raiseAccountSecurityEvent({ userId: user.id, event: 'password_changed', at: new Date() });
  revalidatePath('/settings');
  return { message: 'Password updated. Every other session was signed out.' };
}

export async function beginTotpEnrollmentAction(): Promise<ProfileFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const secret = generateTotpSecret();
  await stashPendingTotpSecret(secret);
  const qrDataUri = await totpQrDataUri(totpKeyUri(user.username, secret));
  return { enrollment: { secret, qrDataUri } };
}

export async function confirmTotpEnrollmentAction(_prev: ProfileFormState, formData: FormData): Promise<ProfileFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const parsed = confirmTotpSchema.safeParse({ code: formData.get('code') ?? '' });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };
  }
  const secret = await readPendingTotpSecret();
  if (!secret) {
    return { error: 'That enrollment expired. Start over and scan a fresh QR code.' };
  }
  // v1.12.1 (item BF / SEC-10), carried into v1.13.0: verify-then-spend, the same pair
  // login's own MFA challenge uses, so the code shown during enrollment cannot be observed
  // (screenshotted, shoulder-surfed) and replayed a second time.
  //
  // Task 14 fix round 1: verify and CONSUME the counter before anything is written. The
  // previous order called enableTotpForUser() first, so a refused replay (consumeTotpCounter
  // returning false) still left MFA switched on with zero recovery codes generated -- a
  // half-applied enrollment that locked the account's second factor to a state nothing else in
  // this flow ever produces. Nothing below this point runs unless the counter was actually
  // spent successfully.
  const counter = verifyTotpCounter(secret, parsed.data.code);
  if (counter === null) {
    return { error: 'That code did not match. Try the next one your app shows.' };
  }
  if (!consumeTotpCounter(user.id, counter)) {
    return { error: 'That code was already used. Try the next one your app shows.' };
  }
  enableTotpForUser(user.id, secret);
  await clearPendingTotpSecret();
  const codes = generateRecoveryCodes();
  storeRecoveryCodes(user.id, codes);
  revalidatePath('/settings');
  return { message: 'Two-factor authentication is on. Save these recovery codes now.', recoveryCodes: codes };
}

/**
 * v1.12.1 (item AA / SEC-4). This took no password, no current code and no confirmation beyond a
 * button click, so anyone at an unlocked browser -- or holding a stolen session cookie -- could
 * strip the account's second factor in one click and convert a temporary foothold into a durable
 * one, with the owner never told. Enrollment is done carefully by comparison: the candidate secret
 * is held server-side in an encrypted, short-lived cookie precisely so a client cannot supply its
 * own. The teardown was the unprotected half of the pair.
 *
 * Three changes, matching what the ADMIN MFA reset already does
 * (src/app/(app)/settings/users/actions.ts:96): the current password is verified with the same
 * block changePasswordAction uses, every other session is destroyed, and the owner is told.
 */
export async function disableTotpAction(_prev: ProfileFormState, formData: FormData): Promise<ProfileFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const parsed = z
    .object({ currentPassword: z.string().min(1, 'Enter your current password.') })
    .safeParse({ currentPassword: formData.get('currentPassword') ?? '' });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Enter your current password.' };

  const record = findUserByUsername(user.username);
  if (!record || !(await verifyPassword(record.passwordHash, parsed.data.currentPassword))) {
    return { error: 'Current password is incorrect.' };
  }

  clearTotpEnrollment(user.id);
  await clearPendingTotpSecret();

  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (token) destroyOtherSessionsForUser(user.id, token);

  raiseAccountSecurityEvent({ userId: user.id, event: 'mfa_disabled', at: new Date() });
  revalidatePath('/settings');
  return { message: 'Two-factor authentication is off. Every other session was signed out.' };
}

/**
 * F-09's per-row "Sign out" (Settings -> Sessions). `sessionId` is the opaque id
 * listSessionsForUser handed the page -- sessions.tokenHash, never a raw token -- so this action
 * never receives, holds or logs anything that could itself sign somebody in.
 *
 * destroySessionForUser is scoped to THIS caller's own userId, so posting another member's
 * session id (guessed, or read out of a shared browser's history) deletes nothing rather than
 * ending a stranger's session -- the same ownership check every other per-row action in this
 * file already makes, just against sessions instead of a household table.
 *
 * Ending your OWN current device is allowed -- it is simply what "sign out" on this row means --
 * and is the one case that must also clear the browser's cookie and leave the page, matching
 * what /api/auth/logout already does for the "Log out everywhere" button beside this list.
 * Ending any OTHER row must never touch the caller's own cookie or session, which is why the
 * comparison below is against the CURRENT session's own hash, not against the row being deleted.
 */
export async function signOutSessionAction(_prev: ProfileFormState, formData: FormData): Promise<ProfileFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const sessionId = String(formData.get('sessionId') ?? '').trim();
  if (sessionId.length === 0) return { error: 'Choose a device to sign out.' };

  const store = await cookies();
  const currentToken = store.get(SESSION_COOKIE_NAME)?.value ?? null;
  const isCurrentDevice = currentToken !== null && hashSessionToken(currentToken) === sessionId;

  destroySessionForUser(user.id, sessionId);

  if (isCurrentDevice) {
    await clearSessionCookie();
    redirect('/login');
  }

  revalidatePath('/settings');
  return { message: 'That device was signed out.' };
}

export interface UpdateActionState {
  error?: string;
  message?: string;
  /**
   * Task 3d (symptom A). The design bet, recorded in the v1.13.1 comment below, was that Next
   * re-streams fresh server-component props as part of the action response. The owner's report
   * is that on this install they do not arrive: Check now says a version is available while the
   * card header still reads "Up to date" until the page is reloaded by hand.
   *
   * Rather than spend time proving WHY the props do not arrive — force-dynamic semantics, the
   * reverse proxy in front of the NAS, or something else entirely, none of it knowable from
   * source — these six fields let the two actions that change availability hand the client
   * exactly what they just wrote, so updates-client.tsx's resolveView() has a second, always-
   * fresh source to prefer over whatever props it was last rendered with. Optional, because
   * enableUpdateChecksAction/disableUpdateChecksAction/dismissUpdateAction still return only
   * { message } or { error } — only checkForUpdateNowAction and applyUpdateAction populate
   * these, and only AFTER their own write.
   */
  latestVersion?: string | null;
  latestPublishedAt?: string | null;
  lastCheckedAt?: string | null;
  severity?: UpdateSeverity;
  applyRequestedVersion?: string | null;
  applyRequestedAt?: string | null;
}

/**
 * Task 3d: the same severity/availability computation UpdatesCard's server component does
 * (parseSemver + classify against APP_VERSION), read straight from readUpdateState() so a
 * caller can hand the client the state it just committed. Callers must invoke this AFTER their
 * own write — recordCheckOutcome / recordApplyRequested / reconcilePendingApply — never before,
 * or it would hand back the stale state this whole task exists to stop happening.
 */
function currentAvailability(): Pick<
  UpdateActionState,
  'latestVersion' | 'latestPublishedAt' | 'lastCheckedAt' | 'severity' | 'applyRequestedVersion' | 'applyRequestedAt'
> {
  const state = readUpdateState();
  const current = parseSemver(APP_VERSION);
  const remote = state.latestVersion === null ? null : parseSemver(state.latestVersion);
  const severity: UpdateSeverity = current !== null && remote !== null ? classify(current, remote) : 'none';
  return {
    latestVersion: state.latestVersion,
    latestPublishedAt: state.latestPublishedAt,
    lastCheckedAt: state.lastCheckedAt,
    severity,
    applyRequestedVersion: state.applyRequestedVersion,
    applyRequestedAt: state.applyRequestedAt,
  };
}

export interface ReviewUpdateState {
  error?: string;
  release?: ChangelogRelease;
  version?: string;
}

const UPDATE_PATH = '/settings';
const STALE_VERSION_ERROR = 'That version is no longer the one on offer. Press Check now and read the notes again.';
const NO_UPDATE_ERROR = 'There is no update on offer right now.';

/**
 * MUST-10.3 (the ownership rule): no update action accepts a userId. The only parameters any
 * of them take are `enabled` (a checkbox) and `version` (a semver string), and the version is
 * re-checked against the server's own state before anything acts on it (MUST-9.7).
 */
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/, 'That is not a version this app can act on.');

/**
 * MUST-10.2: origin FIRST, before auth, before validation, before any read — exactly the
 * shape settings/notifications/actions.ts's guard() uses.
 */
async function updateGuard(): Promise<UpdateActionState | null> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  return null;
}

/**
 * v1.13.1 (item H). All five take (prevState, formData) — including the three that read
 * neither — so updates-client.tsx can hand React the server action ITSELF rather than an inline
 * async closure. A closure defined in a 'use client' module is a client function, so React never
 * processes a server-action response for it: revalidatePath below invalidated the server cache
 * while the client kept the props from the original render, and the availability UI is driven by
 * props, not by the message these return. reviewUpdateAction keeps its own shape — it revalidates
 * nothing and returns a different state type.
 */
export async function enableUpdateChecksAction(_prev: UpdateActionState, formData: FormData): Promise<UpdateActionState> {
  const blocked = await updateGuard();
  if (blocked) return blocked;
  const user = await requireAdmin();
  // MUST-10.3: the caller's id comes from the session, never from a field.
  setUpdateChecksEnabled({ enabled: true, userId: user.id });
  revalidatePath(UPDATE_PATH);
  return { message: 'Update checks are on. This app will ask GitHub once a day whether a newer version is published.' };
}

export async function disableUpdateChecksAction(_prev: UpdateActionState, formData: FormData): Promise<UpdateActionState> {
  const blocked = await updateGuard();
  if (blocked) return blocked;
  const user = await requireAdmin();
  // MUST-3.4: this wipes every update. key but the flag. Off means off.
  setUpdateChecksEnabled({ enabled: false, userId: user.id });
  revalidatePath(UPDATE_PATH);
  return { message: 'Update checks are off. Nothing about updates leaves this machine now.' };
}

export async function setAutoApplyAction(_prev: UpdateActionState, formData: FormData): Promise<UpdateActionState> {
  const blocked = await updateGuard();
  if (blocked) return blocked;
  await requireAdmin();
  if (!readUpdateState().enabled) return { error: 'Turn update checks on first.' };
  // An HTML checkbox posts 'on' when ticked and nothing at all when not.
  setAutoApply(formData.get('autoApply') !== null);
  revalidatePath(UPDATE_PATH);
  return { message: 'Saved.' };
}

export async function checkForUpdateNowAction(_prev: UpdateActionState, formData: FormData): Promise<UpdateActionState> {
  const blocked = await updateGuard();
  if (blocked) return blocked;
  await requireAdmin();
  if (!readUpdateState().enabled) return { error: 'Turn update checks on first.' };

  // MUST-10.9: quota is spent only once every configuration guard has passed.
  const verdict = checkUpdateCheckNow();
  if (!verdict.allowed) return { error: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.` };

  // MUST-5.6 / MUST-10.5 / MUST-10.6: a manual check ignores the daily interval but still
  // refreshes the stamp, and still applies a small update when auto-apply is on. Pressing
  // Check now on an install configured to install small updates automatically installs the
  // small update; anything else would be a surprising second policy.
  const result = await runUpdateCheck({ now: new Date(), manual: true });
  revalidatePath(UPDATE_PATH);
  // Task 3d (symptom A): read AFTER runUpdateCheck's writes, so this reflects exactly what the
  // check just committed rather than the render that is about to go stale again.
  const availability = currentAvailability();
  if (result.error !== null) return { error: result.error, ...availability };
  if (result.applied) return { message: `Version ${result.latestVersion} is being installed now.`, ...availability };
  if (result.latestVersion === null) return { message: 'You are on the newest published version.', ...availability };
  return { message: `Version ${result.latestVersion} is available.`, ...availability };
}

/**
 * MUST-10.2: this action mutates nothing and does not revalidate — but it takes the STRICT
 * isSameOrigin(), not the relaxed isSameOriginOrHeaderless(), because it causes outbound
 * egress on the server. Same reasoning notify MUST-12.8 gives for detectTelegramChatIdAction.
 */
export async function reviewUpdateAction(formData: FormData): Promise<ReviewUpdateState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireAdmin();

  const parsed = versionSchema.safeParse(String(formData.get('version') ?? ''));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  const state = readUpdateState();
  if (state.latestVersion === null) return { error: NO_UPDATE_ERROR };
  if (state.latestVersion !== parsed.data) return { error: STALE_VERSION_ERROR };

  const verdict = checkUpdateReview();
  if (!verdict.allowed) return { error: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.` };

  try {
    const markdown = await fetchRemoteChangelog(parsed.data);
    const release = parseChangelog(markdown).find((entry) => entry.heading.startsWith(`[${parsed.data}]`));
    // MUST-9.6: a failed or missing changelog must not become a wall that stops an admin
    // updating — the panel renders its fallback sentence and still offers the confirm button.
    if (release === undefined) return { version: parsed.data };
    return { version: parsed.data, release: boundRelease(release) };
  } catch {
    return { version: parsed.data };
  }
}

export async function applyUpdateAction(_prev: UpdateActionState, formData: FormData): Promise<UpdateActionState> {
  const blocked = await updateGuard();
  if (blocked) return blocked;
  await requireAdmin();

  const parsed = versionSchema.safeParse(String(formData.get('version') ?? ''));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };

  const state = readUpdateState();
  if (!state.enabled) return { error: 'Turn update checks on first.' };
  if (state.latestVersion === null) return { error: NO_UPDATE_ERROR };
  // MUST-9.7: the version travels in the form so a stale tab cannot install a version its
  // reader never saw — and it is checked against the server's own state, never trusted.
  if (state.latestVersion !== parsed.data) return { error: STALE_VERSION_ERROR };
  // MUST-10.9: no Watchtower means no apply path, and burning apply quota while doing
  // nothing would be the wrong order.
  if (watchtowerConfig() === null) return { error: 'This install has no Watchtower companion to ask.' };

  try {
    const result = await applyUpdate({ version: parsed.data, now: new Date() });
    revalidatePath(UPDATE_PATH);
    // Task 3d (symptom A): read AFTER applyUpdate's write, same reasoning as
    // checkForUpdateNowAction above.
    const availability = currentAvailability();
    // Fix round finding 4 (round 3): the APPLY bucket now lives inside applyUpdate() itself —
    // the single choke point every triggerUpdate() call passes through — rather than in a
    // duplicate check here. This is the same "Too many attempts" sentence that local check
    // used to return, just sourced from applyUpdate()'s own verdict now.
    if (result.outcome === 'rate-limited') {
      return { error: `Too many attempts. Try again in ${result.retryAfterMinutes} minutes.`, ...availability };
    }
    // Task 3d (symptom B): applyUpdate()'s single-flight guard fired — this exact request was
    // already recorded as in flight by an earlier submit (a double-click, a second tab, a
    // stale form resubmit). Map it to the SAME sentence the pending notice in
    // updates-client.tsx renders (pendingApplyMessage below), so a duplicate submit never
    // reads as either a fresh failure or a fresh success — it is neither, the first request is
    // still the one in flight.
    if (result.outcome === 'already-pending') {
      return { message: pendingApplyMessage(parsed.data), ...availability };
    }
    // MUST-9.8: two of the three fixed sentences. The third is the scrubbed error below.
    return {
      message:
        result.outcome === 'accepted'
          ? `Update requested. Watchtower is pulling ${parsed.data} and will restart this app in a moment. Reload this page in a minute or two.`
          : `Update requested. This app is being replaced right now, so it could not wait for a reply. Reload this page in a minute or two — the version at the bottom of this card will tell you whether it worked.`,
      ...availability,
    };
  } catch (error) {
    revalidatePath(UPDATE_PATH);
    const availability = currentAvailability();
    // MUST-7.3 / MUST-10.11: this is the ORIGINAL error applyUpdate() re-throws, not a
    // scrubbed copy — applyUpdate() only scrubs the copy it persists to
    // update.last_apply_error, before re-throwing the error it caught unchanged. The actual
    // guarantee lives further upstream, in watchtower.ts's triggerUpdate(): every message it
    // can throw already passed through its clean()/scrubSecrets call at the point of the
    // throw, so nothing reaching here ever carried the token to begin with.
    return { error: error instanceof Error ? error.message : 'The update could not be requested.', ...availability };
  }
}

/**
 * Task 3d (symptom B): the literal sentence updates-client.tsx's pending notice renders for the
 * exact same condition (an apply already in flight for this version). Duplicated rather than
 * shared, because a 'use server' file may only export async functions — there is no way to
 * hand a plain string-builder across that boundary. Keep the two wordings in lockstep.
 */
function pendingApplyMessage(version: string): string {
  return `Watchtower is pulling ${version}. This page will stop responding for a minute while the container restarts, then come back on the new version. Reload in a minute or two. If this card still says v${APP_VERSION} after 30 minutes, the update did not land and the reason will appear here.`;
}

/** §9.3 item 6 / MUST-5.9. Suppresses only the card's prominence — never the check, never the dedup. */
export async function dismissUpdateAction(_prev: UpdateActionState, formData: FormData): Promise<UpdateActionState> {
  const blocked = await updateGuard();
  if (blocked) return blocked;
  await requireAdmin();
  const raw = String(formData.get('version') ?? '');
  if (raw.length === 0) {
    dismissVersion('');
    revalidatePath(UPDATE_PATH);
    return { message: 'Showing this again.' };
  }
  const parsed = versionSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  // Fix round finding 2: the same two checks applyUpdateAction runs, in the same order.
  // Without them, a stale tab (or a forged field) could pre-dismiss a version that has not
  // been offered yet — including one not yet published — which would silently swallow
  // MUST-5.9's notice the moment that version actually became current.
  const state = readUpdateState();
  if (state.latestVersion === null) return { error: NO_UPDATE_ERROR };
  if (state.latestVersion !== parsed.data) return { error: STALE_VERSION_ERROR };
  dismissVersion(parsed.data);
  revalidatePath(UPDATE_PATH);
  return { message: `Skipping ${parsed.data} for now. You will still be told when a newer version is published.` };
}
