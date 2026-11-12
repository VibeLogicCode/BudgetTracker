import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';

// Fix report IMPORTANT 2: forces one `tarCreate()` call inside buildArchive() to fail, to
// prove a failed build cannot damage or masquerade as the previous good artifact. A plain
// `vi.spyOn(tar, 'create')` cannot redefine a live ESM binding ("Cannot redefine property:
// create"), so this uses vi.mock's supported module-replacement instead, gated by a
// vi.hoisted() flag the test flips on and off around the one call it wants to fail.
//
// v1.60.0 item 7a adds two quieter failures the same switch can produce: an archive cut short
// after a "successful" write (`truncate`), and a well-formed tar whose budget.db is garbage
// (`garbageDb`). Neither throws from tarCreate itself; only the new archive check catches them.
const tarCreateControl = vi.hoisted(() => ({ shouldFail: false, truncate: false, garbageDb: false }));
vi.mock('tar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('tar')>();
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  return {
    ...actual,
    create: (...args: Parameters<typeof actual.create>) => {
      if (tarCreateControl.shouldFail) {
        tarCreateControl.shouldFail = false;
        throw new Error('disk full');
      }
      const options = args[0] as { file: string; cwd: string };
      if (tarCreateControl.garbageDb) {
        tarCreateControl.garbageDb = false;
        nodeFs.writeFileSync(nodePath.join(options.cwd, 'budget.db'), Buffer.alloc(8192, 0x41));
      }
      const result = actual.create(...args);
      if (tarCreateControl.truncate) {
        tarCreateControl.truncate = false;
        const bytes = nodeFs.readFileSync(options.file);
        nodeFs.writeFileSync(options.file, bytes.subarray(0, Math.floor(bytes.length / 2)));
      }
      return result;
    },
  };
});
import {
  ARCHIVE_NAME_RE,
  LEGACY_NAME_RE,
  backupsDir,
  buildArchive,
  createOnDemandArchive,
  nightlyArchiveName,
  resolveSafeTarget,
  tempDir,
} from '@/lib/backup/archive';
import {
  backupHealth,
  listBackups,
  nightlyBackupName,
  pruneBackups,
  runMaintenanceSweep,
  runNightlyBackup,
  runNightlyJob,
  setBackupRetention,
} from '@/lib/backup';
import { SETTING_BACKUP_LAST_FAILURE_AT, SETTING_BACKUP_LAST_FAILURE_REASON, getSetting } from '@/lib/settings';
import { receiptsDir, writeReceiptFile } from '@/lib/warranty/receipts';
import { createSession } from '@/lib/auth/session';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let originalDbPath: string | undefined;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-archive-'));
  originalDataDir = process.env.DATA_DIR;
  originalDbPath = process.env.BUDGET_DB_PATH;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  process.env.BUDGET_DB_PATH = current.path;
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalDbPath === undefined) delete process.env.BUDGET_DB_PATH;
  else process.env.BUDGET_DB_PATH = originalDbPath;
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  Object.assign(tarCreateControl, { shouldFail: false, truncate: false, garbageDb: false });
});

async function entriesOf(archivePath: string): Promise<string[]> {
  const tar = await import('tar');
  const names: string[] = [];
  tar.list({ file: archivePath, sync: true, onReadEntry: (entry) => names.push(entry.path) });
  return names.sort();
}

describe('archive naming and guards', () => {
  it('names the nightly artifact budget-YYYY-MM-DD.tar.gz', () => {
    const at = new Date('2026-08-16T06:00:00.000Z'); // 02:00 in Toronto
    expect(nightlyArchiveName(at, 'America/Toronto')).toBe('budget-2026-08-16.tar.gz');
    expect(nightlyBackupName(at, 'America/Toronto')).toBe('budget-2026-08-16.tar.gz');
    expect(ARCHIVE_NAME_RE.test('budget-2026-08-16.tar.gz')).toBe(true);
    expect(LEGACY_NAME_RE.test('budget-2026-08-16.db')).toBe(true);
  });

  it('refuses a filename that does not match its pattern or escapes its directory', () => {
    expect(() => resolveSafeTarget(backupsDir(), '../evil.tar.gz', ARCHIVE_NAME_RE)).toThrowError(/unsafe/i);
    expect(() => resolveSafeTarget(backupsDir(), 'budget-2026-08-16.tar.gz.bak', ARCHIVE_NAME_RE)).toThrowError(/unsafe/i);
  });
});

