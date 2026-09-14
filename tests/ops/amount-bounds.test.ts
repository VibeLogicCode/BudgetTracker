import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { amountWithinBounds } from '@/lib/categorize/amount-bounds';

const ROOT = process.cwd();
const MODULE = 'src/lib/categorize/amount-bounds.ts';

/** Same walk() shape as tests/ops/display-source-writers.test.ts and its neighbours. */
function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

/** The repo's established stripComments pattern. It matters here: the module being guarded
 *  explains at length WHY the comparison is against a magnitude, and drizzle/0024's reasoning is
 *  quoted in several docblocks. A guard that punished explaining itself would get them deleted. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 2026-09-13, ruling P6 of
 * docs/superpowers/specs/2026-09-13-vendor-amount-person-rules-design.md.
 *
 * "Does this amount fall inside that window" is answered in ONE place,
 * src/lib/categorize/amount-bounds.ts, and this file is what keeps it one place.
 *
 * WHY IT EXISTS BEFORE THERE IS A SECOND CALLER, which is the unusual part. Three call sites are
 * already known: matchRule (src/lib/categorize/rules.ts), the kebab dialog that prefills a window
 * from a row, and -- docs/PENDING-FIXES.md item R27a -- the loan matcher, whose rule today has no
 * amount check at all and will grow one. The forked-predicate failure this prevents is not
 * hypothetical in this repo: src/lib/display-source.ts exists because "which label wins" had been
 * answered independently in three functions, and the third got it wrong in a way that destroyed a
 * loan's label with nothing on screen to say so (tests/ops/display-source-writers.test.ts tells
 * that story in full). A predicate is cheaper to keep single than to re-unify.
 *
 * WHAT IT DOES NOT CATCH, said plainly, because a guard whose limits are unwritten gets trusted
 * for things it does not do:
 *   - a comparison that reaches the columns through a name this scan cannot see: a destructured
 *     `const { amountMinCents: lo } = rule` and then `magnitude < lo`, or a window carried through
 *     a differently-named local. This is a text scan, not a type system.
 *   - raw SQL. A `where abs(amount_cents) between ...` in a query is checked separately below,
 *     since that spelling shares no tokens with the TypeScript one.
 *   - whether a caller that DOES use amountWithinBounds passes the right arguments. The behaviour
 *     is proved by tests/lib/categorize/amount-bounds.test.ts and the precedence cases in
 *     tests/lib/categorize/rules.test.ts; this file proves only that nobody is answering the
 *     question for themselves.
 */
const BOUND_COLUMNS = ['amountMinCents', 'amountMaxCents'];

/** A comparison operator applied to either column name, in either order: `x < rule.amountMinCents`
 *  as well as `rule.amountMaxCents >= x`. `!==`/`===` against null is a presence test, not a
 *  magnitude comparison, and is deliberately not matched -- isBounded's own callers do that, and
 *  so does any code asking "has this rule got a window at all". */
function comparisonOffenders(source: string): string[] {
  const out: string[] = [];
  for (const column of BOUND_COLUMNS) {
    const after = new RegExp(`\\b${column}\\b\\s*(?:!==?|===?)?\\s*(<=?|>=?)(?!=)`, 'g');
    const before = new RegExp(`(<=?|>=?)(?!=)\\s*[A-Za-z_$][\\w$.]*\\.?${column}\\b`, 'g');
    for (const match of source.matchAll(after)) out.push(`${column} ${match[1]}`);
    for (const match of source.matchAll(before)) out.push(`${match[1]} ${column}`);
  }
  return out;
}

/** The SQL spelling of the same question, which shares no tokens with the TypeScript one. */
function sqlOffenders(source: string): string[] {
  const out: string[] = [];
  const pattern =
    /amount_(?:min|max)_cents\s*(?:<=?|>=?)(?!=)|(?:<=?|>=?)(?!=)\s*amount_(?:min|max)_cents|between\s+[^;]{0,80}amount_(?:min|max)_cents/gi;
  for (const match of source.matchAll(pattern)) out.push(match[0].replace(/\s+/g, ' ').slice(0, 60));
  return out;
}

const files = walk('src');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('one amount predicate (P6)', () => {
  it('scans a real tree (a scan that matches nothing proves nothing)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(MODULE);
    expect(files).toContain('src/lib/categorize/rules.ts');
  });

  it('is the module that owns the comparison, and it does compare', () => {
    const source = stripComments(read(MODULE));
    expect(comparisonOffenders(source).length).toBeGreaterThanOrEqual(2);
  });

  it('no other file under src/ compares an amount against a rule window', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === MODULE) continue;
      const source = stripComments(read(file));
      for (const found of [...comparisonOffenders(source), ...sqlOffenders(source)]) {
        offenders.push(`${file}: ${found}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Non-vacuity, the shape tests/ops/spend-where.test.ts uses: reconstruct the offence and prove
   * the scan reports it. Without this, deleting the regexes above would leave a file that passes
   * forever while guarding nothing.
   */
  it('would catch a forked comparison, in either spelling', () => {
    expect(comparisonOffenders('if (magnitude < rule.amountMinCents) return false;')).not.toEqual([]);
    expect(comparisonOffenders('if (rule.amountMaxCents >= magnitude) return true;')).not.toEqual([]);
    expect(sqlOffenders('where abs(amount_cents) >= amount_min_cents')).not.toEqual([]);
    expect(sqlOffenders('where abs(amount_cents) between amount_min_cents and amount_max_cents')).not.toEqual([]);
  });

  it('does not report a presence test, which is a different question', () => {
    expect(comparisonOffenders('if (rule.amountMinCents !== null) return true;')).toEqual([]);
    expect(comparisonOffenders('const bounded = rule.amountMaxCents === null;')).toEqual([]);
  });

  /** The predicate is imported and used, not merely present -- the guard's own subject has to be
   *  reachable or the whole file is about a module nothing calls. */
  it('rules.ts reaches the window through the module rather than answering it itself', () => {
    const source = read('src/lib/categorize/rules.ts');
    expect(source).toContain("from '@/lib/categorize/amount-bounds'");
    expect(source).toContain('amountWithinBounds(');
    expect(amountWithinBounds(-14012, 12500, 15500)).toBe(true);
  });
});
