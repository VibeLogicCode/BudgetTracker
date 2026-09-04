import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/** Same walk() shape as tests/ops/spend-where.test.ts and tests/ops/client-bundle.test.ts. */
function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

/** Same comment-stripping helper as tests/ops/spend-where.test.ts, so a docblock quoting the
 *  literal in prose (this repo argues in prose constantly, and several of these files quote the
 *  very shape below to explain why they no longer write it) is never counted as an occurrence. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * v1.31.0 item M-1. A `Viewer` (src/lib/auth/viewer.ts) is the reader boundary: `visibility` gates
 * every scoped READ, and `scopeFor`/`ownerScope`/`isSelfScoped` decide from it whether a query is
 * narrowed to one person's rows. Constructing one is therefore a security-relevant act, and until
 * this guard existed the codebase did it in eight places at once:
 *
 *   - five byte-identical local `viewerFor(userId)` functions, in
 *     notify/evaluate/{digest,monthly,pace,savings,stale}.ts;
 *   - two more inline `{ id, role, visibility }` projections feeding `isSelfScoped` directly, in
 *     notify/evaluate/budget.ts and notify/evaluate/savings.ts;
 *   - three hand-built household-wide viewers (digest.ts's exported `HOUSEHOLD_VIEWER`,
 *     savings.ts's `HOUSEHOLD_WIDE`, loans.ts's local `householdWide`).
 *
 * Each carried a docblock defending its own copy ("kept local", "none exports the other three's
 * internals as test-only surface", "a new shared module for one constant buys nothing"). Those
 * defences all failed the same way: they argued about where the DEFINITION should sit and left
 * nothing tying the copies together, which is the shape that produced S-18 -- a household budget
 * total reaching a self-scoped recipient's own notification, because one of several copies of one
 * scoping decision was not the one that got fixed. All eight agreed at the time. That is exactly
 * the state a guard is for: the cost of the duplication is not paid on the day it is written.
 *
 * WHAT IS BANNED: a brace-delimited block whose keys are EXACTLY Viewer's three -- an object
 * literal, or an interface/type body declaring the same three fields -- anywhere under src/
 * outside the two files below. Exactly three, not "at least three", and that boundary is the
 * point rather than a convenience:
 *
 *   - A three-key literal is a viewer somebody BUILT. There is no reason to build one outside the
 *     module that owns the rule, so it is banned.
 *   - A WIDER object that happens to carry the three (a session user with a name, a drizzle
 *     column projection, the users table definition) is a row being passed THROUGH. `Viewer` is a
 *     structural interface, so `NotifiableUser` and `UserRecord` already satisfy it and callers
 *     should hand the row straight to `isSelfScoped(user)` -- which is what budget.ts and
 *     savings.ts now do, and is why neither needs a projection at all. Passing the row through is
 *     the behaviour this guard wants to encourage, so it is deliberately not caught.
 *
 * Rejected alternative: banning the token `visibility:` outright. That reads on six legitimate
 * session/schema/column projections today and would fire on any future column read, so it would
 * be maintained by adding exceptions rather than by fixing anything.
 */
const ALLOWED_VIEWER_CONSTRUCTION: Record<string, string> = {
  'src/lib/auth/viewer.ts':
    "HOUSEHOLD_VIEWER -- the one synthetic 'no owner restriction' viewer, beside the ownerScope rule that reads it",
  'src/lib/auth/users.ts':
    'viewerFor(userId) -- the one projection of a user row onto the reader boundary; here rather than in viewer.ts because it needs a database read and viewer.ts stays dependency-free for the browser bundle',
};

/** The file that owns `viewerFor`, and the only one allowed to declare it. */
const VIEWER_FOR_HOME = 'src/lib/auth/users.ts';

const VIEWER_KEYS = ['id', 'role', 'visibility'];

/** Innermost object literals only: `[^{}]*` cannot cross a nested brace, which is what makes the
 *  "exactly these keys" test below meaningful rather than a scan of a whole enclosing object. */
