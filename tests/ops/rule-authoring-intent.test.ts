import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE GOVERNING PRINCIPLE, and the only thing every check in this file is trying to protect:
 *
 *   A MERCHANT RULE IS ONLY EVER AUTHORED WHERE THE PERSON IS MAKING A STATEMENT ABOUT A
 *   MERCHANT. ASSIGNING ONE TRANSACTION TO A LOAN IS A STATEMENT ABOUT THAT TRANSACTION.
 *
 * A merchant rule is household-wide and permanent: it decides how every future statement gets
 * filed, for everybody, until somebody finds and deletes it on Settings -> Rules. "Mark this as a
 * transfer" on a payroll deposit earns one -- a payroll deposit is a transfer every time, so the
 * merchant IS the fact. "File this reimbursement against the work loan" does not -- what makes
 * that money not-spending is the LOAN LINK, and the shop it happened to be spent at is incidental.
 *
 * v1.27.0 item 1 exists because those two got conflated. The owner reported it: "when i add items
 * to loan they are marked transfer by default but it also adds a rule ... next time i buy from
 * [that shop] i dont want it to automatically caretgorize it as transfer". The assign-to-loan
 * editor's "Also mark as a transfer" checkbox was pre-armed ON and posted to setTransferFlag,
 * which does not only set `is_transfer` -- it upserts an exact transfer rule for the merchant. One
 * loan assignment, and every future purchase from that shop was silently flagged out of spending.
 *
 * This is the SECOND time this exact bug class has shipped. v1.12.1 (item U / UX-2, rulings R4 and
 * P5) was the first: picking "Uncategorized" from the row select on /transactions deleted that
 * merchant's household-wide rule, from a mis-scroll over a <select> on a phone. That fix invented
 * the shape both fixes now share -- a REQUIRED boolean with no default, so the compiler makes
 * every call site say what it means (clearCategory's `deleteRule`, setTransferFlag's `learnRule`).
 *
 * Twice is a pattern, and a pattern needs a guard rather than a third careful reviewer. Nothing
 * stopped a fourth path appearing with the same defect, so:
 *
 *   1. Only an argued list of files may touch a rule-authoring helper at all.
 *   2. Every exported function in engine.ts that reaches one must be a KNOWN path with a declared
 *      intent -- a fourth appearing fails, loudly, with instructions.
 *   3. Every call site of a path that carries an intent flag must pass that flag AT THE CALL, even
 *      where the type would let it be omitted. An omitted optional flag is precisely the silence
 *      that made both bugs invisible.
 *   4. The flags introduced for this bug class stay required, with no default.
 *   5. The loan path specifically passes `false`.
 *   6. Only an argued list of files may reach the merchant_rules TABLE at all -- v1.31.0 R-05,
 *      DETECTOR 3. Rules 1-5 all scan for helper NAMES, and this file used to justify that by
 *      asserting rules.ts was "the only file that touches the merchant_rules table", which was
 *      false when it was written: two pack files write that table directly. A file that imports
 *      the table can author a rule while saying no name any scan here knows.
 *
 * Every detector below is a pure function of source TEXT, so the last describe block can run each
 * one over a deliberately broken snippet constructed inside the test and prove it reports the
 * offence. That block is not decoration: a guard that cannot fail reads as protection while
 * providing none, which is worse than no guard at all -- and so is a guard whose STATED REASON is
 * false, which is what rule 6 is here to correct rather than merely to add.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const ENGINE = 'src/lib/categorize/engine.ts';

