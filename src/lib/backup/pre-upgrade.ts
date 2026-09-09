import fs from 'node:fs';
import { runNightlyBackup, type BackupFile } from '@/lib/backup';

/**
 * O-05 (2026-09-02 review, P1). A fresh, verified restore point taken immediately BEFORE an
 * upgrade — on every path that can start one.
 *
 * The gap this closes: no updater touched /data at all. install/update.sh re-tags the previous
 * IMAGE and says so plainly, but its rollback path only restarts that image; it never restores the
 * database. The in-app path posts to Watchtower with no backup call anywhere in src/lib/update/*.
 * And install/synology-compose-pull.yml sets WATCHTOWER_CLEANUP, which deletes the superseded
 * image, so the prebuilt path has no image-level rollback either. The most recent restore point at
 * any upgrade was the previous night's nightly archive — up to 24 hours stale.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. drizzle wraps the whole pending migration set in one
 * transaction and SQLite DDL is transactional, so a half-migrated database is not the risk. The
 * real exposure is a migration that SUCCEEDS and an app that then misbehaves: the schema has moved
 * forward and the only way back is the image, which O-04 now (correctly) refuses to boot against a
 * newer database. Without a backup from just before the upgrade, "roll back" has no meaning.
 *
 * REUSES runNightlyBackup rather than inventing a pre-upgrade artifact, and that is the whole
 * design. A new `budget-pre-upgrade-<stamp>.tar.gz` shape would have to be taught to listBackups,
 * to the restore path's name resolution and to retention pruning — three edits to the highest-stakes
 * code in the repo, to produce a file identical in content to the one the nightly already makes.
 * Instead this writes the ordinary dated archive: listed in Settings → Backups, restorable by the
 * existing UI and CLI, counted by retention, with no new pattern anywhere.
 *
 * Overwriting the same day's nightly is intentional and is a strict improvement: same date, more
 * recent contents, and buildArchive writes to a `.partial` sibling and renames atomically, so there
 * is no window in which the day's backup is truncated. The household ends the day with a restore
 * point from minutes before the upgrade instead of one from 02:00.
 */
export class PreUpgradeBackupError extends Error {}

/**
 * Throws rather than returning a result, because every caller's correct response to failure is the
 * same: do not upgrade. A boolean would invite one of them to carry on.
 *
 * Verification is deliberately thin, and the reason is worth stating: buildArchive runs
 * `VACUUM INTO` against the live database, which is itself a full read of every page — a corrupt
 * or unreadable database cannot produce an archive at all, so a returned file already carries that
 * guarantee. What VACUUM cannot rule out is a write that ran out of room afterwards, which shows up
 * as a present-but-empty file, so that is what is checked here. Re-opening and `quick_check`ing the
 * archive's contents would mean extracting a tarball to prove something the source database just
 * proved.
 */
export function createVerifiedPreUpgradeBackup(now: Date = new Date()): BackupFile {
  let file: BackupFile;
  try {
    file = runNightlyBackup(now);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PreUpgradeBackupError(`Could not create a backup before upgrading: ${detail}`);
  }

  if (!fs.existsSync(file.path) || file.bytes <= 0) {
    // Named as a disk-space problem because that is overwhelmingly what it is: a zero-byte archive
    // means the tar write started and could not finish.
    throw new PreUpgradeBackupError(
      'The backup taken before upgrading is empty, which usually means the disk is full. Free some space and try again.',
    );
  }

  return file;
}
