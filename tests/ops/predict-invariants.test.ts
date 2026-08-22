import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const predictDir = path.join(root, 'src/lib/predict');

function filesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe('MUST-2.1 and AC10: only history.ts touches the database', () => {
  it('no other file under src/lib/predict/ imports @/db, @/lib/env or a node builtin', () => {
    for (const file of filesUnder(predictDir)) {
      if (path.basename(file) === 'history.ts') continue;
      const source = fs.readFileSync(file, 'utf8');
      const name = path.relative(root, file).replace(/\\/g, '/');
      expect({ name, db: /from\s+['"]@\/db/.test(source) }).toEqual({ name, db: false });
      expect({ name, env: /from\s+['"]@\/lib\/env['"]/.test(source) }).toEqual({ name, env: false });
      expect({ name, node: /from\s+['"]node:/.test(source) }).toEqual({ name, node: false });
    }
  });

  it('MUST-2.1: no pure module constructs a Date', () => {
    for (const file of filesUnder(predictDir)) {
      if (path.basename(file) === 'history.ts') continue;
      const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect({ file: path.basename(file), date: /new Date\b/.test(source) }).toEqual({ file: path.basename(file), date: false });
    }
  });

  it('MUST-3.3: divRound is the only division primitive in the tree', () => {
    for (const file of filesUnder(predictDir)) {
      if (path.basename(file) === 'stats.ts') continue;
      const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect({ file: path.basename(file), round: /Math\.round\s*\(/.test(source) }).toEqual({
        file: path.basename(file),
        round: false,
      });
    }
  });
});

describe('MUST-1.4 and AC4: no migration, no schema change', () => {
  // This used to pin the exact newest migration filename ("still 0007"), which was only ever
  // a proxy for "the predictive-targets feature itself adds no migration" -- it was never a
  // promise that no OTHER, unrelated feature could ever add one again. v1.6.0's migration 0008
  // (drizzle/0008_import_attribution.sql, per-card attribution) broke that literal pin without
  // touching anything predictive, which is exactly what the real invariant below still allows.
  // Comment lines are stripped first because every hand-authored migration's boilerplate
  // header warns about diffing against an empty "baseline" -- a false hit on the DDL-neutral
  // English word, not the predictive feature's category baselines.
  it('no migration file\'s DDL names a predictive schema object', () => {
    const files = fs.readdirSync(path.join(root, 'drizzle')).filter((name) => name.endsWith('.sql'));
    for (const file of files) {
      const ddl = fs
        .readFileSync(path.join(root, 'drizzle', file), 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
      for (const banned of ['predict', 'suggestion', 'projection', 'baseline']) {
        expect({ file, banned, present: new RegExp(banned, 'i').test(ddl) }).toEqual({
          file,
          banned,
          present: false,
        });
      }
    }
  });

  it('the journal names no predictive migration tag', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    for (const entry of journal.entries) {
      for (const banned of ['predict', 'suggestion', 'projection', 'baseline']) {
        expect({ tag: entry.tag, banned, present: new RegExp(banned, 'i').test(entry.tag) }).toEqual({
          tag: entry.tag,
          banned,
          present: false,
        });
      }
    }
  });

  it('src/db/schema.ts names no predictive object', () => {
    const schema = fs.readFileSync(path.join(root, 'src/db/schema.ts'), 'utf8');
    for (const banned of ['predict', 'suggestion', 'projection', 'baseline']) {
      expect({ banned, present: new RegExp(banned, 'i').test(schema) }).toEqual({ banned, present: false });
    }
  });
});
