import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Review F4. One destination had five names: "Contracts & Coverage" in the nav and on the page,
 * "Items (N)" over its table, "Back to items" on the way out, "Warranties & bills page" on the
 * dashboard, and "Create warranty" in the transactions row menu. None of them contained the word
 * "loan", which is what most of the money on that page now is.
 *
 * The name is "Loans & Coverage". This guard is here because a sixth name costs nothing to add and
 * is invisible in review -- each of the five was reasonable where it stood.
 */
const RETIRED = ['Back to items', 'Warranties & bills page', 'Warranties &amp; bills page', 'Create warranty', 'Contracts & Coverage', 'Contracts &amp; Coverage'];

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

describe('F4: one noun for Loans & Coverage', () => {
  /** A positive control: the scan has to be looking at real files with real strings in them. */
  it('reads the app source and finds the name in use', () => {
    const files = sourceFiles('src');
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => fs.readFileSync(file, 'utf8').includes('Loans & Coverage'))).toBe(true);
  });

  /**
   * Comments are stripped first. The nav's own docblock quotes the old name to explain the rename,
   * and a comment is not a signpost -- forbidding the words that describe the change would make the
   * code less clear, which is the argument MUST-13.1's own scan already makes.
   */
  function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('no retired name survives anywhere under src/', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      const source = withoutComments(fs.readFileSync(file, 'utf8'));
      for (const retired of RETIRED) {
        source.split('\n').forEach((line, index) => {
          if (line.includes(retired)) offenders.push(`${file}:${index + 1} ${retired}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  /** The stripping must not swallow real code, or the guard would pass by seeing nothing. */
  it('strips comments without eating the strings it guards', () => {
    expect(withoutComments('/* Back to items */\nconst a = 1;')).not.toContain('Back to items');
    expect(withoutComments('const label = "Back to items";')).toContain('Back to items');
  });
});
