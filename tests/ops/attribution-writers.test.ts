import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveAttribution } from '@/lib/attribution';

const ROOT = process.cwd();

/** Same walk() shape as tests/ops/display-source-writers.test.ts, which this file is modelled on. */
function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

/** The repo's established stripComments pattern. It matters more than usual here: three of the
 *  writers below argue about this order at length in prose, and src/lib/attribution.ts quotes the
 *  owner's own words. A guard that punished explaining the order would get its docblocks deleted. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 2026-09-13, ruling P17 of
 * docs/superpowers/specs/2026-09-13-vendor-amount-person-rules-design.md.
 *
 * `transactions.attributed_user_id` decides who a charge belongs to -- which report it appears in,
 * whose spending it counts toward, and what "Household/unattributed" means. The ORDER in which
 * candidates win is now three deep (rule > card > account owner) and lives in exactly one place,
 * src/lib/attribution.ts. This file ties the writers to it.
 *
 * WHY IT IS WRITTEN THE SAME WAY AS display-source-writers. That guard exists because R24 shipped
 * a precedence module, a docblock and two writers that consulted it, and ASSERTED in prose that
 * those two were all of them. There were three, and the third destroyed a loan's label with
 * nothing on screen to say so. The count here was two before this release; adding a third writer
 * and a resolver invites exactly the same mistake, and it is the same column-class of damage:
 * silently moving a charge from one person's reports to another's.
 *
 * WHAT IT DOES NOT CATCH, said plainly, because a guard whose limits are unwritten gets trusted
 * for things it does not do:
 *   - a write reaching the column through a name this scan cannot see -- `.set(patch)` where
 *     `patch` is built elsewhere, or a column list assembled by string concatenation.
 *   - whether a writer that DOES consult the module uses the answer correctly. The behaviour is
 *     proved by tests/lib/import/attribution-rules.test.ts and
 *     tests/lib/categorize/attribution-rules.test.ts; this file proves only that no writer is
 *     deciding the order for itself.
 *   - anything outside src/. drizzle/ declares the column and writes it in no migration; scripts/
 *     never names it (both checked while writing this).
 */
const WRITERS: Record<string, string> = {
  'src/lib/import/commit.ts#commitImport':
    'the import insert, for CSV and SimpleFIN alike (sync.ts goes through this function): calls resolveAttribution with all three candidates, having loaded the rule list and the card map once per commit',
  'src/lib/transactions.ts#createManualTransaction':
    'a row somebody typed: the person they explicitly picked, else the account owner. No rule and no card is involved -- there is no imported cell to match and no merchant the person has not already seen, so the order this module defines has nothing to decide here',
  'src/lib/transactions.ts#bulkSetAttribution':
    'the hand edit, which is the LAST word by construction: nothing automatic writes this column after insert, so this deliberately consults nothing and simply does what a person asked',
  'src/lib/categorize/engine.ts#applyAttributionRule':
    'the rules page "Apply now" for an attribution rule: one of the three deliberate points (ruling P10), reached only by somebody pressing a button beside a rule that names a person, having been shown the count first. The rule IS the order here -- there is no card or owner to rank it against',
  'src/lib/categorize/engine.ts#createRulesFromRow':
    'the kebab dialog own pass, the second of the three deliberate points: it writes the rule and then applies it to the merchant rows it just counted for the person, in the same transaction',
};

/**
 * The writers that must NOT ask the module, with the argument rather than a bare allowance (the
 * precedent is tests/ops/spend-where.test.ts, where every entry states why).
 */
const WRITERS_NOT_CONSULTING: Record<string, string> = {
  'src/lib/transactions.ts#createManualTransaction':
    'a manual add has exactly two candidates -- what the person picked, and the account owner -- ' +
    'and no third one the order could rank them against. Routing it through the resolver would ' +
    'mean inventing a ruleMatched: false, cardUserId: null call whose answer is already the ' +
    'expression it replaced, which is ceremony rather than a shared decision.',
  'src/lib/transactions.ts#bulkSetAttribution':
    'this IS the hand edit the whole order defers to (ruling P11: "against a person set by hand ' +
    'later, the hand edit wins, because nothing automatic writes the column after insert"). ' +
    'Asking the resolver what should win here would invert that: it would let a rule overrule the ' +
    'person who just pressed Save.',
  'src/lib/categorize/engine.ts#applyAttributionRule':
    'a deliberate per-rule apply has one candidate, the rule somebody pressed the button next to. ' +
    'Consulting the order would ask whether a card map should beat it, which is exactly the ' +
    'question the button already answered.',
  'src/lib/categorize/engine.ts#createRulesFromRow':
    'the applyAttributionRule reason at the moment the rule is born: the person in this write is ' +
    'the one just typed into the dialog, over rows the dialog counted and named first. There is ' +
    'no card cell and no account owner in scope to rank it against -- the order applies at ' +
    'IMPORT, deciding a row nobody has spoken about yet, and this is the opposite situation.',
};

const EXPORTS = ['resolveAttribution', 'AttributionSource'];

/** The column, in the spelling a drizzle write uses. The snake_case spelling is checked separately
 *  as raw SQL, because a raw `update transactions set attributed_user_id = ...` would bypass every
 *  drizzle-shaped pattern below. */
