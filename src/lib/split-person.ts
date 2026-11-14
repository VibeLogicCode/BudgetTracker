/**
 * v1.63.0. A split part's person, the pure half: no database, so a client component (the split
 * editor, the Transactions list) can import it without reaching @/db (tests/ops/client-bundle).
 *
 * A part follows its transaction's person unless someone set it (personSet). A set part belongs to
 * attributedUserId, where null is Household, the meaning null already has on a transaction. The
 * SQL form of the same rule is EFFECTIVE_PERSON in src/lib/splits.ts; the two are kept in step by
 * tests/lib/split-person.test.ts and tests/lib/splits.test.ts reading the same fixture.
 */

/** What the split editor writes for a part: follow the transaction, Household, or a user id. */
export type SplitPerson = 'follow' | 'household' | number;

/** The stored pair, as a split row carries it. Both optional: a row read before 0032 follows. */
export interface PartPersonFields {
  personSet?: boolean;
  attributedUserId?: number | null;
}

/** Who a part belongs to: a user id, or null for Household. */
export function effectivePartPerson(part: PartPersonFields, parentPersonId: number | null): number | null {
  return part.personSet === true ? (part.attributedUserId ?? null) : parentPersonId;
}

/** Each distinct effective person of `parts`, in part order. */
export function partPeople(parts: readonly PartPersonFields[], parentPersonId: number | null): (number | null)[] {
  const out: (number | null)[] = [];
  for (const part of parts) {
    const person = effectivePartPerson(part, parentPersonId);
    if (!out.includes(person)) out.push(person);
  }
  return out;
}

/** The editor choice that wrote a stored part, for seeding the editor from it. */
export function splitPersonOf(part: PartPersonFields): SplitPerson {
  if (part.personSet !== true) return 'follow';
  return part.attributedUserId ?? 'household';
}
