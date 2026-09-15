import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { POST as batchRoute, MAX_BATCH_FILES } from '@/app/api/import/batch/detect/route';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { setUserVisibility } from '@/lib/auth/users';
import zlib from 'node:zlib';

const fixture = (name: string): Uint8Array<ArrayBuffer> => {
  const read = fs.readFileSync(path.join(process.cwd(), 'fixtures', name));
  const copy = new Uint8Array(new ArrayBuffer(read.byteLength));
  copy.set(read);
  return copy;
};

let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;
let token: string;
let userId: number;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-batch-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  current = createSeededTestDb();
  userId = insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'admin' });
  token = createSession(userId).token;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
  current?.cleanup();
  current = null;
});

type Part = { name: string; body: Uint8Array<ArrayBuffer> | string };

function upload(parts: Part[], withAuth = true): Request {
  const form = new FormData();
  for (const part of parts) {
    form.append('files', new File([part.body], part.name, { type: 'text/csv' }));
  }
  return new Request('http://nas.local:3000/api/import/batch/detect', {
    method: 'POST',
    headers: {
      origin: 'http://nas.local:3000',
      host: 'nas.local:3000',
      ...(withAuth ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}),
    },
    body: form,
  });
}

interface Row {
  status: string;
  filename: string;
  reason: string | null;
  stagingId: string | null;
  rowCount: number;
  account: { id: number; name: string } | null;
  profile: { id: number; name: string } | null;
}

const rowsOf = async (response: Response): Promise<Row[]> => ((await response.json()) as { rows: Row[] }).rows;

/**
 * 2026-09-15. N files in, one classified row each back. The owner's ask, verbatim: "do you think we
 * can add abiltiy to import multiple fdiles at once?"
 *
 * WHAT THIS FILE DOES NOT COVER: whether the detections are correct. That is
 * tests/lib/import/detect-account.test.ts and detect-profile.test.ts, and ruling B1 says this route
 * must never form a second opinion -- so a test here asserting a particular account would be
 * asserting the detector's behaviour in the wrong file, and would go stale the moment the detector
 * legitimately improved.
 */
describe('POST /api/import/batch/detect: the three refusals', () => {
  it('refuses a cross-origin post before reading anything', async () => {
    const request = new Request('http://nas.local:3000/api/import/batch/detect', {
      method: 'POST',
      headers: { origin: 'http://evil.example', host: 'nas.local:3000', cookie: `${SESSION_COOKIE_NAME}=${token}` },
      body: new FormData(),
    });
    expect((await batchRoute(request)).status).toBe(403);
  });

  it('refuses an unauthenticated post', async () => {
    expect((await batchRoute(upload([{ name: 'a.csv', body: fixture('td-chequing.csv') }], false))).status).toBe(401);
  });

  /** Ruling R2, same as every other import surface: a self-scoped viewer has no import at all. */
  it('refuses a self-scoped member, exactly as the single-file route does', async () => {
    // An admin cannot be limited to their own records, so the self case needs a member.
    const member = insertTestUser(current!.db, { name: 'Kid', username: 'kid', role: 'member' });
    setUserVisibility(member, 'self');
    token = createSession(member).token;
    expect((await batchRoute(upload([{ name: 'a.csv', body: fixture('td-chequing.csv') }]))).status).toBe(403);
  });
});

