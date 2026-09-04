import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DISPLAY_SOURCE_PRECEDENCE, displaySourceMayWrite, displaySourcesAbove } from '@/lib/display-source';

const ROOT = process.cwd();

/** Same walk() shape as tests/ops/viewer-construction.test.ts and tests/ops/spend-where.test.ts. */
function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

/** The repo's established stripComments pattern. It matters more here than usual: three of the
 *  four writers below argue about this precedence at length in prose, and display-source.ts
 *  quotes the very `.set({ displayDescription: null, displaySource: null })` shape that shipped
 *  broken. A guard that punished explaining the defect would get its docblocks deleted. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * v1.31.0 items B-1 and I-2. `transactions.display_description` and `transactions.display_source`
 * have ONE precedence order -- manual > loan > rename > unset -- and it lives in exactly one place,
 * src/lib/display-source.ts (ruling R24). This guard is what ties the writers to it.
 *
 * WHY IT EXISTS, precisely. R24 shipped a module, a docblock and two writers that consult it, and
 * asserted in prose that those two were all of them. There were three. The third,
 * `setTransactionDisplayName`'s clear branch, consulted the module on NEITHER path and nulled both
 * columns unconditionally -- so emptying the rename dialog on a loan-linked row (the dialog
 * invites it: "Leave it empty to go back to the bank's wording") destroyed the loan label, the
 * rename pass immediately stamped the merchant's name over it, and unlinking repaired nothing
 * because `revertLoanDescription` only clears a row still labelled 'loan'. A live loan payment read
 * as an ordinary purchase on every loan page, recoverable only by unlinking and re-linking, with
 * nothing on screen to say so. That is character-for-character the defect R24 was written to
 * prevent, reached through the one path the ruling had not counted.
 *
 * So the enumeration is HERE, executable, instead of in a sentence: every write of either column
 * under src/ must belong to a function on WRITERS below, and every such function must reference one
 * of display-source.ts's three exports -- or be listed in WRITERS_NOT_CONSULTING with an argument
 * for why the module's answer is the wrong one for it. A fifth writer fails this file.
 *
 * WHAT IT DOES NOT CATCH, said plainly, because a guard whose limits are unwritten gets trusted for
 * things it does not do (the precedent is tests/ops/transactions-href.test.ts's own docblock):
 *   - a write reaching the column through a name this scan cannot see -- `.set(patch)` where
 *     `patch` is built elsewhere, or a column list assembled by string concatenation. All four
 *     writers pass plain literals today and Prettier keeps them that way, but this is a text scan
 *     and not a type system.
 *   - whether a writer that DOES reference an export uses it correctly. `displaySourceMayWrite`
 *     read and then ignored would pass here. The behaviour is proved by the unit and integration
 *     tests for the rename engine and the loan link; this file proves only that no writer is
 *     deciding the order for itself.
 *   - anything outside src/. drizzle/ declares these columns and writes neither; scripts/ never
 *     names them (both checked while writing this).
 */
const WRITERS: Record<string, string> = {
  'src/lib/categorize/engine.ts#applyRenameRules':
    "the rename pass: excludes displaySourcesAbove('rename') in its own SELECT, so a row labelled above it is never read, let alone written",
  'src/lib/categorize/engine.ts#setTransactionDisplayName':
    "the per-row hand-typed name, and the B-1 writer: gates both its write and its clear on displaySourceMayWrite('manual', ...), and on clearing hands the row down the order (the loan link) before the rename rules see it",
  'src/lib/loans.ts#applyLoanDescription':
    "the loan label: gates its write on displaySourceMayWrite('loan', ...), so it may overwrite a rename and its own earlier label but never a hand-typed name",
  'src/lib/loans.ts#revertLoanDescription':
    'the loan unlink: clears only a row this file itself labelled -- see WRITERS_NOT_CONSULTING for why that is not a precedence question',
};

/**
 * The one writer that must NOT ask `displaySourceMayWrite`, with the argument rather than a bare
 * allowance (the precedent is tests/ops/spend-where.test.ts, where every entry states why).
 */
const WRITERS_NOT_CONSULTING: Record<string, string> = {
  'src/lib/loans.ts#revertLoanDescription':
    "reverting asks 'did I write this label', which is OWNERSHIP, not precedence, and is strictly " +
    "stronger: displaySourceMayWrite('loan', current) is true for 'rename', so writing this test " +
    'through the module would make unlinking a loan clear a rename label no loan had ever set. ' +
    "The equality against 'loan' is therefore the correct test and deliberately not derived.",
};

const EXPORTS = ['displaySourceMayWrite', 'displaySourcesAbove', 'DISPLAY_SOURCE_PRECEDENCE'];

/** The two columns, in the spelling a drizzle write uses. The snake_case spellings are checked
 *  separately, as raw SQL, because a raw `update transactions set display_source = ...` would
 *  bypass every drizzle-shaped pattern below. */
const COLUMN_KEYS = ['displayDescription', 'displaySource'];

/** Balanced-paren slice starting at the `(` that follows `at`, so `.set({ ... })` is read whole
 *  however deeply its value expressions nest. Returns null on an unbalanced tail. */
