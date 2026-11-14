import fs from 'node:fs';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

/**
 * v1.63.0 (plan 2026-11-12, Y2 and B3). A streamed zip writer built on Node alone: `zlib.crc32`
 * (Node 22.2 and later) and file streams. No dependency: the image is node:22 and the lock file does
 * not move for this.
 *
 * The form is the most widely readable one: STORED entries (receipts are already-compressed JPEG,
 * PNG, WEBP and PDF, so deflating them buys nothing), no data descriptors and no Zip64. Every header
 * carries its real CRC and sizes, so each file is read twice -- once for its CRC, then for its bytes
 * -- and memory stays at one read chunk however large the pack is. Sizes come from the caller (a
 * `stat` before the response starts), which is what lets a route send an exact `content-length`.
 *
 * A file whose size or CRC differs from what the headers promised, on either pass, destroys the
 * stream with an error: a browser then marks the download failed instead of keeping a zip whose
 * directory lies about its contents.
 */

export interface ZipEntry {
  /** ASCII [A-Za-z0-9._/-], relative, no `.`/`..` or empty segment, at most 200 characters, unique. */
  name: string;
  /** YYYY-MM-DD: the entry's date in the archive listing (shown at 12:00). */
  date: string;
  /** Bytes. For a file, the size `stat` gave; the stream errors if the file no longer has it. */
  size: number;
  source: Buffer | { path: string };
}

export class ZipEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipEntryError';
  }
}

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
/** 2.0: the version a stored, non-Zip64 entry needs. */
const ZIP_VERSION = 20;
const NAME_RE = /^[A-Za-z0-9._/-]+$/;
const NAME_MAX = 200;
/** Without Zip64 the entry count is 16 bits and every offset and size 32. */
export const ZIP_MAX_ENTRIES = 0xffff;
export const ZIP_MAX_BYTES = 0xffffffff;

/** The exact byte length zipStream will produce for these entries. */
export function zipLength(entries: readonly ZipEntry[]): number {
  let total = END_RECORD_BYTES;
  for (const entry of entries) {
    const nameBytes = Buffer.byteLength(entry.name, 'ascii');
    total += LOCAL_HEADER_BYTES + nameBytes + entry.size + CENTRAL_HEADER_BYTES + nameBytes;
  }
  return total;
}

