import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@/db/client';
import { createTestDb, type TestDb } from '../helpers/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_MIGRATIONS_DIR = path.join(root, 'drizzle');

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function columns(sqlite: TestDb['sqlite'], table: string): Map<string, ColumnInfo> {
  const rows = sqlite.pragma(`table_info(${table})`) as ColumnInfo[];
  return new Map(rows.map((row) => [row.name, row]));
}

/** A database migrated to 0020 and no further, plus the staged migrations dir that got it there.
 *  Same shape as migration-0020.test.ts's own helper, which stages at 0019. */
function buildPreMigrationDb(): { file: string; tempMigrationsDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0021-migrations-'));
  const names = fs
    .readdirSync(REAL_MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql') && n !== '0021_household_channels.sql');
  for (const name of names) fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, name), path.join(stageDir, name));
  fs.mkdirSync(path.join(stageDir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    version: string;
    dialect: string;
    entries: { idx: number }[];
  };
  fs.writeFileSync(
    path.join(stageDir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 20) }),
  );
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0021-db-'));
  return { file: path.join(dbDir, 'budget.db'), tempMigrationsDir: stageDir };
}

const USER_SQL =
  "insert into users (id, name, username, password_hash, role, created_at) values (?, ?, ?, 'h', ?, '2026-01-01T00:00:00.000Z')";

function seedUsers(sqlite: TestDb['sqlite']): void {
  sqlite.prepare(USER_SQL).run(1, 'Alex', 'alex', 'admin');
  sqlite.prepare(USER_SQL).run(2, 'Robin', 'robin', 'member');
}