const COLUMN_KEYS = ['attributedUserId'];

/**
 * Which table a `.set(...)`/`.values(...)` belongs to, read off the `.update(X)`/`.insert(X)` that
 * opened the chain.
 *
 * Load-bearing, not defensive: merchant_rules has an attributed_user_id column too -- it is how an
 * attribution RULE names its person -- and upsertRuleFromCorrection writes it under exactly the
 * spelling this file scans for. That write decides what a RULE says, not who a TRANSACTION belongs
 * to, so counting it here would demand an exemption for a function that has nothing to do with the
 * order, and would leave the guard unable to say what it is actually guarding.
 */
function writtenTable(source: string, offset: number): string | null {
  const before = source.slice(Math.max(0, offset - 400), offset);
  const chain = /\.(?:update|insert)\s*\(\s*([A-Za-z_$][\w$]*)/g;
  let table: string | null = null;
  for (const match of before.matchAll(chain)) table = match[1];
  return table;
}

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
 * Every offset at which the column is WRITTEN: a drizzle `.set(...)`/`.values(...)` naming it, or
 * a raw-SQL assignment. A READ -- a select projection, a where clause, a comparison -- is not a
 * write and is deliberately not reported: this guard is about who decides the person, and there
 * are dozens of legitimate readers (every report, every filter, the digest).
 */
function writeOffsets(source: string): number[] {
  const offsets: number[] = [];
  const call = /\.(?:set|values)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(source))) {
    const args = callArguments(source, match.index);
    // `[,:}]` and not just `:` -- bulkSetAttribution writes `.set({ attributedUserId, updatedAt })`
    // in shorthand, and a colon-only pattern walks straight past the one writer whose whole job is
    // this column.
    if (
      args !== null &&
      COLUMN_KEYS.some((key) => new RegExp(`\\b${key}\\s*[,:}]`).test(args.text)) &&
      writtenTable(source, match.index) === 'transactions'
    ) {
      offsets.push(match.index);
    }
    call.lastIndex = match.index + match[0].length;
  }
  const raw = /attributed_user_id\s*=(?!=)/g;
  while ((match = raw.exec(source))) offsets.push(match.index);
  return [...new Set(offsets)].sort((a, b) => a - b);
}

const DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

function enclosingFunction(source: string, offset: number): { name: string; body: string } | null {
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

function writersIn(files: string[], read: (file: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files) {
    const source = stripComments(read(file));
    for (const offset of writeOffsets(source)) {
      const enclosing = enclosingFunction(source, offset);
      const key = `${file}#${enclosing === null ? '<top level>' : enclosing.name}`;
      out.set(key, enclosing === null ? '' : enclosing.body);
    }
  }
  return out;
}

const files = walk('src');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const writers = writersIn(files, read);

describe('every writer of attributed_user_id is accounted for (P17)', () => {
  it('scans a real tree (a scan that matches nothing proves nothing)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('src/lib/attribution.ts');
  });

  it('finds the known writers and no others', () => {
    expect([...writers.keys()].sort()).toEqual(Object.keys(WRITERS).sort());
  });

  it('every writer either consults the one order or states why it must not', () => {
    const silent = [...writers.entries()]
      .filter(([key, body]) => !EXPORTS.some((name) => body.includes(name)) && WRITERS_NOT_CONSULTING[key] === undefined)
      .map(([key]) => key);
    expect(silent).toEqual([]);
  });

  it('every exemption carries an argument rather than merely being listed', () => {
    const unexplained = Object.entries(WRITERS_NOT_CONSULTING)
      .filter(([, why]) => why.trim().length < 80)
      .map(([key]) => key);
    expect(unexplained).toEqual([]);
    // An exemption for something that is not a writer is stale and would hide a real gap.
    expect(Object.keys(WRITERS_NOT_CONSULTING).filter((key) => !writers.has(key))).toEqual([]);
  });

  it('the module it points at actually decides the order', () => {
    expect(resolveAttribution({ ruleUserId: 7, ruleMatched: true, cardUserId: 3, ownerUserId: 1 }).source).toBe('rule');
    expect(resolveAttribution({ ruleUserId: null, ruleMatched: false, cardUserId: 3, ownerUserId: 1 }).source).toBe('card');
  });

  /**
   * Non-vacuity: reconstruct a write and prove the scan sees it. Without this, a broken regex
   * would leave a file that passes for ever while guarding nothing.
   */
  it('would catch a new writer, in both spellings', () => {
    expect(writeOffsets('db.update(transactions).set({ attributedUserId: 4 }).run();')).not.toEqual([]);
    expect(writeOffsets('sql`update transactions set attributed_user_id = 4`')).not.toEqual([]);
    expect(writeOffsets('db.update(transactions).set({ attributedUserId, updatedAt }).run();')).not.toEqual([]);
    // A read is not a write.
    expect(writeOffsets('where(eq(transactions.attributedUserId, userId))')).toEqual([]);
    // And the identically-named column on merchant_rules is a different question entirely.
    expect(writeOffsets('db.update(merchantRules).set({ attributedUserId: 4 }).run();')).toEqual([]);
  });
});
