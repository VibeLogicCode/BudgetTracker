import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Readable } from 'node:stream';
import { assertZipEntries, zipLength, zipStream, type ZipEntry } from '@/lib/zip-stream';
import { readZip } from '../helpers/zip-read';

/**
 * v1.63.0 (plan 2026-11-12, B3). The streamed zip writer, read back by an independent reader
 * (tests/helpers/zip-read.ts) and, where it is installed, by Python's zipfile.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-zip-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function twoEntries(): ZipEntry[] {
  const file = path.join(tempDir(), 'c.bin');
  fs.writeFileSync(file, Buffer.from([1, 2, 3]));
  return [
    { name: 'a.txt', date: '2026-03-09', size: 5, source: Buffer.from('hello') },
    { name: 'b/c.bin', date: '2026-12-31', size: fs.statSync(file).size, source: { path: file } },
  ];
}

const hasPython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

describe('zipStream', () => {
  it('writes entries an independent reader takes back, with the real CRC and the listing date', async () => {
    const zip = await collect(zipStream(twoEntries()));
    const entries = readZip(zip);
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'b/c.bin']);
    expect(entries[0].data.toString()).toBe('hello');
    expect(entries[0].crc).toBe(0x3610a686);
    expect([...entries[1].data]).toEqual([1, 2, 3]);
    expect(entries.map((entry) => [entry.date, entry.time])).toEqual([
      ['2026-03-09', '12:00'],
      ['2026-12-31', '12:00'],
    ]);
  });

  it('produces exactly zipLength bytes', async () => {
    const entries = twoEntries();
    const zip = await collect(zipStream(entries));
    expect(zip.length).toBe(zipLength(entries));
    expect(zipLength(entries)).toBe(30 + 5 + 5 + (30 + 7 + 3) + (46 + 5) + (46 + 7) + 22);
  });

  it('writes a valid empty archive', async () => {
    const zip = await collect(zipStream([]));
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  /** Many read chunks per file (64 KiB each), and several files after it at shifted offsets. */
  function largeEntries(): ZipEntry[] {
    const dir = tempDir();
    const big = path.join(dir, 'big.bin');
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 7);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + 7) & 0xff;
    fs.writeFileSync(big, bytes);
    const empty = path.join(dir, 'empty.pdf');
    fs.writeFileSync(empty, '');
    return [
      { name: 'receipts/2026-02-03_big_r1.pdf', date: '2026-02-03', size: bytes.length, source: { path: big } },
      { name: 'receipts/2026-02-04_empty_r2.pdf', date: '2026-02-04', size: 0, source: { path: empty } },
      ...twoEntries(),
    ];
  }

  it('streams a file of many chunks intact, with the entries after it at the right offsets', async () => {
    const entries = largeEntries();
    const zip = await collect(zipStream(entries));
    expect(zip.length).toBe(zipLength(entries));
    const read = readZip(zip);
    expect(read.map((entry) => [entry.name, entry.data.length])).toEqual([
      ['receipts/2026-02-03_big_r1.pdf', 3 * 1024 * 1024 + 7],
      ['receipts/2026-02-04_empty_r2.pdf', 0],
      ['a.txt', 5],
      ['b/c.bin', 3],
    ]);
    expect(read[0].data.equals(fs.readFileSync((entries[0].source as { path: string }).path))).toBe(true);
  });

  it.skipIf(!hasPython)('passes python3 -m zipfile -t, small and large', async () => {
    for (const entries of [twoEntries(), largeEntries()]) {
      const file = path.join(tempDir(), 'pack.zip');
      fs.writeFileSync(file, await collect(zipStream(entries)));
      const result = spawnSync('python3', ['-m', 'zipfile', '-t', file], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it('errors the stream when a file grows between its stat and its read', async () => {
    const file = path.join(tempDir(), 'grows.bin');
    fs.writeFileSync(file, 'abc');
    const size = fs.statSync(file).size;
    fs.appendFileSync(file, 'def');
    await expect(collect(zipStream([{ name: 'grows.bin', date: '2026-03-09', size, source: { path: file } }]))).rejects.toThrow(
      'grows.bin changed while the zip was being written.',
    );
  });

  it('errors the stream when a file shrinks', async () => {
    const file = path.join(tempDir(), 'shrinks.bin');
    fs.writeFileSync(file, 'abcdef');
    await expect(collect(zipStream([{ name: 'shrinks.bin', date: '2026-03-09', size: 9, source: { path: file } }]))).rejects.toThrow(
      'changed while the zip was being written',
    );
  });

  it('refuses a bad name or a duplicate before writing a byte', () => {
    const good: ZipEntry = { name: 'a.txt', date: '2026-03-09', size: 1, source: Buffer.from('x') };
    for (const name of ['/abs.txt', '../up.txt', 'a/../b.txt', 'a//b.txt', 'dir/', 'space name.txt', 'é.txt', 'x'.repeat(201), '']) {
      expect(() => zipStream([{ ...good, name }]), name).toThrow(/Refusing zip entry name/);
    }
    expect(() => zipStream([good, { ...good }])).toThrow('Duplicate zip entry name: a.txt');
    expect(() => zipStream([{ ...good, size: 2 }])).toThrow(/is 1 bytes, not 2/);
    expect(() => zipStream([{ ...good, date: '9 March' }])).toThrow(/YYYY-MM-DD/);
  });

  it('refuses more entries than a zip without Zip64 can list', () => {
    const many: ZipEntry[] = Array.from({ length: 0x10000 }, (_, index) => ({
      name: `f${index}.txt`,
      date: '2026-03-09',
      size: 0,
      source: Buffer.alloc(0),
    }));
    expect(() => assertZipEntries(many)).toThrow('A zip holds at most 65535 entries.');
  });

  it('refuses a total at or past 4 GiB', () => {
    expect(() =>
      assertZipEntries([{ name: 'huge.bin', date: '2026-03-09', size: 0xffffffff, source: { path: 'never-read' } }]),
    ).toThrow('A zip without Zip64 must stay under 4 GiB.');
  });

  it('closes the open file when the stream is destroyed part-way', async () => {
    const file = path.join(tempDir(), 'big.bin');
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024, 7));
    const opened = vi.spyOn(fs, 'createReadStream');
    const zip = zipStream([{ name: 'big.bin', date: '2026-03-09', size: 1024 * 1024, source: { path: file } }]);

    // The CRC pass reads the whole file first; past the local header, the second pass is open.
    await new Promise<void>((resolve) => {
      let seen = 0;
      zip.on('data', (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > 30 + 'big.bin'.length) {
          zip.pause();
          resolve();
        }
      });
    });
    expect(opened).toHaveBeenCalledTimes(2);
    const second = opened.mock.results[1].value as fs.ReadStream;
    expect(second.closed).toBe(false);

    // Leaving a for-await early destroys the file stream with an AbortError, which is the close
    // this test is waiting for, not a failure.
    second.on('error', () => {});
    const closed = new Promise<void>((resolve) => second.once('close', () => resolve()));
    zip.destroy();
    await closed;
    expect(second.closed).toBe(true);
    expect((opened.mock.results[0].value as fs.ReadStream).closed).toBe(true);
  });
});
