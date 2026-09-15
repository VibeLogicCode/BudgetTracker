import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { ZipError, readZipEntries, looksLikeZip, MAX_ZIP_ENTRIES } from '@/lib/import/zip';

/**
 * 2026-09-15, ruling B11/B12. The owner asked for it in the first sentence of the request: "if its
 * a zip it should inzip and import".
 *
 * WHY THE TESTS BUILD REAL ARCHIVES rather than mocking a reader. Every guard in zip.ts is about
 * bytes a hostile or merely broken archive can carry -- a name that climbs out of the directory, a
 * header that lies about its size, a 4 GB expansion of a 4 KB file. A mocked entry list cannot
 * express any of those, so it would test the classification and none of the danger. The builder
 * below is about forty lines and it is what makes the rest of this file mean anything.
 */
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

interface BuildEntry {
  name: string;
  body: string;
  /** 0 = stored, 8 = deflate. Both are legal and banks emit both. */
  method?: 0 | 8;
  /** Overrides the true uncompressed size in BOTH headers -- the lying-header case. */
  declaredSize?: number;
}

function buildZip(entries: BuildEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? 8;
    const raw = Buffer.from(entry.body, 'utf8');
    const data = method === 0 ? raw : zlib.deflateRawSync(raw);
    const name = Buffer.from(entry.name, 'utf8');
    const declared = entry.declaredSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14); // crc, unchecked by the reader
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, central, eocd]);
}

const CSV = 'Date,Description,Amount\n2026-03-02,COFFEE,-4.85\n';

describe('looksLikeZip', () => {
  it('knows one by its bytes, not by its name', () => {
    expect(looksLikeZip('statements.zip', buildZip([{ name: 'a.csv', body: CSV }]))).toBe(true);
    expect(looksLikeZip('statements.zip', Buffer.from(CSV))).toBe(false);
  });

  it('takes a zip that was renamed, because the content is the claim', () => {
    expect(looksLikeZip('statements.csv', buildZip([{ name: 'a.csv', body: CSV }]))).toBe(true);
  });
});

describe('readZipEntries: the ordinary archive', () => {
  it('returns each file with its name and its bytes', () => {
    const entries = readZipEntries(buildZip([{ name: 'jan.csv', body: CSV }, { name: 'feb.csv', body: CSV }]));
    expect(entries.map((entry) => entry.filename)).toEqual(['jan.csv', 'feb.csv']);
    expect(entries[0]!.buf.toString('utf8')).toBe(CSV);
  });

  it('reads a stored entry as well as a deflated one', () => {
    const entries = readZipEntries(buildZip([{ name: 'stored.csv', body: CSV, method: 0 }]));
    expect(entries[0]!.buf.toString('utf8')).toBe(CSV);
  });

  /** A folder-shaped entry is not a file and has no bytes worth handing on. */
  it('skips directory entries', () => {
    const entries = readZipEntries(buildZip([{ name: 'statements/', body: '' }, { name: 'statements/jan.csv', body: CSV }]));
    expect(entries.map((entry) => entry.filename)).toEqual(['statements/jan.csv']);
  });

  /** Every zip made on a Mac carries these, and none of them is a statement. */
  it('skips the __MACOSX noise', () => {
    const entries = readZipEntries(
      buildZip([{ name: '__MACOSX/._jan.csv', body: 'junk' }, { name: 'jan.csv', body: CSV }]),
    );
    expect(entries.map((entry) => entry.filename)).toEqual(['jan.csv']);
  });

  it('refuses something that is not an archive at all', () => {
    expect(() => readZipEntries(Buffer.from(CSV))).toThrow(ZipError);
  });
});

/**
 * The guards. Every one of these is a real archive carrying a real attack or a real mistake, and
 * each is checked BEFORE anything is written or decompressed where that is possible.
 */
describe('readZipEntries: what a hostile archive cannot do', () => {
  it('refuses an entry that climbs out of the directory', () => {
    expect(() => readZipEntries(buildZip([{ name: '../../etc/passwd', body: 'x' }]))).toThrow(/path/i);
  });

  it('refuses an absolute path', () => {
    expect(() => readZipEntries(buildZip([{ name: '/etc/passwd', body: 'x' }]))).toThrow(/path/i);
  });

  /** A backslash is a separator on the platform this app is developed on and a name character elsewhere. */
  it('refuses a windows-style separator', () => {
    expect(() => readZipEntries(buildZip([{ name: '..\\\\secrets.csv', body: 'x' }]))).toThrow(/path/i);
  });

  /**
   * The zip bomb. The archive passes any upload-size check trivially -- it is a few kilobytes --
   * and the DECOMPRESSED total is what has to be bounded. Checked from the headers first, so the
   * refusal costs nothing.
   */
  it('refuses an archive whose declared expansion is absurd', () => {
    const bomb = buildZip([{ name: 'bomb.csv', body: 'A', declaredSize: 900 * 1024 * 1024 }]);
    expect(() => readZipEntries(bomb)).toThrow(/too large|larger than/i);
  });

  /**
   * And the header that LIES: a small declared size, a large real one. The declared total is only
   * a promise, so the reader has to bound what it actually produces as well.
   */
  it('refuses an entry that expands past its own declared size', () => {
    const liar = buildZip([{ name: 'liar.csv', body: 'A'.repeat(2 * 1024 * 1024), declaredSize: 10 }]);
    expect(() => readZipEntries(liar)).toThrow(ZipError);
  });

  it('refuses an archive with more entries than a drop may carry', () => {
    const many = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, index) => ({ name: `f${index}.csv`, body: CSV }));
    expect(() => readZipEntries(buildZip(many))).toThrow(/at most/i);
  });

  /**
   * A zip inside a zip is left as a file for the caller to mark unsupported. Recursing is how a
   * bounded reader becomes an unbounded one, and no bank has ever nested a statement.
   */
  it('does not recurse into a nested archive', () => {
    const inner = buildZip([{ name: 'jan.csv', body: CSV }]);
    const outer = buildZip([{ name: 'inner.zip', body: inner.toString('binary'), method: 0 }, { name: 'feb.csv', body: CSV }]);
    const entries = readZipEntries(outer);
    expect(entries.map((entry) => entry.filename)).toContain('inner.zip');
    expect(entries.map((entry) => entry.filename)).not.toContain('jan.csv');
  });

  it('handles an empty archive without inventing an entry', () => {
    expect(readZipEntries(buildZip([]))).toEqual([]);
  });
});
