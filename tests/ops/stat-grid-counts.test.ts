import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Review F5. `.stat-grid` is a six-column grid with tuned rules for 2, 3, 4, 5 and 6 children
 * (globals.css). Anything else falls through to "span 2 each", which for SEVEN children laid the
 * loan ledger card out 3/3/1 -- a hero, two figures beside it, and one stranded on its own row.
 *
 * The CSS cannot warn about a count it has no rule for, so this does: every caller's child count is
 * one the stylesheet actually tunes.
 */
const TUNED = [1, 2, 3, 4, 5, 6];

function tsxFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      tsxFiles(full, found);
      continue;
    }
    if (entry.name.endsWith('.tsx')) found.push(full.replace(/\\/g, '/'));
  }
  return found;
}

/**
 * The children of the `.stat-grid` element beginning at `from`, counted by brace depth over the
 * JSX. Only STATIC children are counted -- a `{rows.map(...)}` child is a list whose length the
 * data decides, which no static check can know and which the callers here do not use.
 */
function childCount(source: string, from: number): number | null {
  const open = source.indexOf('>', from);
  if (open === -1) return null;
  let depth = 0;
  let children = 0;
  for (let index = open + 1; index < source.length; index += 1) {
    const rest = source.slice(index);
    if (rest.startsWith('</dl>') || rest.startsWith('</div>')) {
      if (depth === 0) return children;
      depth -= 1;
      index += rest.startsWith('</dl>') ? 4 : 5;
      continue;
    }
    if (rest.startsWith('<dl') || rest.startsWith('<div')) {
      depth += 1;
      continue;
    }
    if (depth === 0 && (rest.startsWith('<Figure') || rest.startsWith('<StatTile') || rest.startsWith('<Stat '))) {
      children += 1;
    }
    if (depth === 0 && rest.startsWith('.map(')) return null;
  }
  return children;
}

describe('F5: every stat grid renders a count the CSS has a rule for', () => {
  it('finds the callers, and each renders a tuned number of tiles', () => {
    const callers: { file: string; count: number }[] = [];
    for (const file of [...tsxFiles('src/app'), ...tsxFiles('src/components')]) {
      const source = fs.readFileSync(file, 'utf8');
      let index = source.indexOf('stat-grid');
      while (index !== -1) {
        const count = childCount(source, index);
        if (count !== null && count > 0) callers.push({ file, count });
        index = source.indexOf('stat-grid', index + 1);
      }
    }
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.filter((caller) => !TUNED.includes(caller.count))).toEqual([]);
  });

  /** A positive control: the walker must actually be able to count a seven-tile grid as seven. */
  it('counts children, rather than always answering zero', () => {
    const seven = `<dl className="stat-grid">${'<Figure label="x" value="y" />'.repeat(7)}</dl>`;
    expect(childCount(seven, 0)).toBe(7);
    expect(TUNED.includes(7)).toBe(false);
  });
});
