import { and, eq, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accounts, imports } from '@/db/schema';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';

/**
 * Spec 2026-09-28 §2.1. When was anything last imported, among the accounts this viewer may see.
 *
 * The weekly and monthly digests open with this date, because they fire on a clock and a reader
 * cannot otherwise tell a summary built on yesterday's import from one built on a month-old one.
 * It is a fact about IMPORTS, never about transactions: commitImport writes its row before it
 * counts anything, so a CSV that yielded nothing new still moved this date -- "somebody looked" is
 * the question, and a quiet account that was checked is fresh.
 *
 * Ruling R2, exactly as listAccounts applies it: a self-scoped viewer's answer comes from accounts
 * they own, and a joint account (owner NULL) is not one of them. The family channel's copy is
 * rendered through HOUSEHOLD_VIEWER and sees everything. Listed in REQUIRE_VIEWER
 * (tests/ops/visibility-invariants.test.ts) so the parameter can never become optional.
 *
 * Active accounts only. A deactivated account is out of the reminder's sight (evaluate/stale.ts)
 * and out of this for the same reason: nobody is expected to import into it.
 */
export function latestImportIso(viewer: Viewer): string | null {
  const scope = ownerScope(viewer);
  const clauses: SQL[] = [eq(accounts.isActive, true)];
  if (scope !== null) clauses.push(eq(accounts.ownerUserId, scope));
  const row = getDb()
    .select({ newest: sql<string | null>`max(${imports.createdAt})` })
    .from(imports)
    .innerJoin(accounts, eq(accounts.id, imports.accountId))
    .where(and(...clauses))
    .get();
  const newest = row?.newest ?? null;
  return newest === null ? null : newest.slice(0, 10);
}