const OBJECT_LITERAL = /\{[^{}]*\}/g;
const LITERAL_KEY = /([A-Za-z_$][\w$]*)\s*:/g;

function viewerLiteralsIn(source: string): string[] {
  return (source.match(OBJECT_LITERAL) ?? []).filter((literal) => {
    const keys = [...literal.matchAll(LITERAL_KEY)].map((match) => match[1]).sort();
    return keys.length === VIEWER_KEYS.length && keys.every((key, index) => key === VIEWER_KEYS[index]);
  });
}

/** `function viewerFor`, `const viewerFor =`, and the arrow/method forms of the same name. */
const VIEWER_FOR_DECLARATION = /(?:function|const|let|var)\s+viewerFor\b/g;

/**
 * v1.31.0 item M-5: the hole in the rule above, closed.
 *
 * `viewerLiteralsIn` requires EXACTLY Viewer's three keys, and that boundary is right for the
 * reason its own docblock gives -- a wider object carrying the three is a row being passed
 * THROUGH, which is the behaviour this guard wants to encourage. But `{ ...user, visibility:
 * 'household' }` has one literal key plus a spread, so it is neither: it is a viewer somebody
 * BUILT, by taking a real row and overriding the one field that decides whether a query is
 * narrowed to a single person's rows. It is also the shape most likely to be typed by someone
 * deliberately widening a viewer, which is the edit that most needs a reader -- S-18 was a
 * household total reaching a self-scoped recipient.
 *
 * So a SECOND, narrower detector: an innermost literal containing a spread AND `role:` or
 * `visibility:`. Not "a spread and any key" (every `{ ...prev, month }` state update in the client
 * would fire), and not "a spread" alone (`{ ...user }` overrides nothing and narrows nothing).
 *
 * WHAT IT STILL DOES NOT CATCH, stated rather than left implied (the precedent is
 * tests/ops/transactions-href.test.ts's own docblock): a widening built in two steps -- `const
 * viewer = { ...user }; viewer.visibility = 'household';` -- or one assembled through
 * `Object.assign`. Both read as more than an object literal to a person, and a regex over
 * innermost braces cannot follow either. The assertion here is about the shape somebody types.
 */
function spreadWidenedViewersIn(source: string): string[] {
  return (source.match(OBJECT_LITERAL) ?? []).filter((literal) => {
    if (!literal.includes('...')) return false;
    const keys = [...literal.matchAll(LITERAL_KEY)].map((match) => match[1]);
    return keys.includes('role') || keys.includes('visibility');
  });
}

/**
 * The one spread-plus-`role` literal under src/ today, which is NOT a viewer -- listed with its
 * argument rather than silently exempted, the same way ALLOWED_VIEWER_CONSTRUCTION's entries are.
 */
const ALLOWED_SPREAD_WIDENING: Record<string, string> = {
  'src/lib/auth/users.ts':
    "createFirstAdmin's `{ ...input, role: 'admin' }` is the argument to createUserSchema.parse -- a user being CREATED, not a reader boundary. It carries no visibility, never reaches scopeFor/ownerScope/isSelfScoped, and is the one place in this codebase that DECIDES a role rather than reading one",
};