/**
 * The repo's established stripComments pattern (tests/ops/install.test.ts,
 * tests/ops/loan-invariants.test.ts). Every check here scans for helper NAMES, and this file's
 * subjects discuss those helpers at length in their own docblocks -- setTransferFlag's `learnRule`
 * comment names `upsertRuleFromCorrection` three times. Without this, prose would trip every scan
 * below, and a guard that punishes explaining the code it governs gets its comments deleted.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function srcFiles(dir = path.join(root, 'src'), acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) srcFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const relative = (file: string) => path.relative(root, file).replace(/\\/g, '/');

/**
 * Helpers that CHANGE WHAT A RULE SAYS ABOUT A MERCHANT. All four are defined in
 * src/lib/categorize/rules.ts, which owns those HELPERS -- and, as of v1.31.0, that is all this
 * sentence claims.
 *
 * IT USED TO CLAIM MORE, AND THE CLAIM WAS FALSE: "which is the only file that touches the
 * merchant_rules table". src/lib/packs.ts and src/lib/canadian-pack.ts both import the
 * `merchantRules` table from @/db/schema and write it with `db.update(...)` directly -- hit-count
 * resets, pack provenance stamps, origin keys. So a FIFTH surface could import the table and call
 * `getDb().insert(merchantRules)` and author a rule without ever saying a name the scan below
 * knows, while this file read as protection against exactly that. Review finding R-05 (P2). A
 * guard whose stated reason is false is worse than no guard, because it tells the next reader the
 * question was settled when it was not examined -- this file's own opening docblock says so, one
 * paragraph up. DETECTOR 3 (below) is the coverage that sentence was promising; the premise here
 * is now narrowed to what is true.
 *
 * `bumpRuleUsage` is deliberately NOT here, and the line matters. It increments hit_count and
 * stamps last_used_at -- import-time bookkeeping about how often a rule fired. It cannot change
 * how anything gets filed, so requiring runEngine's tail to "declare intent" before counting a hit
 * would be pure noise, and noise is how a guard gets deleted.
 */
const RULE_AUTHORING_HELPERS: readonly string[] = [
  'upsertRuleFromCorrection',
  'deleteExactRule',
  'deleteRule',
  'setRuleDisabledFlag',
];

/** `input.deleteRule` (a FLAG read) must never read as `deleteRule(...)` (a helper CALL) -- the
 *  flag on clearCategory and the helper in rules.ts genuinely share a name, so the lookbehind on
 *  `.` and word characters is load-bearing, not defensive habit. */
function callsHelper(body: string, helper: string): boolean {
  return new RegExp(`(?<![.\\w])${helper}\\s*\\(`).test(body);
}

function callsAnyHelper(body: string): boolean {
  return RULE_AUTHORING_HELPERS.some((helper) => callsHelper(body, helper));
}

