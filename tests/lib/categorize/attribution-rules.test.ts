import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import {
  applyRuleNow,
  clearRuleFromTransactions,
  previewRuleReapply,
  ruleClearIds,
  ruleImpactCounts,
  ruleImpactIds,
  runEngine,
} from '@/lib/categorize/engine';
import {
  listRules,
  matchRule,
  matchTypeAllowedForKind,
  ruleOutcomeMissing,
  upsertRuleFromCorrection,
  WORD_MATCH_KIND_ERROR,
} from '@/lib/categorize/rules';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function fixture() {
  current = createSeededTestDb();
  const admin = insertTestUser(current.db, { role: 'admin', name: 'Alex' });
  const other = insertTestUser(current.db, { role: 'member', name: 'Sam' });
  const accountId = insertTestAccount(current.db, { ownerUserId: admin });
  const add = (rawDescription: string, amountCents = -4500, attributedUserId: number | null = admin) => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents,
                                categorization_source, attributed_user_id, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', ${rawDescription}, ${normalizeMerchant(rawDescription)}, ${amountCents},
              'none', ${attributedUserId}, ${admin}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { admin, other, accountId, add };
}

function personOf(txnId: number): number | null {
  return current!.db.get<{ attributedUserId: number | null }>(
    sql`select attributed_user_id as attributedUserId from transactions where id = ${txnId}`,
  ).attributedUserId;
}

function rule(input: { pattern: string; attributedUserId: number | null; matchType?: 'exact' | 'contains'; min?: number; max?: number }) {
  const result = upsertRuleFromCorrection({
    pattern: input.pattern,
    matchType: input.matchType ?? 'exact',
    ruleKind: 'attribution',
    categoryId: null,
    attributedUserId: input.attributedUserId,
    amountMinCents: input.min ?? null,
    amountMaxCents: input.max ?? null,
    createdBy: null,
    actorRole: 'admin',
  });
  if (!result.ok) throw new Error(`unexpected refusal: ${result.reason}`);
  return result.ruleId;
}

/**
 * The owner, 2026-09-13: "think about person too so its not just on vendor rule, even sets
 * household, or individual person."
 *
 * A rule could say what a charge IS (a category) but never WHOSE it is. Attribution was decided
 * once, at import, by the per-card map or else the account's owner, and after that only by hand.
 *
 * Spec: docs/superpowers/specs/2026-09-13-vendor-amount-person-rules-design.md, rulings P8-P12.
 */
describe('the attribution rule kind', () => {
  it('carries a person, and the kind alone is a complete outcome when that person is Household', () => {
    current = createSeededTestDb();
    // NULL here is HOUSEHOLD -- the same thing NULL already means in transactions, so there is no
    // third state. ruleOutcomeMissing must therefore say this row is complete, exactly as it
    // already does for transfer and not_transfer.
    expect(ruleOutcomeMissing({ ruleKind: 'attribution', categoryId: null, renameTo: null })).toBe(false);
  });

  it('refuses a whole-word attribution rule, as it does for the transfer kinds', () => {
    expect(matchTypeAllowedForKind('word', 'attribution')).toBe(false);
    current = createSeededTestDb();
    expect(() =>
      upsertRuleFromCorrection({
        pattern: 'GYM', matchType: 'word', ruleKind: 'attribution', categoryId: null,
        attributedUserId: null, createdBy: null, actorRole: 'admin',
      }),
    ).toThrow(WORD_MATCH_KIND_ERROR);
  });

  it('refuses a person on any other kind, which would be a second outcome on one row', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db);
    expect(() =>
      upsertRuleFromCorrection({
        pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'transfer', categoryId: null,
        attributedUserId: user, createdBy: null, actorRole: 'admin',
      }),
    ).toThrow(/attribution/i);
  });

  it('lives alongside a category rule on the same merchant, because the kind is part of the key', () => {
    const { other } = fixture();
    rule({ pattern: 'SAMS GYM', attributedUserId: other });
    upsertRuleFromCorrection({
      pattern: 'SAMS GYM', matchType: 'exact', ruleKind: 'category', categoryId: 1,
      createdBy: null, actorRole: 'admin',
    });
    expect(listRules().length).toBe(2);
  });

  it('can carry an amount window, so one merchant can name two people by premium', () => {
    const { admin, other } = fixture();
    const his = rule({ pattern: 'ACME INSURANCE', attributedUserId: admin, min: 12500, max: 15500 });
    const hers = rule({ pattern: 'ACME INSURANCE', attributedUserId: other, min: 25000, max: 32000 });
    const rules = listRules('attribution');
    expect(matchRule('ACME INSURANCE', 'attribution', rules, -14012)?.id).toBe(his);
    expect(matchRule('ACME INSURANCE', 'attribution', rules, -28000)?.id).toBe(hers);
  });
});

