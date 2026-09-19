import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Review F6. Sixteen `<th>` elements carried no `scope` -- eleven in the notification settings and
 * five in one reports table. Without it a screen reader cannot tell a column header from a row
 * header, so it announces neither while reading the cells, and a table of forty notification
 * preferences becomes forty unlabelled checkboxes.
 *
 * Every other table in the app already had it; these were the ones nobody had gone back to.
 */
const BARE_TH = /<th(?![^>]*\bscope=)[\s>]/;

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

describe('F6: every column header says it is one', () => {
  /** A positive control: the pattern catches what it is looking for, and spares what it should. */
  it('recognises a bare header and leaves a scoped one alone', () => {
    expect(BARE_TH.test('<th>Category</th>')).toBe(true);
    expect(BARE_TH.test('<th className="text-right">Median</th>')).toBe(true);
    expect(BARE_TH.test('<th scope="col">Category</th>')).toBe(false);
    expect(BARE_TH.test('<thead>')).toBe(false);
  });

  it('no <th> under src/ is missing its scope', () => {
    const offenders: string[] = [];
    for (const file of [...tsxFiles('src/app'), ...tsxFiles('src/components')]) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (BARE_TH.test(line)) offenders.push(`${file}:${index + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
