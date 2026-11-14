'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { CategoryCombobox } from '@/components/CategoryCombobox';
import { FormError } from '@/components/FormError';
import { CheckIcon } from '@/components/icons';
import { SubmitButton } from '@/components/SubmitButton';
import { buttonClass } from '@/components/ui/Button';
import { Card, CardFooter } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { selectClass } from '@/components/ui/form';
import { categoryOptions, type CategoryLike } from '@/lib/category-order';
import { dayLabel } from '@/lib/dates';
import type { AiSuggestionView } from '@/lib/ai/types';
import type { MerchantGroupPage, MerchantGroupRow, TransactionRow } from '@/lib/transactions';
// A RELATIVE import, for the reason PossibleDuplicatesCard.tsx gives: the client-bundle guard
// follows `@/`-qualified value imports and cannot tell a 'use server' file from an ordinary module.
import { reviewMerchantGroupAction, type ActionState } from '../../app/(app)/transactions/actions';
import { acceptAiSuggestionAction, ignoreAiSuggestionAction } from '../../app/(app)/transactions/ai-actions';

const initial: ActionState = {};

/** The heading a group card carries: the newest row's display name, or a plain label for `''`. */
function merchantGroupName(group: Pick<MerchantGroupRow, 'merchant' | 'displayName'>): string {
  return group.merchant === '' ? 'No merchant name' : group.displayName;
}

/**
 * The server action, with its success message handed up to the list. A decided group leaves the
 * queue when the page revalidates, so a message kept in its own card would vanish unread; the
 * list's live region stays and says it. Same shape as PossibleDuplicatesCard's `reporting`.
 */
function reporting(onDone: (message: string | null) => void): (prev: ActionState, formData: FormData) => Promise<ActionState> {
  return async (prev, formData) => {
    const result = await reviewMerchantGroupAction(prev, formData);
    onDone(result.message ?? null);
    return result;
  };
}

/**
 * An AI action, with its message handed up to the list for the reason `reporting` gives. The whole
 * result is still returned, so a refusal (the suggestion is gone, the row was filed meanwhile)
 * shows in the card the way a group decision's does.
 */
function reportingAi(
  run: (prev: ActionState, formData: FormData) => Promise<ActionState>,
  onDone: (message: string | null) => void,
): (prev: ActionState, formData: FormData) => Promise<ActionState> {
  return async (prev, formData) => {
    const result = await run(prev, formData);
    onDone(result.message ?? null);
    return result;
  };
}

interface Person {
  id: number;
  name: string;
}

