import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...tsxFiles(rel));
    else if (entry.name.endsWith('.tsx')) out.push(rel);
  }
  return out;
}

/**
 * The one rule behind the v1.10.1 table-width work, and the only one worth a guard.
 *
 * `.cell-truncate` clips a cell and shows an ellipsis. That is a legitimate choice for a value
 * that repeats down a column -- an account name -- and an illegitimate one on its own, because
 * an ellipsis with nothing behind it does not tidy data away, it HIDES it. The whole reported
 * bug was "data is being cut off", so shipping a fix that cuts text off differently would be
 * the same defect wearing a stylesheet.
 *
 * `title` is the condition of use: hover and assistive tech both read it, so the full value
 * stays reachable. This is a grep guard rather than a render test for the reason
 * balance-invariants.test.ts gives -- a rule about what must accompany a construct in EVERY
 * file cannot be enforced by fixtures, which only cover the files someone remembered to write
 * one for.
 *
 * Deliberately NOT guarded here: that a `fixed` TableWrap's <colgroup> has one <col> per
 * column. It is the other way this can break (a mismatch silently divides the width equally,
 * which is worse than the `auto` default it replaced), but several pages render more than one
 * table per file, so a per-file count of <col> against <th> reports failures that are not
 * real. A guard that cries wolf gets deleted, so it is left to review.
 */
describe('table cells never truncate silently', () => {
  const offenders: string[] = [];
  const uses: string[] = [];

  for (const rel of tsxFiles('src')) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    source.split(/\r?\n/).forEach((line, index) => {
      // A real use always applies the class, so it always carries `className` on the same
      // line. Requiring that is what separates a use from prose ABOUT the class -- the
      // docblocks explaining this rule name `cell-truncate` several times, and an earlier
      // version of this guard reported two of those comment lines as violations. Skipping
      // lines that merely LOOK like comments was not enough: both were continuation lines of
      // a multi-line {/* ... */} block, so neither began with a comment marker.
      if (!line.includes('cell-truncate') || !line.includes('className')) return;
      uses.push(`${rel}:${index + 1}`);
      if (!line.includes('title=')) offenders.push(`${rel}:${index + 1}`);
    });
  }

  it('every cell-truncate carries a title with the full value', () => {
    expect(offenders).toEqual([]);
  });

  /**
   * The guard for the bug v1.10.1 shipped and v1.10.3 fixed.
   *
   * `.data-table` is `width: 100%`, so a `table-layout: fixed` table can never grow past its
   * container -- which means the `overflow-x-auto` wrapper has nothing to overflow and never
   * scrolls. The browser honours the <colgroup> by shrinking every column instead. On a phone
   * that turned the transactions description into a single character, printing merchant names
   * one letter per line, while the release notes claimed narrow screens would scroll.
   *
   * `minWidth` is what makes that claim true, so `fixed` without it is the defect, not a style
   * preference. Checked by grep because the pairing is a property of every call site, and the
   * failure is invisible at the width a developer happens to have open.
   */
  it('every fixed TableWrap also passes minWidth, or nothing scrolls and columns crush instead', () => {
    const bad: string[] = [];
    for (const rel of tsxFiles('src')) {
      const source = fs.readFileSync(path.join(root, rel), 'utf8');
      // Opening tag only: `fixed` and `minWidth` are both attributes of the same element.
      for (const match of source.matchAll(/<TableWrap[^>]*>/g)) {
        const tag = match[0];
        if (!/\bfixed\b/.test(tag)) continue;
        if (!/\bminWidth=/.test(tag)) {
          bad.push(`${rel}: ${tag.trim()}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('finds the truncating cells at all, so the check above cannot pass vacuously', () => {
    // A floor, not a count: adding a truncating cell must fail the assertion above with its
    // own file:line, not this one.
    expect(uses.length).toBeGreaterThan(0);
  });
});