/** The family Telegram, inserted the way the app inserts it: no user, an audit trail, a token. */
function insertHouseholdTelegram(sqlite: TestDb['sqlite'], createdBy: number | null = 1, destination = '-1009999'): void {
  sqlite
    .prepare(
      `insert into notification_targets
         (user_id, scope, created_by_user_id, channel, destination, secret_encrypted, created_at, updated_at)
       values (null, 'household', ?, 'telegram', ?, 'ENCRYPTED-BLOB', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    )
    .run(createdBy, destination);
}

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  delete process.env.BUDGET_MIGRATIONS_DIR;
});

describe('drizzle/0021_household_channels.sql', () => {
  it('adds scope and created_by_user_id, and makes user_id nullable', () => {
    current = createTestDb();
    const cols = columns(current.sqlite, 'notification_targets');

    const scope = cols.get('scope');
    expect(scope, 'missing column scope').toBeDefined();
    expect(scope?.type.toLowerCase()).toBe('text');
    expect(scope?.notnull, 'scope must be NOT NULL').toBe(1);
    // The default is what makes every pre-existing row -- and every row a caller that has not
    // heard of households writes -- a personal one.
    expect(scope?.dflt_value).toBe("'personal'");

    const createdBy = cols.get('created_by_user_id');
    expect(createdBy, 'missing column created_by_user_id').toBeDefined();
    expect(createdBy?.notnull, 'created_by_user_id must be nullable: it goes NULL when that admin is deleted').toBe(0);

    // The whole ownership decision in one assertion. user_id was NOT NULL with ON DELETE CASCADE;
    // if it still were, a household row would have to belong to somebody and would die with them.
    expect(cols.get('user_id')?.notnull, 'user_id must be nullable so a household row can belong to nobody').toBe(0);
  });

  it('makes notification_targets_household_channel_uq a PARTIAL index, not a plain one', () => {
    current = createTestDb();
    const list = current.sqlite.pragma('index_list(notification_targets)') as {
      name: string;
      unique: number;
      partial: number;
    }[];
    const household = list.find((row) => row.name === 'notification_targets_household_channel_uq');
    expect(household, 'missing notification_targets_household_channel_uq').toBeDefined();
    expect(household?.unique).toBe(1);
    // If this were 0 the index would be unconditional and would forbid every personal row past
    // the first per channel -- the household constraint would have broken personal targets.
    expect(household?.partial, 'the index must carry a WHERE clause').toBe(1);
    expect(list.find((row) => row.name === 'notification_targets_user_channel_uq')?.unique).toBe(1);
  });

  it('refuses a SECOND household target on the same channel, in the DATABASE', () => {
    current = createTestDb();
    seedUsers(current.sqlite);
    insertHouseholdTelegram(current.sqlite, 1, '-1001111');
    // Not "the application declines to offer a second button": the second row cannot exist.
    expect(() => insertHouseholdTelegram(current!.sqlite, 2, '-1002222')).toThrow(/UNIQUE/i);
    const rows = current.sqlite
      .prepare("select count(*) as n from notification_targets where scope = 'household'")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('lets one household Telegram and one household email coexist', () => {
    current = createTestDb();
    seedUsers(current.sqlite);
    insertHouseholdTelegram(current.sqlite);
    current.sqlite
      .prepare(
        `insert into notification_targets (user_id, scope, created_by_user_id, channel, destination, created_at, updated_at)
         values (null, 'household', 1, 'email', 'family@example.invalid', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
      )
      .run();
    const rows = current.sqlite
      .prepare("select channel from notification_targets where scope = 'household' order by channel")
      .all() as { channel: string }[];
    expect(rows.map((r) => r.channel)).toEqual(['email', 'telegram']);
  });

  it('lets a personal and a household target coexist for the same user and channel', () => {
    current = createTestDb();
    seedUsers(current.sqlite);
    current.sqlite
      .prepare(
        `insert into notification_targets (user_id, channel, destination, secret_encrypted, created_at, updated_at)
         values (1, 'telegram', '12345', 'ALEX-TOKEN', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
      )
      .run();
    insertHouseholdTelegram(current.sqlite, 1);
    // The reported defect, inverted into an assertion: "once i set my own channel i cannot add
    // another channel for joint notifcations".
    const rows = current.sqlite
      .prepare("select scope, user_id, destination from notification_targets where channel = 'telegram' order by scope")
      .all() as { scope: string; user_id: number | null; destination: string }[];
    expect(rows).toEqual([
      { scope: 'household', user_id: null, destination: '-1009999' },
      { scope: 'personal', user_id: 1, destination: '12345' },
    ]);
  });

  it('keeps the family channel when the admin who created it is deleted', () => {
    current = createTestDb();
    seedUsers(current.sqlite);
    // Alex also has a personal Telegram, so this asserts BOTH halves of the ownership split at
    // once: the personal row cascades away with its owner, the household row does not.
    current.sqlite
      .prepare(
        `insert into notification_targets (user_id, channel, destination, secret_encrypted, created_at, updated_at)
         values (1, 'telegram', '12345', 'ALEX-TOKEN', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
      )
      .run();
    insertHouseholdTelegram(current.sqlite, 1);

    current.sqlite.prepare('delete from users where id = 1').run();

    const rows = current.sqlite
      .prepare('select scope, user_id, created_by_user_id, destination, secret_encrypted from notification_targets')
      .all() as {
      scope: string;
      user_id: number | null;
      created_by_user_id: number | null;
      destination: string;
      secret_encrypted: string | null;
    }[];
    expect(rows, "Alex's personal target should have cascaded away; the family channel should not").toHaveLength(1);
    expect(rows[0].scope).toBe('household');
    expect(rows[0].destination).toBe('-1009999');
    // Robin still needs this channel. All that is lost is the note of who set it up.
    expect(rows[0].created_by_user_id, 'authorship degrades to NULL rather than taking the row with it').toBeNull();
    expect(rows[0].secret_encrypted).toBe('ENCRYPTED-BLOB');
  });

  it('keeps every CHECK from 0006 and adds the scope/user_id pairing', () => {
    current = createTestDb();
    seedUsers(current.sqlite);
    const insert = (userId: number | null, scope: string, channel: string, secret: string | null) =>
      current!.sqlite
        .prepare(
          `insert into notification_targets (user_id, scope, channel, destination, secret_encrypted, created_at, updated_at)
           values (?, ?, ?, 'd', ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
        )
        .run(userId, scope, channel, secret);

    // The channel/secret pairing, verbatim from 0006 and applying to household rows identically.
    expect(() => insert(1, 'personal', 'telegram', null), 'a telegram row must carry a secret').toThrow(/CHECK/i);
    expect(() => insert(null, 'household', 'telegram', null)).toThrow(/CHECK/i);
    expect(() => insert(1, 'personal', 'email', 'X'), 'an email row must not carry a secret').toThrow(/CHECK/i);
    expect(() => insert(null, 'household', 'email', 'X')).toThrow(/CHECK/i);
    expect(() => insert(1, 'personal', 'sms', null), 'channel is still constrained').toThrow(/CHECK/i);
    // The new pairing: scope and user_id are one fact, so neither can drift from the other.
    expect(() => insert(1, 'household', 'email', null), 'a household row owned by a user').toThrow(/CHECK/i);
    expect(() => insert(null, 'personal', 'email', null), 'a personal row owned by nobody').toThrow(/CHECK/i);
    expect(() => insert(1, 'shared', 'email', null), 'scope is constrained').toThrow(/CHECK/i);
  });

  it('creates notification_household_prefs WITHOUT ROWID, keyed on (event_id, channel)', () => {
    current = createTestDb();
    const ddl = current.sqlite
      .prepare("select sql from sqlite_master where type = 'table' and name = 'notification_household_prefs'")
      .get() as { sql: string } | undefined;
    expect(ddl, 'missing table notification_household_prefs').toBeDefined();
    expect(ddl?.sql).toMatch(/WITHOUT ROWID/i);

    const insert = (eventId: string, channel: string) =>
      current!.sqlite
        .prepare(
          "insert into notification_household_prefs (event_id, channel, enabled, updated_at) values (?, ?, 1, '2026-09-01T00:00:00.000Z')",
        )
        .run(eventId, channel);
    insert('weekly_digest', 'telegram');
    expect(() => insert('weekly_digest', 'telegram'), 'the composite PK is the row').toThrow(/UNIQUE|PRIMARY/i);
    expect(() => insert('weekly_digest', 'sms'), 'channel is constrained').toThrow(/CHECK/i);
    // MUST-3.6: no CHECK and no FK on event_id, so a new event stays one append to events.ts.
    // Eligibility is enforced in code, at the write path and again at the send path.
    expect(() => insert('an_event_that_does_not_exist', 'email')).not.toThrow();
  });

  it('leaves the table empty on a fresh install, so upgrading changes no delivery', () => {
    current = createTestDb();
    const row = current.sqlite.prepare('select count(*) as n from notification_household_prefs').get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('dedups a household outbox row against itself, through COALESCE(user_id, -1)', () => {
    current = createTestDb();
    seedUsers(current.sqlite);
    const insert = (userId: number | null) =>
      current!.sqlite
        .prepare(
          `insert into notification_outbox (user_id, channel, event_id, dedup_key, subject, body, next_attempt_at, created_at)
           values (?, 'telegram', 'weekly_digest', 'hh:digest-week:2026-08-17', 's', 'b', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
        )
        .run(userId);

    insert(null);
    // THE assertion this index exists for. SQLite treats NULLs as distinct inside a unique index,
    // so a plain (user_id, channel, dedup_key) would admit this second row and the family group
    // chat would get one copy per member per tick.
    expect(() => insert(null)).toThrow(/UNIQUE/i);
    // A member's own row on the same key is a different fact and still allowed: -1 can never
    // collide with a real user id.
    expect(() => insert(1)).not.toThrow();
    expect(() => insert(1)).toThrow(/UNIQUE/i);
  });

  it('records itself in the journal, immediately after 0020, and is the newest', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((row) => row.tag === '0021_household_channels');
    expect(entry).toMatchObject({ idx: 21, tag: '0021_household_channels' });
    const idxs = journal.entries.map((e) => e.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(21)).toBe(idxs.indexOf(20) + 1);
    // This suite now owns the "I am the newest" claim, handed on from 0020's suite the way 0020
    // took it from 0019. Whichever migration is last owns it; nobody else asserts it.
    expect(Math.max(...idxs)).toBe(21);
  });
});

