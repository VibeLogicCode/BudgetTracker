import { getDb } from '@/db/client';
import { appendAudit } from '@/lib/audit';
import { nowIso } from '@/lib/clock';
import { deleteSetting, getSetting, setSetting } from '@/lib/settings';
import { LOCAL_AI_MODEL_NAME_ERROR, LocalAiAnswerError, LocalAiServerError, chatJson, listModels } from '@/lib/ai/client';
import { addressLabel, normalizeLocalAiBaseUrl } from '@/lib/ai/lan';
import { TEST_LABELS, TEST_PROMPT } from '@/lib/ai/prompts';
import { isModelName, merchantAnswer } from '@/lib/ai/schemas';
import { aiSuggestionCounts, clearFailedAiSuggestions } from '@/lib/ai/suggestions';
import type { LocalAiConfig, LocalAiStatus } from '@/lib/ai/types';

/**
 * v1.64.0 (plan 2026-11-12, L4 and L5). Local AI's settings and its backoff, as plain settings rows
 * (absence = off, the simplefin_auto_sync discipline). Nothing secret is stored: there is no key
 * field and an address carrying a user name is refused, so nothing here is encrypted. Turning it on,
 * changing the address or model, and turning it off each append one audit row, whose detail names
 * the model and the server's host and port, never a full address.
 */
export const SETTING_LOCAL_AI_ENABLED = 'local_ai_enabled';
export const SETTING_LOCAL_AI_BASE_URL = 'local_ai_base_url';
export const SETTING_LOCAL_AI_MODEL = 'local_ai_model';
export const SETTING_LOCAL_AI_FAILURES = 'local_ai_failures';
export const SETTING_LOCAL_AI_LAST_ATTEMPT_AT = 'local_ai_last_attempt_at';
export const SETTING_LOCAL_AI_LAST_ERROR = 'local_ai_last_error';
export const SETTING_LOCAL_AI_LAST_OK_AT = 'local_ai_last_ok_at';
export const SETTING_LOCAL_AI_UNREADABLE_STREAK = 'local_ai_unreadable_streak';

const STATE_KEYS = [
  SETTING_LOCAL_AI_FAILURES,
  SETTING_LOCAL_AI_LAST_ATTEMPT_AT,
  SETTING_LOCAL_AI_LAST_ERROR,
  SETTING_LOCAL_AI_LAST_OK_AT,
  SETTING_LOCAL_AI_UNREADABLE_STREAK,
] as const;

/** Five unreadable answers in a row count as one server failure. */
export const LOCAL_AI_UNREADABLE_LIMIT = 5;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
const MAX_LAST_ERROR_CHARS = 300;

export const LOCAL_AI_TURNED_OFF_DETAIL = 'Local AI turned off';

export function localAiOnDetail(config: LocalAiConfig): string {
  return `Local AI on: ${config.model} at ${addressLabel(config.baseUrl)}`;
}

// ---------------------------------------------------------------------------------- reading

/** The saved server and model when both are valid, whether or not the helper is on; otherwise null. */
export function readLocalAiConfig(): LocalAiConfig | null {
  const address = normalizeLocalAiBaseUrl(getSetting(SETTING_LOCAL_AI_BASE_URL) ?? '');
  const model = getSetting(SETTING_LOCAL_AI_MODEL);
  if (!address.ok || model === null || !isModelName(model)) return null;
  return { baseUrl: address.baseUrl, model };
}

/** The admin's switch. Suggestions already stored show while this is on, even while waiting. */
export function localAiEnabled(): boolean {
  return getSetting(SETTING_LOCAL_AI_ENABLED) === '1';
}

/** On, set up, and not waiting after failures: the only state in which a request may be made. */
export function localAiActive(now: Date = new Date()): boolean {
  return localAiEnabled() && readLocalAiConfig() !== null && localAiBackoff(now) === null;
}

// ---------------------------------------------------------------------------------- writing