describe('a Viewer is constructed in exactly one place per reason (M-1)', () => {
  const files = walk('src');
  const literalsByFile = new Map<string, number>();
  const declarationsByFile = new Map<string, number>();
  for (const file of files) {
    const source = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const literals = viewerLiteralsIn(source);
    if (literals.length > 0) literalsByFile.set(file, literals.length);
    const declarations = source.match(VIEWER_FOR_DECLARATION);
    if (declarations && declarations.length > 0) declarationsByFile.set(file, declarations.length);
  }

  it('finds the known constructions (a scan that matches nothing proves nothing)', () => {
    expect(files.length).toBeGreaterThan(100);
    // Two in viewer.ts: the `interface Viewer` body itself plus HOUSEHOLD_VIEWER. The interface
    // matching is a feature, not noise -- a SECOND declaration of Viewer's own three fields as a
    // type somewhere else is the same defect as a second construction of one, and is caught by the
    // same rule below.
    expect(literalsByFile.get('src/lib/auth/viewer.ts'), 'viewer.ts no longer holds both the Viewer interface and HOUSEHOLD_VIEWER as three-key blocks').toBe(2);
    expect(literalsByFile.get(VIEWER_FOR_HOME), "viewerFor's own projection is no longer a three-key literal").toBe(1);
  });

  it('no file outside src/lib/auth builds a bare { id, role, visibility } viewer', () => {
    const offenders: string[] = [];
    for (const [file, count] of literalsByFile) {
      if (Object.prototype.hasOwnProperty.call(ALLOWED_VIEWER_CONSTRUCTION, file)) continue;
      offenders.push(
        `${file} (${count} literal${count === 1 ? '' : 's'}): import viewerFor / HOUSEHOLD_VIEWER from ` +
          '@/lib/auth/users or @/lib/auth/viewer, or pass the row itself -- Viewer is structural, so a ' +
          'UserRecord/NotifiableUser already satisfies it. Item M-1: seven copies of this projection ' +
          'shipped before this guard, and S-18 is what one of them not being fixed cost.',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('no file builds a viewer by spreading a row and overriding role or visibility (M-5)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      const literals = spreadWidenedViewersIn(source);
      if (literals.length === 0) continue;
      if (Object.prototype.hasOwnProperty.call(ALLOWED_SPREAD_WIDENING, file)) continue;
      offenders.push(
        `${file} (${literals.length} literal${literals.length === 1 ? '' : 's'}): a viewer built by ` +
          'spreading a row and overriding `role` or `visibility` is a viewer somebody widened by ' +
          'hand. Use HOUSEHOLD_VIEWER (@/lib/auth/viewer) for the household-wide reader, or ' +
          'viewerFor(userId) (@/lib/auth/users) for one person, or pass the row itself -- Viewer is ' +
          'structural. If this object is not a reader boundary, add it to ALLOWED_SPREAD_WIDENING ' +
          'with the reason. S-18 is what one un-fixed copy of a scoping decision cost.',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('the spread detector fails on the widening it exists to catch (M-5 positive control)', () => {
    // Non-vacuity: the assertion above is an empty list, so a typo in the detector would leave it
    // green forever. The shape M-5 named is rebuilt here rather than left in the tree.
    expect(spreadWidenedViewersIn("const viewer = { ...user, visibility: 'household' };")).toHaveLength(1);
    expect(spreadWidenedViewersIn("scopeFor({ ...session.user, role: 'admin' })")).toHaveLength(1);
    // ...and the three shapes it must NOT fire on: a plain pass-through spread, an unrelated state
    // update, and the three-key literal the other detector already owns.
    expect(spreadWidenedViewersIn('const copy = { ...user };')).toEqual([]);
    expect(spreadWidenedViewersIn("setState({ ...prev, month: '2026-09' })")).toEqual([]);
    expect(spreadWidenedViewersIn("const viewer = { id, role, visibility: 'self' };")).toEqual([]);
    // Both detectors on one source is what M-1 plus M-5 asserts together.
    expect(viewerLiteralsIn("const viewer = { id: 1, role: 'member', visibility: 'self' };")).toHaveLength(1);
  });

  it('viewerFor is declared exactly once, in src/lib/auth/users.ts', () => {
    expect([...declarationsByFile.keys()]).toEqual([VIEWER_FOR_HOME]);
    expect(
      declarationsByFile.get(VIEWER_FOR_HOME),
      'viewerFor is declared more than once in its own home file',
    ).toBe(1);
  });

  it('every allowlist entry still names a file that exists', () => {
    for (const file of [...Object.keys(ALLOWED_VIEWER_CONSTRUCTION), ...Object.keys(ALLOWED_SPREAD_WIDENING)]) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} is allowlisted but no longer exists`).toBe(true);
    }
    expect(fs.existsSync(path.join(ROOT, VIEWER_FOR_HOME))).toBe(true);
  });
});
