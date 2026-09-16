import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { commitImport } from '@/lib/import/commit';
import { computeRowHashes } from '@/lib/import/dedup';
import { upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { resolveAttribution } from '@/lib/attribution';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function rows(input: { description: string; amountCents: number; cells?: string[] }[], accountId: number) {
  return computeRowHashes(
    accountId,
    input.map((row, index) => ({
      rowIndex: index,
      rawDate: '2026-03-02',
      date: '2026-03-02',
      rawDescription: row.description,
      amountCents: row.amountCents,
      balanceCents: null,
      cells: row.cells ?? [],
    })),
  );
}

function personOf(txnId: number): number | null {
  return current!.db.get<{ attributedUserId: number | null }>(
    sql`select attributed_user_id as attributedUserId from transactions where id = ${txnId}`,
  ).attributedUserId;
}

/**
 * The owner, 2026-09-13: "think about person too so its not just on vendor rule, even sets
 * household, or individual person."
 *
 * Ruling P17: the order is written ONCE, here, rather than inline in commitImport's closure --
 * because it is the sentence three surfaces have to agree on. Ruling P11 decides the order
 * itself.
 */
describe('resolveAttribution: rule, then card, then the account owner', () => {
  it('takes the rule when there is one, over the card and the report alike', () => {
    expect(resolveAttribution({ ruleUserId: 7, ruleMatched: true, cardUserId: 3, ownerUserId: 1 })).toEqual({
      userId: 7,
      source: 'rule',
    });
  });

  /**
   * A rule naming HOUSEHOLD is the whole point of the Household option: it stops the fallback
   * chain rather than falling through it. Distinguished from "no rule matched" by ruleMatched,
   * because both carry a null user id and they mean opposite things.
   */
  it('honours a rule that names Household, rather than falling through to the card', () => {
    expect(resolveAttribution({ ruleUserId: null, ruleMatched: true, cardUserId: 3, ownerUserId: 1 })).toEqual({
      userId: null,
      source: 'rule',
    });
  });

  it('falls to the card when no rule matched', () => {
    expect(resolveAttribution({ ruleUserId: null, ruleMatched: false, cardUserId: 3, ownerUserId: 1 })).toEqual({
      userId: 3,
      source: 'card',
    });
  });

  it('falls to the account owner when neither a rule nor the card says anything', () => {
    expect(resolveAttribution({ ruleUserId: null, ruleMatched: false, cardUserId: null, ownerUserId: 1 })).toEqual({
      userId: 1,
      source: 'owner',
    });
  });

  /** An account with no owner yields NULL, which it already did before any of this existed. */
  it('ends at nobody when the account has no owner either', () => {
    expect(resolveAttribution({ ruleUserId: null, ruleMatched: false, cardUserId: null, ownerUserId: null })).toEqual({
      userId: null,
      source: 'owner',
    });
  });
});

describe('an attribution rule at import time', () => {
  function setup() {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', role: 'admin' });
    const sam = insertTestUser(current.db, { name: 'Sam', role: 'member' });
    const accountId = insertTestAccount(current.db, { ownerUserId: alex });
    return { alex, sam, accountId };
  }

  it('puts the row on the rule person rather than the account owner', () => {
    const { alex, sam, accountId } = setup();
    upsertRuleFromCorrection({
      pattern: 'SAMS GYM', matchType: 'contains', ruleKind: 'attribution', categoryId: null,
      attributedUserId: sam, createdBy: alex, actorRole: 'admin',
    });

    const result = commitImport({
      accountId, profileId: null, filename: 'march.csv', importedBy: alex,
      rows: rows([{ description: 'SAMS GYM MONTREAL', amountCents: -4500 }], accountId),
      errors: [],
    });

    expect(personOf(result.insertedTransactionIds[0]!)).toBe(sam);
  });

  it('respects the rule amount window, so the other policy still goes to the owner', () => {
    const { alex, sam, accountId } = setup();
    upsertRuleFromCorrection({
      pattern: 'ACME INSURANCE', matchType: 'exact', ruleKind: 'attribution', categoryId: null,
      attributedUserId: sam, amountMinCents: 12500, amountMaxCents: 15500,
      createdBy: alex, actorRole: 'admin',
    });

    const result = commitImport({
      accountId, profileId: null, filename: 'march.csv', importedBy: alex,
      rows: rows(
        [
          { description: 'ACME INSURANCE', amountCents: -14012 },
          { description: 'ACME INSURANCE', amountCents: -8940 },
        ],
        accountId,
      ),
      errors: [],
    });

    expect(personOf(result.insertedTransactionIds[0]!)).toBe(sam);
    expect(personOf(result.insertedTransactionIds[1]!)).toBe(alex);
  });

  /**
   * Ruling P11/Q7: a rule names a merchant and an amount; a card map names a whole account. The
   * specific beats the general, so a payment for Sam's policy charged to Alex's card lands on Sam.
   */
  it('beats the per-card map, which names a whole card rather than this charge', () => {
    const { alex, sam, accountId } = setup();
    current!.db.run(
      sql`insert into account_card_people (account_id, card_value, user_id, created_at)
          values (${accountId}, '1234', ${alex}, '2026-01-01T00:00:00.000Z')`,
    );
    upsertRuleFromCorrection({
      pattern: 'SAMS GYM', matchType: 'contains', ruleKind: 'attribution', categoryId: null,
      attributedUserId: sam, createdBy: alex, actorRole: 'admin',
    });

    const result = commitImport({
      accountId, profileId: null, filename: 'march.csv', importedBy: alex,
      mapping: { dateCol: 0, descCol: 1, amountCol: 2, cardCol: 3 } as never,
      rows: rows([{ description: 'SAMS GYM MONTREAL', amountCents: -4500, cells: ['2026-03-02', 'SAMS GYM MONTREAL', '-45.00', '1234'] }], accountId),
      errors: [],
    });

    expect(personOf(result.insertedTransactionIds[0]!)).toBe(sam);
  });

  /**
   * The summary is what the household reads after an import. Counting a rule match as a card
   * fallback would make it say "1 row to the account owner (no card match)" about a row that went
   * somewhere else entirely.
   */
  it('says how many rows a rule decided, rather than filing them under the card fallback', () => {
    const { alex, sam, accountId } = setup();
    current!.db.run(
      sql`insert into account_card_people (account_id, card_value, user_id, created_at)
          values (${accountId}, '1234', ${alex}, '2026-01-01T00:00:00.000Z')`,
    );
    upsertRuleFromCorrection({
      pattern: 'SAMS GYM', matchType: 'contains', ruleKind: 'attribution', categoryId: null,
      attributedUserId: sam, createdBy: alex, actorRole: 'admin',
    });

    const result = commitImport({
      accountId, profileId: null, filename: 'march.csv', importedBy: alex,
      mapping: { dateCol: 0, descCol: 1, amountCol: 2, cardCol: 3 } as never,
      rows: rows(
        [
          { description: 'SAMS GYM MONTREAL', amountCents: -4500, cells: ['2026-03-02', 'SAMS GYM MONTREAL', '-45.00', '1234'] },
          { description: 'THE COFFEE HOUSE', amountCents: -500, cells: ['2026-03-02', 'THE COFFEE HOUSE', '-5.00', '1234'] },
        ],
        accountId,
      ),
      errors: [],
    });

    expect(result.attributionSummary).toContain('by rule');
  });

  it('leaves every row where it was when the household has no attribution rule at all', () => {
    const { alex, accountId } = setup();
    const result = commitImport({
      accountId, profileId: null, filename: 'march.csv', importedBy: alex,
      rows: rows([{ description: 'THE COFFEE HOUSE', amountCents: -500 }], accountId),
      errors: [],
    });
    expect(personOf(result.insertedTransactionIds[0]!)).toBe(alex);
    expect(result.attributionSummary).toBeNull();
  });
});