export type SaveLocalAiResult = { ok: true; config: LocalAiConfig; changed: boolean } | { ok: false; error: string };

function clearLocalAiState(): void {
  for (const key of STATE_KEYS) deleteSetting(key);
}

/**
 * Checks the address (LAN only) and the model name, then turns the helper on with them. A new
 * address or model starts clean: the backoff and its last error go, and so do failed answers, so
 * those merchants are asked again. One audit row when anything changed, none when nothing did.
 */
export function saveLocalAiConfig(input: { baseUrl: string; model: string; userId: number; at?: Date }): SaveLocalAiResult {
  const address = normalizeLocalAiBaseUrl(input.baseUrl);
  if (!address.ok) return { ok: false, error: address.error };
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!isModelName(model)) return { ok: false, error: LOCAL_AI_MODEL_NAME_ERROR };
  const config: LocalAiConfig = { baseUrl: address.baseUrl, model };
  const at = input.at ?? new Date();
  const changed = getDb().transaction(() => {
    const wasOn = localAiEnabled();
    const targetChanged = getSetting(SETTING_LOCAL_AI_BASE_URL) !== config.baseUrl || getSetting(SETTING_LOCAL_AI_MODEL) !== config.model;
    setSetting(SETTING_LOCAL_AI_ENABLED, '1');
    setSetting(SETTING_LOCAL_AI_BASE_URL, config.baseUrl);
    setSetting(SETTING_LOCAL_AI_MODEL, config.model);
    if (targetChanged) {
      clearLocalAiState();
      clearFailedAiSuggestions();
    }
    const anything = targetChanged || !wasOn;
    if (anything) {
      appendAudit({ userId: input.userId, action: 'set_local_ai', entity: 'settings', entityId: 0, detail: localAiOnDetail(config), at: nowIso(at) });
    }
    return anything;
  });
  return { ok: true, config, changed };
}

/** Turns it off and keeps the address and model, so the form still holds them. Audited when it was on. */
export function turnOffLocalAi(input: { userId: number; at?: Date }): boolean {
  const at = input.at ?? new Date();
  return getDb().transaction(() => {
    if (!localAiEnabled()) return false;
    deleteSetting(SETTING_LOCAL_AI_ENABLED);
    appendAudit({ userId: input.userId, action: 'set_local_ai', entity: 'settings', entityId: 0, detail: LOCAL_AI_TURNED_OFF_DETAIL, at: nowIso(at) });
    return true;
  });
}

// ---------------------------------------------------------------------------------- backoff

/** 5 minutes after the first failure, doubling, never more than 6 hours (autoSyncBackoffMs' shape). */
export function localAiBackoffMs(failures: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return 0;
  // 2^7 x 5 min is already past the cap, so the exponent never needs to grow beyond that.
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(Math.floor(failures) - 1, 7), BACKOFF_MAX_MS);
}