/** Index of the character matching the opener at `open`, or -1. */
function matchDelimiter(source: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === opener) depth += 1;
    else if (source[i] === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every `export function NAME` in `source`, split into its signature and its body.
 *
 * Finding where the body starts is the whole difficulty, and the obvious two heuristics are both
 * wrong here -- worth recording, because both fail SILENTLY (a truncated body reports "authors no
 * rule", which is the safe-looking answer and the dangerous one):
 *   - "the first `}` in the first column" ends at the parameter OBJECT TYPE's closing brace, since
 *     every function in engine.ts takes a multi-line `input: { ... }` whose `}` sits at column 0.
 *   - "the first `{` after the parameter list" lands inside the RETURN type, which for
 *     upsertRenameRule is `{ ok: true; ... } | { ok: false; ... }`.
 *   - "the last `{` on the line the closing paren sits on" also lands in the return type, because
 *     deleteRenameRule's spans three lines: `): {\n ruleId...\n} {`.
 * So the braces after the parameter list are walked instead: brace-match each candidate in turn,
 * and if what follows its match is another `{` or a type continuation (`|`, `&`), that candidate
 * was part of the return TYPE and the walk moves on. The first candidate not followed by one of
 * those is the body.
 *
 * Still a formatting assumption, so it is not trusted blind: the completeness check below asserts
 * an EXACT list of names, which is what turns any regression in this parser into a red test rather
 * than a quietly weakened guard.
 *
 * v1.31.0 R-05 widened the pattern from `^export function NAME(` to also take `export async
 * function`. The old regex missed it, and missed it silently: an `export async function` in
 * engine.ts that called upsertRuleFromCorrection was simply not a function as far as DETECTOR 1
 * was concerned, so "a fourth appearing fails, loudly" (this file's own promise, twice) was untrue
 * for one of the two ways a fourth would most plausibly be written. `export const NAME = (...) =>`
 * is the other, and it is handled by exportedArrowFunctions below rather than here, because its
 * body is found a different way.
 */
function exportedFunctions(source: string): { name: string; signature: string; body: string }[] {
  const bare = stripComments(source);
  const result: { name: string; signature: string; body: string }[] = [];
  const re = /^export (?:async )?function (\w+)\s*\(/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(bare)) !== null) {
    const openParen = match.index + match[0].length - 1;
    const closeParen = matchDelimiter(bare, openParen, '(', ')');
    if (closeParen === -1) continue;

    let cursor = closeParen;
    let openBrace = -1;
    let closeBrace = -1;
    // Bounded: a signature with ten return-type objects in a union is not a thing in this repo,
    // and an unbounded walk on malformed input would run to the end of the file.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      openBrace = bare.indexOf('{', cursor);
      if (openBrace === -1) break;
      closeBrace = matchDelimiter(bare, openBrace, '{', '}');
      if (closeBrace === -1) break;
      const next = bare.slice(closeBrace + 1).match(/^\s*(\S)/);
      if (next === null || !['{', '|', '&'].includes(next[1] as string)) break;
      cursor = closeBrace + 1;
    }
    if (openBrace === -1) continue;

    result.push({
      name: match[1] as string,
      signature: bare.slice(match.index, openBrace),
      body: bare.slice(openBrace, closeBrace === -1 ? bare.length : closeBrace + 1),
    });
  }
  return result;
}

/**
 * The OTHER shape a module-level export takes: `export const NAME = (args) => { ... }`, async or
 * not. v1.31.0 R-05: invisible to exportedFunctions above, and this repo writes plenty of them, so
 * a rule-authoring path written this way passed every assertion in this file.
 *
 * The body is found from the arrow rather than from the parameter list, because there is no return
 * type to trip over: brace-match a block body; for a concise (expression) body, take everything to
 * the first `;` outside any bracket.
 *
 * WHAT THIS DOES NOT CATCH, said plainly rather than left for somebody to discover: an explicitly
 * ANNOTATED const (`export const f: Handler = (x) => ...`), because a type annotation may itself
 * contain `=>` and no regex tells the two arrows apart; a helper reached through a variable
 * (`const fn = deleteRule; fn(1)`); an export re-exported from another module (`export { tidy }
 * from './x'` -- the DEFINING file is the one that calls the helper, so the file allow-list is what
 * covers that); or a call assembled from strings. All four are still caught by the file allow-list,
 * which scans whole files rather than exports -- that check is the floor, and this one only adds
 * "and say which path it is" on top of it.
 */
function exportedArrowFunctions(source: string): { name: string; signature: string; body: string }[] {
  const bare = stripComments(source);
  const result: { name: string; signature: string; body: string }[] = [];
  const re = /^export const (\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>\s*/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(bare)) !== null) {
    const after = match.index + match[0].length;
    let body: string;
    if (bare[after] === '{') {
      const close = matchDelimiter(bare, after, '{', '}');
      body = bare.slice(after, close === -1 ? bare.length : close + 1);
    } else {
      let depth = 0;
      let end = after;
      for (; end < bare.length; end += 1) {
        const ch = bare[end] as string;
        if ('([{'.includes(ch)) depth += 1;
        else if (')]}'.includes(ch)) depth -= 1;
        else if (ch === ';' && depth === 0) break;
      }
      body = bare.slice(after, end);
    }
    result.push({ name: match[1] as string, signature: match[0], body });
  }
  return result;
}

/** Every module-level export whose body this file can read, in either shape. */
function allExports(source: string): { name: string; signature: string; body: string }[] {
  return [...exportedFunctions(source), ...exportedArrowFunctions(source)];
}

/** DETECTOR 1 (rule 2): which exported functions in a file can author a merchant rule. */
function ruleAuthoringPaths(source: string): string[] {
  return allExports(source)
    .filter((fn) => callsAnyHelper(fn.body))
    .map((fn) => fn.name)
    .sort();
}

/**
 * DETECTOR 3 (v1.31.0 R-05): which files reach the merchant_rules TABLE, rather than a helper.
 *
 * This is the coverage the premise above used to assert and never had. A file that imports
 * `merchantRules` from @/db/schema can insert, update or delete a rule row with no helper name
 * anywhere in it -- `getDb().update(merchantRules).set({ categoryId })` authors a rule as
 * thoroughly as upsertRuleFromCorrection does, and two files already do write that table directly.
 * So the same "argued list, or fail" treatment the helpers get, applied one layer down.
 *
 * The name is matched as a whole word so `merchantRulesSomething` cannot satisfy it, and comments
 * are stripped so this file's own subjects may keep discussing the table.
 */
function touchesRuleTable(source: string): boolean {
  return /(?<![.\w])merchantRules(?![\w])/.test(stripComments(source));
}

/**
 * How each known path in engine.ts declares its intent. Either a REQUIRED-at-the-call-site flag
 * name, or NAME_DECLARES_IT with the reason spelled out per entry -- following the shipped-pack
 * cross-collision guard's precedent, where an allowance carries its argument rather than the check
 * being weakened for everybody.
 */
const NAME_DECLARES_IT = Symbol('the function name is itself the declaration');

