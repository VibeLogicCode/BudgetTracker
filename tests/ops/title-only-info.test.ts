import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Review F5/F6. A `title` attribute is a hover tooltip: unreachable by touch, unreachable by
 * keyboard, and unannounced by most screen readers. Twice in this app it was carrying something a
 * person actually needed -- the working behind a loan's interest charge, and the reason a
 * notification checkbox was disabled -- and in both cases the people most likely to need it were
 * the ones who could not get it.
 *
 * The rule this guards is narrow on purpose: no `title` on a table CELL that carries something the
 * cell does not already say. A cell that TRUNCATES its own text is the allowed case -- there the
 * title repeats what is visibly cut off, which is the affordance browsers built it for, and three
 * cells in this app (a CSV preview and two account names) use it exactly that way.
 */
const TITLE_ON_CELL = /<t[dh](?=[^>]*\stitle=)/;
const TRUNCATES = /truncate/;

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

describe('F5/F6: nothing a person needs lives in a tooltip', () => {
  /** A positive control: the pattern has to catch the shape it forbids. */
  it('recognises a cell that carries one', () => {
    expect(TITLE_ON_CELL.test('<td title={detail}>{describe(row)}</td>')).toBe(true);
    expect(TITLE_ON_CELL.test('<th title="why">Event</th>')).toBe(true);
    expect(TITLE_ON_CELL.test('<td className="text-right">{amount}</td>')).toBe(false);
    expect(TITLE_ON_CELL.test('<a title="Open">link</a>')).toBe(false);
    // And the truncation case is recognised as the allowed one.
    expect(TRUNCATES.test('<td className="max-w-40 truncate" title={cell}>')).toBe(true);
    expect(TRUNCATES.test('<td title={detail}>')).toBe(false);
  });

  it('no table cell under src/ carries a title', () => {
    const offenders: string[] = [];
    for (const file of [...tsxFiles('src/app'), ...tsxFiles('src/components')]) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (TITLE_ON_CELL.test(line) && !TRUNCATES.test(line)) offenders.push(`${file}:${index + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
