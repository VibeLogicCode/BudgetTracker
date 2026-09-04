import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import {
  clearRuleFromTransactions,
  previewRuleReapply,
  ruleClearIds,
  ruleImpactCounts,
  ruleImpactIds,
  runEngine,
  upsertRenameRule,
} from '@/lib/categorize/engine';
import { matchTypeAllowedForKind, upsertRuleFromCorrection, type MatchType, type RuleKind } from '@/lib/categorize/rules';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';

/**
 * THE GOVERNING PROPERTY, and the only thing this file protects:
 *
 *   FOR EVERY (match type, rule kind) PAIR THE APP ACCEPTS, THE FOUR ATTRIBUTION SURFACES MUST
 *   RESOLVE A ROW THE WAY THE ENGINE REALLY MATCHES IT -- BY SIMULATING THE MATCH, NEVER BY
 *   ASSUMING A MATCH TYPE.
 *
 * The four: eligibleForRuleReapply (which rows "Apply now" may touch, reached here through
 * previewRuleReapply), ruleImpactCounts (the "Affects" column), ruleImpactIds (the ids behind that
 * number, which the confirm dialog states) and ruleClearIds (the rows a CLEAR actually writes to).
 *
 * v1.31.0 review finding R-01 (P1) is why this exists. matchTypeAllowedForKind refuses exactly one
 * combination -- 'word' on a transfer kind -- so the rules form and the pack importer have always
 * accepted a `contains` transfer rule, and matchRule has always fired it as a substring match. All
 * four functions nonetheless looked their rows up by `normalized_merchant = rule.pattern`, on the
 * strength of six docblocks asserting an invariant that nothing enforced. The visible damage was
 * the delete-and-clear button: it previewed the exact-text rows, un-flagged only those, and left
 * every substring-matched row still flagged as a transfer -- excluded from every report and every
 * budget -- with the rule gone and nothing left to attribute it to.
 *
 * A guard was chosen over trusting the fix because the shortcut was not a slip: it was argued for,
 * at length, in the docblock of every function that took it. The next person to add a match type,
 * or to widen a kind, will read those same functions.
 *
 * SHAPE. The primary check is a PROPERTY, not a grep: the pair list is derived from
 * matchTypeAllowedForKind itself, so a newly-allowed combination fails here until somebody proves
 * attribution handles it. The unions are enumerated through `satisfies Record<..., true>`, so
 * adding a member to MatchType or RuleKind breaks THIS FILE'S COMPILE -- `npx tsc --noEmit` is
 * part of the guard. The source-text check at the bottom is a backstop and says plainly what it
 * cannot catch.
 */

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/**
 * Exhaustive by construction: `satisfies Record<MatchType, true>` fails to compile the moment the
 * union grows, which is the point -- a fourth match type must not be able to reach the rules form
 * without somebody deciding what attribution does with it.
 */
const ALL_MATCH_TYPES = Object.keys({
  exact: true,
  contains: true,
  word: true,
} satisfies Record<MatchType, true>) as MatchType[];

const ALL_RULE_KINDS = Object.keys({
  category: true,
  transfer: true,
  rename: true,
  not_transfer: true,
} satisfies Record<RuleKind, true>) as RuleKind[];

/**
 * Every pair the app accepts whose match type is NOT `exact`. `exact` is excluded because it is
 * the degenerate case the shortcut got right by accident -- a rule whose pattern IS the merchant
 * text. Everything else is a rule that fires on text it does not equal, which is precisely what
 * attribution has to simulate rather than assume.
 */
const INEXACT_PAIRS = ALL_RULE_KINDS.flatMap((kind) =>
  ALL_MATCH_TYPES.filter((matchType) => matchType !== 'exact' && matchTypeAllowedForKind(matchType, kind)).map(
    (matchType) => ({ matchType, kind }),
  ),
);

/**
 * A per-kind exemption, which must carry its argument rather than merely being listed -- the
 * precedent set by tests/ops/rule-authoring-intent.test.ts, where every allowance states why.
 */
type Expectation = { attributes: true } | { attributes: false; why: string };