describe('what an attribution rule affects, and what "Apply now" does', () => {
  it('counts the rows whose person DIFFERS from what it would set, which is what applying changes', () => {
    const { admin, other, add } = fixture();
    const mine = add('SAMS GYM MONTREAL', -4500, admin);
    const already = add('SAMS GYM MONTREAL', -4500, other);
    const ruleId = rule({ pattern: 'SAMS GYM', attributedUserId: other, matchType: 'contains' });

    expect(ruleImpactCounts().get(ruleId) ?? 0).toBe(1);
    expect(ruleImpactIds(ruleId)).toEqual([mine]);
    expect(already).toBeGreaterThan(0);
  });

  it('never counts a transfer, which belongs to no one in particular', () => {
    const { other, add } = fixture();
    const txnId = add('CC PAYMENT SAMS GYM', 25000, null);
    current!.db.run(sql`update transactions set is_transfer = 1 where id = ${txnId}`);
    const ruleId = rule({ pattern: 'SAMS GYM', attributedUserId: other, matchType: 'contains' });
    expect(ruleImpactCounts().get(ruleId) ?? 0).toBe(0);
  });

  it('sets the person on exactly those rows when applied', () => {
    const { admin, other, add } = fixture();
    const mine = add('SAMS GYM MONTREAL', -4500, admin);
    const unrelated = add('THE COFFEE HOUSE', -500, admin);
    const ruleId = rule({ pattern: 'SAMS GYM', attributedUserId: other, matchType: 'contains' });

    const result = applyRuleNow(ruleId);

    expect(result.changed).toBe(1);
    expect(personOf(mine)).toBe(other);
    expect(personOf(unrelated)).toBe(admin);
  });

  it('sets Household, which is how a rule stops the card map and the account owner deciding', () => {
    const { admin, add } = fixture();
    const txnId = add('JOINT GYM MONTREAL', -4500, admin);
    const ruleId = rule({ pattern: 'JOINT GYM', attributedUserId: null, matchType: 'contains' });

    applyRuleNow(ruleId);

    expect(personOf(txnId)).toBeNull();
  });

  it('previews the same number it then changes', () => {
    const { admin, other, add } = fixture();
    add('SAMS GYM MONTREAL', -4500, admin);
    add('SAMS GYM LAVAL', -4500, admin);
    const ruleId = rule({ pattern: 'SAMS GYM', attributedUserId: other, matchType: 'contains' });

    expect(previewRuleReapply(ruleId).eligible).toBe(2);
    expect(applyRuleNow(ruleId).changed).toBe(2);
    // Applied twice, the second pass has nothing left to do -- the count is what WOULD change, not
    // how many rows the pattern reaches.
    expect(previewRuleReapply(ruleId).eligible).toBe(0);
  });

  /**
   * Ruling P10: never inside runEngine. ELIGIBLE protects a human CATEGORY decision through
   * categorization_source; attributed_user_id has no source column, so a re-run could not tell a
   * person somebody set by hand from the account-owner fallback and would overwrite the hand edit.
   * The owner asked for exactly this: "they dont have to be automatic".
   */
  it('is never applied by a plain engine run', () => {
    const { admin, other, add } = fixture();
    const txnId = add('SAMS GYM MONTREAL', -4500, admin);
    rule({ pattern: 'SAMS GYM', attributedUserId: other, matchType: 'contains' });

    runEngine([txnId]);

    expect(personOf(txnId)).toBe(admin);
  });
});

/**
 * Ruling P12. For a category rule, clearing means UNCATEGORIZED -- a real "undecided" state that
 * Needs review picks back up. NULL attribution is not undecided; it is Household. And nothing
 * anywhere records what the row carried before, so "put it back" is not information this
 * application has. Delete-only, exactly as for not_transfer.
 */
describe('clearing an attribution rule is refused, not silently wrong', () => {
  it('has no rows to clear', () => {
    const { admin, other, add } = fixture();
    add('SAMS GYM MONTREAL', -4500, admin);
    const ruleId = rule({ pattern: 'SAMS GYM', attributedUserId: other, matchType: 'contains' });
    applyRuleNow(ruleId);
    expect(ruleClearIds(ruleId)).toEqual([]);
  });

  it('writes nothing when a stale form reaches the clear path anyway', () => {
    const { admin, other, add } = fixture();
    const txnId = add('SAMS GYM MONTREAL', -4500, admin);
    const ruleId = rule({ pattern: 'SAMS GYM', attributedUserId: other, matchType: 'contains' });
    applyRuleNow(ruleId);

    expect(clearRuleFromTransactions({ ruleId })).toEqual({ rowsCleared: 0 });
    expect(personOf(txnId)).toBe(other);
  });
});