describe('buildArchive (MUST-12.1, MUST-12.2)', () => {
  it('contains budget.db and every receipt, and leaves no temp snapshot behind', async () => {
    insertTestUser(current!.db, { name: 'Alice', username: 'alice' });
    const a = writeReceiptFile(JPEG, 'image/jpeg');
    const b = writeReceiptFile(Buffer.from('%PDF-1.7\n'), 'application/pdf');

    const target = path.join(dataDir, 'out.tar.gz');
    buildArchive(target);

    const head = fs.readFileSync(target).subarray(0, 2);
    expect([head[0], head[1]]).toEqual([0x1f, 0x8b]);
    expect(await entriesOf(target)).toEqual(['budget.db', 'receipts/', `receipts/${a}`, `receipts/${b}`].sort());

    // No leftovers in DATA_DIR/tmp — neither the VACUUM snapshot nor the staging directory.
    expect(fs.readdirSync(tempDir()).filter((n) => n.endsWith('.db') || n.includes('archive'))).toEqual([]);
  });

  it('never includes DATA_DIR/secret.key — offsite backup copies must never be able to decrypt TOTP secrets', async () => {
    fs.writeFileSync(path.join(dataDir, 'secret.key'), 'z'.repeat(64), { mode: 0o600 });

    const target = path.join(dataDir, 'secret-key-exclusion.tar.gz');
    buildArchive(target);

    const entries = await entriesOf(target);
    expect(entries.some((name) => name.includes('secret.key'))).toBe(false);
  });

  it('works when there are no receipts at all', async () => {
    const target = path.join(dataDir, 'empty.tar.gz');
    buildArchive(target);
    expect(await entriesOf(target)).toContain('budget.db');
  });

  it('overwrites an existing target rather than failing the day’s backup', () => {
    const target = path.join(dataDir, 'twice.tar.gz');
    buildArchive(target);
    expect(() => buildArchive(target)).not.toThrow();
  });

  it('createOnDemandArchive writes into tmp under a UUID name', () => {
    const { path: file, bytes } = createOnDemandArchive();
    expect(path.dirname(file)).toBe(path.resolve(tempDir()));
    expect(path.basename(file)).toMatch(/^[0-9a-f-]{36}\.tar\.gz$/);
    expect(bytes).toBeGreaterThan(0);
  });

  it('a failed build leaves the prior artifact intact and no truncated corpse at the final name (fix report IMPORTANT 2)', () => {
    const target = path.join(backupsDir(), 'budget-2026-08-16.tar.gz');
    fs.mkdirSync(backupsDir(), { recursive: true });
    buildArchive(target);
    const goodBytes = fs.readFileSync(target);
    expect(goodBytes.length).toBeGreaterThan(0);

    tarCreateControl.shouldFail = true;
    expect(() => buildArchive(target)).toThrow('disk full');

    // The good artifact at the final name must be untouched — not deleted, not truncated.
    expect(fs.readFileSync(target).equals(goodBytes)).toBe(true);
    // No `.partial` leftover, and nothing else in backupsDir() that ARCHIVE_NAME_RE would
    // treat as a second, corrupt, "healthy-looking" backup.
    const entries = fs.readdirSync(backupsDir());
    expect(entries).toEqual(['budget-2026-08-16.tar.gz']);
    expect(entries.some((n) => n.endsWith('.partial'))).toBe(false);
  });
});

