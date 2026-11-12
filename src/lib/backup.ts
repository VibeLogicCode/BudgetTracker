import fs from 'node:fs';
import path from 'node:path';
import { purgeOldLoginAttempts } from '@/lib/auth/ratelimit';
import { todayIso } from '@/lib/dates';
import { postAllDueInterest } from '@/lib/loans';
import { purgeExpiredSessions } from '@/lib/auth/session';
import { purgeStagedFiles } from '@/lib/import/staging';
import { purgeOldOutboxRows } from '@/lib/notify/outbox';
import {
  SETTING_BACKUP_LAST_FAILURE_AT,
  SETTING_BACKUP_LAST_FAILURE_REASON,
  SETTING_BACKUP_RETENTION,
  deleteSetting,
  getIntSetting,
  getSetting,
  setIntSetting,
  setSetting,
} from '@/lib/settings';
import {
  ARCHIVE_NAME_RE,
  LEGACY_NAME_RE,
  NIGHTLY_PARTIAL_NAME_RE,
  ON_DEMAND_PARTIAL_NAME_RE,
  PARTIAL_MAX_AGE_MS,
  backupsDir,
  buildArchive,
  createOnDemandArchive,
  nightlyArchiveName,
  resolveSafeTarget,
  tempDir,
} from '@/lib/backup/archive';
import { listStoredFilenames } from '@/lib/warranty/items';
import { purgeOrphanReceipts } from '@/lib/warranty/receipts';
import { purgePreRestoreCopies, verifyBackupArchive } from '@/lib/backup/restore';

export const DEFAULT_BACKUP_RETENTION = 14;

// Re-exported so every existing importer of '@/lib/backup' keeps working unchanged.
export { backupsDir, tempDir };

export function nightlyBackupName(at: Date = new Date(), tz?: string): string {
  return nightlyArchiveName(at, tz);
}

export interface BackupFile {
  name: string;
  path: string;
  bytes: number;
  modifiedAt: string;
}

export function listBackups(): BackupFile[] {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    // MUST-12.3: retention counting spans BOTH shapes, so a v1.0.0 install's existing
    // .db backups stay visible and prunable after the upgrade. Both patterns are anchored
    // with `$`, so a `budget-....tar.gz.partial` left by an interrupted buildArchive()
    // (src/lib/backup/archive.ts) never matches either one and is never listed, counted
    // toward retention, or evicted-in-place-of.
    .filter((name) => ARCHIVE_NAME_RE.test(name) || LEGACY_NAME_RE.test(name))
    .map((name) => {
      const file = path.join(dir, name);
      const stats = fs.statSync(file);
      return { name, path: file, bytes: stats.size, modifiedAt: new Date(stats.mtimeMs).toISOString() };
    })
    .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : a.name < b.name ? 1 : -1));
}

export function getBackupRetention(): number {
  return Math.max(1, getIntSetting(SETTING_BACKUP_RETENTION, DEFAULT_BACKUP_RETENTION));
}

export function setBackupRetention(count: number): void {
  setIntSetting(SETTING_BACKUP_RETENTION, Math.max(1, Math.floor(count)));
}

/**
 * Builds today's archive and checks it before it replaces anything (v1.60.0): a new archive that
 * fails verifyBackupArchive never reaches its listed name, so the day's earlier archive (a
 * pre-upgrade backup, or the 02:00 run before a catch-up) stays exactly as it was.
 *
 * Spec section 8's delete-before-build is gone because nothing needs it any more: VACUUM INTO now
 * writes to a uuid-named snapshot in tmp (buildArchive), never to this target, and the final
 * rename replaces an existing file at this name in one step.
 */
export function runNightlyBackup(at: Date = new Date()): BackupFile {
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = nightlyArchiveName(at);
  const target = resolveSafeTarget(dir, name, ARCHIVE_NAME_RE);
  buildArchive(target, { verify: verifyBackupArchive });
  const stats = fs.statSync(target);
  return { name, path: target, bytes: stats.size, modifiedAt: new Date(stats.mtimeMs).toISOString() };
}

