import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { settings } from '@/db/schema';

export const SETTING_BAYES_VOCAB_SIZE = 'bayes_vocab_size';
export const SETTING_BACKUP_RETENTION = 'backup_retention';
/** When the nightly backup last failed (ISO instant) and why. Both absent once a run succeeds. */
export const SETTING_BACKUP_LAST_FAILURE_AT = 'backup_last_failure_at';
export const SETTING_BACKUP_LAST_FAILURE_REASON = 'backup_last_failure_reason';

export function getSetting(key: string): string | null {
  const row = getDb().select().from(settings).where(eq(settings.key, key)).get();
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

export function getIntSetting(key: string, fallback: number): number {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function setIntSetting(key: string, value: number): void {
  setSetting(key, String(value));
}

export function deleteSetting(key: string): void {
  getDb().delete(settings).where(eq(settings.key, key)).run();
}