function readCount(key: string): number {
  const parsed = Number.parseInt(getSetting(key) ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export interface LocalAiBackoff {
  failures: number;
  nextTryAt: Date;
}

/** Non-null while waiting. An unreadable attempt time reads as no wait, so a damaged key never stops it for good. */
export function localAiBackoff(now: Date = new Date()): LocalAiBackoff | null {
  const failures = readCount(SETTING_LOCAL_AI_FAILURES);
  if (failures === 0) return null;
  const lastAttempt = Date.parse(getSetting(SETTING_LOCAL_AI_LAST_ATTEMPT_AT) ?? '');
  if (!Number.isFinite(lastAttempt)) return null;
  const nextTryAt = lastAttempt + localAiBackoffMs(failures);
  return now.getTime() < nextTryAt ? { failures, nextTryAt: new Date(nextTryAt) } : null;
}

/** The server could not be used. `sentence` is the app's own (a LocalAiServerError's message). */
export function recordLocalAiFailure(at: Date, sentence: string): number {
  const failures = readCount(SETTING_LOCAL_AI_FAILURES) + 1;
  setSetting(SETTING_LOCAL_AI_FAILURES, String(failures));
  setSetting(SETTING_LOCAL_AI_LAST_ATTEMPT_AT, nowIso(at));
  setSetting(SETTING_LOCAL_AI_LAST_ERROR, sentence.slice(0, MAX_LAST_ERROR_CHARS));
  deleteSetting(SETTING_LOCAL_AI_UNREADABLE_STREAK);
  return failures;
}

/** The server answered. Clears the failure count, its last error and the unreadable streak. */
export function recordLocalAiSuccess(at: Date): void {
  deleteSetting(SETTING_LOCAL_AI_FAILURES);
  deleteSetting(SETTING_LOCAL_AI_LAST_ERROR);
  deleteSetting(SETTING_LOCAL_AI_UNREADABLE_STREAK);
  setSetting(SETTING_LOCAL_AI_LAST_ATTEMPT_AT, nowIso(at));
  setSetting(SETTING_LOCAL_AI_LAST_OK_AT, nowIso(at));
}

/** One more unreadable answer in a row. Returns the streak; at LOCAL_AI_UNREADABLE_LIMIT the caller records a failure. */
export function recordUnreadableAnswer(): number {
  const streak = readCount(SETTING_LOCAL_AI_UNREADABLE_STREAK) + 1;
  setSetting(SETTING_LOCAL_AI_UNREADABLE_STREAK, String(streak));
  return streak;
}

// ---------------------------------------------------------------------------------- status

export function localAiStatus(now: Date = new Date()): LocalAiStatus {
  const backoff = localAiBackoff(now);
  const on = localAiEnabled() && readLocalAiConfig() !== null;
  return {
    state: !on ? 'off' : backoff !== null ? 'waiting' : 'on',
    lastOkAt: getSetting(SETTING_LOCAL_AI_LAST_OK_AT),
    nextTryAt: backoff === null ? null : nowIso(backoff.nextTryAt),
    failures: readCount(SETTING_LOCAL_AI_FAILURES),
    lastError: getSetting(SETTING_LOCAL_AI_LAST_ERROR),
    counts: aiSuggestionCounts(),
  };
}

// ---------------------------------------------------------------------------------- the Test button

/**
 * Settings' Test, with the posted (unsaved) values. Asks the server for its models, then asks the
 * model about a made-up row (TEST_PROMPT), so no household data leaves on a test. Writes no setting,
 * no state, no suggestion and no audit row.
 */
export async function testLocalAiConnection(input: { baseUrl: string; model: string }, _now: Date = new Date()): Promise<{ ok: boolean; message: string }> {
  const address = normalizeLocalAiBaseUrl(input.baseUrl);
  if (!address.ok) return { ok: false, message: address.error };
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!isModelName(model)) return { ok: false, message: LOCAL_AI_MODEL_NAME_ERROR };
  const config: LocalAiConfig = { baseUrl: address.baseUrl, model };
  try {
    const listed = await listModels(config);
    const answer = merchantAnswer(TEST_LABELS);
    const { content, ms } = await chatJson({ config, prompt: TEST_PROMPT, schemaName: 'merchant_suggestion', jsonSchema: answer.jsonSchema });
    if (!answer.zodSchema.safeParse(content).success) {
      return { ok: false, message: `${model} answered, but not in the shape the app asked for. Try a different model.` };
    }
    const seconds = Math.max(ms / 1000, 0.1).toFixed(1);
    if (!listed.includes(model)) return { ok: true, message: `The server does not list ${model}; it answered anyway.` };
    return { ok: true, message: `${model} answered in ${seconds} seconds.` };
  } catch (error) {
    if (error instanceof LocalAiServerError) return { ok: false, message: error.message };
    if (error instanceof LocalAiAnswerError) return { ok: false, message: `${model} answered, but not in the shape the app asked for. Try a different model.` };
    return { ok: false, message: 'The test failed unexpectedly.' };
  }
}
