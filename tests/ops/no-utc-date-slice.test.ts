import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Review B9. `new Date().toISOString().slice(0, 10)` is the UTC date, and this household does not
 * live in UTC: for the five hours after seven in the evening in Toronto it names TOMORROW. Every
 * date this app decides has to come from todayIso/monthOf (src/lib/dates.ts), which read the
 * configured zone.
 *
 * One survivor was left when the rule was written -- cashflowTrend's default endMonth, unreachable
 * because every caller passes one, which is exactly how it survived four reviews. This guard is
 * cheaper than a fifth.
 */
const SLICE = /toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*(?:7|10)\s*\)/;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, found);
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(full.replace(/\\/g, '/'));
  }
  return found;
}

describe('B9: no date is decided in UTC', () => {
  /** A positive control: the pattern has to catch the thing it names. */
  it('catches the shape it forbids', () => {
    expect(SLICE.test("const today = new Date().toISOString().slice(0, 10);")).toBe(true);
    expect(SLICE.test("const month = at.toISOString().slice(0, 7);")).toBe(true);
    // And leaves alone the full-instant form, which is a timestamp and not a date at all.
    expect(SLICE.test('const stamp = new Date().toISOString();')).toBe(false);
  });

  it('nothing under src/ slices a date off an ISO string', () => {
    const offenders = sourceFiles('src')
      .map((file) => ({ file, lines: fs.readFileSync(file, 'utf8').split('\n') }))
      .flatMap(({ file, lines }) =>
        lines
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => SLICE.test(line))
          .map(({ index }) => `${file}:${index + 1}`),
      );
    expect(offenders).toEqual([]);
  });
});
