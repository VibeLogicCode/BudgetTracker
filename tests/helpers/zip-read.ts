import zlib from 'node:zlib';

/**
 * v1.63.0 (plan 2026-11-12, B3). A minimal zip READER written for the tests, independent of the
 * writer in src/lib/zip-stream.ts: it walks the end record and the central directory, checks every
 * signature, that each local header agrees with its directory entry, that entries sit back to back
 * from offset 0 up to the directory, and recomputes each CRC over the stored bytes. Anything else
 * throws. Stored entries only (method 0), no Zip64, no archive comment: the one form the writer
 * produces.
 */
export interface ZipReadEntry {
  name: string;
  data: Buffer;
  crc: number;
  /** YYYY-MM-DD decoded from the DOS date field. */
  date: string;
  /** HH:MM decoded from the DOS time field. */
  time: string;
}

function fail(message: string): never {
  throw new Error(`zip-read: ${message}`);
}

export function readZip(zip: Buffer): ZipReadEntry[] {
  if (zip.length < 22) fail('shorter than an end record');
  const end = zip.length - 22;
  if (zip.readUInt32LE(end) !== 0x06054b50) fail('no end-of-central-directory signature at the end');
  if (zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0) fail('multi-disk archive');
  const onDisk = zip.readUInt16LE(end + 8);
  const count = zip.readUInt16LE(end + 10);
  if (onDisk !== count) fail('entry counts disagree');
  const directoryBytes = zip.readUInt32LE(end + 12);
  const directoryOffset = zip.readUInt32LE(end + 16);
  if (zip.readUInt16LE(end + 20) !== 0) fail('archive comment present');
  if (directoryOffset + directoryBytes !== end) fail('central directory does not end where the end record starts');

  const entries: ZipReadEntry[] = [];
  let at = directoryOffset;
  let nextLocal = 0;
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) fail(`entry ${index}: bad central signature`);
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const time = zip.readUInt16LE(at + 12);
    const date = zip.readUInt16LE(at + 14);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.toString('ascii', at + 46, at + 46 + nameLength);
    if (flags !== 0) fail(`${name}: flags ${flags}`);
    if (method !== 0) fail(`${name}: method ${method}, not stored`);
    if (compressed !== size) fail(`${name}: stored entry with different sizes`);
    if (localOffset !== nextLocal) fail(`${name}: local header at ${localOffset}, expected ${nextLocal}`);

    if (zip.readUInt32LE(localOffset) !== 0x04034b50) fail(`${name}: bad local signature`);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const local = {
      flags: zip.readUInt16LE(localOffset + 6),
      method: zip.readUInt16LE(localOffset + 8),
      time: zip.readUInt16LE(localOffset + 10),
      date: zip.readUInt16LE(localOffset + 12),
      crc: zip.readUInt32LE(localOffset + 14),
      compressed: zip.readUInt32LE(localOffset + 18),
      size: zip.readUInt32LE(localOffset + 22),
      name: zip.toString('ascii', localOffset + 30, localOffset + 30 + localNameLength),
    };
    if (
      local.flags !== flags ||
      local.method !== method ||
      local.time !== time ||
      local.date !== date ||
      local.crc !== crc ||
      local.compressed !== compressed ||
      local.size !== size ||
      local.name !== name
    ) {
      fail(`${name}: local header disagrees with the central directory`);
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(dataStart, dataStart + size);
    if (data.length !== size) fail(`${name}: truncated`);
    if (zlib.crc32(data) !== crc) fail(`${name}: CRC mismatch`);
    nextLocal = dataStart + size;

    const pad = (value: number) => String(value).padStart(2, '0');
    entries.push({
      name,
      data: Buffer.from(data),
      crc,
      date: `${(date >> 9) + 1980}-${pad((date >> 5) & 0xf)}-${pad(date & 0x1f)}`,
      time: `${pad(time >> 11)}:${pad((time >> 5) & 0x3f)}`,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (nextLocal !== directoryOffset) fail('bytes between the last entry and the central directory');
  if (at !== end) fail('central directory longer than its entries');
  return entries;
}