/**
 * Fix report BLOCKER 2: a `.partial` archive left behind by a hard-killed nightly job
 * (buildArchive()'s `finally` never runs under SIGKILL) is outside ARCHIVE_NAME_RE and
 * LEGACY_NAME_RE, so listBackups()/pruneBackups()'s retention pass above never sees it — it
 * would otherwise sit in backupsDir() forever, and the next night's cleanup targets a
 * different dated name. Mirrors the `-archive` stale-directory rule in
 * src/lib/import/staging.ts's purgeStagedFiles(): only removed once old enough
 * (PARTIAL_MAX_AGE_MS) that no buildArchive() call still in flight could be writing it.
 */
function pruneStalePartials(now: Date): string[] {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  const removed: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!NIGHTLY_PARTIAL_NAME_RE.test(name) && !ON_DEMAND_PARTIAL_NAME_RE.test(name)) continue;
    const file = path.join(dir, name);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    if (now.getTime() - stats.mtimeMs <= PARTIAL_MAX_AGE_MS) continue;
    fs.rmSync(file, { force: true });
    removed.push(name);
  }
  return removed;
}

export function pruneBackups(retain: number = getBackupRetention(), now: Date = new Date()): string[] {
  const files = listBackups();
  const doomed = files.slice(Math.max(0, retain));
  for (const file of doomed) fs.rmSync(file.path, { force: true });
  const stalePartials = pruneStalePartials(now);
  return [...doomed.map((file) => file.name), ...stalePartials];
}

/** Settings -> "Download backup now". Written to /data/tmp so it cannot collide with the nightly names. */
export function createOnDemandBackup(): { path: string; bytes: number } {
  return createOnDemandArchive();
}

export interface SweepResult {
  sessionsPurged: number;
  loginAttemptsPurged: number;
  stagedFilesPurged: number;
  receiptOrphansPurged: number;
  preRestoreCopiesPurged: number;
  outboxRowsPurged: number;
}

export function runMaintenanceSweep(at: Date = new Date()): SweepResult {
  return {
    sessionsPurged: purgeExpiredSessions(at),
    loginAttemptsPurged: purgeOldLoginAttempts(at),
    stagedFilesPurged: purgeStagedFiles(undefined, at),
    // MUST-4.9: files in receipts/ with no matching stored_filename row AND an mtime older
    // than 24 h. The age guard prevents a race with an in-flight upload.
    // E9: a thunk, so the table is read after the directory listing rather than before it.
    receiptOrphansPurged: purgeOrphanReceipts(() => new Set(listStoredFilenames()), undefined, at),
    // MUST-20.33: budget.pre-restore-*.db (+ -wal/-shm), receipts.pre-restore-*/ and
    // restore-failed-*/ older than 30 days, except the most recent of each kind.
    preRestoreCopiesPurged: purgePreRestoreCopies(at),
    // MUST-3.14: sent/failed notification_outbox rows older than OUTBOX_RETENTION_DAYS = 400.
    // Retention must exceed the longest coming_due window (365 days, the top of the
    // notification_user_settings range) with margin, or the sweep could delete a 'sent'
    // coming_due row while the item is still inside the user's lookahead window,
    // resurrecting its dedup key and re-alerting on the same item.
    outboxRowsPurged: purgeOldOutboxRows(at),
  };
}

/**
 * v1.60.0: what the health line reads. A failure is stamped with the job's own clock; a success
 * clears it. Guarded, because a settings write that throws here must not replace the backup's own
 * error, or stop the sweep that runs next.
 */
