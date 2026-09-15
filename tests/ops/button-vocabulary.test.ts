import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buttonClass } from '@/components/ui/Button';

const ROOT = process.cwd();

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.tsx$/.test(entry.name) ? [relative] : [];
  });
}

/**
 * 2026-09-15, from `$impeccable critique`: `buttonClass` is documented as existing "so a link never
 * has to re-describe the styling by hand and drift from it" — and then 43 files re-described it by
 * hand anyway, against 3 that imported it. An abstraction nothing reaches for is not an
 * abstraction; it is a second definition with better manners.
 *
 * WHAT THIS ACTUALLY BUYS, since the CSS is already central and a literal `class="btn btn--sm"`
 * renders identically today: the composition. Sizes and variants are a closed set, and going
 * through the builder is what makes them one — so a future rule about how a button link is put
 * together (an icon gap, a loading affordance, a disabled treatment for links) has one place to
 * land instead of forty.
 *
 * WHAT IT DOES NOT CLAIM. `.btn` in a plain `<button>` inside a component that already renders its
 * own element is not the target here and is not scanned for: `SubmitButton` and `Button` both
 * build their class through `buttonClass` already, and the CSS file itself obviously names the
 * classes. This is about hand-written class STRINGS in markup.
 */
const files = walk('src');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** A hand-written button class string in markup: `className="btn btn--secondary btn--sm"`. */
function literalButtonClasses(source: string): string[] {
  return [...source.matchAll(/className="btn(?: btn--[a-z]+)+[^"]*"/g)].map((m) => m[0]);
}

describe('one way to build a button class', () => {
  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('src/components/ui/Button.tsx');
  });

  it('no markup re-describes the button classes by hand', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const found of literalButtonClasses(read(file))) offenders.push(`${file}: ${found}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the builder is actually reached', () => {
    const users = files.filter((file) => read(file).includes('buttonClass('));
    expect(users.length).toBeGreaterThan(20);
  });

  /** Non-vacuity: the scan must reject the exact shape that was there before. */
  it('would catch the drift it removed', () => {
    expect(literalButtonClasses('<Link className="btn btn--secondary btn--sm">x</Link>')).not.toEqual([]);
    expect(literalButtonClasses('<Link className="btn btn--primary">x</Link>')).not.toEqual([]);
    // A className built through the builder is not a literal and must not be reported.
    expect(literalButtonClasses('<Link className={buttonClass()}>x</Link>')).toEqual([]);
  });

  it('builds what the CSS expects', () => {
    expect(buttonClass('secondary', 'sm')).toBe('btn btn--secondary btn--sm');
    expect(buttonClass('primary')).toBe('btn btn--primary');
    expect(buttonClass('ghost', 'sm', 'text-accent-text')).toBe('btn btn--ghost btn--sm text-accent-text');
  });
});
