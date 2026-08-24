'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { CheckIcon } from '@/components/icons';
import { AutoSaveSelect } from '@/components/ui/AutoSave';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { selectClass } from '@/components/ui/form';
import type { CategoryRecord } from '@/lib/categories';
import { categoryOptions } from '@/lib/category-order';
import type { TransactionRow } from '@/lib/transactions';
import { acceptGuessAction, applyToAllMatchingAction, fixCategoryAction, markTransferAction, type ReviewState } from './actions';

const initial: ReviewState = {};

/** Bound for the auto-save select; fixCategoryAction itself is unchanged. */
const saveFixCategory = (formData: FormData) => fixCategoryAction({}, formData);

/** Dense enough to sit three-across in a row of actions without shouting. */
const pickerClass = 'field-control w-auto max-w-[12rem] px-2 py-1 text-xs';

export function ReviewClient({
  total,
  rows,
  categories,
}: {
  total: number;
  rows: (TransactionRow & { matchingCount: number })[];
  categories: CategoryRecord[];
}) {
  const [acceptState, accept] = useActionState(acceptGuessAction, initial);
  const [allState, applyAll] = useActionState(applyToAllMatchingAction, initial);
  const [transferState, markTransfer] = useActionState(markTransferAction, initial);

  // Task 6 (v1.8.0): computed once and reused by both selects below, so a child category
  // always renders directly after its own parent instead of wherever raw creation order put
  // it. categoryOptions() (src/lib/category-order.ts) is a type-only consumer of
  // CategoryRecord -- it never reaches @/db/client, so it stays safe for this 'use client' file.
  const options = categoryOptions(categories);

  const notice = acceptState.message ?? allState.message ?? transferState.message;
  const error = acceptState.error ?? allState.error ?? transferState.error;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow={`${total} waiting`}
        title="Review queue"
        description="Transactions the categorizer could not place with confidence. Correcting one teaches it."
      />
      {/* Same `rows.length === 0` the success state below is rendered on. An empty queue is the
          state a reader reaches most often, and it is exactly when "why did this screen exist
          again?" needs answering, since the queue fills itself back up on the next import. */}
      <PageGuide empty={rows.length === 0}>
        <p>
          Every import runs each new transaction past the categorizer. Anything it could not
          place with confidence waits here instead of being filed under a guess, so this screen
          is the one place where a wrong category is a decision you made rather than one the app
          made quietly.
        </p>
        <p>
          Accepting a guess or correcting it does two things: it files that transaction, and it
          teaches the categorizer what that merchant is. The same merchant arrives already
          sorted next time. Where a merchant already has other unsorted rows on file, the count
          beside it offers to apply your choice to all of them at once.
        </p>
        <p>
          This queue is not a one-time setup step. It empties, then refills the next time you
          import a statement, so clearing it is part of the monthly routine rather than
          something you finish once.
        </p>
      </PageGuide>

      <FormError message={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={CheckIcon}
            title="Nothing to review. Everything is categorized."
            action={
              <>
                <Link href="/transactions" className="btn btn--primary btn--sm">
                  See what was categorized
                </Link>
                <Link href="/import" className="btn btn--secondary btn--sm">
                  Bring in more
                </Link>
              </>
            }
          >
            New imports land here whenever the categorizer is unsure.
          </EmptyState>
        </Card>
      ) : null}

      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.id} className="card flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-sm">
                <strong className="font-semibold text-ink">{row.normalizedMerchant}</strong>{' '}
                <span className="text-muted">— {row.rawDescription}</span>
              </span>
              <Money cents={row.amountCents} className="text-base font-semibold" />
            </div>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-subtle">
              <span className="tabnum">{row.date}</span>
              <span aria-hidden="true">·</span>
              <span>{row.accountName}</span>
              <span aria-hidden="true">·</span>
              {row.source === 'bayes' && row.categoryName ? (
                <span className="badge badge--amber">
                  guessed {row.categoryName} (margin {row.confidence?.toFixed(2)})
                </span>
              ) : (
                <span className="badge badge--slate">uncategorized</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              {row.source === 'bayes' && row.categoryId ? (
                <form action={accept}>
                  <input type="hidden" name="transactionId" value={row.id} />
                  <button type="submit" className="btn btn--primary btn--sm">
                    <CheckIcon className="h-3.5 w-3.5" />
                    Accept {row.categoryName}
                  </button>
                </form>
              ) : null}
              {/* The "Set" button is gone: picking a category IS the decision, and holding it
                  behind a second click was the idiom this release removes. The placeholder is
                  `disabled` so it can only ever be the starting state -- fixCategoryAction
                  answers an empty categoryId with "Pick a category.", and with no Set button to
                  hold back there would be nothing to stop a person selecting it. The same
                  guard the transactions loan select already used. */}
              <AutoSaveSelect
                name="categoryId"
                defaultValue={row.categoryId === null ? '' : String(row.categoryId)}
                options={[
                  { value: '', label: 'Choose a category…', disabled: true },
                  ...options.map((opt) => ({
                    value: String(opt.id),
                    label: '  '.repeat(opt.depth) + opt.label,
                  })),
                ]}
                fields={{ transactionId: String(row.id) }}
                action={saveFixCategory}
                ariaLabel={`Category for ${row.normalizedMerchant}`}
                className={pickerClass}
              />
              {row.matchingCount > 1 ? (
                <form action={applyAll} className="flex items-center gap-1.5">
                  <input type="hidden" name="normalizedMerchant" value={row.normalizedMerchant} />
                  <select
                    name="categoryId"
                    defaultValue={row.categoryId ?? ''}
                    aria-label={`Category for all ${row.matchingCount} matching ${row.normalizedMerchant}`}
                    className={pickerClass}
                  >
                    <option value="">Choose a category…</option>
                    {options.map((opt) => (
                      <option key={opt.id} value={opt.id}>{'\u00A0\u00A0'.repeat(opt.depth) + opt.label}</option>
                    ))}
                  </select>
                  <button type="submit" className="btn btn--secondary btn--sm">
                    Apply to all {row.matchingCount} matching + create rule
                  </button>
                </form>
              ) : null}
              <form action={markTransfer}>
                <input type="hidden" name="transactionId" value={row.id} />
                <button type="submit" className="btn btn--ghost btn--sm">Mark as transfer</button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
