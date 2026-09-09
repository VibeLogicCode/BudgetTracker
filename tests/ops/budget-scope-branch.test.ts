import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DEFINITION = 'src/lib/budgets.ts';

/** Same walk() shape as tests/ops/spend-where.test.ts and tests/ops/client-bundle.test.ts. */
function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

/**
 * Same comment-stripping helper as tests/ops/spend-where.test.ts, and it earns its keep here
 * immediately: evaluate/digest.ts's own comment QUOTES the ternary it replaced, to say what the
 * line no longer does. A docblock arguing about a rule is not an instance of it.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * v1.32.0. "Which set of budgets does this viewer read" had been written out five times, each
 * time as its own ternary over `isSelfScoped(viewer)`; `budgetScopeFor` in src/lib/budgets.ts is
 * now the one definition, and this stops a sixth copy.
 *
 * WHAT IS SCANNED: every .ts/.tsx file under src/, comments stripped, for a conditional whose two
 * arms are the two `BudgetScope` string literals -- `? 'household' : 'personal'` and the reverse,
 * in single or double quotes. That is the shape of the branch regardless of what the CONDITION is,
 * which matters: the copies this replaced were not all spelled `isSelfScoped(...)` inline (one read
 * a `selfScoped` local computed twenty lines earlier), so keying the scan on the predicate would
 * have missed exactly the copies that are hardest to see.
 *
 * WHAT IS NOT SCANNED, deliberately:
 *   - tests/ (this file included). A test that constructs both scopes to compare them is doing its
 *     job; a guard that forbade the literal in tests would be guarding its own fixtures.
 *   - anything inside a comment or docblock (stripComments above).
 *   - the `scope === 'personal' ? viewer.id : null` USER-ID pairing, which is a different
 *     expression with a different result type. It is not a second copy of anything either: it is
 *     `ownerScope(viewer)` (src/lib/auth/viewer.ts), and the two call sites converted with this
 *     guard call that function instead of rewriting it.
 *   - a scope chosen from something other than a viewer -- e.g. a URL parameter or a form field
 *     validated to one of the two values. Those do not match the pattern (they are parses, not
 *     ternaries) and they are not this branch: the question there is "which scope did the user
 *     ASK for", not "which scope may this viewer read".
 *
 * INVERTED ALLOWLIST, in the discipline of tests/ops/spend-where.test.ts: the ternary is allowed in
 * the definition, plus any file named below WITH A REASON. The allowlist is EMPTY today, and that
 * is a fact about the code rather than an oversight -- after the two conversions there is exactly
 * one occurrence left under src/ and it is `budgetScopeFor`'s own body. The positive control below
 * is what keeps that emptiness meaningful: this guard asserts it can still SEE the definition, so a
 * detector that quietly stopped matching anything fails here rather than passing silently. (Two
 * shipped guards in this repo asserted an empty offender list with a broken detector; that is the
 * mistake this paragraph exists to not repeat.)
 */
const ALLOWED_SCOPE_TERNARIES: Record<string, string> = {};

const SCOPE_TERNARY = /\?\s*(['"])(household|personal)\1\s*:\s*(['"])(household|personal)\3/g;

describe('the "which budget scope does this viewer read" branch has one definition (v1.32.0)', () => {
  const files = walk('src');
  const countsByFile = new Map<string, number>();
  for (const file of files) {
    const source = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    // Both arms must be the SAME two literals in opposite order; `? 'household' : 'household'` is
    // not a scope branch, it is a typo, and is not this guard's business.
    const matches = [...source.matchAll(SCOPE_TERNARY)].filter((match) => match[2] !== match[4]);
    if (matches.length > 0) countsByFile.set(file, matches.length);
  }

  it('still finds the definition (positive control: a scan that matches nothing proves nothing)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(
      countsByFile.get(DEFINITION),
      `${DEFINITION} no longer contains the scope ternary: either budgetScopeFor was rewritten (fine -- ` +
        'point this control at whatever replaced it) or this scanner has stopped matching (not fine)',
    ).toBe(1);
  });

  it('the ternary appears nowhere else under src/ except an allowlisted file with a reason', () => {
    const offenders: string[] = [];
    for (const [file, count] of countsByFile) {
      if (file === DEFINITION) continue;
      if (Object.prototype.hasOwnProperty.call(ALLOWED_SCOPE_TERNARIES, file)) continue;
      offenders.push(
        `${file} (${count} occurrence${count === 1 ? '' : 's'}): "which budget scope does this viewer read" is ` +
          'budgetScopeFor(viewer) from @/lib/budgets, paired with ownerScope(viewer) for the userId argument. ' +
          'If this ternary is asking a DIFFERENT question -- a refusal, an omission, a delivery decision, a ' +
          'scope the user asked for -- add it to ALLOWED_SCOPE_TERNARIES with the sentence that says so.',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry still names a file that exists', () => {
    for (const [file, reason] of Object.entries(ALLOWED_SCOPE_TERNARIES)) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} is allowlisted but no longer exists`).toBe(true);
      expect(reason.trim().length, `${file} is allowlisted with no reason`).toBeGreaterThan(20);
    }
  });
});
