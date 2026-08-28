import { requireUser } from '@/lib/auth/session';
import { isSelfScoped, ownerScope } from '@/lib/auth/viewer';
import { acceptsTransactions, listAccounts } from '@/lib/accounts';
import { listCategories } from '@/lib/categories';
import { findUserById, listAttributablePeople } from '@/lib/auth/users';
import { loanLinksForTransactions, listLoans } from '@/lib/loans';
import { splitsForTransactions } from '@/lib/splits';
import { listTransactions, type TransactionFilter } from '@/lib/transactions';
import { todayIso } from '@/lib/dates';
import { resolveRange, type ResolvedRange } from '@/lib/date-range';
import { readEnv } from '@/lib/env';
import { TransactionsClient } from './transactions-client';

export const dynamic = 'force-dynamic';

function readFilter(
  params: Record<string, string | string[] | undefined>,
  range: ResolvedRange | null,
  /** v1.13.0 ruling R2: the person filter for a self viewer comes from the SESSION, not the URL --
   *  the same `ownerScope(viewer) ?? urlValue` idiom dashboard/page.tsx and reports/page.tsx already
   *  use, so a self viewer's own id always wins over whatever a hand-edited `?person=` says. */
  selfOwnerId: number | null,
): TransactionFilter {
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const num = (key: string) => {
    const value = one(key);
    return value && /^\d+$/.test(value) ? Number(value) : undefined;
  };
  const person = one('person');
  const category = one('category');
  return {
    accountId: num('account') ?? null,
    categoryId: category === 'uncategorized' ? 'uncategorized' : category && /^\d+$/.test(category) ? Number(category) : null,
    attributedUserId:
      selfOwnerId !== null
        ? selfOwnerId
        : person === 'unattributed'
          ? 'unattributed'
          : person && /^\d+$/.test(person)
            ? Number(person)
            : null,
    from: range?.from ?? null,
    to: range?.to ?? null,
    search: one('q') ?? null,
    uncategorizedOnly: one('uncat') === '1',
    includeTransfers: one('transfers') !== '0',
    page: num('page') ?? 1,
    pageSize: 50,
  };
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireUser();
  const params = await searchParams;
  const today = todayIso(new Date(), readEnv().tz);
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  // MUST-13.5: fallback null, because Transactions is the page people open to find a charge
  // from March and giving it a default range would hide exactly those rows.
  const range = resolveRange({ preset: one('range'), from: one('from'), to: one('to'), today, fallback: null });
  const filter = readFilter(params, range, ownerScope(viewer));
  const page = listTransactions(filter, viewer);
  return (
    <TransactionsClient
      page={page}
      // Ruling R10: an asset account holds a typed balance and takes no transactions/imports, so
      // it is filtered out of every account picker on this page -- the filter select, quick-add
      // and (formerly) the bottom manual-entry form all shared this one `accounts` prop, so
      // filtering it once here covers all of them.
      accounts={listAccounts({}, viewer)
        .filter((account) => acceptsTransactions(account.type))
        .map((a) => ({ id: a.id, name: a.name }))}
      // Archived categories are included here (not just listCategories()) so a row whose
      // category was later archived can still render its real name on the per-row select
      // and keep it as the initial selection instead of silently falling back to
      // "Uncategorized". See TransactionsClient's activeCategories split.
      categories={listCategories({ includeArchived: true })}
      // Ruling R5: every attribution picker reads the same list -- active people, login or not.
      // This is also the fix for the pre-v1.13.0 inconsistency where this page listed deactivated
      // members and budgets/page.tsx did not.
      // v1.13.1 (item BO): except for a self viewer, who gets none. Every attribution choice is
      // refused for them server-side, so the names were travelling into the client for controls
      // that could never work.
      people={isSelfScoped(viewer) ? [] : listAttributablePeople().map((person) => ({ id: person.id, name: person.name }))}
      today={today}
      range={range}
      // Ruling R2: the pill/select that would let a self viewer pick someone else is not
      // rendered at all -- the read is already forced to their own id above, in readFilter.
      selfScoped={isSelfScoped(viewer)}
      // Ruling R7: quick-add's own default account, remembered per person.
      defaultAccountId={findUserById(viewer.id)?.lastAccountId ?? null}
      // MUST-14.9: empty for a household with no loans (or none with a balance still owed),
      // which is exactly what makes the row control disappear entirely on that page.
      loanOptions={listLoans(today, viewer)
        .filter((loan) => loan.currentBalanceCents !== null)
        .map((loan) => ({ id: loan.itemId, name: loan.name }))}
      loanLinks={Object.fromEntries(loanLinksForTransactions(page.rows.map((row) => row.id)))}
      splits={Object.fromEntries(splitsForTransactions(page.rows.map((row) => row.id)))}
    />
  );
}
