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
 * Reported 2026-09-13: a rule should be able to name a person too, not only a vendor, and even
 * set household or an individual person.
 *
 * Ruling P17: the order is written ONCE, here, rather than inline in commitImport's closure --
 * because it is the sentence three surfaces have to agree on. Ruling P11 decided the order; v1.59.0
 * reversed its first half, so a linked card holder now comes before any rule.
 */
describe('resolveAttribution: the card holder, then a rule, then the account owner', () => {
  it('takes a linked card over a person rule', () => {
    expect(resolveAttribution({ ruleUserId: 7, ruleMatched: true, cardUserId: 3, ownerUserId: 1 })).toEqual({
      userId: 3,
      source: 'card',
    });
  });

  it('takes a linked card over a Household rule as well', () => {
    expect(resolveAttribution({ ruleUserId: null, ruleMatched: true, cardUserId: 3, ownerUserId: 1 })).toEqual({
      userId: 3,
      source: 'card',
    });
  });

  it('takes the rule when no card is linked', () => {
    expect(resolveAttribution({ ruleUserId: 7, ruleMatched: true, cardUserId: null, ownerUserId: 1 })).toEqual({
      userId: 7,
      source: 'rule',
    });
  });

  /**
   * A rule naming HOUSEHOLD still stops the chain before the account owner: that is the whole
   * point of the Household option. Distinguished from "no rule matched" by ruleMatched, because
   * both carry a null user id and they mean opposite things.
   */
  it('honours a rule that names Household, rather than falling through to the owner', () => {
    expect(resolveAttribution({ ruleUserId: null, ruleMatched: true, cardUserId: null, ownerUserId: 1 })).toEqual({
      userId: null,
      source: 'rule',
    });
  });

  it('falls to the account owner when neither a card nor a rule says anything', () => {
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
   * v1.59.0, P11 reversed: a linked card names who held the card the charge was made on, so it
   * beats a person rule for the same row.
   */
  it('loses to a linked card, which names who actually spent it', () => {
    const { alex, sam, accountId } = setup();
    current!.db.run(
      sql`insert into account_card_people (account_id, card_value, user_id, created_at)
          values (${accountId}, 'CARD 1001', ${alex}, '2026-01-01T00:00:00.000Z')`,
    );
    upsertRuleFromCorrection({
      pattern: 'MAPLE GROCER', matchType: 'contains', ruleKind: 'attribution', categoryId: null,
      attributedUserId: sam, createdBy: alex, actorRole: 'admin',
    });

    const result = commitImport({
      accountId, profileId: null, filename: 'march.csv', importedBy: alex,
      mapping: { dateCol: 0, descCol: 1, amountCol: 2, cardCol: 3 } as never,
      rows: rows([{ description: 'MAPLE GROCER 12', amountCents: -4500, cells: ['2026-03-02', 'MAPLE GROCER 12', '-45.00', 'CARD 1001'] }], accountId),
      errors: [],
    });

    expect(personOf(result.insertedTransactionIds[0]!)).toBe(alex);
  });

  it('a Household rule loses to a linked card too', () => {
    const { alex, sam, accountId } = setup();
    current!.db.run(
      sql`insert into account_card_people (account_id, card_value, user_id, created_at)
          values (${accountId}, 'CARD 1001', ${sam}, '2026-01-01T00:00:00.000Z')`,
    );
    upsertRuleFromCorrection({
      pattern: 'MAPLE GROCER', matchType: 'contains', ruleKind: 'attribution', categoryId: null,
      attributedUserId: null, createdBy: alex, actorRole: 'admin',
    });

    const result = commitImport({
      accountId, profileId: null, filename: 'march.csv', importedBy: alex,
      mapping: { dateCol: 0, descCol: 1, amountCol: 2, cardCol: 3 } as never,
      rows: rows([{ description: 'MAPLE GROCER 12', amountCents: -4500, cells: ['2026-03-02', 'MAPLE GROCER 12', '-45.00', 'CARD 1001'] }], accountId),
      errors: [],
    });

    expect(personOf(result.insertedTransactionIds[0]!)).toBe(sam);
  });

  it('still decides a row whose card value is blank or linked to nobody', () => {
    const { alex, sam, accountId } = setup();
    current!.db.run(
      sql`insert into account_card_people (account_id, card_value, user_id, created_at)
          values (${accountId}, 'CARD 1001', ${alex}, '2026-01-01T00:00:00.000Z')`,
    );
    upsertRuleFromCorrection({
      pattern: 'MAPLE GROCER', matchType: 'contains', ruleKind: 'attribution', categoryId: null,
      attributedUserId: sam, createdBy: alex, actorRole: 'admin',
    });

    const result = commitImport({
      accountId, profileId: null, filename: 'march.csv', importedBy: alex,
      mapping: { dateCol: 0, descCol: 1, amountCol: 2, cardCol: 3 } as never,
      rows: rows(
        [
          { description: 'MAPLE GROCER 12', amountCents: -4500, cells: ['2026-03-02', 'MAPLE GROCER 12', '-45.00', ''] },
          { description: 'MAPLE GROCER 14', amountCents: -2500, cells: ['2026-03-02', 'MAPLE GROCER 14', '-25.00', 'CARD 2002'] },
        ],
        accountId,
      ),
      errors: [],
    });

    expect(personOf(result.insertedTransactionIds[0]!)).toBe(sam);
    expect(personOf(result.insertedTransactionIds[1]!)).toBe(sam);
  });

  /**
   * The summary is what the household reads after an import. Counting a rule match as a card
   * fallback would make it say "1 row to the account owner (no card match)" about a row that went
   * somewhere else entirely; counting a card match as a rule would hide whose card it was.
   */
  it('says how many rows a rule decided, apart from the card holder and the fallback', () => {
    const { alex, sam, accountId } = setup();
    current!.db.run(
      sql`insert into account_card_people (account_id, card_value, user_id, created_at)
          values (${accountId}, 'CARD 1001', ${alex}, '2026-01-01T00:00:00.000Z')`,
    );
    upsertRuleFromCorrection({
      pattern: 'MAPLE GROCER', matchType: 'contains', ruleKind: 'attribution', categoryId: null,
      attributedUserId: sam, createdBy: alex, actorRole: 'admin',
    });

    const result = commitImport({
      accountId, profileId: null, filename: 'march.csv', importedBy: alex,
      mapping: { dateCol: 0, descCol: 1, amountCol: 2, cardCol: 3 } as never,
      rows: rows(
        [
          // A rule and the linked card both match: the card holder wins.
          { description: 'MAPLE GROCER 12', amountCents: -4500, cells: ['2026-03-02', 'MAPLE GROCER 12', '-45.00', 'CARD 1001'] },
          // No card value at all: the rule decides.
          { description: 'MAPLE GROCER 14', amountCents: -2500, cells: ['2026-03-02', 'MAPLE GROCER 14', '-25.00', ''] },
          { description: 'FUEL STOP 12', amountCents: -500, cells: ['2026-03-02', 'FUEL STOP 12', '-5.00', 'CARD 1001'] },
        ],
        accountId,
      ),
      errors: [],
    });

    expect(result.attributionSummary).toBe('2 rows to Alex, 1 row by rule');
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