describe('a v1.27.x database (0020 applied, 0021 not) upgrades cleanly', () => {
  it('turns every pre-existing target into a personal one and loses nothing', () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    try {
      process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
      const staged = openDatabase(file);
      seedUsers(staged.sqlite);
      staged.sqlite
        .prepare(
          `insert into notification_targets (id, user_id, channel, destination, secret_encrypted, enabled, verified_at, created_at, updated_at)
           values (7, 1, 'telegram', '12345', 'ALEX-TOKEN', 1, '2026-08-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
        )
        .run();
      staged.sqlite
        .prepare(
          `insert into notification_targets (id, user_id, channel, destination, created_at, updated_at)
           values (8, 2, 'email', 'robin@example.invalid', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')`,
        )
        .run();
      staged.sqlite
        .prepare(
          `insert into notification_outbox (id, user_id, channel, event_id, dedup_key, subject, body, status, attempts, next_attempt_at, created_at, sent_at)
           values (3, 1, 'telegram', 'coming_due', 'due:4:2026-09-01', 'S', 'B', 'sent', 1, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:05.000Z')`,
        )
        .run();
      staged.sqlite.close();

      delete process.env.BUDGET_MIGRATIONS_DIR; // falls back to the real drizzle/, which includes 0021
      const upgraded = openDatabase(file);
      try {
        const targets = upgraded.sqlite
          .prepare('select * from notification_targets order by id')
          .all() as Record<string, unknown>[];
        expect(targets).toHaveLength(2);
        // Every pre-existing row is personal. Nothing an existing household has configured
        // changes meaning, and nobody's channel silently becomes shared.
        expect(targets.map((r) => r.scope)).toEqual(['personal', 'personal']);
        expect(targets.map((r) => r.user_id)).toEqual([1, 2]);
        // created_by_user_id backfills to the row's own owner: for a personal target, the person
        // whose channel it is IS the person who created it.
        expect(targets.map((r) => r.created_by_user_id)).toEqual([1, 2]);
        // The rebuild carries every column across, ids included -- an id change would orphan
        // nothing here but would be a lie about the row's identity.
        expect(targets[0]).toMatchObject({
          id: 7,
          channel: 'telegram',
          destination: '12345',
          secret_encrypted: 'ALEX-TOKEN',
          enabled: 1,
          verified_at: '2026-08-01T00:00:00.000Z',
          created_at: '2026-07-01T00:00:00.000Z',
        });

        // The outbox survives its own rebuild: its rows are the dedup memory (MUST-3.9), so
        // losing them would re-announce everything already delivered.
        const outbox = upgraded.sqlite.prepare('select * from notification_outbox').all() as Record<string, unknown>[];
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({ id: 3, user_id: 1, dedup_key: 'due:4:2026-09-01', status: 'sent' });

        // And the new constraints are live on the upgraded file, not only on a fresh one.
        insertHouseholdTelegram(upgraded.sqlite, 1);
        expect(() => insertHouseholdTelegram(upgraded.sqlite, 2, '-1003333')).toThrow(/UNIQUE/i);
      } finally {
        upgraded.sqlite.close();
      }
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });

  it('reopening the upgraded file applies 0021 exactly once', () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    try {
      process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
      openDatabase(file).sqlite.close();
      delete process.env.BUDGET_MIGRATIONS_DIR;
      openDatabase(file).sqlite.close();
      // A table rebuild that ran twice would have thrown on the second pass (the __new_ table
      // already exists); this proves the journal stamp is what stops it, not luck.
      const reopened = openDatabase(file);
      try {
        expect(columns(reopened.sqlite, 'notification_targets').has('scope')).toBe(true);
        const stray = reopened.sqlite
          .prepare("select name from sqlite_master where type = 'table' and name like '__new_%'")
          .all() as { name: string }[];
        expect(stray, 'a rebuild left its scratch table behind').toEqual([]);
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });
});
