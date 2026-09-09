import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDb, type TestDb } from '../helpers/db';
import { backupsDir } from '@/lib/backup/archive';
import { PreUpgradeBackupError, createVerifiedPreUpgradeBackup } from '@/lib/backup/pre-upgrade';

/**
 * O-05 (2026-09-02 review, P1). No updater took a backup before upgrading, on any path. The source
 * updater re-tags the previous IMAGE and its rollback restores that image only -- never the
 * database -- and the prebuilt path sets WATCHTOWER_CLEANUP, which deletes the superseded image
 * outright. The newest restore point at any upgrade was the previous night's archive.
 */
let t: TestDb | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  t?.cleanup();
  t = null;
});

describe('the pre-upgrade backup', () => {
  it('writes a real archive into the backups directory, where the restore UI can find it', () => {
    t = createTestDb();
    const file = createVerifiedPreUpgradeBackup(new Date('2026-09-08T21:00:00Z'));

    expect(fs.existsSync(file.path)).toBe(true);
    expect(file.bytes).toBeGreaterThan(0);
    // backupsDir(), not tmp: a restore point nobody can list is not a restore point. Reusing the
    // ordinary dated name is what makes it listable, restorable and prunable with no new pattern
    // taught to the retention code -- see the module docblock.
    expect(path.dirname(path.resolve(file.path))).toBe(path.resolve(backupsDir()));
    expect(file.name).toMatch(/^budget-\d{4}-\d{2}-\d{2}\.tar\.gz$/);
  });

  it('refuses, loudly, when the archive cannot be built', () => {
    t = createTestDb();
    // A full disk, a locked database, a missing directory: every one of them surfaces as a throw
    // out of the archive build, and every one of them must stop the upgrade rather than let it
    // proceed with no way back.
    const boom = new Error('ENOSPC: no space left on device');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw boom;
    });

    expect(() => createVerifiedPreUpgradeBackup()).toThrowError(PreUpgradeBackupError);
    expect(() => createVerifiedPreUpgradeBackup()).toThrowError(/no space left on device/);
  });

  it('refuses when the archive is present but empty', () => {
    t = createTestDb();
    // The shape a disk that filled up MID-WRITE leaves behind: the file exists, so an existence
    // check alone would pass it, and restoring from it would fail at the worst possible moment.
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 0, mtimeMs: Date.now() } as unknown as fs.Stats);

    expect(() => createVerifiedPreUpgradeBackup()).toThrowError(/empty|disk is full/i);
  });

  it('names the likely cause, because the only record on a headless box is the log', () => {
    t = createTestDb();
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 0, mtimeMs: Date.now() } as unknown as fs.Stats);
    let message = '';
    try {
      createVerifiedPreUpgradeBackup();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/disk is full/i);
    expect(message).toMatch(/free some space/i);
  });
});

describe('O-05: every upgrade path takes one', () => {
  const read = (name: string) => fs.readFileSync(path.join(process.cwd(), name), 'utf8');

  it('the in-app path backs up BEFORE it records the request or calls Watchtower', () => {
    const source = read('src/lib/update/check.ts');
    const backupAt = source.indexOf('createVerifiedPreUpgradeBackup(');
    const recordAt = source.indexOf('recordApplyRequested({');
    expect(backupAt).toBeGreaterThan(-1);
    // Everything after recordApplyRequested may be killed at any moment by the container this call
    // is about to ask Watchtower to replace, so the backup has to be finished before it.
    expect(backupAt).toBeLessThan(recordAt);
  });

  it('the in-app path pays for no backup on a request it is going to refuse', () => {
    const source = read('src/lib/update/check.ts');
    const rateLimitAt = source.indexOf('checkUpdateApply()');
    const backupAt = source.indexOf('createVerifiedPreUpgradeBackup(');
    expect(rateLimitAt).toBeLessThan(backupAt);
  });

  it('both shell updaters back up before the swap, and both offer the same override', () => {
    // ONE implementation, three callers. The scripts contribute glue, not a second backup routine
    // written in bash and a third in PowerShell -- which is what makes this behave identically on
    // Linux, Windows, macOS and Synology.
    const sh = read('install/update.sh');
    const ps1 = read('install/update.ps1');

    for (const [name, source] of [['update.sh', sh], ['update.ps1', ps1]] as const) {
      expect(source, `${name} does not run the shared backup`).toContain('npm run --silent backup');
      const backupAt = source.indexOf('npm run --silent backup');
      const buildAt = source.indexOf('compose', source.indexOf('rebuilding'));
      expect(backupAt, `${name} backs up after the rebuild`).toBeLessThan(buildAt);
    }

    expect(sh).toContain('--skip-backup');
    expect(ps1).toContain('SkipBackup');
  });

  it('the npm script the shells call actually exists', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.backup).toBe('node --experimental-strip-types scripts/create-backup.ts');
  });
});