describe('listBackups compatibility (MUST-12.3)', () => {
  function fake(name: string, ageMinutes: number): void {
    fs.mkdirSync(backupsDir(), { recursive: true });
    const file = path.join(backupsDir(), name);
    fs.writeFileSync(file, 'x');
    const when = new Date(Date.now() - ageMinutes * 60_000);
    fs.utimesSync(file, when, when);
  }

  it('lists BOTH .tar.gz and legacy .db artifacts, newest first', () => {
    fake('budget-2026-08-16.tar.gz', 1);
    fake('budget-2026-08-15.db', 60);
    fake('budget-2026-08-16.tar.gz.bak', 2);
    fake('README.txt', 3);
    expect(listBackups().map((b) => b.name)).toEqual(['budget-2026-08-16.tar.gz', 'budget-2026-08-15.db']);
  });

  it('prunes across both shapes with one retention count', () => {
    fake('budget-2026-08-16.tar.gz', 1);
    fake('budget-2026-08-15.db', 60);
    fake('budget-2026-08-14.db', 120);
    expect(pruneBackups(1).sort()).toEqual(['budget-2026-08-14.db', 'budget-2026-08-15.db']);
    expect(listBackups().map((b) => b.name)).toEqual(['budget-2026-08-16.tar.gz']);
  });
});