function callArguments(source: string, at: number): { text: string; end: number } | null {
  const open = source.indexOf('(', at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return { text: source.slice(open, i + 1), end: i + 1 };
    }
  }
  return null;
}

/**
 * Every offset in `source` (already comment-stripped) at which either column is WRITTEN: a
 * drizzle `.set(...)` or `.values(...)` whose arguments name one of the columns, or a raw-SQL
 * assignment to the underlying column. A READ -- a select projection, a where clause, a
 * `row.displaySource === 'loan'` comparison -- is not a write and is deliberately not reported:
 * this guard is about who decides the label, and there are dozens of legitimate readers.
 */
function writeOffsets(source: string): number[] {
  const offsets: number[] = [];
  const call = /\.(?:set|values)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(source))) {
    const args = callArguments(source, match.index);
    if (args !== null && COLUMN_KEYS.some((key) => new RegExp(`\\b${key}\\s*:`).test(args.text))) {
      offsets.push(match.index);
    }
    call.lastIndex = match.index + match[0].length;
  }
  const raw = /display_(?:description|source)\s*=(?!=)/g;
  while ((match = raw.exec(source))) offsets.push(match.index);
  return [...new Set(offsets)].sort((a, b) => a - b);
}

/** `function name(`, `const name =` and the export forms, at column 0 -- every writer in this
 *  Prettier-formatted tree is a top-level declaration, and the body ends at the next column-0
 *  `}`. A write inside a nested arrow (applyRenameRules writes inside `db.transaction((tx) =>
 *  {...})`) is therefore attributed to the enclosing top-level function, which is the unit whose
 *  text has to show the consultation. */
const DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

interface Enclosing {
  name: string;
  body: string;
}

function enclosingFunction(source: string, offset: number): Enclosing | null {
  let found: { name: string; start: number } | null = null;
  DECLARATION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DECLARATION.exec(source))) {
    if (match.index > offset) break;
    found = { name: match[1], start: match.index };
  }
  if (found === null) return null;
  const tail = source.slice(offset);
  const relativeEnd = tail.search(/^\}/m);
  const end = relativeEnd === -1 ? source.length : offset + relativeEnd + 1;
  return { name: found.name, body: source.slice(found.start, end) };
}

