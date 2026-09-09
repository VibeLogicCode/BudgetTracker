import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, insertTestUser, type TestDb } from '../helpers/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 2026-09-09. notification_user_settings.summary_frequency: how often the spending summary is sent.
 *
 * Owner report: "i only import data on sundays i dont want daily messages they need to be weekly
 * only or when i press notify in app manually." The two columns beside it answer WHEN; this answers
 * HOW OFTEN, which previously had no answer at all.
 */
let t: TestDb | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

describe('drizzle/0023_summary_frequency.sql', () => {
  it('adds the column with a weekly default, so an upgrade changes nothing for anybody', () => {
    t = createTestDb();
    const columns = t.sqlite.pragma('table_info(notification_user_settings)') as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const column = columns.find((c) => c.name === 'summary_frequency');
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(1);
    // The default is what every existing row silently takes at upgrade time, so it has to be the
    // behaviour those rows already had. Anything else would change every install's cadence on a
    // migration nobody chose to run.
    expect(column?.dflt_value).toBe("'weekly'");
  });

  it('gives an existing settings row the weekly default without it being written', () => {
    t = createTestDb();
    const userId = insertTestUser(t.db);
    t.sqlite
      .prepare(
        'insert into notification_user_settings (user_id, created_at, updated_at) values (?, ?, ?)',
      )
      .run(userId, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');
    const row = t.sqlite
      .prepare('select summary_frequency from notification_user_settings where user_id = ?')
      .get(userId) as { summary_frequency: string };
    expect(row.summary_frequency).toBe('weekly');
  });

  it('records itself in the journal, immediately after 0022, and is the newest', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((row) => row.tag === '0023_summary_frequency');
    expect(entry).toMatchObject({ idx: 23, tag: '0023_summary_frequency' });
    const idxs = journal.entries.map((e) => e.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(23)).toBe(idxs.indexOf(22) + 1);
    // This suite now owns the "I am the newest" claim, handed on from 0022's.
    expect(Math.max(...idxs)).toBe(23);
  });
});