type IntentDeclaration = string | { declaredBy: typeof NAME_DECLARES_IT; why: string };

const RULE_AUTHORING_PATHS: ReadonlyMap<string, IntentDeclaration> = new Map<string, IntentDeclaration>([
  ['confirmCategory', 'createRule'],
  ['clearCategory', 'deleteRule'],
  ['setTransferFlag', 'learnRule'],
  [
    'applyCategoryToMatching',
    {
      declaredBy: NAME_DECLARES_IT,
      why:
        'This IS "Apply category to all N matching transactions + create rule" -- the button says ' +
        'so, and authoring the rule is the entire point of choosing it over a per-row confirm. A ' +
        'flag here could only ever be passed true, which is configuration nobody sets.',
    },
  ],
  [
    'upsertRenameRule',
    {
      declaredBy: NAME_DECLARES_IT,
      why:
        '"All matching + future": the function name contains the word upsert and the word rule. A ' +
        'caller cannot reach it while believing it edits one transaction.',
    },
  ],
  [
    'deleteRenameRule',
    {
      declaredBy: NAME_DECLARES_IT,
      why: 'Same as upsertRenameRule in reverse -- the name names the rule and names the delete.',
    },
  ],
  [
    'setRuleDisabled',
    {
      declaredBy: NAME_DECLARES_IT,
      why:
        'Takes a ruleId, not a transactionId. It is the Settings -> Rules disable control (item ' +
        '11), where the whole page a person is looking at IS the statement about the rule -- there ' +
        'is no per-row action to mistake it for.',
    },
  ],
]);

/**
 * DETECTOR 2 (rule 3): call sites of `fnName` in `source` whose argument object does not name
 * `flag`. Paren-matched from the call's own `(` so a nested call in an earlier argument cannot end
 * the scan early.
 */
