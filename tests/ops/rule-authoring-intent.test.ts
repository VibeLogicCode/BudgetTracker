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
 *
 * Every detector below is a pure function of source TEXT, so the last describe block can run each
 * one over a deliberately broken snippet constructed inside the test and prove it reports the
 * offence. That block is not decoration: a guard that cannot fail reads as protection while
 * providing none, which is worse than no guard at all.
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
 * Helpers that CHANGE WHAT A RULE SAYS ABOUT A MERCHANT. All five live in
 * src/lib/categorize/rules.ts, which is the only file that touches the merchant_rules table.
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
 */
function exportedFunctions(source: string): { name: string; signature: string; body: string }[] {
  const bare = stripComments(source);
  const result: { name: string; signature: string; body: string }[] = [];
  const re = /^export function (\w+)\s*\(/gm;
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

/** DETECTOR 1 (rule 2): which exported functions in a file can author a merchant rule. */
function ruleAuthoringPaths(source: string): string[] {
  return exportedFunctions(source)
    .filter((fn) => callsAnyHelper(fn.body))
    .map((fn) => fn.name)
    .sort();
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