describe('POST /api/import/batch/detect: a row per file', () => {
  it('answers three files in one round trip', async () => {
    insertTestAccount(current!.db, { name: 'TD Chequing' });
    const response = await batchRoute(
      upload([
        { name: 'jan.csv', body: fixture('td-chequing.csv') },
        { name: 'feb.csv', body: fixture('td-chequing.csv') },
        { name: 'mar.csv', body: fixture('td-chequing.csv') },
      ]),
    );
    expect(response.status).toBe(200);
    const rows = await rowsOf(response);
    expect(rows.map((row) => row.filename)).toEqual(['jan.csv', 'feb.csv', 'mar.csv']);
  });

  it('stages each readable file separately, so any row can be opened later', async () => {
    insertTestAccount(current!.db, { name: 'TD Chequing' });
    const rows = await rowsOf(
      await batchRoute(
        upload([
          { name: 'jan.csv', body: fixture('td-chequing.csv') },
          { name: 'feb.csv', body: fixture('td-chequing.csv') },
        ]),
      ),
    );
    const ids = rows.map((row) => row.stagingId);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it('classifies every row into one of the four statuses', async () => {
    insertTestAccount(current!.db, { name: 'TD Chequing' });
    const rows = await rowsOf(await batchRoute(upload([{ name: 'jan.csv', body: fixture('td-chequing.csv') }])));
    expect(['ready', 'already-imported', 'needs-you', 'unsupported']).toContain(rows[0]!.status);
  });
});

/**
 * The drop that motivated the whole feature is a bank folder, and a bank folder has a PDF in it.
 * Answering that drop with one error would be worse than the flow it replaces.
 */
describe('POST /api/import/batch/detect: one bad file does not cost the others', () => {
  it('reports the unreadable file as a row and still answers the good ones', async () => {
    insertTestAccount(current!.db, { name: 'TD Chequing' });
    const rows = await rowsOf(
      await batchRoute(
        upload([
          { name: 'jan.csv', body: fixture('td-chequing.csv') },
          { name: 'scan.pdf', body: new TextEncoder().encode('%PDF-1.4 not a statement') as Uint8Array<ArrayBuffer> },
          { name: 'feb.csv', body: fixture('td-chequing.csv') },
        ]),
      ),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]!.status).not.toBe('unsupported');
    expect(rows[2]!.status).not.toBe('unsupported');
  });

  /** An unsupported row stages nothing, so it must not offer a staging id to open. */
  it('gives an unreadable file no staging id to open', async () => {
    const rows = await rowsOf(await batchRoute(upload([{ name: 'huge.csv', body: new Uint8Array(new ArrayBuffer(6 * 1024 * 1024)).fill(65) }])));
    expect(rows[0]!.status).toBe('unsupported');
    expect(rows[0]!.stagingId).toBeNull();
    expect(rows[0]!.reason).toMatch(/larger than/i);
  });
});

describe('POST /api/import/batch/detect: bounds', () => {
  it('refuses an empty post', async () => {
    expect((await batchRoute(upload([]))).status).toBe(400);
  });

  /** A folder-select can hand over hundreds by accident; each one costs a parse and a staged write. */
  it('refuses more files than one drop may carry', async () => {
    const parts = Array.from({ length: MAX_BATCH_FILES + 1 }, (_, index) => ({
      name: `f${index}.csv`,
      body: 'Date,Description,Amount\n',
    }));
    const response = await batchRoute(upload(parts));
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe('too_many_files');
  });
});

/**
 * Ruling B11, and the owner's first sentence: "if its a zip it should inzip and import". Every
 * guard lives in src/lib/import/zip.ts and is tested against real hostile archives there
 * (tests/lib/import/zip.test.ts) -- what this covers is the ROUTE's half: an archive becomes
 * ordinary rows, and a refusal from the reader costs only the archive.
 */
function zipOf(entries: { name: string; body: Uint8Array | string }[]): Uint8Array<ArrayBuffer> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.body as never);
    const data = zlib.deflateRawSync(raw);
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const whole = Buffer.concat([...locals, central, eocd]);
  const copy = new Uint8Array(new ArrayBuffer(whole.byteLength));
  copy.set(whole);
  return copy;
}

describe('POST /api/import/batch/detect: a zip becomes ordinary rows', () => {
  it('opens the archive and lists what was inside it, not the archive', async () => {
    insertTestAccount(current!.db, { name: 'TD Chequing' });
    const rows = await rowsOf(
      await batchRoute(
        upload([
          {
            name: 'statements.zip',
            body: zipOf([
              { name: 'jan.csv', body: fixture('td-chequing.csv') },
              { name: 'feb.csv', body: fixture('td-chequing.csv') },
            ]),
          },
        ]),
      ),
    );
    expect(rows.map((row) => row.filename)).toEqual(['jan.csv', 'feb.csv']);
    expect(rows.every((row) => row.stagingId !== null)).toBe(true);
  });

  it('mixes a zip and a loose file in one drop', async () => {
    insertTestAccount(current!.db, { name: 'TD Chequing' });
    const rows = await rowsOf(
      await batchRoute(
        upload([
          { name: 'mar.csv', body: fixture('td-chequing.csv') },
          { name: 'statements.zip', body: zipOf([{ name: 'jan.csv', body: fixture('td-chequing.csv') }]) },
        ]),
      ),
    );
    expect(rows.map((row) => row.filename)).toEqual(['mar.csv', 'jan.csv']);
  });

  /** Ruling B11: listed, never opened. Recursion is how a bounded reader stops being bounded. */
  it('lists a nested archive instead of recursing into it', async () => {
    const inner = zipOf([{ name: 'deep.csv', body: fixture('td-chequing.csv') }]);
    const rows = await rowsOf(await batchRoute(upload([{ name: 'outer.zip', body: zipOf([{ name: 'inner.zip', body: inner }]) }])));
    expect(rows.map((row) => row.filename)).toEqual(['inner.zip']);
    expect(rows[0]!.status).toBe('unsupported');
  });

  /** A refusal from the reader costs the archive and nothing else in the drop. */
  it('reports a bad archive as one row and still answers the loose file', async () => {
    insertTestAccount(current!.db, { name: 'TD Chequing' });
    const rows = await rowsOf(
      await batchRoute(
        upload([
          { name: 'broken.zip', body: zipOf([{ name: '../escape.csv', body: 'x' }]) },
          { name: 'mar.csv', body: fixture('td-chequing.csv') },
        ]),
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe('unsupported');
    expect(rows[0]!.reason).toMatch(/unsafe path/i);
    expect(rows[1]!.filename).toBe('mar.csv');
  });
});