function callSitesMissingFlag(source: string, fnName: string, flag: string): string[] {
  const bare = stripComments(source);
  const offenders: string[] = [];
  const re = new RegExp(`(?<![.\\w])${fnName}\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(bare)) !== null) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < bare.length; end += 1) {
      if (bare[end] === '(') depth += 1;
      else if (bare[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const args = bare.slice(match.index, end + 1);
    // `export function setTransferFlag(input: {...})` is the declaration, not a call.
    if (/^export function/.test(bare.slice(Math.max(0, match.index - 16), match.index + match[0].length))) continue;
    if (!new RegExp(`(?<![.\\w])${flag}\\s*:`).test(args)) {
      offenders.push(`${fnName}(...) with no ${flag}: ${args.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  return offenders;
}

describe('v1.27.0 item 1: only an argued list of files may author a merchant rule', () => {
  /**
   * Keyed by file, valued by the reason. A new entry is not forbidden -- it is a decision that has
   * to be written down, because "which surfaces teach the household how to file money" is exactly
   * the question nobody asked before the loan checkbox shipped.
   */
  const ALLOWED_AUTHORS: ReadonlyMap<string, string> = new Map([
    [
      'src/lib/categorize/rules.ts',
      'Owns the merchant_rules table. Every helper this guard names is defined here, and a ' +
        'definition necessarily mentions itself.',
    ],
    [
      ENGINE,
      'The per-transaction paths. This is the file the whole guard is about: every exported ' +
        'function here that can author a rule is enumerated in RULE_AUTHORING_PATHS below.',
    ],
    [
      'src/app/(app)/settings/merchant-rules/actions.ts',
      'The rules page itself, admin-only. A person on a page titled "Rules", editing a row that ' +
        'shows the pattern and the outcome, is making a statement about a merchant by definition.',
    ],
    [
      'src/lib/packs.ts',
      'Pack import: installing a named, versioned rule SET, chosen deliberately and reversible as ' +
        'a set. The statement is "use these rules", which is a statement about merchants in bulk.',
    ],
    [
      'src/lib/canadian-pack.ts',
      'The shipped pack\'s own installer/upgrader, same reasoning as packs.ts.',
    ],
  ]);

  it('no file outside the allow-list calls a rule-authoring helper', () => {
    const offenders = srcFiles()
      .filter((file) => callsAnyHelper(stripComments(fs.readFileSync(file, 'utf8'))))
      .map(relative)
      .filter((rel) => !ALLOWED_AUTHORS.has(rel))
      .sort();
    expect(
      offenders,
      'A merchant rule is household-wide and permanent. Before adding a file here, answer the ' +
        'governing principle at the top of this file: is the person making a statement about a ' +
        'MERCHANT, or about one transaction? If it is one transaction, do not author a rule.',
    ).toEqual([]);
  });

  it('every allow-list entry still names a file that authors rules, and carries a real reason', () => {
    // A stale entry is how an allow-list rots into a list of files somebody once mentioned.
    const stale = [...ALLOWED_AUTHORS.keys()]
      .filter((rel) => !callsAnyHelper(stripComments(read(rel))))
      .sort();
    expect(stale).toEqual([]);
    const unexplained = [...ALLOWED_AUTHORS.entries()].filter(([, why]) => why.trim().length < 60).map(([rel]) => rel);
    expect(unexplained).toEqual([]);
  });
});

describe('v1.31.0 R-05: only an argued list of files may reach the merchant_rules TABLE', () => {
  /**
   * DETECTOR 3's allow-list, and the reason this describe block exists at all: the helper scan
   * above was sold as covering "the only file that touches the merchant_rules table", and two
   * files were already writing that table with no helper name in sight. Each entry names what it
   * writes DIRECTLY -- not what it does in general -- so a reviewer can check the claim against
   * the code rather than take the file's word for it.
   *
   * A new entry is not forbidden. It is a decision that has to be written down, and the question
   * to answer first is the governing principle at the top of this file: authoring a rule row by
   * hand is authoring a rule, whichever API you reach for.
   */
  const ALLOWED_TABLE_WRITERS: ReadonlyMap<string, string> = new Map([
    [
      'src/db/schema.ts',
      'Declares the merchantRules table itself, plus the pattern/match_type/rule_kind unique index ' +
        'every helper above upserts against. A definition necessarily names what it defines.',
    ],
    [
      'src/lib/categorize/rules.ts',
      'Owns the table: every insert, delete and disabled_at flip in this app goes through the four ' +
        'helpers defined here, which is what makes the helper scan above meaningful at all.',
    ],
    [
      'src/lib/packs.ts',
      'Pack import writes the table directly for the bookkeeping the shared upsert does not carry: ' +
        'a hit_count/last_used_at reset on a re-imported row (importRulesPack), and the ' +
        'pack_origin_key provenance in rememberPackOrigin / applyPackOriginCarry. Rule CONTENT ' +
        'still goes through upsertRuleFromCorrection -- see the ALLOWED_AUTHORS reason above.',
    ],
    [
      'src/lib/canadian-pack.ts',
      "The shipped pack's installer/upgrader stamps and un-stamps pack_source/pack_version/" +
        'installed_at with raw updates (an unchanged row needs nothing else written; a row the pack ' +
        'no longer claims becomes an ordinary household rule). Content changes go through the ' +
        'helpers, as its own comments state.',
    ],
  ]);

  it('no file outside the allow-list reaches the merchant_rules table', () => {
    const offenders = srcFiles()
      .filter((file) => touchesRuleTable(fs.readFileSync(file, 'utf8')))
      .map(relative)
      .filter((rel) => !ALLOWED_TABLE_WRITERS.has(rel))
      .sort();
    expect(
      offenders,
      'This file imports the merchantRules TABLE. A rule row written by hand -- ' +
        'getDb().insert(merchantRules) or .update(merchantRules).set({ categoryId }) -- authors a ' +
        'household-wide rule exactly as upsertRuleFromCorrection does, and it says none of the ' +
        'helper names the scan above looks for. Either write rule CONTENT through the helpers in ' +
        'src/lib/categorize/rules.ts, or add this file to ALLOWED_TABLE_WRITERS with a reason ' +
        'naming what it writes directly and why that is not rule content.',
    ).toEqual([]);
  });

  it('every allow-list entry still reaches the table, and carries a real reason', () => {
    // The same stale-entry check the helper allow-list gets: a list of files somebody once
    // mentioned is not a guard.
    const stale = [...ALLOWED_TABLE_WRITERS.keys()].filter((rel) => !touchesRuleTable(read(rel))).sort();
    expect(stale).toEqual([]);
    const unexplained = [...ALLOWED_TABLE_WRITERS.entries()].filter(([, why]) => why.trim().length < 60).map(([rel]) => rel);
    expect(unexplained).toEqual([]);
  });

  it('the two lists agree about the files that do both', () => {
    // Not a redundancy: a file that writes rule CONTENT must be argued in both places, and it is
    // the pair of lists disagreeing that says somebody added one and forgot the other.
    for (const rel of ['src/lib/categorize/rules.ts', 'src/lib/packs.ts', 'src/lib/canadian-pack.ts']) {
      expect({ rel, helpers: callsAnyHelper(stripComments(read(rel))), table: touchesRuleTable(read(rel)) }).toEqual({
        rel,
        helpers: true,
        table: true,
      });
    }
  });
});

describe('v1.27.0 item 1: every rule-authoring path in engine.ts declares its intent', () => {
  it('the set of paths that can author a rule is exactly the declared set', () => {
    expect(
      ruleAuthoringPaths(read(ENGINE)),
      'A new exported function in engine.ts reaches a rule-authoring helper. Decide which it is ' +
        'and add it to RULE_AUTHORING_PATHS: (a) a per-transaction action, in which case give it a ' +
        'REQUIRED boolean with no default, the way setTransferFlag has learnRule and clearCategory ' +
        'has deleteRule, and gate BOTH the upsert and any housekeeping delete on it; or (b) a path ' +
        'whose own NAME says it edits a rule, in which case say so with a reason. If it is (a) and ' +
        'you were about to default the flag ON, read the owner report at the top of this file.',
    ).toEqual([...RULE_AUTHORING_PATHS.keys()].sort());
  });

  it('every flag-declared path passes its flag at EVERY call site, across all of src/', () => {
    const flagged = [...RULE_AUTHORING_PATHS.entries()].filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    const offenders: string[] = [];
    for (const file of srcFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      for (const [fnName, flag] of flagged) {
        for (const site of callSitesMissingFlag(source, fnName, flag)) offenders.push(`${relative(file)}: ${site}`);
      }
    }
    expect(
      offenders,
      'confirmCategory\'s createRule is typed OPTIONAL and defaults to ON, so the compiler will ' +
        'not catch an omission -- and an omitted flag that quietly writes a household rule is the ' +
        'exact silence that made both v1.12.1 item U and v1.27.0 item 1 invisible. Spell it out at ' +
        'the call, even when the value you want is the default.',
    ).toEqual([]);
  });

  it('every name-declared path carries a written reason, not just an exemption', () => {
    const unexplained = [...RULE_AUTHORING_PATHS.entries()]
      .filter((entry): entry is [string, { declaredBy: typeof NAME_DECLARES_IT; why: string }] => typeof entry[1] !== 'string')
      .filter(([, value]) => value.why.trim().length < 80)
      .map(([name]) => name);
    expect(unexplained).toEqual([]);
  });
});

describe('v1.27.0 item 1: the intent flags stay required, and the loan path stays false', () => {
  /**
   * The flags invented for this bug class, both of which must stay REQUIRED with no default. Making
   * one optional would restore the failure mode wholesale: a new call site would compile while
   * saying nothing, and would author a household rule by default. `createRule` is deliberately not
   * in this list -- it predates the rule and is optional today; the call-site check above is what
   * covers it, and tightening its type is a separate change with its own callers to audit.
   */
  const REQUIRED_FLAGS: readonly { fn: string; flag: string }[] = [
    { fn: 'clearCategory', flag: 'deleteRule' },
    { fn: 'setTransferFlag', flag: 'learnRule' },
  ];

  it.each(REQUIRED_FLAGS)('$fn declares $flag with no `?` and no default', ({ fn, flag }) => {
    const bare = stripComments(read(ENGINE));
    const decl = exportedFunctions(read(ENGINE)).find((f) => f.name === fn);
    expect(decl, `${fn} is no longer an exported function in ${ENGINE}`).toBeDefined();
    const signature = (decl as { signature: string }).signature;
    expect({ flag, declared: new RegExp(`(^|\\s)${flag}:\\s*boolean;`).test(signature) }).toEqual({
      flag,
      declared: true,
    });
    expect({ flag, optionalOrDefaulted: new RegExp(`${flag}\\s*(\\?|=)`).test(signature) }).toEqual({
      flag,
      optionalOrDefaulted: false,
    });
    expect(bare).toContain(`${flag}:`);
  });

  /**
   * The regression itself, asserted structurally as well as behaviourally (the behavioural test is
   * tests/app/transactions-actions.test.ts, named after the owner's report). A structural check
   * earns its place here because the behavioural one can be satisfied by a fixture that never
   * exercises the checkbox, whereas this reads the literal a person would have to change.
   */
  it('assignToLoanAction passes learnRule: false', () => {
    const source = stripComments(read('src/app/(app)/transactions/actions.ts'));
    const start = source.indexOf('export async function assignToLoanAction');
    expect(start).toBeGreaterThan(-1);
    const close = source.indexOf('\n}', start);
    const body = close === -1 ? source.slice(start) : source.slice(start, close + 2);

    expect({ where: 'assignToLoanAction', passes: /learnRule:\s*false/.test(body) }).toEqual({
      where: 'assignToLoanAction',
      passes: true,
    });
    expect({ where: 'assignToLoanAction', teachesAMerchant: /learnRule:\s*true/.test(body) }).toEqual({
      where: 'assignToLoanAction',
      teachesAMerchant: false,
    });
  });

  it('setRowTransferAction, the deliberate per-row control, still passes learnRule: true', () => {
    const source = stripComments(read('src/app/(app)/transactions/actions.ts'));
    const start = source.indexOf('export async function setRowTransferAction');
    expect(start).toBeGreaterThan(-1);
    const close = source.indexOf('\n}', start);
    const body = close === -1 ? source.slice(start) : source.slice(start, close + 2);
    expect(/learnRule:\s*true/.test(body)).toBe(true);
  });
});

/**
 * NON-VACUITY. Every check above passes today; that is only worth something if the checks can
 * fail. A typo in a helper name, a regex whose lookbehind swallowed every match, an
 * exportedFunctions that returned an empty list -- each would pass every assertion above forever
 * while protecting nothing.
 *
 * So the two detectors are re-run here against source text CONSTRUCTED IN THE TEST: the v1.27.0
 * defect reconstructed exactly (a fourth path that authors a rule with no flag, and a call site
 * that omits one), plus the shapes a reviewer would most plausibly wave through. Same pattern as
 * the shipped-pack cross-collision guard, which rebuilds its own shipped v2 defect in the test
 * rather than leaving it in the pack.
 */
describe('v1.27.0 item 1: the guard fails on a deliberately bad case', () => {
  it('DETECTOR 1 spots a fourth undeclared path -- the v1.27.0 defect, reconstructed', () => {
    const bad = [
      'export function markAsReimbursement(input: { transactionId: number; userId: number }): void {',
      '  const row = readRow(input.transactionId);',
      '  upsertRuleFromCorrection({ pattern: row.normalizedMerchant, ruleKind: "transfer" });',
      '  writeFlag(input.transactionId);',
      '}',
    ].join('\n');

    expect(ruleAuthoringPaths(bad)).toEqual(['markAsReimbursement']);
    // ...and it is not in the declared set, which is what turns detection into a failure.
    expect(RULE_AUTHORING_PATHS.has('markAsReimbursement')).toBe(false);
  });

  it('DETECTOR 1 spots the housekeeping-delete half too, not just the upsert', () => {
    // The half a fix is most likely to miss: suppress the upsert, leave the delete. A loan
    // assignment that deletes somebody's deliberate "not a transfer" override is the same defect
    // wearing the other sign.
    const onlyDeletes = [
      'export function tidyUpAfterLinking(input: { transactionId: number }): void {',
      '  deleteExactRule(readRow(input.transactionId).normalizedMerchant, "not_transfer");',
      '}',
    ].join('\n');
    expect(ruleAuthoringPaths(onlyDeletes)).toEqual(['tidyUpAfterLinking']);
  });

  it('DETECTOR 1 is not fooled by prose, and does not fire on bookkeeping', () => {
    const prose = [
      '/** Never calls upsertRuleFromCorrection -- see setTransferFlag for why. */',
      'export function describeOnly(input: { transactionId: number }): void {',
      '  // deleteExactRule(x, "transfer") would be wrong here.',
      '  bumpRuleUsage(input.transactionId);',
      '}',
    ].join('\n');
    expect(ruleAuthoringPaths(prose)).toEqual([]);
  });

  it('DETECTOR 2 spots an omitted flag, and accepts one that is spelled out', () => {
    const omitted = 'const r = confirmCategory({ transactionId: id, categoryId, userId, actorRole });';
    const found = callSitesMissingFlag(omitted, 'confirmCategory', 'createRule');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('no createRule');

    const spelledOut = 'const r = confirmCategory({ transactionId: id, categoryId, userId, createRule: false, actorRole });';
    expect(callSitesMissingFlag(spelledOut, 'confirmCategory', 'createRule')).toEqual([]);
  });

  it('DETECTOR 2 is not satisfied by a nested call carrying the flag instead', () => {
    // The shape a paren-matching bug would wave through: the flag appears in the source, just not
    // in THIS call's arguments.
    const misplaced = [
      'setTransferFlag({',
      '  transactionId: pick({ learnRule: true }).id,',
      '  isTransfer: true,',
      '});',
      'setTransferFlag({ transactionId: other, isTransfer: false });',
    ].join('\n');
    // The first call does carry `learnRule:` inside its own parens (a limitation this states
    // rather than hides -- the compiler, not this regex, is what makes learnRule required); the
    // SECOND, with no learnRule anywhere in it, must still be caught.
    const found = callSitesMissingFlag(misplaced, 'setTransferFlag', 'learnRule');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('other');
  });

  it('DETECTOR 2 does not mistake the declaration for a call site', () => {
    const declaration = [
      'export function setTransferFlag(input: {',
      '  transactionId: number;',
      '  learnRule: boolean;',
      '}): void {}',
    ].join('\n');
    expect(callSitesMissingFlag(declaration, 'setTransferFlag', 'learnRule')).toEqual([]);
  });

  it('DETECTOR 1 spots an `export async function`, the shape it used to miss (R-05)', () => {
    // The regex was `^export function NAME(`, so this was not a function at all as far as the
    // guard was concerned -- and "a fourth appearing fails, loudly" was untrue for it.
    const asyncPath = [
      'export async function markAll(input: { ids: number[] }): Promise<void> {',
      '  for (const id of input.ids) {',
      '    upsertRuleFromCorrection({ pattern: merchantOf(id), ruleKind: "transfer" });',
      '  }',
      '}',
    ].join('\n');
    expect(ruleAuthoringPaths(asyncPath)).toEqual(['markAll']);
    expect(RULE_AUTHORING_PATHS.has('markAll')).toBe(false);
  });

  it('DETECTOR 1 spots an `export const NAME = () => {}`, the other shape it missed (R-05)', () => {
    const arrowBlock = ['export const tidy = (id: number) => {', '  deleteRule(id);', '};'].join('\n');
    expect(ruleAuthoringPaths(arrowBlock)).toEqual(['tidy']);

    // Concise body, and an async one, both of which a block-brace-only reader would drop.
    const arrowExpression = 'export const nuke = (id: number) => deleteRule(id);';
    expect(ruleAuthoringPaths(arrowExpression)).toEqual(['nuke']);
    const asyncArrow = [
      'export const clean = async (id: number) => {',
      '  await Promise.resolve();',
      '  deleteExactRule("X", "transfer");',
      '};',
    ].join('\n');
    expect(ruleAuthoringPaths(asyncArrow)).toEqual(['clean']);

    // ...and an ordinary exported const is not mistaken for a path.
    expect(ruleAuthoringPaths('export const LIMIT = 5;')).toEqual([]);
    expect(ruleAuthoringPaths('export const label = (id: number) => `rule ${String(id)}`;')).toEqual([]);
  });

  it('DETECTOR 3 spots a file that writes the merchant_rules TABLE with no helper in sight (R-05)', () => {
    // The FALSE PREMISE, reconstructed: this file authors a rule and says none of the four helper
    // names, so every check that scans for those names passes on it.
    const tableWriter = [
      "import { merchantRules } from '@/db/schema';",
      'export function fileEverythingAsGroceries(categoryId: number): void {',
      '  getDb().update(merchantRules).set({ categoryId }).run();',
      '}',
    ].join('\n');
    expect(callsAnyHelper(stripComments(tableWriter))).toBe(false);
    expect(touchesRuleTable(tableWriter)).toBe(true);
    expect(ruleAuthoringPaths(tableWriter)).toEqual([]);

    // ...and it is not fooled by prose, by a longer identifier, or by a property of that name.
    expect(touchesRuleTable(['// merchantRules is written only in rules.ts', 'export const x = 1;'].join('\n'))).toBe(false);
    expect(touchesRuleTable('const merchantRulesCount = 3;')).toBe(false);
    expect(touchesRuleTable('const n = plan.merchantRules;')).toBe(false);
  });

  it('the file allow-list check fails on a file that is not on it', () => {
    // Same detector the first describe block runs over every file in src/, run over one line of
    // constructed source: a new surface reaching for a rule-authoring helper is seen.
    const rogue = 'export async function someNewAction() { deleteRule(target.id); }';
    expect(callsAnyHelper(stripComments(rogue))).toBe(true);
    // And the lookbehind that keeps `input.deleteRule` (a flag) from reading as a helper call
    // really is doing its job -- otherwise the check above would fire on clearCategory forever.
    expect(callsAnyHelper('if (input.deleteRule) return;')).toBe(false);
  });
});
