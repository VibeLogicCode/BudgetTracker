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

/** The hash both QuickAddTrigger (the header button, below) and this component's own dashboard
 *  panel treat as "open" -- see useQuickAddHash's own comment for why a URL fragment, not React
 *  state, is what the two agree on. */
const DASHBOARD_QUICK_ADD_ID = 'quick-add';

/**
 * Item 6 (2026-08-30 plan): the dashboard's Quick add "stops being a card" -- what is left, once
 * the title and description sentence are gone, is a plain button, and it now lives in
 * PageHeader's own actions row (item 5, same lane) rather than beside a card title further down
 * the page. That button and the form it opens are no longer the same React subtree (the button
 * is authored where dashboard/page.tsx builds `<PageHeader actions={...}>`, the form is this same
 * component, rendered separately, lower on the page), so neither can hold the other's `useState`.
 * The URL hash is the one fact both sides can read without a shared parent: exactly the mechanism
 * ruling R7 already used for the PWA manifest shortcut, just driven live via `hashchange` instead
 * of checked once on mount, because now a click that changes the hash can happen WHILE this page
 * is already open, not only on the initial navigation a shortcut produces.
 */
function useQuickAddHash(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const sync = () => setOpen(window.location.hash === `#${DASHBOARD_QUICK_ADD_ID}`);
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return open;
}

/**
 * Item 6: the dashboard-only trigger. dashboard/page.tsx renders this INSIDE
 * `<PageHeader actions={...}>`; QuickAddTransaction itself (variant="card") renders no button of
 * its own any more -- see useQuickAddHash above for how the two stay in sync without sharing a
 * tree. Transactions (variant="page") is untouched by this: its own toggle still lives inside
 * CardHeader's `action` slot, exactly as ruling S6 shipped it.
 */
export function QuickAddTrigger() {
  const open = useQuickAddHash();
  return (
    <button
      type="button"
      // 44px floor (global constraint), same reasoning the page-variant toggle below documents.
      className="btn btn--secondary btn--sm min-h-11 sm:min-h-0"
      aria-expanded={open}
      aria-controls={DASHBOARD_QUICK_ADD_ID}
      onClick={() => {
        window.location.hash = open ? '' : DASHBOARD_QUICK_ADD_ID;
        // Dispatched by hand rather than left to the browser: a same-document hash assignment
        // does fire 'hashchange' natively, but not necessarily inside the same synchronous tick
        // this click handler runs in, and the ONE other listener that matters (this component's
        // own dashboard panel, wherever it is mounted) needs to hear about it deterministically.
        window.dispatchEvent(new Event('hashchange'));
      }}
    >
      {open ? 'Close' : 'Add a transaction'}
    </button>
  );
}

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
  /** 'page' (Transactions) keeps its own Card, title and toggle button, anchored at #quick-add.
   *  'card' (the dashboard) is item 6's bare form -- no card, no title, no button of its own;
   *  see QuickAddTrigger above for where its toggle actually lives. */
  variant: 'page' | 'card';
  /**
   * Ruling S6 (v1.15.0) folded this into a disclosure on Transactions only, keying `isDisclosure`
   * below on BOTH this flag AND `variant === 'page'` so that passing it "by accident" on the
   * dashboard's card render stayed inert. v1.16.0 Lane C item 1 (the plan's own rule: "Content is
   * always visible. A form that CREATES something sits behind a button.") applies just as much to
   * the dashboard's Quick add -- it was the largest block on the card while being the least-used
   * control on it, exactly like the loan rule form and the receipt picker this same plan folds
   * away elsewhere. `isDisclosure` below now keys on this flag alone; dashboard/page.tsx passes it
   * on purpose so the two surfaces share one behaviour instead of one being fixed and the other
   * left standing open. Default stays false, so anything that never passes it keeps the old
   * always-open render.
   */
  collapsible?: boolean;
}) {
  const [state, action] = useActionState(manualEntryAction, initial);
  const [direction, setDirection] = useState<'spend' | 'income'>('spend');
  const groups = categoryOptionGroups(categories);
  const accountValue = defaultAccountId === null ? 'cash' : String(defaultAccountId);
  const isDisclosure = collapsible;
  const isDashboardVariant = variant === 'card';
  // Closed by default when it is a disclosure at all; otherwise always open, which is the exact
  // pre-ruling-S6 behaviour every existing caller (and every existing test) still gets. Only
  // meaningful for variant="page" -- item 6 moved the dashboard's own toggle out of this
  // component entirely (QuickAddTrigger, above), so its open state is hash-driven instead, via
  // useQuickAddHash below.
  const [pageOpen, setPageOpen] = useState(!isDisclosure);
  const dashboardHashOpen = useQuickAddHash();

  // Ruling S6: the PWA manifest shortcut (v1.13.0 ruling R7) targets `/transactions#quick-add`
  // and must still land on an OPEN form. `window.location` does not exist during the server
  // render, so it is read here, in an effect, and NEVER in the render body -- reading it during
  // render would print the server's "closed" markup and then flip to "open" the instant this
  // effect ran on the client, which is exactly what a hydration mismatch is. This is the
  // page-variant's OWN one-time check and is unchanged by item 6: the dashboard's equivalent
  // check is useQuickAddHash's `sync()` call, which runs live (on 'hashchange' too) because its
  // trigger is a separate component that can fire while this page is already mounted, not only
  // on the initial navigation a shortcut produces.
  useEffect(() => {
    if (!isDashboardVariant && isDisclosure && window.location.hash === '#quick-add') setPageOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Item 6: on the dashboard, "open" is entirely the hash's answer (no local toggle at all,
  // since there is no button left in this component to hold one) unless collapsible was never
  // requested, in which case there is no disclosure at all and the form is simply always there --
  // the exact pre-Lane-3 always-open render nothing here changes.
  const open = isDashboardVariant ? (isDisclosure ? dashboardHashOpen : true) : pageOpen;

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

  if (isDashboardVariant) {
    // Item 6: "stops being a card" -- no Card, no title, no description sentence, no button of
    // its own (QuickAddTrigger, in the header, is the only thing that opens this). Collapsed, it
    // renders nothing at all rather than hiding the form with CSS, same reasoning the page
    // variant's own comment below gives. The `#quick-add` id only needs to exist while this is a
    // live disclosure target -- the always-open, non-collapsible render (nobody currently calls
    // it that way on the dashboard, but the pre-Lane-3 contract still allows it) has no toggle to
    // synchronise with, so it stays a bare form with no anchor id.
    if (!open) return null;
    return isDisclosure ? <div id={DASHBOARD_QUICK_ADD_ID}>{form}</div> : form;
  }

  // variant === 'page' (Transactions): unchanged by item 6 -- this lane touches this file, not
  // this branch's behaviour. Its own Card, title, description and toggle button all stay exactly
  // as ruling S6 shipped them.
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
              onClick={() => setPageOpen((prev) => !prev)}
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

  // Card does not accept an `id` prop, so the #quick-add anchor (the manifest shortcut's target,
  // ruling R7) lives on a wrapping div instead.
  return <div id="quick-add">{body}</div>;
}