/** file#function -> how many writes it contains, for every writer of either column under src/. */
function writersIn(files: string[], read: (file: string) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const file of files) {
    const source = stripComments(read(file));
    for (const offset of writeOffsets(source)) {
      const enclosing = enclosingFunction(source, offset);
      const key = `${file}#${enclosing === null ? '<top level>' : enclosing.name}`;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  return out;
}

function consults(body: string): boolean {
  return EXPORTS.some((name) => body.includes(name));
}

/** Every writing function's own body text, keyed the same way as WRITERS. */
function writerBodies(files: string[], read: (file: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files) {
    const source = stripComments(read(file));
    for (const offset of writeOffsets(source)) {
      const enclosing = enclosingFunction(source, offset);
      if (enclosing === null) continue;
      out.set(`${file}#${enclosing.name}`, enclosing.body);
    }
  }
  return out;
}

const files = walk('src');
const readFile = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const writers = writersIn(files, readFile);
const bodies = writerBodies(files, readFile);

describe('every writer of display_source reads its one definition (I-2)', () => {
  it('finds the known writers (a scan that matches nothing proves nothing)', () => {
    expect(files.length).toBeGreaterThan(100);
    // Six write statements across four functions: two in applyRenameRules (the rule's write and
    // the clear of what a rule set), two in setTransactionDisplayName (write and clear), one each
    // in applyLoanDescription and revertLoanDescription.
    expect([...writers.values()].reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(6);
    expect(writers.get('src/lib/categorize/engine.ts#applyRenameRules')).toBe(2);
    expect(writers.get('src/lib/categorize/engine.ts#setTransactionDisplayName')).toBe(2);
  });

  it('the writers are exactly the enumerated ones', () => {
    expect(
      [...writers.keys()].sort(),
      'A function writing transactions.display_description or display_source is not on WRITERS. ' +
        'Add it WITH ITS REASON and make it consult src/lib/display-source.ts -- or, if it must not, ' +
        'list it in WRITERS_NOT_CONSULTING with the argument. This assertion exists because ruling ' +
        'R24 enumerated two writers in prose when there were three, and the uncounted one shipped ' +
        'the v1.31.0 release blocker: a loan-linked row reverting to the merchant name, ' +
        'unrecoverable except by unlinking and re-linking.',
    ).toEqual(Object.keys(WRITERS).sort());
  });

  it('each writer either consults display-source.ts or states why it must not', () => {
    const offenders: string[] = [];
    for (const [key, body] of bodies) {
      if (consults(body)) continue;
      if (Object.prototype.hasOwnProperty.call(WRITERS_NOT_CONSULTING, key)) continue;
      offenders.push(
        `${key}: writes display_description/display_source without reading ` +
          `${EXPORTS.join(' / ')} from @/lib/display-source. Gate the write on ` +
          "displaySourceMayWrite(<this writer's own source>, current), or exclude " +
          'displaySourcesAbove(<source>) from the rows it selects. B-1 is what a writer deciding ' +
          'the order for itself costs.',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('the clear path hands the row down the order rather than straight to the rules', () => {
    // The half of B-1 a text scan CAN pin: clearing a manual name must offer the row to the loan
    // link before applyRenameRules, because 'loan' sits between 'manual' and 'rename'.
    const body = bodies.get('src/lib/categorize/engine.ts#setTransactionDisplayName');
    expect(body, 'setTransactionDisplayName is no longer a recognised writer').toBeDefined();
    expect(body).toContain('restoreLoanDescription');
    expect((body as string).indexOf('restoreLoanDescription')).toBeLessThan((body as string).indexOf('applyRenameRules'));
  });

  it('every entry states a reason rather than merely being listed', () => {
    const unexplained = [...Object.entries(WRITERS), ...Object.entries(WRITERS_NOT_CONSULTING)]
      .filter(([, reason]) => reason.trim().length < 60)
      .map(([key]) => key);
    expect(unexplained).toEqual([]);
    for (const key of Object.keys(WRITERS_NOT_CONSULTING)) {
      expect(
        Object.prototype.hasOwnProperty.call(WRITERS, key),
        `${key} is exempted from consulting the module but is not a listed writer`,
      ).toBe(true);
    }
  });

  it('every enumerated writer still exists under that name', () => {
    for (const key of Object.keys(WRITERS)) {
      const [file, name] = key.split('#');
      expect(fs.existsSync(path.join(ROOT, file)), `${file} is enumerated but no longer exists`).toBe(true);
      expect(stripComments(readFile(file)).includes(name), `${file} no longer declares ${name}`).toBe(true);
    }
  });

  it('the precedence array is what the writers are being held to', () => {
    // Non-vacuity in the other direction: the guard above is worth nothing if the module it points
    // at stops expressing an order. 'manual' being top is exactly why B-1's new gate refuses
    // nothing today, and why it has to be there anyway.
    expect(DISPLAY_SOURCE_PRECEDENCE).toEqual(['manual', 'loan', 'rename']);
    expect(displaySourcesAbove('rename')).toEqual(['manual', 'loan']);
    expect(displaySourceMayWrite('manual', 'loan')).toBe(true);
    expect(displaySourceMayWrite('rename', 'loan')).toBe(false);
    expect(displaySourceMayWrite('loan', 'rename')).toBe(true);
  });
});

describe('the detector fails on the defect, reconstructed (I-2 positive control)', () => {
  const B1 = [
    'export function setTransactionDisplayName(input: { transactionId: number }): void {',
    '  const db = getDb();',
    '  db.update(transactions)',
    '    .set({ displayDescription: null, displaySource: null, updatedAt: nowIso() })',
    '    .where(eq(transactions.id, input.transactionId))',
    '    .run();',
    '  applyRenameRules([input.transactionId]);',
    '}',
  ].join('\n');

  it('sees the write, names the function, and reports it as consulting nothing', () => {
    const offsets = writeOffsets(B1);
    expect(offsets).toHaveLength(1);
    const enclosing = enclosingFunction(B1, offsets[0]);
    expect(enclosing === null ? null : enclosing.name).toBe('setTransactionDisplayName');
    expect(consults(enclosing === null ? '' : enclosing.body)).toBe(false);
    expect(writersIn(['b1.ts'], () => B1)).toEqual(new Map([['b1.ts#setTransactionDisplayName', 1]]));
  });

  it('sees a raw-SQL write too', () => {
    expect(writeOffsets("db.run(sql`update transactions set display_source = 'rename' where id = 1`)")).toHaveLength(1);
  });

  it('a gated write is reported as a writer, but as one that consults', () => {
    const gated = [
      'function applyLoanDescription(tx, txnId, at) {',
      "  if (!displaySourceMayWrite('loan', row.displaySource)) return false;",
      "  tx.update(transactions).set({ displaySource: 'loan', updatedAt: at }).run();",
      '  return true;',
      '}',
    ].join('\n');
    const enclosing = enclosingFunction(gated, writeOffsets(gated)[0]);
    expect(enclosing === null ? null : enclosing.name).toBe('applyLoanDescription');
    expect(consults(enclosing === null ? '' : enclosing.body)).toBe(true);
  });

  it('reads and prose are not writes', () => {
    // A select projection, a comparison and a docblock quoting the defect all have to stay clear of
    // this scan, or the four writers would drown in dozens of legitimate readers.
    expect(writeOffsets('const row = db.select({ displaySource: transactions.displaySource }).from(transactions).get();')).toEqual([]);
    expect(writeOffsets("if (row.displaySource === 'loan') return;")).toEqual([]);
    expect(writeOffsets(stripComments('// .set({ displayDescription: null, displaySource: null }) was the B-1 clear.'))).toEqual([]);
    expect(writeOffsets(stripComments('/** Nulled `display_source = null` unconditionally until v1.31.0. */'))).toEqual([]);
  });
});
