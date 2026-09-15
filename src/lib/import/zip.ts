import zlib from 'node:zlib';
import { MAX_FILE_BYTES } from './parse';

/**
 * 2026-09-15, rulings B11 and B12. A zip of statements, opened so the files inside can be imported
 * like any other drop. The owner asked for it in the first sentence of the request: "if its a zip
 * it should inzip and import".
 *
 * WHY THIS IS HAND-WRITTEN rather than a dependency (ruling B12). `tar` is in this app's
 * dependencies for backups; zip is a different container and no zip library is present. The part
 * of the format a bank export actually uses is small -- a central directory, and two compression
 * methods -- and the whole reader is the file you are reading. The trade is stated plainly because
 * it is a real one: a library would be fewer lines of ours to be wrong in, and one more package in
 * a public, self-hosted image to trust and to keep patched.
 *
 * WHAT IT DELIBERATELY DOES NOT SUPPORT: zip64 (an archive over 4 GB, or with over 65535 entries),
 * encryption, data descriptors with unknown sizes, and any compression method but STORE and
 * DEFLATE. Every one of those throws rather than guessing. A household's bank export is none of
 * them, and a reader that muddles through a format it does not understand is how a parser becomes
 * an exploit.
 *
 * THE GUARDS ARE THE POINT. An archive is untrusted input that expands, so the dangers are not the
 * usual parsing ones: a name that climbs out of the extraction directory, a few kilobytes that
 * decompress to gigabytes, a header that lies about how much it will produce. Each is refused
 * below, and each has a test built on a real archive carrying the real attack
 * (tests/lib/import/zip.test.ts).
 */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

/** One file out of an archive: the name it carried, and its bytes. */
export interface ZipEntry {
  filename: string;
  buf: Buffer;
}

/** As many files as one drop may carry -- deliberately the same bound the batch route applies. */
export const MAX_ZIP_ENTRIES = 25;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD_MIN = 22;
/** The comment that may follow the end-of-directory record, and therefore how far back to look. */
const EOCD_MAX_COMMENT = 0xffff;

/**
 * By the bytes, never by the extension. A `.zip` that is really a CSV and a `.csv` that is really
 * a zip both happen -- the first when a bank names an export badly, the second when somebody
 * renames a download -- and the content is the only claim worth believing. This is the same
 * dispatch rule `looksLikeOfx` follows, for the same reason.
 */
export function looksLikeZip(_filename: string, buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const signature = buf.readUInt32LE(0);
  // An EMPTY archive has no local headers at all -- it is an end-of-directory record and nothing
  // else, so it opens with that signature instead. Rare, but a household that zipped the wrong
  // folder produces one, and answering "that is not a zip" would be both wrong and unhelpful.
  return signature === LOCAL_SIG || signature === EOCD_SIG;
}

/** The end-of-central-directory record, which is the only reliable way into a zip. */
function findEocd(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - EOCD_MIN - EOCD_MAX_COMMENT);
  for (let at = buf.length - EOCD_MIN; at >= earliest; at -= 1) {
    if (buf.readUInt32LE(at) === EOCD_SIG) return at;
  }
  throw new ZipError('This zip file could not be read.');
}

/**
 * Names that must never be honoured. The reader hands bytes to a caller that writes them under a
 * generated UUID, so traversal cannot actually escape today -- this refuses it anyway, because
 * that safety is a property of the CALLER and this function should not depend on a guarantee made
 * somewhere it cannot see. A backslash is refused along with a slash: it is a separator on the
 * platform this app is developed on, and a perfectly ordinary name character on the one it ships to.
 */
function assertSafeName(name: string): void {
  const unsafe =
    name.includes('..') ||
    name.startsWith('/') ||
    name.includes('\\') ||
    /^[a-zA-Z]:/.test(name) ||
    name.includes('\0');
  if (unsafe) throw new ZipError(`That zip contains an unsafe path (${name}) and was not opened.`);
}

/** Folder entries and the metadata every Mac-made archive carries. Neither is a statement. */
function isNoise(name: string): boolean {
  return name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').pop()?.startsWith('._') === true;
}

export function readZipEntries(buf: Buffer): ZipEntry[] {
  if (!looksLikeZip('', buf)) throw new ZipError('That file is not a zip archive.');

  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const directoryAt = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ZIP_ENTRIES) {
    throw new ZipError(`That zip holds ${count} files. Drop at most ${MAX_ZIP_ENTRIES} at once.`);
  }

  /*
    TWO PASSES, AND THE ORDER MATTERS. The first reads the directory only, which is where every
    entry states how large it will become. Summing those BEFORE decompressing anything is what
    makes a zip bomb cost nothing to refuse: the archive is a few kilobytes, the answer is in its
    headers, and nothing has been expanded to find it out.

    The declared total is only a promise, so the second pass bounds what each entry ACTUALLY
    produces as well -- see inflate() below.
  */
  const planned: { name: string; method: number; compressedSize: number; declaredSize: number; localAt: number }[] = [];
  let cursor = directoryAt;
  let declaredTotal = 0;

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new ZipError('This zip file could not be read.');
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const declaredSize = buf.readUInt32LE(cursor + 24);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localAt = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    assertSafeName(name);
    if (!isNoise(name)) {
      declaredTotal += declaredSize;
      if (declaredTotal > MAX_FILE_BYTES) {
        throw new ZipError(`The files in that zip are larger than ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB in total.`);
      }
      planned.push({ name, method, compressedSize, declaredSize, localAt });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return planned.map((entry) => ({ filename: entry.name, buf: extract(buf, entry) }));
}

function extract(
  buf: Buffer,
  entry: { name: string; method: number; compressedSize: number; declaredSize: number; localAt: number },
): Buffer {
  const at = entry.localAt;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL_SIG) {
    throw new ZipError(`${entry.name} could not be read out of that zip.`);
  }
  // The local header repeats the name and extra-field lengths, and they may legitimately DIFFER
  // from the central directory's -- the extra field commonly does. So the data offset is computed
  // from the local header, never from the directory's copy.
  const nameLength = buf.readUInt16LE(at + 26);
  const extraLength = buf.readUInt16LE(at + 28);
  const from = at + 30 + nameLength + extraLength;
  const data = buf.subarray(from, from + entry.compressedSize);

  if (entry.method === 0) {
    if (data.length > MAX_FILE_BYTES) throw new ZipError(`${entry.name} is too large to import.`);
    return Buffer.from(data);
  }
  if (entry.method !== 8) {
    throw new ZipError(`${entry.name} uses a compression this app cannot read.`);
  }
  return inflate(data, entry);
}

/**
 * The second half of the bomb guard. `maxOutputLength` makes zlib itself stop at the bound rather
 * than allocating first and being refused after, which is the difference between a rejection and
 * an out-of-memory crash of the whole server.
 *
 * The bound is the SMALLER of what the entry promised and what this app will import at all -- so a
 * header claiming ten bytes and producing two megabytes is refused on its own claim, and one
 * claiming four megabytes is still held to the import limit.
 */
function inflate(data: Buffer, entry: { name: string; declaredSize: number }): Buffer {
  const limit = Math.min(entry.declaredSize, MAX_FILE_BYTES);
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: limit });
  } catch {
    throw new ZipError(`${entry.name} could not be read out of that zip.`);
  }
}