function GroupCard({
  group,
  scope,
  categories,
  people,
  today,
  actionable,
  suggestion,
  onCreateRule,
  onDone,
}: {
  group: MerchantGroupRow;
  scope: string;
  categories: CategoryLike[];
  people: Person[];
  today: string;
  actionable: boolean;
  suggestion: AiSuggestionView | null;
  onCreateRule: (row: TransactionRow) => void;
  onDone: (message: string | null) => void;
}) {
  const [state, action] = useActionState(reporting(onDone), initial);
  // The assignment list (v1.57.2): live categories only, so an archived one is never offered and a
  // guess stored before its category was archived opens the picker empty rather than on it.
  const options = categoryOptions(categories);
  const seed = group.guessCategoryId !== null && options.some((option) => option.id === group.guessCategoryId) ? group.guessCategoryId : null;
  // v1.64.0: with no Bayes guess, the picker opens on the local AI's category (a guess still wins).
  const aiCategoryId =
    seed === null && suggestion?.categoryId != null && options.some((option) => option.id === suggestion.categoryId) ? suggestion.categoryId : null;
  const [categoryId, setCategoryId] = useState<number | null>(seed ?? aiCategoryId);
  const [aiUseState, aiUseAction] = useActionState(reportingAi(acceptAiSuggestionAction, onDone), initial);
  const [aiIgnoreState, aiIgnoreAction] = useActionState(reportingAi(ignoreAiSuggestionAction, onDone), initial);

  const name = merchantGroupName(group);
  const hasMerchant = group.merchant !== '';
  const count = group.count;
  const noun = count === 1 ? 'transaction' : 'transactions';
  const first = dayLabel(group.firstDate, today);
  const last = dayLabel(group.lastDate, today);
  const span = first === last ? first : `${first} to ${last}`;

  /** The three fields every decision posts: which view, which merchant, which decision. */
  const fields = (decision: 'category' | 'person' | 'transfer' | 'recurring') => (
    <>
      <input type="hidden" name="scope" value={scope} />
      <input type="hidden" name="merchant" value={group.merchant} />
      <input type="hidden" name="decision" value={decision} />
    </>
  );

  return (
    <li data-merchant-group className="flex flex-col gap-3 border-b border-line px-4 py-4 last:border-b-0 sm:px-5">
      <div className="flex flex-col gap-1">
        <h3 className="break-words text-base font-semibold text-ink">{name}</h3>
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-sm text-muted">
          <span className="tabnum">{`${count} ${noun}`}</span>
          <span aria-hidden="true">·</span>
          <Money cents={group.totalCents} className="font-semibold" />
          <span aria-hidden="true">·</span>
          <span>{span}</span>
        </p>
      </div>

      {group.preview.length > 0 ? (
        <ul className="flex flex-col rounded-md border border-line bg-surface-2/60">
          {group.preview.map((row) => (
            <li key={row.id} data-merchant-preview-row className="flex items-baseline justify-between gap-3 px-3 py-1.5 text-sm">
              <span className="flex min-w-0 items-baseline gap-3">
                <span className="tabnum shrink-0 text-muted">{row.date}</span>
                <span className="truncate text-ink">{row.description}</span>
              </span>
              <Money cents={row.amountCents} className="tabnum shrink-0" />
            </li>
          ))}
          {count > group.preview.length ? (
            <li className="px-3 py-1.5 text-xs text-muted">{`Showing ${group.preview.length} of ${count}`}</li>
          ) : null}
        </ul>
      ) : null}

      {actionable ? (
        <div className="flex flex-col gap-3">
          <form action={action} className="flex flex-wrap items-center gap-2">
            {fields('category')}
            <CategoryCombobox
              options={options}
              value={categoryId}
              onChange={setCategoryId}
              label={`Category for ${name}`}
              name="categoryId"
              includeUncategorized={false}
              placeholder="Choose a category"
              className="w-56"
            />
            {/* Ticked, as the bulk Categorize bar's create rules is (the owner's decision). Not
                offered for the no-name group: there is no merchant text for a rule to match. */}
            {hasMerchant ? (
              <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
                <input type="checkbox" name="createRules" defaultChecked className="accent-accent" />
                {`Remember for future ${group.merchant} rows`}
              </label>
            ) : null}
            {/* Only while the picker still holds the AI's category: another pick is the person's own. */}
            {aiCategoryId !== null && categoryId === aiCategoryId ? <span className="text-xs text-muted">AI suggestion</span> : null}
            <SubmitButton size="sm" disabled={categoryId === null} className="min-h-11 sm:min-h-0" ariaLabel={`File all ${count} (${name})`}>
              {`File all ${count}`}
            </SubmitButton>
          </form>

          {hasMerchant && suggestion !== null && (suggestion.categoryId !== null || suggestion.cleanName !== null) ? (
            <div data-ai-suggestion className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="badge badge--slate">AI</span>
              {suggestion.cleanName !== null ? (
                <form action={aiUseAction}>
                  <input type="hidden" name="transactionId" value={String(group.newest.id)} />
                  <input type="hidden" name="part" value="name" />
                  <input type="hidden" name="remember" value="1" />
                  <SubmitButton variant="secondary" size="sm" className="min-h-11 sm:min-h-0" ariaLabel={`Use the name ${suggestion.cleanName} for all (${name})`}>
                    {`Use the name ${suggestion.cleanName} for all`}
                  </SubmitButton>
                </form>
              ) : null}
              <form action={aiIgnoreAction}>
                <input type="hidden" name="merchant" value={group.merchant} />
                <SubmitButton variant="ghost" size="sm" className="min-h-11 sm:min-h-0" ariaLabel={`Ignore the AI suggestion for ${group.merchant}`}>
                  Ignore
                </SubmitButton>
              </form>
            </div>
          ) : null}

          {people.length > 0 ? (
            <form action={action} className="flex flex-wrap items-center gap-2">
              {fields('person')}
              <select name="attributedUserId" aria-label={`Person for ${name}`} defaultValue="" className={selectClass}>
                <option value="">Household</option>
                {people.map((person) => (
                  <option key={person.id} value={String(person.id)}>
                    {person.name}
                  </option>
                ))}
              </select>
              <SubmitButton variant="secondary" size="sm" className="min-h-11 sm:min-h-0" ariaLabel={`Set person for all ${count} (${name})`}>
                {`Set person for all ${count}`}
              </SubmitButton>
            </form>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {/* A transfer and a recurring mark are both remembered by the merchant's text, so the
                no-name group has neither (the action refuses them too). */}
            {hasMerchant ? (
              <>
                <form action={action}>
                  {fields('transfer')}
                  <SubmitButton variant="secondary" size="sm" className="min-h-11 sm:min-h-0" ariaLabel={`Mark all ${count} as transfers (${name})`}>
                    {`Mark all ${count} as transfers`}
                  </SubmitButton>
                </form>
                <form action={action}>
                  {fields('recurring')}
                  <SubmitButton variant="secondary" size="sm" className="min-h-11 sm:min-h-0" ariaLabel={`Mark recurring (${name})`}>
                    Mark recurring
                  </SubmitButton>
                </form>
                <button
                  type="button"
                  className={buttonClass('ghost', 'sm', 'min-h-11 sm:min-h-0')}
                  aria-label={`Create a rule… (${name})`}
                  onClick={() => onCreateRule(group.newest)}
                >
                  Create a rule…
                </button>
              </>
            ) : null}
          </div>
          <FormError message={state.error} />
          <FormError message={aiUseState.error} />
          <FormError message={aiIgnoreState.error} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * v1.62.0 (plan item 1). Needs review by merchant: one card per merchant waiting in the queue, so
 * clearing it is a handful of decisions instead of one per row.
 *
 * Each card states the group's full size (every row page of it) and its money, previews its five
 * newest rows, and offers one decision for the whole group -- a category (seeded with the
 * categorizer's most common guess, with Remember ticked as the bulk Categorize bar has it), a
 * person, a transfer, or a recurring mark -- plus the row menu's Create a rule dialog, opened from
 * the group's newest row. Every form posts the page's own querystring and the merchant, never row
 * ids, so reviewMerchantGroupAction rebuilds exactly the set this card counted.
 *
 * Props only: page.tsx reads the groups (groupTransactionsByMerchant) and the client hands them
 * here with the categories and people it already has. `actionable` is false outside review mode,
 * where `?group=merchant` is honoured as a read-only summary: a decision applies to queued rows
 * only (the owner's decision), and a list's group counts rows that are not in the queue.
 */
export function MerchantGroups({
  groupPage,
  scope,
  categories,
  people,
  today,
  actionable,
  previousHref = null,
  nextHref = null,
  onCreateRule,
  aiSuggestions = {},
}: {
  groupPage: MerchantGroupPage;
  /** The page's own querystring (currentQuery), posted as the decision's scope. */
  scope: string;
  categories: CategoryLike[];
  people: Person[];
  today: string;
  actionable: boolean;
  previousHref?: string | null;
  nextHref?: string | null;
  onCreateRule: (row: TransactionRow) => void;
  /** v1.64.0: the local AI's suggestion per merchant (page.tsx); empty when off. */
  aiSuggestions?: Record<string, AiSuggestionView>;
}) {
  // The last decision's message, kept here for the reason `reporting` gives. The live region is
  // always rendered, empty until then, so a screen reader announces the message.
  const [done, setDone] = useState<string | null>(null);
  const status = (
    <p
      role="status"
      aria-live="polite"
      className={done === null ? 'sr-only' : 'rounded-md bg-positive-soft px-3.5 py-3 text-sm text-positive-soft-fg'}
    >
      {done}
    </p>
  );

  if (groupPage.groupCount === 0) {
    return (
      <>
        {status}
        <Card>
          <EmptyState
            icon={CheckIcon}
            title={actionable ? 'Nothing to review. Everything is categorized.' : 'Nothing matches these filters'}
            noAction="New rows arrive from imports and the bank sync on their own, so there is nothing to start from here."
          >
            {actionable
              ? 'New imports land here, grouped by merchant, whenever the categorizer is unsure.'
              : 'No transactions in this view, so there are no merchants to group them under.'}
          </EmptyState>
        </Card>
      </>
    );
  }

  const firstShown = (groupPage.page - 1) * groupPage.pageSize + 1;
  const lastShown = Math.min(groupPage.groupCount, groupPage.page * groupPage.pageSize);
  return (
    <>
      {status}
      <Card as="div">
        <ul data-merchant-groups>
          {groupPage.groups.map((group) => (
            <GroupCard
              key={group.merchant === '' ? '(no merchant)' : group.merchant}
              group={group}
              scope={scope}
              categories={categories}
              people={people}
              today={today}
              actionable={actionable}
              suggestion={Object.hasOwn(aiSuggestions, group.merchant) ? aiSuggestions[group.merchant] : null}
              onCreateRule={onCreateRule}
              onDone={setDone}
            />
          ))}
        </ul>
        <CardFooter>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>
              {`Merchants ${firstShown}–${lastShown} of ${groupPage.groupCount} — ${groupPage.totalCount} transaction${groupPage.totalCount === 1 ? '' : 's'} in this view`}
            </span>
            {previousHref !== null ? (
              <Link href={previousHref} className={buttonClass('secondary', 'sm')}>
                Previous merchants
              </Link>
            ) : null}
            {nextHref !== null ? (
              <Link href={nextHref} className={buttonClass('secondary', 'sm')}>
                Next merchants
              </Link>
            ) : null}
          </span>
        </CardFooter>
      </Card>
    </>
  );
}
