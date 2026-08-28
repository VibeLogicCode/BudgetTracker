import { requireUser } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import type { Viewer } from '@/lib/auth/viewer';
import { todayIso } from '@/lib/dates';
import { displayNameOf, getTransaction } from '@/lib/transactions';
import { listItemTypes } from '@/lib/warranty/types';
import { NewWarrantyClient, type WarrantyPrefill } from './new-warranty-client';

export const dynamic = 'force-dynamic';

/**
 * MUST-11.3: prefill is computed SERVER-SIDE from the transaction row. The query parameter
 * carries only the id; no field value is ever trusted from the URL.
 *
 * v1.13.0 (fix round 1, controller ruling): getTransaction is now viewer-scoped (Task 3). For a
 * self-scoped viewer, a transactionId that belongs to someone ELSE in the household comes back
 * null -- indistinguishable here from an id that never existed at all, and that is fine: either
 * way there is nothing this viewer may prefill from. Returning null (never notFound()) means the
 * page still renders, just with an empty form, instead of 404ing a person out of /warranties/new
 * entirely because of a query string they didn't necessarily craft themselves (a stale bookmark,
 * a shared link).
 */
function prefillFromTransaction(transactionId: number, viewer: Viewer): WarrantyPrefill | null {
  const txn = getTransaction(transactionId, viewer);
  if (!txn) return null;
  return {
    purchaseDate: txn.date,
    // The ledger stores spend negative; a warranty stores a positive price (§3.2 / §17.26).
    priceCents: Math.abs(txn.amountCents),
    vendor: displayNameOf(txn).replace(/\s+/g, ' ').trim().slice(0, 60),
    transactionId: txn.id,
  };
}

export default async function NewWarrantyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const raw = Array.isArray(params.transactionId) ? params.transactionId[0] : params.transactionId;
  const prefill = (raw && /^\d+$/.test(raw) ? prefillFromTransaction(Number(raw), user) : null) ?? {};

  return (
    <NewWarrantyClient
      people={listUsers().filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name }))}
      types={listItemTypes().map((t) => ({ id: t.id, name: t.name, kind: t.kind }))}
      currentUserId={user.id}
      today={todayIso()}
      prefill={prefill}
      isAdmin={user.role === 'admin'}
    />
  );
}
