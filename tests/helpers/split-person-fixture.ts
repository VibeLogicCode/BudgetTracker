import { sql } from 'drizzle-orm';
import type { Viewer } from '@/lib/auth/viewer';
import { createCategory } from '@/lib/categories';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { setTransactionSplits, type SplitPart } from '@/lib/splits';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from './db';

/**
 * v1.63.0 (plan 2026-11-12, Lane A). The one split-person fixture, March 2026, Alex admin, Sam member:
 *
 *   MAPLE GROCER -150.00 on 2026-03-09, Alex's, split into
 *     Groceries -80.00 (follows the transaction),
 *     Dining -40.00 (set to Sam),
 *     Household supplies -30.00 (set to Household);
 *   FUEL STOP 12 -61.30 on 2026-03-12 (Transport), Sam's, unsplit.
 *
 * Household spend 211.30 = Alex 80.00 + Sam 101.30 + Household 30.00.
 *
 * `allFollow: true` writes the same three parts with no person, the shape every split had before
 * 0032: Alex 150.00, Sam 61.30, Household 0.00, the same household 211.30.
 */
export interface SplitPersonFixture {
  t: TestDb;
  alex: number;
  sam: number;
  account: number;
  groceries: number;
  dining: number;
  supplies: number;
  transport: number;
  maple: number;
  fuel: number;
  /** The parts' ids, in the order written. */
  parts: { groceries: number; dining: number; supplies: number };
  admin: Viewer;
  household: (id: number) => Viewer;
  self: (id: number) => Viewer;
  /** Insert one more transaction (unsplit), signed cents, manual source. */
  add: (over: { date: string; description: string; amountCents: number; categoryId: number | null; person: number | null }) => number;
}

export function buildSplitPersonFixture(opts: { allFollow?: boolean } = {}): SplitPersonFixture {
  const t = createSeededTestDb();
  const alex = insertTestUser(t.db, { name: 'Alex', username: 'alex', role: 'admin' });
  const sam = insertTestUser(t.db, { name: 'Sam', username: 'sam', role: 'member' });
  const account = insertTestAccount(t.db, { name: 'Joint chequing', ownerUserId: alex });
  const groceries = categoryIdByName(t.db, 'Groceries');
  const transport = categoryIdByName(t.db, 'Transport');
  const dining = createCategory({ name: 'Dining', parentId: null });
  const supplies = createCategory({ name: 'Household supplies', parentId: null });

  const add: SplitPersonFixture['add'] = (over) =>
    t.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id,
        categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${account}, ${over.date}, ${over.description}, ${normalizeMerchant(over.description)}, ${over.amountCents},
        ${over.categoryId}, 'manual', 0, ${over.person}, ${alex}, ${nowIso()}, ${nowIso()})
      returning id`).id;

  const maple = add({ date: '2026-03-09', description: 'MAPLE GROCER', amountCents: -15000, categoryId: groceries, person: alex });
  const fuel = add({ date: '2026-03-12', description: 'FUEL STOP 12', amountCents: -6130, categoryId: transport, person: sam });

  const split: SplitPart[] = opts.allFollow
    ? [
        { categoryId: groceries, amountCents: -8000 },
        { categoryId: dining, amountCents: -4000 },
        { categoryId: supplies, amountCents: -3000 },
      ]
    : [
        { categoryId: groceries, amountCents: -8000, person: 'follow' },
        { categoryId: dining, amountCents: -4000, person: sam },
        { categoryId: supplies, amountCents: -3000, person: 'household' },
      ];
  setTransactionSplits({ txnId: maple, parts: split, userId: alex });
  const ids = t.db
    .all<{ id: number }>(sql`select id from transaction_splits where txn_id = ${maple} order by id`)
    .map((row) => row.id);

  return {
    t,
    alex,
    sam,
    account,
    groceries,
    dining,
    supplies,
    transport,
    maple,
    fuel,
    parts: { groceries: ids[0], dining: ids[1], supplies: ids[2] },
    admin: { id: alex, role: 'admin', visibility: 'household' },
    household: (id) => ({ id, role: 'member', visibility: 'household' }),
    self: (id) => ({ id, role: 'member', visibility: 'self' }),
    add,
  };
}
