import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomInt } from 'node:crypto';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { totpRecoveryCodes, users } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { readEnv } from '@/lib/env';

export const TOTP_HKDF_INFO = 'totp-v1';
export const TOTP_ISSUER = 'Budget Tracker';
export const RECOVERY_CODE_COUNT = 8;
export const RECOVERY_CODE_LENGTH = 16;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * otplib defaults: SHA-1, 6 digits, 30 s step. Spec requires +/-1 step tolerance.
 * A module-local clone avoids mutating otplib's shared singleton (`authenticator.options = ...`
 * would silently widen the replay window for any other module that touches the default instance).
 */
const totp = authenticator.clone({ window: 1 });

/**
 * The step, spelled out, because v1.12.1 does counter arithmetic against it and a magic 30 in two
 * places is a 30 that can disagree with itself. It matches the clone above -- otplib's default and
 * RFC 6238's -- and changing one without the other would make every stored counter wrong.
 */
export const TOTP_STEP_SECONDS = 30;

export function deriveTotpKey(secretKey: string = readEnv().secretKey): Buffer {
  // Salt is empty by design: SECRET_KEY is already high-entropy and per-install.
  const derived = hkdfSync('sha256', Buffer.from(secretKey, 'utf8'), Buffer.alloc(0), Buffer.from(TOTP_HKDF_INFO, 'utf8'), 32);
  return Buffer.from(derived);
}

/** base64( iv[12] || tag[16] || ciphertext ) */
export function encryptTotpSecret(plain: string, secretKey?: string): string {
  const key = deriveTotpKey(secretKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptTotpSecret(payload: string, secretKey?: string): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('malformed TOTP payload');
  }
  const key = deriveTotpKey(secretKey);
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function generateTotpSecret(): string {
  return totp.generateSecret();
}

export function totpKeyUri(username: string, secret: string, issuer: string = TOTP_ISSUER): string {
  return totp.keyuri(username, issuer, secret);
}

/** otplib has a first-class epoch option — prefer a per-call clone over monkeypatching Date.now. */
function totpAt(at: Date | undefined): typeof totp {
  return at ? totp.clone({ epoch: at.getTime() }) : totp;
}

export function currentTotpToken(secret: string, at?: Date): string {
  return totpAt(at).generate(secret);
}

export function verifyTotp(secret: string, token: string, at?: Date): boolean {
  const cleaned = token.replace(/\s+/g, '');
  if (!/^\d{6,8}$/.test(cleaned)) return false;
  try {
    return totpAt(at).check(cleaned, secret);
  } catch {
    return false;
  }
}

/**
 * Like verifyTotp, but returns WHICH time step the accepted code belongs to -- or null if it does
 * not verify at all.
 *
 * v1.12.1 (item BF / SEC-10). `window: 1` means a code is accepted for roughly 90 seconds and
 * nothing recorded that one had been spent, so a code observed in that window -- shoulder-surfed,
 * screenshotted into a chat, relayed by a phishing page -- could be replayed on a second login.
 * Recovery codes were already single-use, via an atomic conditional UPDATE (consumeRecoveryCode
 * below), which is the pattern this pair copies: verify here, spend in consumeTotpCounter.
 *
 * checkDelta is otplib's own API for this (@otplib/core's Authenticator) and returns the offset in
 * steps -- -1, 0 or 1 under `window: 1` -- so the counter is the current step plus that offset.
 * Deriving it by re-generating three candidate tokens and comparing would be the same arithmetic
 * with a hand-rolled comparison in the middle of it.
 *
 * Pure: no database read, no write. The spending is a separate call, so a caller cannot
 * accidentally consume a counter while merely checking one.
 */
export function verifyTotpCounter(secret: string, token: string, at?: Date): number | null {
  const cleaned = token.replace(/\s+/g, '');
  if (!/^\d{6,8}$/.test(cleaned)) return null;
  try {
    const delta = totpAt(at).checkDelta(cleaned, secret);
    if (delta === null) return null;
    const epochMs = at ? at.getTime() : Date.now();
    return Math.floor(epochMs / 1000 / TOTP_STEP_SECONDS) + delta;
  } catch {
    return null;
  }
}

/**
 * Records a TOTP counter as spent, atomically. Returns false when it -- or a later one -- was
 * already recorded, which is a replay.
 *
 * The conditional UPDATE is the whole guard, exactly as it is in consumeRecoveryCode: two logins
 * racing with the same code both reach this, SQLite serialises the writes, and only one of them
 * sees changes === 1. Doing it as a read-then-write would leave that race open.
 *
 * NULL means nothing has been accepted yet -- true for every row that existed before migration
 * 0012 and for anyone who has never enrolled -- so the first code any user presents is always
 * accepted and no backfill is needed.
 */
export function consumeTotpCounter(userId: number, counter: number): boolean {
  const result = getDb()
    .update(users)
    .set({ totpLastCounter: counter })
    .where(and(eq(users.id, userId), or(isNull(users.totpLastCounter), lt(users.totpLastCounter, counter))))
    .run();
  return Number(result.changes ?? 0) === 1;
}

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    let code = '';
    for (let i = 0; i < RECOVERY_CODE_LENGTH; i += 1) {
      code += BASE32_ALPHABET[randomInt(BASE32_ALPHABET.length)];
    }
    codes.add(code);
  }
  return [...codes];
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

export function storeRecoveryCodes(userId: number, codes: string[], at: Date = new Date()): void {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, userId)).run();
    for (const code of codes) {
      tx.insert(totpRecoveryCodes)
        .values({ userId, codeHash: hashRecoveryCode(code), usedAt: null, createdAt: nowIso(at) })
        .run();
    }
  });
}

export function consumeRecoveryCode(userId: number, code: string, at: Date = new Date()): boolean {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length === 0) return false;
  const result = getDb()
    .update(totpRecoveryCodes)
    .set({ usedAt: nowIso(at) })
    .where(
      and(
        eq(totpRecoveryCodes.userId, userId),
        eq(totpRecoveryCodes.codeHash, hashRecoveryCode(normalized)),
        isNull(totpRecoveryCodes.usedAt),
      ),
    )
    .run();
  return Number(result.changes ?? 0) === 1;
}

export function countUnusedRecoveryCodes(userId: number): number {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(totpRecoveryCodes)
    .where(and(eq(totpRecoveryCodes.userId, userId), isNull(totpRecoveryCodes.usedAt)))
    .get();
  return row?.c ?? 0;
}

export function enableTotpForUser(userId: number, secretPlain: string): void {
  getDb()
    .update(users)
    .set({ totpSecretEncrypted: encryptTotpSecret(secretPlain), totpEnabled: true })
    .where(eq(users.id, userId))
    .run();
}

export function getTotpSecretForUser(userId: number): string | null {
  const row = getDb()
    .select({ encrypted: users.totpSecretEncrypted, enabled: users.totpEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!row || !row.enabled || !row.encrypted) return null;
  return decryptTotpSecret(row.encrypted);
}

/** Admin "reset MFA": lost phone + lost codes must not mean permanent lockout. */
export function clearTotpEnrollment(userId: number): void {
  const db = getDb();
  db.transaction((tx) => {
    tx.update(users).set({ totpSecretEncrypted: null, totpEnabled: false }).where(eq(users.id, userId)).run();
    tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, userId)).run();
  });
}

export async function totpQrDataUri(keyUri: string): Promise<string> {
  return QRCode.toDataURL(keyUri, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
}