interface Scenario {
  /** Creates the rule and one transaction whose merchant CONTAINS the pattern without equalling it. */
  build: () => { ruleId: number; txnId: number; merchant: string };
  /**
   * Puts the rule's effect ON the row, for the kinds whose work is still ahead of them when the
   * rule is saved. A category or transfer rule needs a run; a rename applies itself on save, and
   * the not_transfer scenario has already run the engine to get a row worth releasing.
   */
  apply?: (txnId: number) => void;
  /** What "Apply now" should scope to before that, and why if it should scope to nothing. */
  reapply: Expectation;
  /** What a CLEAR should write to after it, and why if it must write to nothing. */
  clear: Expectation;
  /**
   * How many rows still carry what this rule gave them. Zero after a clear, and the count has to
   * be kind-specific: "cleared" means uncategorized for a category rule, unflagged for a transfer
   * rule and back to the bank's own text for a rename.
   */
  residue: (txnId: number) => number;
}

const countRows = (where: string, txnId: number): number =>
  (current!.sqlite.prepare(`select count(*) as c from transactions where id = ? and ${where}`).get(txnId) as { c: number })
    .c;

function fixture() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db);
  const accountId = insertTestAccount(current.db);
  const add = (rawDescription: string, amountCents = -1000, date = '2026-03-02') => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, ${date}, ${rawDescription}, ${normalizeMerchant(rawDescription)}, ${amountCents}, 'none', ${userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { db: current.db, sqlite: current.sqlite, userId, add };
}

const SCENARIOS: ReadonlyMap<RuleKind, Scenario> = new Map<RuleKind, Scenario>([
  [
    'category',
    {
      build: () => {
        const { db, userId, add } = fixture();
        const txnId = add('THE COFFEE HOUSE DOWNTOWN');
        const rule = upsertRuleFromCorrection({
          pattern: 'COFFEE HOUSE', matchType: 'contains', ruleKind: 'category',
          categoryId: categoryIdByName(db, 'Coffee'), createdBy: userId, actorRole: 'admin',
        });
        if (!rule.ok) throw new Error('unexpected refusal');
        return { ruleId: rule.ruleId, txnId, merchant: 'THE COFFEE HOUSE DOWNTOWN' };
      },
      apply: (txnId) => void runEngine([txnId]),
      reapply: { attributes: true },
      clear: { attributes: true },
      residue: (txnId) => countRows('category_id is not null', txnId),
    },
  ],
  [
    'transfer',
    {
      build: () => {
        const { userId, add } = fixture();
        const txnId = add('CC PAYMENT RECEIVED', 25000);
        const rule = upsertRuleFromCorrection({
          pattern: 'PAYMENT', matchType: 'contains', ruleKind: 'transfer',
          categoryId: null, createdBy: userId, actorRole: 'admin',
        });
        if (!rule.ok) throw new Error('unexpected refusal');
        return { ruleId: rule.ruleId, txnId, merchant: 'CC PAYMENT RECEIVED' };
      },
      apply: (txnId) => void runEngine([txnId]),
      reapply: { attributes: true },
      clear: { attributes: true },
      residue: (txnId) => countRows('is_transfer = 1', txnId),
    },
  ],
  [
    'not_transfer',
    {
      build: () => {
        const { userId, add } = fixture();
        // The card-payment list flags this one on its own; the override is what releases it.
        const txnId = add('VISA PAYMENT MONTREAL', 40000);
        runEngine([txnId]);
        const rule = upsertRuleFromCorrection({
          pattern: 'VISA PAYMENT', matchType: 'contains', ruleKind: 'not_transfer',
          categoryId: null, createdBy: userId, actorRole: 'admin',
        });
        if (!rule.ok) throw new Error('unexpected refusal');
        return { ruleId: rule.ruleId, txnId, merchant: 'VISA PAYMENT MONTREAL' };
      },
      reapply: { attributes: true },
      clear: {
        attributes: false,
        why:
          'Clearing a not_transfer override would mean re-flagging its rows AS transfers, which is ' +
          'not a revert but a stronger positive claim -- and transfers are excluded from every ' +
          'report and budget, so it would silently move money out of every total. ruleClearIds ' +
          'returns [] for this kind and deleteRuleAndClearAction refuses it outright. The ' +
          'attribution surfaces above still have to be right, which is what this row checks.',
      },
      residue: (txnId) => countRows('is_transfer = 1', txnId),
    },
  ],
  [
    'rename',
    {
      build: () => {
        const { userId, add } = fixture();
        const txnId = add('MCDONALDS RESTAURANT 88');
        const rule = upsertRenameRule({
          pattern: 'MCDONALDS', matchType: 'contains', renameTo: "McDonald's", userId, actorRole: 'admin',
        });
        if (!rule.ok) throw new Error('unexpected refusal');
        return { ruleId: rule.ruleId, txnId, merchant: 'MCDONALDS RESTAURANT' };
      },
      reapply: {
        attributes: false,
        why:
          'A rename rule is already retroactive on every save, disable and delete (upsertRenameRule / ' +
          'setRuleDisabled / deleteRenameRule all run applyRenameRules), so "Apply now" has nothing ' +
          'left to do that saving the rule did not already do. eligibleForRuleReapply returns [] for ' +
          'this kind before attribution is even reached.',
      },
      clear: { attributes: true },
      residue: (txnId) => countRows("display_source = 'rename'", txnId),
    },
  ],
]);

