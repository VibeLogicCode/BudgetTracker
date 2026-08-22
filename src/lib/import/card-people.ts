import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accountCardPeople, users } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { normalizeCardValue } from './mapping';

/**
 * One account's card-value -> person assignments (spec 2026-08-22, v1.6.0, MUST-3.1).
 *
 * `account_card_people.card_value` is ALWAYS normalizeCardValue()'d before it is written or
 * looked up — every function in this file does that, so a value typed with odd spacing or
 * mixed case still matches the same row. The person is resolved through an INNER JOIN against
 * `users`, not a left join and never filtered on `is_active`: an assignment pointing at a
 * since-deactivated user (users.is_active = 0) is never hidden or deleted here, because
 * deactivation only flips a flag — it never removes the row this joins against. Deleting or
 * hiding it would silently break `commit.ts`'s per-row attribution for every future import
 * that account ever runs, which is exactly the failure MUST-3.1 forbids.
 */
export interface AccountCardPersonRecord {
  id: number;
  accountId: number;
  /** Already normalized (trim, collapse whitespace, uppercase) — see normalizeCardValue. */
  cardValue: string;
  userId: number;
  userName: string;
  userIsActive: boolean;
  createdAt: string;
}

export function listAccountCardPeople(accountId: number): AccountCardPersonRecord[] {
  return getDb()
    .select({
      id: accountCardPeople.id,
      accountId: accountCardPeople.accountId,
      cardValue: accountCardPeople.cardValue,
      userId: accountCardPeople.userId,
      userName: users.name,
      userIsActive: users.isActive,
      createdAt: accountCardPeople.createdAt,
    })
    .from(accountCardPeople)
    .innerJoin(users, eq(users.id, accountCardPeople.userId))
    .where(eq(accountCardPeople.accountId, accountId))
    .orderBy(accountCardPeople.cardValue)
    .all();
}

/**
 * Create or repoint one assignment. `(account_id, normalized card_value)` is the natural key
 * (enforced by the `account_card_people_uq` unique index from migration 0008), so assigning
 * the same value to a different person is an update, not a duplicate row.
 *
 * The person must be an existing user (MUST-3.1) — checked here rather than left to the
 * database's FK constraint, so the caller gets a clear message instead of a raw SQLite
 * constraint-violation error. Deliberately NOT restricted to active users: nothing in the
 * spec says an admin cannot point a new assignment at a currently-inactive user, and the
 * symmetrical read path (listAccountCardPeople, and commit.ts's lookup) already resolves and
 * honours an assignment to a deactivated user without hiding it.
 */
export function upsertAccountCardPerson(input: { accountId: number; cardValue: string; userId: number }): void {
  const db = getDb();
  const user = db.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).get();
  if (!user) throw new Error(`No user ${input.userId}`);

  const cardValue = normalizeCardValue(input.cardValue);
  if (cardValue.length === 0) throw new Error('Card value cannot be empty');

  db.insert(accountCardPeople)
    .values({ accountId: input.accountId, cardValue, userId: input.userId, createdAt: nowIso() })
    .onConflictDoUpdate({
      target: [accountCardPeople.accountId, accountCardPeople.cardValue],
      set: { userId: input.userId },
    })
    .run();
}

/** No-op (0 rows affected) when the value has no assignment — deleting an absent row is not an error. */
export function deleteAccountCardPerson(accountId: number, cardValue: string): void {
  getDb()
    .delete(accountCardPeople)
    .where(and(eq(accountCardPeople.accountId, accountId), eq(accountCardPeople.cardValue, normalizeCardValue(cardValue))))
    .run();
}
