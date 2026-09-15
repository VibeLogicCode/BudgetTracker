import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CSS = fs.readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8');

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.tsx$/.test(entry.name) ? [relative] : [];
  });
}

/**
 * 2026-09-15, from `$impeccable critique`: the type scale was 97% two sizes (`text-sm` and
 * `text-xs`, 390 of 401 uses) with ten arbitrary one-offs filling the gaps — and two of those
 * one-offs, `text-[0.6875rem]` and `text-[11px]`, were THE SAME SIZE in two spellings. That is how
 * a scale stops being a scale: nobody can see the steps, so everybody invents one.
 *
 * The fix was not to add sizes. It was to NAME the ones the app had already invented by hand
 * (`--text-2xs`, `--text-md`, `--text-display` in globals.css) so they are part of the scale and
 * adjustable in one place. This guard keeps them that way.
 *
 * WHAT IT DOES NOT CHECK: whether the scale is used WELL — whether a given label should be `2xs`
 * or `xs` is a judgement no grep can make. It checks only that every size in the app has a name.
 */
const files = walk('src');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** `text-[13px]`, `text-[0.8rem]` — a size nobody named. Arbitrary COLOURS and other properties
 *  are a different question and are deliberately not matched. */
function arbitrarySizes(source: string): string[] {
  return [...source.matchAll(/\btext-\[[0-9.]+(?:rem|px|em)\]/g)].map((m) => m[0]);
}

describe('every font size in the app has a name', () => {
  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('declares the steps Tailwind does not ship', () => {
    for (const token of ['--text-2xs', '--text-md', '--text-display']) {
      expect(CSS).toContain(`${token}:`);
    }
  });

  it('no component reaches for an arbitrary font size', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const found of arbitrarySizes(read(file))) offenders.push(`${file}: ${found}`);
    }
    expect(offenders).toEqual([]);
  });

  /** Non-vacuity: the scan must reject the exact spellings that were there. */
  it('would catch the one-offs it removed', () => {
    expect(arbitrarySizes('<span className="text-[0.6875rem]">x</span>')).not.toEqual([]);
    expect(arbitrarySizes('<span className="text-[11px]">x</span>')).not.toEqual([]);
    expect(arbitrarySizes('<h1 className="sm:text-[1.75rem]">x</h1>')).not.toEqual([]);
    // A named step is not an offence, and neither is an arbitrary colour.
    expect(arbitrarySizes('<span className="text-2xs text-[#fff]">x</span>')).toEqual([]);
  });

  /** The eyebrow reads its size from the token rather than restating the number beside it. */
  it('the eyebrow uses the token it shares with the rest of the app', () => {
    const block = CSS.slice(CSS.indexOf('.eyebrow {'), CSS.indexOf('}', CSS.indexOf('.eyebrow {')));
    expect(block).toContain('var(--text-2xs)');
  });
});
