import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, type TestDb } from '../helpers/db';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('0029: login attempts carry an optional device id', () => {
  it('is in the journal right after 0028', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    expect(journal.entries.find((row) => row.tag === '0029_login_attempt_device')).toMatchObject({ idx: 29 });
  });

  it('adds a nullable device_id column and its index', () => {
    current = createSeededTestDb();
    const columns = current.sqlite.prepare('pragma table_info(login_attempts)').all() as { name: string; notnull: number }[];
    expect(columns.find((c) => c.name === 'device_id')).toMatchObject({ notnull: 0 });
    const indexes = current.sqlite.prepare('pragma index_list(login_attempts)').all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain('login_attempts_device_idx');
  });
});
