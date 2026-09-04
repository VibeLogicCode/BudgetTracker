import { formatCents } from '@/lib/money';
import type { Discrepancy } from '@/lib/balance-reconcile';

/**
 * v1.31.0 F-03. Split out of settings/accounts/accounts-manager.tsx (where this sentence was
 * first written, v1.8.0 Task 5) so a SECOND surface -- the import screen's post-commit summary
 * -- can render the identical wording instead of growing its own copy of it. The reason this
 * cannot simply live in src/lib/balance-reconcile.ts, where `Discrepancy` and `reconcileAccount`
 * are defined: that module's top-level import of @/db/client makes it server-only, and the
 * import screen's summary renders from 'use client' code (import-client.tsx). A 'use client'
 * file that value-imported discrepancyMessage FROM balance-reconcile.ts would drag that whole
 * module -- getDb included -- into the browser bundle (tests/ops/client-bundle.test.ts), the
 * exact trap transaction-links.ts's own docblock describes for a different pair of modules. This
 * file imports nothing but formatCents (already client-safe) and Discrepancy as a TYPE (erased
 * at compile time), so both a Server Component and a 'use client' component can share the one
 * sentence.
 *
 * The entire text of ruling R7's diagnostic (spec 2026-08-23, v1.8.0 Task 5): report the gap,
 * name both statement dates, and go no further -- never guess which transaction is missing, and
 * never say the account "lost" or "gained" money, since nothing here knows which side is wrong.
 * `deltaCents` is impliedCents - expectedCents (balance-reconcile.ts's own docblock): positive
 * means this app's OWN imported transactions add up to MORE than the bank says the account holds
 * on `toDate` -- the statement reads LOWER than our rows account for -- and negative is the exact
 * mirror. Exported so tests can assert on the sentence directly rather than re-deriving it from
 * rendered DOM text.
 */
export function discrepancyMessage(discrepancy: Discrepancy): string {
  const { fromDate, toDate, deltaCents } = discrepancy;
  const direction = deltaCents > 0 ? 'lower' : 'higher';
  const amount = formatCents(Math.abs(deltaCents));
  return (
    `Your statement balance for ${toDate} is ${amount} ${direction} than your imported transactions account for ` +
    `— an import is probably missing rows between ${fromDate} and ${toDate}.`
  );
}
