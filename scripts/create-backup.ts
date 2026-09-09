/**
 * O-05 (2026-09-02 review, P1). `npm run backup` — a verified restore point, on demand, from a
 * shell.
 *
 * WHY THIS EXISTS AT ALL, given applyUpdate() already takes one: the in-app path covers the
 * Watchtower/prebuilt-image install, and nothing else. `install/update.sh` and
 * `install/update.ps1` rebuild from source and never enter the application at all, so without
 * this entry point the source-build path would still upgrade with no fresh backup.
 *
 * The owner's constraint drove the shape: "synology is only 1 type of device we r running it on.
 * now it can run on docker on unix linux windows so we need something that works for all devices
 * just like the app". The portable half of any updater is the part that runs INSIDE the container,
 * because that is identical on every host. So the backup logic lives in Node
 * (src/lib/backup/pre-upgrade.ts) and every path — the in-app button, update.sh, update.ps1 —
 * calls that one implementation. The scripts contribute one line of glue each, not a second
 * backup routine in bash and a third in PowerShell.
 *
 * Exit codes are the contract the shells read: 0 with the archive path on stdout, 1 with a written
 * reason on stderr. Nothing else is printed on success, so a caller can capture the path directly.
 */
import { createVerifiedPreUpgradeBackup } from '../src/lib/backup/pre-upgrade.ts';

function main(): void {
  try {
    const file = createVerifiedPreUpgradeBackup();
    // The path, alone, so `BACKUP=$(npm run --silent backup)` is usable.
    console.log(file.path);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

main();
