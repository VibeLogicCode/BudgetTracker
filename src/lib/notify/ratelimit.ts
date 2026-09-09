import type { Channel } from '@/lib/notify/events';

/**
 * MUST-13.1 / MUST-13.1a: in-memory token buckets for the two user-triggered egress
 * buttons.
 *
 * MUST-13.2: in-memory rather than DB-backed, unlike src/lib/auth/ratelimit.ts. Different
 * threat: the login limiter defends against an unauthenticated attacker who can retry
 * across restarts, while these bound an authenticated household member's misclicks and a
 * stuck form. A restart resetting the bucket is acceptable, and a member cannot restart
 * the container (§19.13).
 */
export const TEST_SEND_WINDOW_MS = 10 * 60_000;
export const TEST_SEND_MAX_PER_USER = 3; // per (userId, channel)
export const TEST_SEND_MAX_GLOBAL = 10; // across all users and channels

export const DETECT_CHAT_WINDOW_MS = 10 * 60_000;
export const DETECT_CHAT_MAX_PER_USER = 10; // per userId, and NO global cap

/**
 * 2026-09-08. The "Send me a summary now" button on the dashboard (spec:
 * docs/superpowers/specs/2026-09-08-manual-digest-send-design.md). A third bucket rather than a
 * reuse of checkTestSend, for two reasons that pull in opposite directions and both matter.
 *
 * TIGHTER than a test send in what it costs. A test send is one short message; a manual digest
 * runs categoryBreakdown, topMerchants, budgetProgress and reviewQueueCount, and -- when the
 * household option is picked -- the per-member queries in buildHouseholdDigest on top. Sharing
 * the test-send bucket would let ten of those run in ten minutes.
 *
 * LOOSER in the shape of legitimate use. Somebody checking "did the household actually get that"
 * presses this once and waits; nobody has a reason to press it four times in a row the way they
 * do with Detect chat ID. Three in the hour is generous for real use and still bounds a stuck
 * form.
 *
 * A GLOBAL cap, like the test send's and for the same reason: the household digest goes out over
 * a shared Brevo allowance and a shared bot, which one enthusiastic member can exhaust for
 * everyone.
 */
export const MANUAL_DIGEST_WINDOW_MS = 60 * 60_000;
export const MANUAL_DIGEST_MAX_PER_USER = 3;
export const MANUAL_DIGEST_MAX_GLOBAL = 8;

export interface RateVerdict {
  allowed: boolean;
  retryAfterMinutes: number;
}

/** MUST-13.3: the seam, so both windows are testable without real waiting. */
let clock: () => number = () => Date.now();

export function setNotifyRateLimitClockForTests(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

const testSendByUser = new Map<string, number[]>();
const testSendGlobal: number[] = [];
const detectByUser = new Map<number, number[]>();
const manualDigestByUser = new Map<number, number[]>();
const manualDigestGlobal: number[] = [];

export function resetNotifyRateLimitsForTests(): void {
  testSendByUser.clear();
  testSendGlobal.length = 0;
  detectByUser.clear();
  manualDigestByUser.clear();
  manualDigestGlobal.length = 0;
}

function prune(stamps: number[], now: number, windowMs: number): void {
  while (stamps.length > 0 && (stamps[0] as number) <= now - windowMs) stamps.shift();
}

function verdict(stamps: number[], now: number, windowMs: number): RateVerdict {
  const oldest = stamps[0] ?? now;
  const waitMs = Math.max(0, oldest + windowMs - now);
  return { allowed: false, retryAfterMinutes: Math.max(1, Math.ceil(waitMs / 60_000)) };
}

/** Consumes a token when it returns allowed; the caller then sends nothing on a refusal. */
export function checkTestSend(userId: number, channel: Channel, now: number = clock()): RateVerdict {
  const key = `${userId}:${channel}`;
  const perUser = testSendByUser.get(key) ?? [];
  prune(perUser, now, TEST_SEND_WINDOW_MS);
  prune(testSendGlobal, now, TEST_SEND_WINDOW_MS);

  if (perUser.length >= TEST_SEND_MAX_PER_USER) {
    testSendByUser.set(key, perUser);
    return verdict(perUser, now, TEST_SEND_WINDOW_MS);
  }
  // The global cap exists because a household's Brevo free tier and a Telegram bot's
  // per-minute allowance are shared resources one enthusiastic member can exhaust for
  // everyone (MUST-13.1).
  if (testSendGlobal.length >= TEST_SEND_MAX_GLOBAL) {
    testSendByUser.set(key, perUser);
    return verdict(testSendGlobal, now, TEST_SEND_WINDOW_MS);
  }

  perUser.push(now);
  testSendGlobal.push(now);
  testSendByUser.set(key, perUser);
  return { allowed: true, retryAfterMinutes: 0 };
}

/**
 * MUST-13.1a: a separate, LOOSER bucket. Detect chat ID is genuinely expected to be
 * pressed several times in a row ("press it, realise you never messaged the bot, message
 * the bot, press it again"), so a cap of three would punish correct use. No global cap:
 * each user's presses hit their own bot, so there is no shared resource to protect.
 */
/**
 * 2026-09-08. Same consume-on-allow contract as checkTestSend: the caller enqueues nothing on a
 * refusal, and a refusal costs no queries -- the action checks this BEFORE evaluateWeeklyDigest,
 * which is the whole point of limiting the expensive one.
 */
export function checkManualDigest(userId: number, now: number = clock()): RateVerdict {
  const perUser = manualDigestByUser.get(userId) ?? [];
  prune(perUser, now, MANUAL_DIGEST_WINDOW_MS);
  prune(manualDigestGlobal, now, MANUAL_DIGEST_WINDOW_MS);

  if (perUser.length >= MANUAL_DIGEST_MAX_PER_USER) {
    manualDigestByUser.set(userId, perUser);
    return verdict(perUser, now, MANUAL_DIGEST_WINDOW_MS);
  }
  if (manualDigestGlobal.length >= MANUAL_DIGEST_MAX_GLOBAL) {
    manualDigestByUser.set(userId, perUser);
    return verdict(manualDigestGlobal, now, MANUAL_DIGEST_WINDOW_MS);
  }

  perUser.push(now);
  manualDigestGlobal.push(now);
  manualDigestByUser.set(userId, perUser);
  return { allowed: true, retryAfterMinutes: 0 };
}

export function checkDetectChat(userId: number, now: number = clock()): RateVerdict {
  const stamps = detectByUser.get(userId) ?? [];
  prune(stamps, now, DETECT_CHAT_WINDOW_MS);
  if (stamps.length >= DETECT_CHAT_MAX_PER_USER) {
    detectByUser.set(userId, stamps);
    return verdict(stamps, now, DETECT_CHAT_WINDOW_MS);
  }
  stamps.push(now);
  detectByUser.set(userId, stamps);
  return { allowed: true, retryAfterMinutes: 0 };
}
