import { and, asc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { accounts } from '@/db/schema';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import { nowIso } from '@/lib/clock';

/**
 * v1.13.0 ruling R10. Five values, up from three. This column has never carried a SQL CHECK
 * (drizzle/0000_init.sql:59), so widening it took no migration -- micro-ruling M2.
 */
export type AccountType = 'chequing' | 'credit' | 'cash' | 'savings' | 'asset';

export interface AccountRecord {
  id: number;
  name: string;
  institution: string;
  type: AccountType;
  ownerUserId: number | null;
  importProfileId: number | null;
  isActive: boolean;
  createdAt: string;
}

/**
 * Ruling R10: an asset (a house, a TFSA, an RRSP) holds a balance a person types in once a quarter.
 * It takes no transactions and no imports, so it is filtered out of every account picker that leads
 * to a write. It is NOT filtered out of net worth -- being in net worth is the whole reason it
 * exists.
 */
export function acceptsTransactions(type: AccountType): boolean {
  return type !== 'asset';
}

/**
 * Ruling R10: savings behaves like chequing for balances and transactions but is deliberately left
 * out of safe-to-spend -- money set aside is not money available this month, and folding it in is
 * how a safe-to-spend figure starts lying. Credit was never in it either.
 */
export function countsTowardSafeToSpend(type: AccountType): boolean {
  return type === 'chequing' || type === 'cash';
}

export const createAccountSchema = z.object({
  name: z.string().trim().min(1, 'Account name is required').max(80),
  // Optional: a cash jar or a credit union nobody has a tidy name for still
  // deserves an account row. The column is NOT NULL, so it stores '' when the
  // family leaves it blank rather than refusing the whole account.
  institution: z.string().trim().max(80).default(''),
  type: z.enum(['chequing', 'credit', 'cash', 'savings', 'asset']),
  ownerUserId: z.number().int().positive().nullable(),
  importProfileId: z.number().int().positive().nullable().optional(),
});

export const renameAccountSchema = z.string().trim().min(1, 'Account name is required').max(80);

/**
 * v1.13.0 ruling R2: `viewer` is REQUIRED. A self viewer sees only accounts they own -- including
 * NOT the joint account, because an un-owned account is the household's shared money and R2 says a
 * self user sees no account balances that are not theirs.
 */
export function listAccounts(opts: { includeInactive?: boolean }, viewer: Viewer): AccountRecord[] {
  const scope = ownerScope(viewer);
  const clauses: SQL[] = [];
  if (!opts.includeInactive) clauses.push(eq(accounts.isActive, true));
  if (scope !== null) clauses.push(eq(accounts.ownerUserId, scope));
  const query = getDb().select().from(accounts);
  return (clauses.length === 0 ? query : query.where(and(...clauses))).orderBy(asc(accounts.id)).all();
}

/**
 * NO viewer parameter, on purpose (micro-ruling M3). This is an internal resolver, not a read model:
 * createManualTransaction (src/lib/transactions.ts), commitImport (src/lib/import/commit.ts) and
 * commitStagedImport (src/lib/import/flow.ts) all call it with an id they produced themselves and
 * have no viewer to pass. No page or route resolves a user-supplied account id through it.
 * tests/ops/visibility-invariants.test.ts names it on the exempt list with this reason.
 */
export function getAccount(id: number): AccountRecord | null {
  return getDb().select().from(accounts).where(eq(accounts.id, id)).get() ?? null;
}

export function createAccount(input: {
  name: string;
  institution?: string;
  type: AccountType;
  ownerUserId: number | null;
  importProfileId?: number | null;
}): number {
  const parsed = createAccountSchema.parse(input);
  const row = getDb()
    .insert(accounts)
    .values({
      name: parsed.name,
      institution: parsed.institution,
      type: parsed.type,
      ownerUserId: parsed.ownerUserId,
      importProfileId: parsed.importProfileId ?? null,
      isActive: true,
      createdAt: nowIso(),
    })
    .returning({ id: accounts.id })
    .get();
  return row.id;
}

export function setAccountActive(id: number, active: boolean): void {
  getDb().update(accounts).set({ isActive: active }).where(eq(accounts.id, id)).run();
}

/** Display name only — never touches the id, so history, imports and dedup are unaffected. */
export function renameAccount(id: number, name: string): void {
  getDb().update(accounts).set({ name: renameAccountSchema.parse(name) }).where(eq(accounts.id, id)).run();
}

/** null = Joint/household (spec section 3: owner_user_id NULL means joint). */
export function setAccountOwner(id: number, ownerUserId: number | null): void {
  getDb().update(accounts).set({ ownerUserId }).where(eq(accounts.id, id)).run();
}

/** Each user gets one personal Cash account, created on demand for manual entries. */
export function getOrCreateCashAccount(userId: number, userName: string): number {
  const existing = getDb()
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.ownerUserId, userId), eq(accounts.type, 'cash')))
    .get();
  if (existing) return existing.id;
  return createAccount({ name: `${userName} Cash`, institution: 'Cash', type: 'cash', ownerUserId: userId });
}
