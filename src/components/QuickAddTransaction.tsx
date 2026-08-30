'use client';

import { useActionState, useEffect, useState } from 'react';
// Relative, not '@/...': tests/ops/client-bundle.test.ts walks every '@/'-value-import edge out of
// a 'use client' file looking for a path back to @/db/client. actions.ts is 'use server', but the
// guard is a source-level regex scan, not real webpack -- it does not know that boundary and would
// walk straight into actions.ts's own @/lib/accounts, @/lib/transactions, etc. imports and find
// @/db/client at the far end. A relative specifier is skipped by that walk (only '@/' edges are
// followed), which is exactly how transactions-client.tsx already imports the same actions.
import { manualEntryAction } from '../app/(app)/transactions/actions';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import { categoryOptionGroups, type CategoryLike } from '@/lib/category-order';

const initial: { error?: string; message?: string } = {};

/**
 * v1.13.0 ruling R7 (item AK / PROD-4). With no bank sync, hand entry is the main loop for cash and
 * e-transfers, and until now the only way in was a seven-field form below fifty table rows.
 *
 * It posts to the EXISTING manualEntryAction rather than a new one: two entry points writing a
 * transaction through two code paths is how the two drift. Task 13 renders this same component
 * with `variant="card"` on the dashboard; this file is this task's alone, that one only imports it.
 *
 * DIRECTION IS DERIVED, NOT ASKED. Six controls fit on a phone; seven do not, and money-out is the
 * overwhelming majority. A leading '+' means money in -- the same convention a spreadsheet uses --
 * and the hint under the field says so, because a convention nobody is told is a trap.
 */
export function QuickAddTransaction({
  accounts,
  categories,
  people,
  today,
  defaultAccountId,
  variant,
  collapsible = false,
}: {
  accounts: { id: number; name: string }[];
  categories: CategoryLike[];
  people: { id: number; name: string }[];
  today: string;
  /** users.last_account_id, or null on this person's first entry. */
  defaultAccountId: number | null;
  /** 'page' anchors it at #quick-add with a heading; 'card' is the dashboard's compact form. */
  variant: 'page' | 'card';
  /**
   * Ruling S6 (v1.15.0): on Transactions this form is ~600px sitting above the first data row of
   * a page whose job is reading rows -- the biggest single measured win of the responsive-rows
   * release. Default false so the dashboard's `variant="card"` render (Task 13, v1.13.0) stays
   * byte-identical to before this ruling: `isDisclosure` below is false unless BOTH this is true
   * AND `variant === 'page'`, so passing it accidentally on the card variant is inert rather than
   * a silent behaviour change on the dashboard.
   */
  collapsible?: boolean;
}) {
  const [state, action] = useActionState(manualEntryAction, initial);
  const [direction, setDirection] = useState<'spend' | 'income'>('spend');
  const groups = categoryOptionGroups(categories);
  const accountValue = defaultAccountId === null ? 'cash' : String(defaultAccountId);
  const isDisclosure = collapsible && variant === 'page';
  // Closed by default when it is a disclosure at all; otherwise always open, which is the exact
  // pre-ruling-S6 behaviour every existing caller (and every existing test) still gets.
  const [open, setOpen] = useState(!isDisclosure);

  // Ruling S6: the PWA manifest shortcut (v1.13.0 ruling R7) targets `#quick-add` and must still
  // land on an OPEN form even though this now starts closed on Transactions. `window.location`
  // does not exist during the server render, so it is read here, in an effect, and NEVER in the
  // render body -- reading it during render would print the server's "closed" markup and then
  // flip to "open" the instant this effect ran on the client, which is exactly what a hydration
  // mismatch is.
  useEffect(() => {
    if (isDisclosure && window.location.hash === '#quick-add') setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const form = (
    <form action={action} className="grid gap-3 sm:grid-cols-6">
      <input type="hidden" name="direction" value={direction} />
      <Field label="Amount" className="sm:col-span-1" hint="Start with + for money in">
        <input
          name="amount"
          inputMode="decimal"
          placeholder="12.34"
          required
          className={inputClass}
          onInput={(event) => setDirection(event.currentTarget.value.trim().startsWith('+') ? 'income' : 'spend')}
        />
      </Field>
      <Field label="Description" className="sm:col-span-2">
        <input name="description" required className={inputClass} />
      </Field>
      <Field label="Date" className="sm:col-span-1">
        <input type="date" name="date" defaultValue={today} required className={inputClass} />
      </Field>
      <Field label="Account" className="sm:col-span-1">
        <select name="accountId" defaultValue={accountValue} className={selectClass}>
          <option value="cash">My cash</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Category" className="sm:col-span-1">
        <select name="categoryId" className={selectClass}>
          <option value="">Leave to the categorizer</option>
          {groups.map((group) =>
            group.label === null ? (
              <option key={group.options[0].id} value={group.options[0].id}>
                {group.options[0].label}
              </option>
            ) : (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ),
          )}
        </select>
      </Field>
      {people.length > 0 ? (
        // Item BO: /transactions passes people: [] for a self viewer, which left this select
        // with a lone "Account default" option -- a control that cannot do anything. No new
        // prop: an empty roster is exactly the condition.
        <Field label="Person" className="sm:col-span-1">
          <select name="attributedUserId" className={selectClass}>
            <option value="">Account default</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <input type="hidden" name="notes" value="" />
      <div className="sm:col-span-6">
        <SubmitButton className="w-fit">Add</SubmitButton>
        <FormError message={state.error} />
        {state.message ? (
          <p role="status" className="mt-1 text-xs text-muted">
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );

  const body = (
    <Card as="div">
      <CardHeader
        title="Quick add"
        description="Cash, an e-transfer, anything the bank will not send you."
        action={
          isDisclosure ? (
            // 44px floor (global constraint) on anything new: `btn--sm`'s own padding alone
            // lands well under it on a phone, so `min-h-11 sm:min-h-0` is explicit here rather
            // than relied on from the class alone.
            <button
              type="button"
              className="btn btn--secondary btn--sm min-h-11 sm:min-h-0"
              aria-expanded={open}
              aria-controls="quick-add-body"
              onClick={() => setOpen((prev) => !prev)}
            >
              {open ? 'Close' : 'Add a transaction'}
            </button>
          ) : undefined
        }
      />
      {/* Collapsed, this simply does not render the form rather than hiding it with CSS -- unlike
          the filters disclosure (ruling S7, transactions-client.tsx), which must keep its fields
          mounted so a hand-edited URL's values are never lost mid-toggle. Quick add has no such
          state to preserve while closed: it is a blank create form either way.
          CardBody itself takes no `id` prop (out of scope to add one -- Card.tsx belongs to
          neither file this task may touch), so the `aria-controls` target is this thin wrapping
          div instead. */}
      {open ? (
        <div id="quick-add-body">
          <CardBody>{form}</CardBody>
        </div>
      ) : null}
    </Card>
  );

  if (variant === 'card') return body;

  // Card does not accept an `id` prop, so the #quick-add anchor (the manifest shortcut's target,
  // ruling R7) lives on a wrapping div instead.
  return <div id="quick-add">{body}</div>;
}
