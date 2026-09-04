import { requireUser } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import { ownerScope } from '@/lib/auth/viewer';
import { addDaysIso, todayIso } from '@/lib/dates';
import { recurringCharges, recurringLoad } from '@/lib/recurring';
import { isWarrantyStatus } from '@/lib/warranty/expiry';
import { unpaidInstallments } from '@/lib/warranty/installments';
import { isWarrantySort, searchWarrantyItems } from '@/lib/warranty/search';
import { listItemTypes } from '@/lib/warranty/types';
import { WarrantiesClient } from './warranties-client';

export const dynamic = 'force-dynamic';

export default async function WarrantiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireUser();
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) ?? '';
  };

  const query = one('q');
  const status = one('status');
  const owner = one('owner');
  const typeId = one('typeId');
  const sortRaw = one('sort');
  const sort = isWarrantySort(sortRaw) ? sortRaw : 'expiry';
  const page = /^\d+$/.test(one('page')) ? Number(one('page')) : 1;
  const today = todayIso();

  const result = searchWarrantyItems(
    {
      q: query,
      status: isWarrantyStatus(status) ? status : null,
      ownerUserId: /^\d+$/.test(owner) ? Number(owner) : null,
      // Delta T9: composes with q/status/owner/sort like every other filter.
      typeId: /^\d+$/.test(typeId) ? Number(typeId) : null,
      sort,
      page,
      today,
    },
    viewer,
  );

  /**
   * Item Q (ruling P5). The list's row shape (WarrantyListItem) carries no schedule and
   * searchWarrantyItems is a REQUIRE_VIEWER read-model -- widening it for a display detail would
   * touch a guarded reader, so the page folds the schedule itself. unpaidInstallments already
   * orders due_date ASC, so the FIRST row per item is its next due date.
   *
   * ownerUserId is what keeps a self viewer to their own bills: unpaidInstallments takes no
   * viewer of its own (its own docblock says omitting the id spans the household), so the scope
   * has to be passed in here or a child would see a sibling's bill dates.
   *
   * A ten-year window is effectively unbounded, which is right for a LIST: the row should name
   * the next due date however far out it is. The dashboard card is the one with a horizon.
   */
  const scope = ownerScope(viewer);
  const billSchedules: Record<number, { nextDueDate: string; overdueCount: number }> = {};
  for (const row of unpaidInstallments({
    today,
    windowEnd: addDaysIso(today, 3650),
    includeOverdue: true,
    ownerUserId: scope ?? undefined,
  })) {
    const entry = billSchedules[row.itemId];
    if (entry === undefined) {
      billSchedules[row.itemId] = { nextDueDate: row.dueDate, overdueCount: row.dueDate < today ? 1 : 0 };
    } else if (row.dueDate < today) {
      entry.overdueCount += 1;
    }
  }

  /**
   * F-05 (2026-09-02 review, v1.31.0). Two read models, nothing stored: `recurringLoad` totals
   * the billing amounts somebody actually typed into items (the header line), and
   * `recurringCharges` derives what the LEDGER shows arriving on a rhythm (the card below the
   * table). They are separate calls, and separate figures on screen, because one is recorded
   * fact and the other is a pattern the app noticed -- blending them into a single "your
   * recurring spend" number would present the guess with the authority of the record.
   *
   * `ownerUserId: scope` -- this page has no `?person=` of its own (it filters by `?owner=`,
   * which is an ITEM filter and not a spend attribution), so the only person scope a recurring
   * CHARGE read can honestly carry here is the viewer's own, or the household. Passing
   * `ownerScope(viewer)` rather than the `owner` query parameter is deliberate: `?owner=` names
   * whose ITEM a row is, and re-using it to filter transactions would answer a question nobody
   * asked and would let any viewer narrow a spend read through the URL.
   */
  const load = recurringLoad({ today, ownerUserId: scope, viewer });
  const recurring = recurringCharges({ today, ownerUserId: scope, viewer });

  return (
    <WarrantiesClient
      result={result}
      recurring={recurring}
      recurringLoad={load}
      recurringPerson={scope}
      people={listUsers().filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name }))}
      types={listItemTypes().map((t) => ({ id: t.id, name: t.name, kind: t.kind }))}
      today={today}
      query={query}
      status={status}
      owner={owner}
      typeId={typeId}
      sort={sort}
      billSchedules={billSchedules}
    />
  );
}
