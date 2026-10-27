import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readEnv } from '@/lib/env';

/**
 * v1.58.1: a signed "this browser has signed in as that user before" marker. It never authenticates
 * anything; the sign-in lockout reads it only to choose which failure bucket applies.
 */
export const KNOWN_DEVICE_COOKIE_NAME = 'bt_device';
export const KNOWN_DEVICE_MAX_ENTRIES = 5;
export const KNOWN_DEVICE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
const MAX_VALUE_LENGTH = 1024;
const HKDF_INFO = 'budget-tracker known-device v1';
const ENTRY_SEPARATOR = '~';
const ENTRY = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

function deviceKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(readEnv().secretKey, 'utf8'), Buffer.alloc(0), Buffer.from(HKDF_INFO, 'utf8'), 32));
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function macFor(username: string, deviceId: string): string {
  return createHmac('sha256', deviceKey()).update(`${normalizeUsername(username)}\n${deviceId}`).digest('base64url');
}

function parseEntries(value: string | undefined): { deviceId: string; mac: string }[] {
  if (!value || value.length > MAX_VALUE_LENGTH) return [];
  const entries: { deviceId: string; mac: string }[] = [];
  for (const part of value.split(ENTRY_SEPARATOR)) {
    const match = ENTRY.exec(part);
    if (match) entries.push({ deviceId: match[1], mac: match[2] });
  }
  return entries;
}

function macMatches(username: string, entry: { deviceId: string; mac: string }): boolean {
  const expected = Buffer.from(macFor(username, entry.deviceId));
  const given = Buffer.from(entry.mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The device id of an entry that was minted for this username, or null. */
export function knownDeviceFor(cookieValue: string | undefined, username: string): string | null {
  for (const entry of parseEntries(cookieValue)) {
    if (macMatches(username, entry)) return entry.deviceId;
  }
  return null;
}

/** The cookie value to store after a full sign-in: this user's device id first, other entries kept, at most five. */
export function withKnownDevice(cookieValue: string | undefined, username: string): string {
  const entries = parseEntries(cookieValue);
  const existing = knownDeviceFor(cookieValue, username);
  const deviceId = existing ?? randomBytes(16).toString('base64url');
  const first = `${deviceId}.${macFor(username, deviceId)}`;
  const rest = entries.filter((entry) => entry.deviceId !== deviceId).map((entry) => `${entry.deviceId}.${entry.mac}`);
  return [first, ...rest].slice(0, KNOWN_DEVICE_MAX_ENTRIES).join(ENTRY_SEPARATOR);
}