/** Throws ZipEntryError on the first entry no reader could take safely. Nothing is written first. */
export function assertZipEntries(entries: readonly ZipEntry[]): void {
  if (entries.length > ZIP_MAX_ENTRIES) throw new ZipEntryError(`A zip holds at most ${ZIP_MAX_ENTRIES} entries.`);
  const seen = new Set<string>();
  for (const entry of entries) {
    const { name } = entry;
    if (name.length === 0 || name.length > NAME_MAX || !NAME_RE.test(name)) {
      throw new ZipEntryError(`Refusing zip entry name: ${JSON.stringify(name.slice(0, NAME_MAX))}`);
    }
    // A leading slash, a trailing one, `a//b`, `.` and `..` are all an empty or relative segment:
    // the names a reader would resolve outside the folder it extracts into.
    if (name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new ZipEntryError(`Refusing zip entry name: ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) throw new ZipEntryError(`Duplicate zip entry name: ${name}`);
    seen.add(name);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new ZipEntryError(`Bad size for zip entry ${name}`);
    if (Buffer.isBuffer(entry.source) && entry.source.length !== entry.size) {
      throw new ZipEntryError(`Zip entry ${name} is ${entry.source.length} bytes, not ${entry.size}`);
    }
    dosDateTime(entry.date);
  }
  if (zipLength(entries) >= ZIP_MAX_BYTES) throw new ZipEntryError('A zip without Zip64 must stay under 4 GiB.');
}

/**
 * DOS date and time for 12:00 on `date`, built from the string's own parts, never through a Date
 * (which would be UTC, and a day early west of Greenwich). DOS dates run 1980 to 2107; a year
 * outside that is clamped to the nearest end, since the listing date is a courtesy, not data.
 */
function dosDateTime(date: string): { time: number; date: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new ZipEntryError(`Zip entry date must be YYYY-MM-DD: ${date}`);
  const year = Math.min(2107, Math.max(1980, Number(match[1])));
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new ZipEntryError(`Zip entry date must be YYYY-MM-DD: ${date}`);
  return { time: 12 << 11, date: ((year - 1980) << 9) | (month << 5) | day };
}

function localHeader(name: Buffer, crc: number, size: number, when: { time: number; date: number }): Buffer {
  const header = Buffer.alloc(LOCAL_HEADER_BYTES);
  header.writeUInt32LE(LOCAL_SIGNATURE, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(0, 6); // flags: no data descriptor, ASCII names
  header.writeUInt16LE(0, 8); // method: stored
  header.writeUInt16LE(when.time, 10);
  header.writeUInt16LE(when.date, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name]);
}

function centralHeader(name: Buffer, crc: number, size: number, when: { time: number; date: number }, offset: number): Buffer {
  const header = Buffer.alloc(CENTRAL_HEADER_BYTES);
  header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(ZIP_VERSION, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(when.time, 12);
  header.writeUInt16LE(when.date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(size, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30); // extra
  header.writeUInt16LE(0, 32); // comment
  header.writeUInt16LE(0, 34); // disk
  header.writeUInt16LE(0, 36); // internal attributes
  header.writeUInt32LE(0, 38); // external attributes
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}

function endRecord(count: number, directoryBytes: number, directoryOffset: number): Buffer {
  const record = Buffer.alloc(END_RECORD_BYTES);
  record.writeUInt32LE(END_SIGNATURE, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(directoryBytes, 12);
  record.writeUInt32LE(directoryOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

function changed(name: string): Error {
  return new Error(`${name} changed while the zip was being written.`);
}

/**
 * The first pass: the file's CRC, streamed. Leaving the loop early (an error, or the zip being
 * destroyed) runs the read stream's own cleanup, which closes the file.
 */
async function fileCrc(path: string, size: number, name: string): Promise<number> {
  let crc = 0;
  let read = 0;
  for await (const chunk of fs.createReadStream(path)) {
    const bytes = chunk as Buffer;
    read += bytes.length;
    if (read > size) throw changed(name);
    crc = zlib.crc32(bytes, crc);
  }
  if (read !== size) throw changed(name);
  return crc;
}

/** The second pass: the bytes themselves, checked against the size and CRC already sent. */
async function* fileBytes(path: string, size: number, crc: number, name: string): AsyncGenerator<Buffer> {
  let again = 0;
  let read = 0;
  for await (const chunk of fs.createReadStream(path)) {
    const bytes = chunk as Buffer;
    read += bytes.length;
    if (read > size) throw changed(name);
    again = zlib.crc32(bytes, again);
    yield bytes;
  }
  if (read !== size || again !== crc) throw changed(name);
}

async function* zipChunks(entries: readonly ZipEntry[]): AsyncGenerator<Buffer> {
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'ascii');
    const when = dosDateTime(entry.date);
    const { source } = entry;
    const crc = Buffer.isBuffer(source) ? zlib.crc32(source) : await fileCrc(source.path, entry.size, entry.name);
    const local = localHeader(name, crc, entry.size, when);
    yield local;
    if (Buffer.isBuffer(source)) {
      if (source.length > 0) yield source;
    } else {
      yield* fileBytes(source.path, entry.size, crc, entry.name);
    }
    directory.push(centralHeader(name, crc, entry.size, when, offset));
    offset += local.length + entry.size;
  }
  let directoryBytes = 0;
  for (const header of directory) {
    directoryBytes += header.length;
    yield header;
  }
  yield endRecord(entries.length, directoryBytes, offset);
}

/**
 * The zip as a byte stream. Entries are checked first (assertZipEntries): a bad name, a duplicate,
 * too many entries or a total past 4 GiB throws here, before a single byte exists.
 */
export function zipStream(entries: readonly ZipEntry[]): Readable {
  assertZipEntries(entries);
  return Readable.from(zipChunks(entries), { objectMode: false });
}