describe('maintenance sweep (MUST-4.9)', () => {
  it('reports receiptOrphansPurged and leaves referenced files alone', () => {
    // BLOCKER 1b: `known` must be non-empty here, or the belt-and-braces guard in
    // purgeOrphanReceipts() refuses the whole sweep outright (an empty known set with a
    // populated receipts/ directory is always either mid-restore or corrupt, never a
    // legitimate sweep target — see tests/lib/warranty/receipts.test.ts). A real referenced
    // receipt row is what makes this test's `orphan` genuinely, unambiguously orphaned.
    insertTestUser(current!.db, { name: 'Alice', username: 'alice' });
    const known = writeReceiptFile(JPEG, 'image/jpeg');
    current!.sqlite
      .prepare(
        `insert into warranty_items (id, name, purchase_date, is_lifetime, owner_user_id, created_at, updated_at)
         values (1, 'Fridge', '2026-08-16', 0, 1, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
      )
      .run();
    current!.sqlite
      .prepare(
        `insert into warranty_receipts (warranty_item_id, original_filename, stored_filename, mime, size_bytes,
           sha256, ocr_status, created_at)
         values (1, 'a.jpg', ?, 'image/jpeg', 64, ?, 'done', '2026-08-16T00:00:00.000Z')`,
      )
      .run(known, 'a'.repeat(64));

    const orphan = writeReceiptFile(JPEG, 'image/jpeg');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(path.join(receiptsDir(), orphan), twoDaysAgo, twoDaysAgo);

    const result = runMaintenanceSweep(new Date());
    expect(result.receiptOrphansPurged).toBe(1);
    expect(fs.existsSync(path.join(receiptsDir(), orphan))).toBe(false);
    expect(fs.existsSync(path.join(receiptsDir(), known))).toBe(true);
  });
});

describe('stale .partial cleanup (BLOCKER 2)', () => {
  it('removes an aged .partial, keeps a fresh one, and leaves live archives untouched', () => {
    fs.mkdirSync(backupsDir(), { recursive: true });
    const live = path.join(backupsDir(), 'budget-2026-08-16.tar.gz');
    fs.writeFileSync(live, 'archive bytes');

    const agedPartial = path.join(backupsDir(), 'budget-2026-08-14.tar.gz.partial');
    fs.writeFileSync(agedPartial, 'stale partial left by a SIGKILL');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(agedPartial, twoDaysAgo, twoDaysAgo);

    const freshPartial = path.join(backupsDir(), 'budget-2026-08-16.tar.gz.partial');
    fs.writeFileSync(freshPartial, 'a backup in flight right now');

    const removed = pruneBackups(14);

    expect(removed).toContain('budget-2026-08-14.tar.gz.partial');
    expect(fs.existsSync(agedPartial)).toBe(false);
    expect(fs.existsSync(freshPartial)).toBe(true);
    expect(fs.existsSync(live)).toBe(true);
  });

  it('never touches a live .tar.gz or .db backup, only the .partial shape', () => {
    fs.mkdirSync(backupsDir(), { recursive: true });
    const live = path.join(backupsDir(), 'budget-2026-08-01.tar.gz');
    fs.writeFileSync(live, 'x');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(live, twoDaysAgo, twoDaysAgo);

    const removed = pruneBackups(14);
    expect(removed).toEqual([]);
    expect(fs.existsSync(live)).toBe(true);
  });
});

describe('runNightlyJob', () => {
  it('writes the archive, prunes, sweeps, and reports the archive name', () => {
    const result = runNightlyJob(new Date('2026-08-16T06:00:00.000Z'));
    expect(result.backup.name).toBe('budget-2026-08-16.tar.gz');
    expect(result.backup.bytes).toBeGreaterThan(0);
    expect(result.sweep.receiptOrphansPurged).toBe(0);
  });

  // Fix report BLOCKER 3: before this fix, runNightlyJob ran backup -> prune -> sweep with
  // no isolation between the steps, so a thrown backup error skipped the sweep entirely —
  // permanently disabling session expiry, login-attempt pruning, staged-upload cleanup and
  // the orphan-receipt sweep on every subsequent failed night. This proves the sweep's
  // observable effect (an expired session actually gets purged) still happens even though
  // the backup step throws, and that the backup failure is still surfaced to the caller.
  it('still runs the maintenance sweep, and still surfaces the error, when the backup step throws', () => {
    const userId = insertTestUser(current!.db, { name: 'Alice', username: 'alice' });
    createSession(userId, { at: new Date('2026-01-01T00:00:00.000Z') }); // long expired

    tarCreateControl.shouldFail = true;
    expect(() => runNightlyJob(new Date('2026-08-16T06:00:00.000Z'))).toThrow('disk full');

    expect((current!.sqlite.prepare('select count(*) as c from sessions').get() as { c: number }).c).toBe(0);
  });
});

/**
 * v1.60.0 item 7a. A new archive is checked on its `.partial` before the rename, so a bad one never
 * reaches a listed name: it cannot replace the same day's earlier archive, and because the throw
 * lands before pruneBackups, it can never be counted toward retention or evict a good backup.
 */
describe('the new-archive check (item 7a)', () => {
  it('buildArchive runs verify on the .partial, before the rename into place', () => {
    const target = path.join(dataDir, 'checked.tar.gz');
    const seen: { path: string; partialExists: boolean; targetExists: boolean }[] = [];
    buildArchive(target, {
      verify: (partial) => seen.push({ path: partial, partialExists: fs.existsSync(partial), targetExists: fs.existsSync(target) }),
    });
    expect(seen).toEqual([{ path: `${target}.partial`, partialExists: true, targetExists: false }]);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('a failed verify deletes the partial, keeps the earlier archive at that name, and says the check failed', () => {
    const target = path.join(backupsDir(), 'budget-2026-08-16.tar.gz');
    fs.mkdirSync(backupsDir(), { recursive: true });
    buildArchive(target);
    const goodBytes = fs.readFileSync(target);

    expect(() =>
      buildArchive(target, {
        verify: () => {
          throw new Error('quick_check said no');
        },
      }),
    ).toThrowError('The new backup failed its check: quick_check said no');

    expect(fs.readFileSync(target).equals(goodBytes)).toBe(true);
    expect(fs.readdirSync(backupsDir())).toEqual(['budget-2026-08-16.tar.gz']);
  });

  it('a good nightly archive passes the real check', () => {
    const backup = runNightlyBackup(new Date('2026-08-16T06:00:00.000Z'));
    expect(backup.name).toBe('budget-2026-08-16.tar.gz');
    expect(fs.readdirSync(backupsDir())).toEqual(['budget-2026-08-16.tar.gz']);
  });

  for (const [label, flag] of [
    ['a truncated archive', 'truncate'],
    ['a tar whose budget.db is garbage', 'garbageDb'],
  ] as const) {
    it(`${label} fails the nightly job and keeps yesterday's archive`, () => {
      setBackupRetention(1);
      runNightlyJob(new Date('2026-08-15T06:00:00.000Z'));
      const yesterday = fs.readFileSync(path.join(backupsDir(), 'budget-2026-08-15.tar.gz'));

      tarCreateControl[flag] = true;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => runNightlyJob(new Date('2026-08-16T06:00:00.000Z'))).toThrowError(/^The new backup failed its check: /);
      errorSpy.mockRestore();

      // Retention is 1, and a bad archive counted toward it would have evicted yesterday's.
      expect(listBackups().map((b) => b.name)).toEqual(['budget-2026-08-15.tar.gz']);
      expect(fs.readFileSync(path.join(backupsDir(), 'budget-2026-08-15.tar.gz')).equals(yesterday)).toBe(true);
      expect(fs.readdirSync(backupsDir()).some((n) => n.endsWith('.partial'))).toBe(false);
      // The scratch copy of budget.db the check extracted is gone too.
      expect(fs.readdirSync(tempDir()).filter((n) => n.endsWith('-archive') || n.endsWith('.db'))).toEqual([]);
    });
  }

  it('a failed check on the same day leaves the earlier same-day archive in place', () => {
    const at = new Date('2026-08-16T06:00:00.000Z');
    runNightlyBackup(at);
    const earlier = fs.readFileSync(path.join(backupsDir(), 'budget-2026-08-16.tar.gz'));

    tarCreateControl.truncate = true;
    expect(() => runNightlyBackup(new Date('2026-08-16T20:00:00.000Z'))).toThrowError(/failed its check/);

    expect(fs.readFileSync(path.join(backupsDir(), 'budget-2026-08-16.tar.gz')).equals(earlier)).toBe(true);
  });

  it('on-demand downloads are not checked (unchanged)', () => {
    tarCreateControl.truncate = true;
    expect(() => createOnDemandArchive()).not.toThrow();
  });
});

