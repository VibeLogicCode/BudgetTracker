import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase } from '@/db/client';
import { createTestDb, type TestDb } from '../helpers/db';

const REAL_MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle');

let current: TestDb | null = null;
const tempDirs: string[] = [];
afterEach(() => {
  current?.cleanup();
  current = null;
  delete process.env.BUDGET_MIGRATIONS_DIR;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** drizzle/0034_auth_limits.sql (v1.64.1). One index on login_attempts and two triggers on users. */
describe('0034: the migration records itself', () => {
  it('sits immediately after 0033 in the journal', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    expect(journal.entries.find((row) => row.tag === '0034_auth_limits')).toMatchObject({ idx: 34, when: 1758931200000 });
    const idxs = journal.entries.map((entry) => entry.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(34)).toBe(idxs.indexOf(33) + 1);
    const when = (idx: number) => journal.entries.find((entry) => entry.idx === idx)!.when;
    expect(when(34)).toBeGreaterThan(when(33));
  });
});

/** A database migrated to 0033 and no further, and the staged migrations folder that got it there. */
function buildPre0034Db(): { file: string; stageDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0034-migrations-'));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0034-db-'));
  tempDirs.push(stageDir, dbDir);
  for (const name of fs.readdirSync(REAL_MIGRATIONS_DIR).filter((n) => n.endsWith('.sql') && !n.startsWith('0034_'))) {
    fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, name), path.join(stageDir, name));
  }
  fs.mkdirSync(path.join(stageDir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number }[];
  };
  fs.writeFileSync(
    path.join(stageDir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 33) }),
  );
  return { file: path.join(dbDir, 'budget.db'), stageDir };
}

const INDEX = "select count(*) as c from sqlite_master where type = 'index' and name = 'login_attempts_created_idx'";

describe('0034: an existing install', () => {
  it('gains the index and the triggers, and leaves every existing row as it was', () => {
    const { file, stageDir } = buildPre0034Db();
    process.env.BUDGET_MIGRATIONS_DIR = stageDir;
    const staged = openDatabase(file);
    const s = staged.sqlite;
    expect(s.prepare(INDEX).get()).toEqual({ c: 0 });
    const insertUser = s.prepare(
      `insert into users (id, name, username, password_hash, role, created_at) values (?, ?, ?, 'h', ?, '2026-03-01T00:00:00.000Z')`,
    );
    insertUser.run(1, 'Alex', 'alex', 'admin');
    insertUser.run(2, 'Sam', 'sam', 'member');
    // Nothing refused another role before 0034; a row like this is kept exactly as it is.
    insertUser.run(3, 'Old', 'old', 'auditor');
    const insertAttempt = s.prepare(`insert into login_attempts (username, ip, success, created_at, device_id) values (?, ?, ?, ?, ?)`);
    insertAttempt.run('alex', 'unknown', 0, '2026-03-09T08:00:00.000Z', null);
    insertAttempt.run('sam', '192.168.1.40', 1, '2026-03-09T08:01:00.000Z', 'dev-sam');
    const usersBefore = s.prepare('select * from users order by id').all();
    const attemptsBefore = s.prepare('select * from login_attempts order by id').all();
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR;
    const upgraded = openDatabase(file);
    try {
      const u = upgraded.sqlite;
      expect(u.prepare(INDEX).get()).toEqual({ c: 1 });
      expect(u.prepare("select name from sqlite_master where type = 'trigger' and tbl_name = 'users' order by name").all()).toEqual([
        { name: 'users_role_allowed_insert' },
        { name: 'users_role_allowed_update' },
      ]);
      expect(u.prepare('select * from users order by id').all()).toEqual(usersBefore);
      expect(u.prepare('select * from login_attempts order by id').all()).toEqual(attemptsBefore);
      // Other columns of a stored row can still change; only a role change is checked.
      expect(() => u.prepare("update users set name = 'Old Account' where id = 3").run()).not.toThrow();
    } finally {
      upgraded.sqlite.close();
    }
  });
});

describe('0034: on a new database', () => {
  it('the nightly purge of old attempts reads through the created_at index', () => {
    current = createTestDb();
    const plan = current.sqlite
      .prepare("explain query plan delete from login_attempts where created_at < '2026-02-01T00:00:00.000Z'")
      .all() as { detail: string }[];
    expect(plan.map((row) => row.detail).join(' | ')).toContain('login_attempts_created_idx');
  });

  it('refuses a role other than admin or member, on insert and on update', () => {
    current = createTestDb();
    const s = current.sqlite;
    const insert = s.prepare(`insert into users (name, username, password_hash, role, created_at) values (?, ?, 'h', ?, '2026-03-01T00:00:00.000Z')`);
    const alex = Number(insert.run('Alex', 'alex', 'admin').lastInsertRowid);
    const sam = Number(insert.run('Sam', 'sam', 'member').lastInsertRowid);

    for (const role of ['owner', 'Admin', '', 'admin ']) {
      expect(() => insert.run('Kai', `kai${role.length}${role}`, role), role).toThrow(/users\.role must be admin or member/);
      expect(() => s.prepare('update users set role = ? where id = ?').run(role, sam), role).toThrow(/users\.role must be admin or member/);
    }

    expect(() => s.prepare("update users set role = 'admin' where id = ?").run(sam)).not.toThrow();
    expect(() => s.prepare("update users set role = 'member' where id = ?").run(alex)).not.toThrow();
    expect(s.prepare('select username, role from users order by id').all()).toEqual([
      { username: 'alex', role: 'member' },
      { username: 'sam', role: 'admin' },
    ]);
  });
});
