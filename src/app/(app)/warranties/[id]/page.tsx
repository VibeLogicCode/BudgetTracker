import { notFound } from 'next/navigation';
import { listAccounts } from '@/lib/accounts';
import { requireUser } from '@/lib/auth/session';
import { listAttributablePeople } from '@/lib/auth/users';
import { listCategories } from '@/lib/categories';
import { todayIso } from '@/lib/dates';
import { listLoanRules, listLoans } from '@/lib/loans';
import { displayNameOf, getTransaction } from '@/lib/transactions';
import { warrantyStatus } from '@/lib/warranty/expiry';
import { getWarrantyItem, listWarrantyReceipts } from '@/lib/warranty/items';
import { INSTALLMENT_DUE_SOON_DAYS, listInstallments } from '@/lib/warranty/installments';
import { listItemTypes } from '@/lib/warranty/types';
import { WarrantyDetailClient } from './warranty-detail-client';

export const dynamic = 'force-dynamic';

export default async function WarrantyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireUser();
  const { id: raw } = await params;
  if (!/^\d+$/.test(raw)) notFound();
  // v1.13.0 ruling R2/R3. getWarrantyItem returns null for an item this viewer may not see, so the
  // ownership check IS this line -- there is no second branch to forget, and the confirmed-exploitable
  // finding (review 2026-08-27, SEC-1: incrementing the integer) closes in the query.
  const item = getWarrantyItem(Number(raw), viewer);
  if (!item) notFound();

  const txn = item.transactionId === null ? null : getTransaction(item.transactionId, viewer);
  const today = todayIso();
  // v1.3.1: the loan summary (payoff fraction, last payment, payment count) this item's
  // read-only money block renders -- undefined for a non-loan item, or a loan whose money
  // fields haven't been filled in yet.
  const loanSummary = listLoans(today, viewer).find((loan) => loan.itemId === item.id);

  return (
    <WarrantyDetailClient
      item={item}
      receipts={listWarrantyReceipts(item.id)}
      status={warrantyStatus(item, today)}
      people={listAttributablePeople().map((person) => ({ id: person.id, name: person.name }))}
      types={listItemTypes().map((t) => ({ id: t.id, name: t.name, kind: t.kind }))}
      today={today}
      linkedTransaction={txn ? { id: txn.id, date: txn.date, description: displayNameOf(txn) } : null}
      /* §10.4: never render a dead link. ON DELETE SET NULL leaves no durable marker that
         a link USED to exist, so the only detectable case is a dangling id, which is what
         a database restored with foreign keys off would produce. See the plan's
         "Spec ambiguities resolved" note. */
      linkRemoved={item.transactionId !== null && txn === null}
      rules={listLoanRules(item.id)}
      /* v1.12.0: ALWAYS loaded, whatever the kind -- ruling B7. The card is rendered when the
         kind allows installments OR when the item already has some, and the client cannot make
         that second decision without the rows. INSTALLMENT_DUE_SOON_DAYS is the page's own
         window; the notification evaluator passes the user's comingDueDays instead. */
      installments={listInstallments(item.id, today, INSTALLMENT_DUE_SOON_DAYS)}
      /* v1.13.0 ruling R11: the budget-category select on a bill's Installments card. Archived
         AND income categories are excluded -- a bill is an expense, and linking one to a category
         nobody budgets in (archived) or that isn't an expense line at all (income) would render a
         sinking-fund line against a row the budgets page does not show. */
      categories={listCategories({ includeArchived: false })
        .filter((category) => !category.isIncome)
        .map((category) => ({ id: category.id, name: category.name }))}
      accounts={listAccounts({}, viewer).map((a) => ({ id: a.id, name: a.name }))}
      payoffFraction={loanSummary?.payoffFraction ?? null}
      lastPaymentAt={loanSummary?.lastPaymentAt ?? null}
      paymentCount={loanSummary?.paymentCount ?? 0}
    />
  );
}