/** v1.60.0 item 7b: the nightly job remembers how it last ended, for the health line. */
describe('runNightlyJob records its outcome (item 7b)', () => {
  it('records the failure time and reason, and backupHealth reports it as failed', () => {
    const first = runNightlyJob(new Date('2026-08-15T06:00:00.000Z'));
    // Backup age is the archive's mtime, so pin it to the job's date rather than the real clock.
    fs.utimesSync(first.backup.path, new Date('2026-08-15T06:00:00.000Z'), new Date('2026-08-15T06:00:00.000Z'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tarCreateControl.truncate = true;
    const failedAt = new Date('2026-08-16T06:00:00.000Z');
    expect(() => runNightlyJob(failedAt)).toThrow();
    errorSpy.mockRestore();

    expect(getSetting(SETTING_BACKUP_LAST_FAILURE_AT)).toBe(failedAt.toISOString());
    expect(getSetting(SETTING_BACKUP_LAST_FAILURE_REASON)).toMatch(/^The new backup failed its check: /);
    const health = backupHealth(new Date(failedAt.getTime() + 60_000));
    expect(health.state).toBe('failed');
    expect(health.failureReason).toMatch(/failed its check/);
  });

  it('records a thrown build failure the same way', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tarCreateControl.shouldFail = true;
    const at = new Date('2026-08-16T06:00:00.000Z');
    expect(() => runNightlyJob(at)).toThrow('disk full');
    errorSpy.mockRestore();
    expect(getSetting(SETTING_BACKUP_LAST_FAILURE_AT)).toBe(at.toISOString());
    expect(getSetting(SETTING_BACKUP_LAST_FAILURE_REASON)).toBe('disk full');
  });

  it('a later success clears the recorded failure', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tarCreateControl.shouldFail = true;
    expect(() => runNightlyJob(new Date('2026-08-16T06:00:00.000Z'))).toThrow();
    errorSpy.mockRestore();

    runNightlyJob(new Date('2026-08-17T06:00:00.000Z'));
    expect(getSetting(SETTING_BACKUP_LAST_FAILURE_AT)).toBeNull();
    expect(getSetting(SETTING_BACKUP_LAST_FAILURE_REASON)).toBeNull();
  });
});
