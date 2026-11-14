import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from './db';

/**
 * v1.64.0. The review queue the local AI is asked about (plan 2026-11-12, A7), March 2026, all
 * invented: MAPLE GROCER three uncategorized rows (the newest 2026-03-09, one of them Sam's with a
 * note), FUEL STOP 12 one Bayes guess, STREAMBOX one rule-filed row, a transfer, a split row, a row
 * with no merchant text and an Always ask merchant (CORNER STORE). Two accounts, two people.
 */
export interface AiFixture {
  t: TestDb;
  alex: number;
  sam: number;
  joint: number;
  samCard: number;
  groceries: number;
  gas: number;
  rows: { mapleOld: number; mapleNewest: number; mapleNoted: number; fuel: number; stream: number; transfer: number; split: number; blank: number; corner: number };
}

export const FIXTURE_NOTE = 'cake for the party';

export function buildAiFixture(): AiFixture {
  const t = createSeededTestDb();
  const alex = insertTestUser(t.db, { name: 'Alex', username: 'alex', role: 'admin' });
  const sam = insertTestUser(t.db, { name: 'Sam', username: 'sam', role: 'member' });
  const joint = insertTestAccount(t.db, { name: 'Maple Joint Chequing', institution: 'Example Credit Union' });
  const samCard = insertTestAccount(t.db, { name: 'Sam Rewards Visa', institution: 'Example Bank', type: 'credit', ownerUserId: sam });
  const groceries = categoryIdByName(t.db, 'Groceries');
  const gas = categoryIdByName(t.db, 'Gas');
  const subscriptions = categoryIdByName(t.db, 'Subscriptions');

  const insert = t.sqlite.prepare(
    `insert into transactions (account_id, attributed_user_id, date, raw_description, normalized_merchant, amount_cents,
       category_id, categorization_source, is_transfer, notes, created_by, created_at, updated_at)
     values (@account, @person, @date, @raw, @merchant, @cents, @category, @source, @transfer, @notes, @by,
       '2026-03-10T12:00:00.000Z', '2026-03-10T12:00:00.000Z')`,
  );
  const add = (row: {
    account?: number;
    person?: number | null;
    date: string;
    raw: string;
    merchant: string;
    cents: number;
    category?: number | null;
    source?: string;
    transfer?: number;
    notes?: string | null;
  }) =>
    Number(
      insert.run({
        account: row.account ?? joint,
        person: row.person ?? null,
        date: row.date,
        raw: row.raw,
        merchant: row.merchant,
        cents: row.cents,
        category: row.category ?? null,
        source: row.source ?? 'none',
        transfer: row.transfer ?? 0,
        notes: row.notes ?? null,
        by: alex,
      }).lastInsertRowid,
    );

  const rows = {
    mapleOld: add({ date: '2026-03-02', raw: 'MAPLE GROCER #12', merchant: 'MAPLE GROCER', cents: -6309 }),
    mapleNewest: add({ date: '2026-03-09', raw: 'MAPLE GROCER 0042', merchant: 'MAPLE GROCER', cents: -4217 }),
    mapleNoted: add({ account: samCard, person: sam, date: '2026-03-05', raw: 'MAPLE GROCER 0042', merchant: 'MAPLE GROCER', cents: -1850, notes: FIXTURE_NOTE }),
    fuel: add({ date: '2026-03-08', raw: 'FUEL STOP 12', merchant: 'FUEL STOP 12', cents: -5500, category: gas, source: 'bayes' }),
    stream: add({ date: '2026-03-07', raw: 'STREAMBOX MONTHLY', merchant: 'STREAMBOX', cents: -1699, category: subscriptions, source: 'rule' }),
    transfer: add({ date: '2026-03-06', raw: 'TRANSFER TO SAVINGS', merchant: 'TRANSFER TO SAVINGS', cents: -20000, transfer: 1 }),
    split: add({ date: '2026-03-04', raw: 'BULK BARN 7', merchant: 'BULK BARN', cents: -9000 }),
    blank: add({ date: '2026-03-03', raw: '0000', merchant: '', cents: -100 }),
    corner: add({ date: '2026-03-09', raw: 'CORNER STORE 3', merchant: 'CORNER STORE', cents: -799 }),
  };
  const part = t.sqlite.prepare(
    `insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (?, ?, ?, '2026-03-10T12:00:00.000Z')`,
  );
  part.run(rows.split, groceries, -6000);
  part.run(rows.split, gas, -3000);
  t.sqlite
    .prepare(
      `insert into merchant_rules (pattern, match_type, rule_kind, created_by, created_at) values ('CORNER STORE', 'exact', 'always_ask', ?, '2026-03-01T00:00:00.000Z')`,
    )
    .run(alex);
  return { t, alex, sam, joint, samCard, groceries, gas, rows };
}