function recordNightlyOutcome(at: Date, error: unknown): void {
  try {
    if (error === undefined) {
      deleteSetting(SETTING_BACKUP_LAST_FAILURE_AT);
      deleteSetting(SETTING_BACKUP_LAST_FAILURE_REASON);
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    setSetting(SETTING_BACKUP_LAST_FAILURE_AT, at.toISOString());
    setSetting(SETTING_BACKUP_LAST_FAILURE_REASON, reason.slice(0, 500) || 'The backup failed without an error message.');
  } catch (recordError) {
    console.error('[backup] could not record the nightly outcome', recordError);
  }
}

export interface NightlyJobResult {
  backup: BackupFile;
  pruned: string[];
  sweep: SweepResult;
}

/**
 * Fix report BLOCKER 3: the backup+prune step is wrapped in its own try/catch so a failure
 * there (ENOSPC, a full disk, anything buildArchive()/pruneBackups() can throw) can never
 * prevent runMaintenanceSweep() from running. Before this fix the three steps shared one
 * implicit try (the caller's), so a backup failure silently and permanently disabled session
 * expiry, login-attempt pruning, staged-upload cleanup and the orphan-receipt sweep every
 * night thereafter — nothing about those four purges depends on the backup having succeeded.
 * The backup error is still rethrown after the sweep has run, so every existing caller
 * (the scheduler, the "run now" settings action) sees and reports the failure exactly as
 * before.
 */
export function runNightlyJob(at: Date = new Date()): NightlyJobResult {
  /*
    Ledger spec P3. Interest posts BEFORE the backup, so tonight's archive already contains
    tonight's postings -- restoring it puts the loans back exactly where they were, rather than a
    day behind. Swallowed: a loan that cannot be posted must not cost the household its backup,
    and the next sweep will try again.
  */
  try {
    const swept = postAllDueInterest(todayIso(at), at);
    if (swept.posted > 0 || swept.adjusted > 0) {
      console.log(`[loans] posted ${swept.posted} period(s) and ${swept.adjusted} adjustment(s) across ${swept.items} loan(s)`);
    }
    if (swept.failed > 0) console.error(`[loans] ${swept.failed} loan(s) could not be posted; see the errors above`);
  } catch (error) {
    console.error('[loans] posting due interest failed; the backup still runs', error);
  }

  let backup: BackupFile | undefined;
  let pruned: string[] = [];
  let backupError: unknown;
  try {
    backup = runNightlyBackup(at);
    pruned = pruneBackups(undefined, at);
  } catch (error) {
    backupError = error;
    console.error('[backup] nightly backup/prune failed; maintenance sweep will still run', error);
  }
  recordNightlyOutcome(at, backupError);

  const sweep = runMaintenanceSweep(at);

  if (backupError !== undefined) throw backupError;

  console.log(
    `[backup] wrote ${backup!.name} (${backup!.bytes} bytes), pruned ${pruned.length}, purged ${sweep.sessionsPurged} sessions / ${sweep.loginAttemptsPurged} login attempts / ${sweep.stagedFilesPurged} staged uploads / ${sweep.receiptOrphansPurged} orphan receipts`,
  );
  return { backup: backup!, pruned, sweep };
}

/** Past this, a missing night has been missed: one 24-hour cycle plus two hours of slack. */
export const BACKUP_STALE_AFTER_HOURS = 26;
const HOUR_MS = 60 * 60 * 1000;

/**
 * The newest nightly archive's mtime, or null when there is none. A restore leaves backups/ alone,
 * so this stays true across one.
 */
export function newestBackupAt(): Date | null {
  const newest = listBackups()[0];
  return newest ? new Date(newest.modifiedAt) : null;
}

/** v1.60.0 boot catch-up: due when there is no archive, or the newest is over 26 hours old. */
export function backupCatchUpDue(newestAt: Date | null, now: Date): boolean {
  if (newestAt === null) return true;
  return now.getTime() - newestAt.getTime() > BACKUP_STALE_AFTER_HOURS * HOUR_MS;
}

export type BackupHealthState = 'ok' | 'stale' | 'failed' | 'none';

export interface BackupHealth {
  lastBackupAt: string | null;
  /** Whole hours since the newest archive, or null when there is none. */
  ageHours: number | null;
  state: BackupHealthState;
  /** The recorded reason, only while state is 'failed'. */
  failureReason: string | null;
}

/**
 * One summary for the dashboard line and Settings, Backups. 'failed' means a recorded failure newer
 * than the newest archive (an older one has been overtaken by a good backup since); otherwise the
 * archive's age decides between 'ok' and 'stale', and no archive at all is 'none'.
 */
export function backupHealth(now: Date = new Date()): BackupHealth {
  const newest = newestBackupAt();
  const failedAt = Date.parse(getSetting(SETTING_BACKUP_LAST_FAILURE_AT) ?? '');
  const failed = Number.isFinite(failedAt) && (newest === null || failedAt > newest.getTime());
  const ageMs = newest === null ? null : now.getTime() - newest.getTime();
  const state: BackupHealthState = failed
    ? 'failed'
    : newest === null
      ? 'none'
      : backupCatchUpDue(newest, now)
        ? 'stale'
        : 'ok';
  return {
    lastBackupAt: newest === null ? null : newest.toISOString(),
    ageHours: ageMs === null ? null : Math.max(0, Math.floor(ageMs / HOUR_MS)),
    state,
    failureReason: failed ? (getSetting(SETTING_BACKUP_LAST_FAILURE_REASON) ?? 'The backup failed without an error message.') : null,
  };
}