describe('v1.31.0 R-01: attribution simulates the match for every combination the app accepts', () => {
  it('every inexact (match type, kind) pair the app accepts has a scenario proving attribution', () => {
    const covered = [...SCENARIOS.keys()].sort();
    const accepted = [...new Set(INEXACT_PAIRS.map((pair) => pair.kind))].sort();
    expect(
      accepted,
      'matchTypeAllowedForKind now accepts a (match type, kind) combination no scenario below ' +
        'covers. Add one: create a rule of that kind with that match type, and a transaction whose ' +
        'merchant CONTAINS the pattern without equalling it, then let the checks below run. If you ' +
        'were about to delete the pair instead, read R-01: narrowing the accepted types to make an ' +
        'attribution shortcut true was considered in v1.31.0 and refused, because it leaves the ' +
        'same trap armed for the next type somebody adds.',
    ).toEqual(covered);
    // Non-vacuous: the pair list is derived, so an empty one would pass the equality above.
    expect(INEXACT_PAIRS.length).toBeGreaterThan(0);
  });

  it.each([...SCENARIOS.keys()])(
    'a contains %s rule is attributed the rows it really matches, by all four surfaces',
    (kind) => {
      const scenario = SCENARIOS.get(kind) as Scenario;
      const { ruleId, txnId } = scenario.build();

      // 1. ruleImpactCounts -- the "Affects" column.
      expect({ kind, affects: ruleImpactCounts().get(ruleId) ?? 0 }).toEqual({ kind, affects: 1 });
      // 2. ruleImpactIds -- the ids behind that number.
      expect({ kind, ids: ruleImpactIds(ruleId) }).toEqual({ kind, ids: [txnId] });
      // 3. eligibleForRuleReapply, through its public face.
      expect({ kind, eligible: previewRuleReapply(ruleId).eligible }).toEqual({
        kind,
        eligible: scenario.reapply.attributes ? 1 : 0,
      });

      // 4. ruleClearIds -- the rows the button underneath the number writes to. Asserted AFTER the
      // rule has actually been applied, because for the transfer kind "affects" and "clear" point
      // in opposite directions on purpose (ruleClearIds' docblock): affects is the rows still to be
      // flagged, clear is the rows already flagged, and the two are never the same set at once.
      scenario.apply?.(txnId);
      expect({ kind, clear: ruleClearIds(ruleId) }).toEqual({
        kind,
        clear: scenario.clear.attributes ? [txnId] : [],
      });
    },
  );

  it('the clear path leaves no row still carrying what the rule gave it', () => {
    for (const [kind, scenario] of SCENARIOS) {
      if (!scenario.clear.attributes) continue;
      const { ruleId, txnId } = scenario.build();
      scenario.apply?.(txnId);
      expect({ kind, carrying: scenario.residue(txnId) }).toEqual({ kind, carrying: 1 });

      clearRuleFromTransactions({ ruleId });

      // This is the assertion the P1 failed. It cleared the rows whose merchant text EQUALLED the
      // pattern and left every other matched row carrying the rule's effect with the rule gone --
      // for a transfer rule, still flagged and so out of every report and budget.
      expect({ kind, carrying: scenario.residue(txnId) }).toEqual({ kind, carrying: 0 });
      current?.cleanup();
      current = null;
    }
  });

  it('every exemption states a reason rather than merely being listed', () => {
    const unexplained = [...SCENARIOS.entries()]
      .flatMap(([kind, scenario]) => [
        { kind, at: 'reapply', value: scenario.reapply },
        { kind, at: 'clear', value: scenario.clear },
      ])
      .filter((entry) => entry.value.attributes === false && (entry.value as { why: string }).why.trim().length < 80)
      .map((entry) => `${entry.kind}.${entry.at}`);
    expect(unexplained).toEqual([]);
  });
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENGINE = 'src/lib/categorize/engine.ts';

/** The repo's established stripComments pattern -- engine.ts's docblocks quote the very shortcut
 *  this scans for, at length, and a guard that punishes explaining the defect gets its comments
 *  deleted. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The literal shortcut, in both spellings it shipped in: the SQL one
 * (`eq(transactions.normalizedMerchant, rule.pattern)`) and the JavaScript one
 * (`row.normalizedMerchant === rule.pattern`).
 */
function exactMerchantShortcuts(source: string): string[] {
  const bare = stripComments(source);
  const patterns = [
    /eq\(\s*transactions\.normalizedMerchant\s*,\s*rule\.pattern\s*\)/g,
    /\w+\.normalizedMerchant\s*===\s*rule\.pattern/g,
  ];
  return patterns.flatMap((re) => [...bare.matchAll(re)].map((m) => m[0]));
}

describe('v1.31.0 R-01: the shortcut itself is gone from engine.ts', () => {
  /**
   * A BACKSTOP, AND DELIBERATELY THE WEAKER HALF -- said plainly, because a guard whose limits are
   * unwritten gets trusted for things it does not do. It catches the exact two spellings that
   * shipped, in one file. It does NOT catch: the same lookup written another way (a raw `sql`
   * fragment, a `.pattern` aliased into a local first, a `Map` keyed by pattern the way
   * ruleImpactCounts' old transfer branch was); an attribution shortcut in a NEW file; or any
   * shortcut for a kind other than the two that had one. The property above is what covers those,
   * because it asserts the OUTCOME for every combination the app accepts rather than the absence
   * of a string. This check earns its place only because it names the regression in the form a
   * person re-introducing it would actually type.
   */
  it('neither spelling of `normalized_merchant = rule.pattern` appears in engine.ts', () => {
    expect(
      exactMerchantShortcuts(fs.readFileSync(path.join(root, ENGINE), 'utf8')),
      'Attribution in engine.ts is comparing a transaction merchant against a rule PATTERN again. ' +
        'That is only correct for an exact rule, and matchTypeAllowedForKind accepts `contains` on ' +
        'every kind -- including transfer, where getting it wrong means "Delete rule and clear from ' +
        'transactions" strands substring-matched rows flagged as transfers, out of every report and ' +
        'budget, with the rule deleted. Resolve the row through attributedRuleId instead.',
    ).toEqual([]);
  });

  it('the detector fails on the defect, reconstructed', () => {
    // Non-vacuity: a typo in either regex would leave the check above passing forever while
    // protecting nothing. Both shipped spellings are rebuilt here rather than left in the file.
    const sqlShortcut = [
      'export function ruleClearIds(ruleId: number): number[] {',
      '  return db.select({ id: transactions.id }).from(transactions)',
      '    .where(and(eq(transactions.normalizedMerchant, rule.pattern), eq(transactions.isTransfer, true)))',
      '    .all().map((row) => row.id);',
      '}',
    ].join('\n');
    expect(exactMerchantShortcuts(sqlShortcut)).toHaveLength(1);

    const jsShortcut = 'return eligible.filter((row) => row.normalizedMerchant === rule.pattern).map((row) => row.id);';
    expect(exactMerchantShortcuts(jsShortcut)).toHaveLength(1);

    // ...and prose about the shortcut is not the shortcut.
    const prose = '// row.normalizedMerchant === rule.pattern was the v1.30.0 shortcut, removed in v1.31.0.';
    expect(exactMerchantShortcuts(prose)).toEqual([]);
  });
});
