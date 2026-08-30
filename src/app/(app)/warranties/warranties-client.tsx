'use client';

import Link from 'next/link';
import { StatusBadge } from '@/components/warranty/StatusBadge';
import { WarrantiesIcon } from '@/components/icons';
import { Card, CardBody, CardFooter } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, inputClass, selectClass } from '@/components/ui/form';
// Ruling P4: WARRANTY_SORTS/WarrantySort come from constants.ts (pure, client-safe), NOT
// from search.ts -- search.ts imports @/db/client, and a VALUE import from it (as opposed to
// a type-only one) drags better-sqlite3 into this client bundle and breaks `next build`.
import {
  billingCycleSuffixForKind,
  billScheduleLabel,
  expiryPhraseForKind,
  openEndedDisplayLabel,
  WARRANTY_SORTS,
  type ItemKind,
  type WarrantySort,
} from '@/lib/warranty/constants';
import { statusLabel, WARRANTY_STATUSES } from '@/lib/warranty/expiry';
import type { WarrantySearchResult } from '@/lib/warranty/search';

const SORT_LABELS: Record<WarrantySort, string> = {
  expiry: 'Soonest expiry',
  name: 'Name',
  // Item 5 (v1.16.0 plan): the underlying sort key (and the column it orders) is still called
  // `purchase` everywhere else -- only the two words a person actually reads changed, because
  // "purchase" is wrong for three of this page's five kinds (a loan is not purchased, a bill
  // is not purchased, a subscription is barely purchased).
  purchase: 'Newest start',
};

export function WarrantiesClient({
  result,
  people,
  types,
  today,
  query,
  status,
  owner,
  typeId,
  sort,
  billSchedules,
}: {
  result: WarrantySearchResult;
  people: { id: number; name: string }[];
  /** Delta T9: an optional type filter/select, alongside status/owner/sort. */
  types: { id: number; name: string; kind: ItemKind }[];
  today: string;
  query: string;
  status: string;
  owner: string;
  typeId: string;
  sort: WarrantySort;
  /** Item Q: a Bill's next due date and overdue count, keyed by item id. Built server-side in
   *  page.tsx from unpaidInstallments() -- see that file's docblock for why. */
  billSchedules: Record<number, { nextDueDate: string; overdueCount: number }>;
}) {
  const searching = query.trim().length > 0 || status !== '' || owner !== '' || typeId !== '';

  // M12: Prev/Next must preserve every other filter/sort param currently in force -- page 2+
  // was otherwise unreachable (no link anywhere pointed at it), which is silent data loss
  // past WARRANTY_PAGE_SIZE (50) rows.
  function pageHref(page: number): string {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query);
    if (status) params.set('status', status);
    if (owner) params.set('owner', owner);
    if (typeId) params.set('typeId', typeId);
    if (sort !== 'expiry') params.set('sort', sort);
    if (page > 1) params.set('page', String(page));
    const qs = params.toString();
    return qs ? `/warranties?${qs}` : '/warranties';
  }

  return (
    // Item 4 (v1.16.0 plan): the trimmed colgroup below still needs more than the shell's
    // standard 72rem (max-w-6xl) cap to sit comfortably beside eight columns -- the same
    // data-page-width escape hatch transactions-client.tsx and reports-client.tsx already use
    // (see globals.css's `main:has(> [data-page-width='wide'])` rule).
    <div data-page-width="wide" className="flex flex-col gap-6">
      <PageHeader
        title="Contracts & Coverage"
        description="Receipts, coverage and cancel-by dates for everything worth keeping the paperwork on."
        actions={
          <Link href="/warranties/new" className="btn btn--primary">
            Add item
          </Link>
        }
      />

      <PageGuide>
        <p>
          Five kinds of paperwork live on this page: warranties on things you bought,
          subscriptions you might want to cancel, contracts with a term, loans, and bills that
          fall due on set dates. They share one screen because the question is the same for all
          of them — what does this cover, and when does it run out?
        </p>
        <p>
          Each item carries the dates that matter and whose it is. What expires soonest surfaces
          on the Dashboard on its own, so nothing here has to be checked by hand to catch a
          cancel-by date. The filters compose, and the resulting view stays in the address bar.
        </p>
        <p>
          Attach the receipt or the document itself and the app reads the text off the image on
          this server, then makes every word printed on it searchable. A model number or a
          policy number you never typed in anywhere is enough to find the item years later. The
          image never leaves the machine the app runs on.
        </p>
        <p>
          A bill is the odd one out: instead of a monthly or annual cycle it carries a list of due
          dates you type in, which is what a property tax bill actually looks like. Make an item
          type of kind <strong>Bill</strong> under Settings → Item types, add the item here, and
          enter each due date on the item&rsquo;s own page. You are reminded before each one and
          told when one goes past.
        </p>
      </PageGuide>

      {result.error ? <Notice tone="error">{result.error}</Notice> : null}

      <Card>
        <CardBody className="pt-5">
          {/* A plain GET form: ?q=/?status=/?owner=/?typeId=/?sort= are all linkable and survive
              refresh (Ruling P12). The type filter chip composes with every other filter here --
              it does not replace any of them (type-deltas.md T9). */}
          <form method="get" className="flex flex-wrap items-end gap-3">
            {/* Item 4 (v1.16.0 plan): flex-1 beside four ~150px selects used to give this field
                roughly 400px on its own, out of proportion with the row beside it. max-w-sm
                caps it while keeping flex-1's grow-to-fill-the-gap behaviour on a wide screen. */}
            <Field label="Search" className="min-w-[14rem] max-w-sm flex-1">
              <input name="q" defaultValue={query} placeholder="Any word on the receipt or document" className={inputClass} />
            </Field>
            <Field label="Status">
              <select name="status" defaultValue={status} className={selectClass}>
                <option value="">All</option>
                {WARRANTY_STATUSES.map((value) => (
                  // M15: statusLabel() gives the human-readable text ("Active", "Expiring
                  // soon", ...); the option's VALUE stays the raw status code the server
                  // filters on. statusLabel() is subscription-agnostic by construction, and
                  // that is deliberate here too -- a filter option applies across both
                  // warranties and subscriptions at once, so it uses the neutral wording
                  // rather than either verb (expiryPhrase()'s "expires"/"cancel by" swap is
                  // for a single item's own row, not this generic bucket).
                  <option key={value} value={value}>{statusLabel(value, null, today)}</option>
                ))}
              </select>
            </Field>
            <Field label="Owner">
              <select name="owner" defaultValue={owner} className={selectClass}>
                <option value="">All</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>{person.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Type">
              <select name="typeId" defaultValue={typeId} className={selectClass}>
                <option value="">All</option>
                {types.map((type) => (
                  <option key={type.id} value={type.id}>{type.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Sort">
              <select name="sort" defaultValue={sort} className={selectClass}>
                {WARRANTY_SORTS.map((value) => (
                  <option key={value} value={value}>{SORT_LABELS[value]}</option>
                ))}
              </select>
            </Field>
            <button type="submit" className="btn btn--primary">Apply</button>
          </form>
        </CardBody>
      </Card>

      <Card>
        {result.rows.length === 0 ? (
          searching ? (
            <EmptyState
              icon={WarrantiesIcon}
              title="No matches for that search."
              action={
                <Link href="/warranties" className="btn btn--secondary btn--sm">
                  Clear filters
                </Link>
              }
            >
              Try fewer words, or clear the status and owner filters.
            </EmptyState>
          ) : (
            <EmptyState
              icon={WarrantiesIcon}
              title="Nothing tracked yet"
              action={
                <Link href="/warranties/new" className="btn btn--primary btn--sm">
                  Add the first one
                </Link>
              }
            >
              Add a warranty, subscription, contract, or loan — snap the receipt and this will remember the
              model, the price and when the cover runs out.
            </EmptyState>
          )
        ) : (
          /* Item 4 (v1.16.0 plan). The colgroup used to total 85rem (14+9+9+7+13+8+9+7+9) inside
             the shell's 72rem cap -- every desktop scrolled sideways, at any window size, hiding
             the last two columns even with one row. Two things fixed that together: Vendor
             stopped being a column (it is `--` on every loan and every contract, and now reads as
             a muted sub-line under the item name instead -- one whole 9rem column gone), and the
             remaining eight were trimmed to bring the total to 72rem, matching the shell's own
             cap so the table fits even without the data-page-width="wide" escape hatch below.
             minWidth is the colgroup's own total; without it .data-table's width:100% means the
             overflow-x-auto wrapper has nothing to scroll and the browser crushes every column
             instead -- see TableWrap's minWidth docblock. */
          <TableWrap bare fixed minWidth="72rem" responsive>
            <colgroup>
              {/* The item name (plus its vendor sub-line, when there is one) -- still the one
                  column people scan first. Left unsized it took whatever the other columns left
                  over, which on a long name meant a vertical column of characters. */}
              <col style={{ width: '13rem' }} />
              {/* An item-type name, rendered as a small badge. */}
              <col style={{ width: '9rem' }} />
              {/* An ISO date in tabular figures: the same width on every row. */}
              <col style={{ width: '7rem' }} />
              {/* A date, or -- for a Bill -- "2 overdue · next 2026-06-30" (item Q). */}
              <col style={{ width: '13rem' }} />
              {/* One badge. */}
              <col style={{ width: '8rem' }} />
              {/* A person's name, or "Household" -- neither needs 9rem. */}
              <col style={{ width: '7rem' }} />
              {/* A five-figure amount, right-aligned, on one line. */}
              <col style={{ width: '7rem' }} />
              {/* An amount plus its cycle suffix ("/mo" or a loan's longer "per month"). */}
              <col style={{ width: '8rem' }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Type</th>
                {/* Item 5 (v1.16.0 plan): this column is shared by all five kinds, so it cannot
                    say "Purchase date" (wrong for a loan, a bill, barely right for a
                    subscription) OR pick just one kind's own word -- "Started" is the one word
                    that reads correctly for all of them. The detail page, which knows the
                    item's actual kind, says more (see detailStartLabel there). */}
                <th scope="col">Started</th>
                <th scope="col">Expiry</th>
                <th scope="col">Status</th>
                <th scope="col">Owner</th>
                <th scope="col" className="text-right">Price</th>
                <th scope="col" className="text-right">Billing</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.id}>
                  {/* v1.15.0 (responsive rows): the item name is what tells one row from
                      another on this page, so it is the phone card's headline. */}
                  <td className="cell-stack-headline" data-label="Item">
                    <Link href={`/warranties/${row.id}`} className="font-medium text-ink hover:text-accent-text">{row.name}</Link>
                    {/* Item 4 (v1.16.0 plan): Vendor stopped being its own column -- it is `--`
                        on every loan and every contract, so it earned a whole 9rem for almost
                        nothing scanned. Nested in THIS <td>, not a sibling one: the table is
                        `fixed` with an explicit <colgroup> (one <col> per column), and a real
                        extra <td> here would desync the two. `cell-stack-meta` is inert outside
                        the phone media query (Lane A's rule lives there), so `text-xs
                        text-subtle` is what actually mutes it on every screen size. */}
                    {row.vendor ? <div className="cell-stack-meta text-xs text-subtle">{row.vendor}</div> : null}
                    {row.model ? <div className="text-xs text-subtle">{row.model}</div> : null}
                  </td>
                  <td data-label="Type">
                    {row.typeName ? (
                      <span className="badge badge--slate">{row.typeName}</span>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                  <td className="tabnum whitespace-nowrap text-muted" data-label="Started">{row.purchaseDate}</td>
                  {/* Delta T9, generalized to `kind` in v1.2.2 Task 2: expiryPhraseForKind()
                      supplies the expires/cancel by/ends on/paid off by verb -- no component
                      hard-codes any of them (MUST-19.11). v1.3.0 fix: an open-ended item
                      (isLifetime) has no expiry_date -- that used to render as a bare em dash
                      here, indistinguishable from "no data". Show the per-kind open-ended word
                      instead. */}
                  <td className="whitespace-nowrap text-muted" data-label="Expiry">
                    {/* Item Q: a bill has no expiry, it has a schedule. Every other kind falls through
                        unchanged -- this is one arm added ahead of the existing three, not a rewrite. */}
                    {row.kind === 'bill'
                      ? billScheduleLabel(
                          billSchedules[row.id]?.nextDueDate ?? null,
                          billSchedules[row.id]?.overdueCount ?? 0,
                        )
                      : row.isLifetime
                        ? openEndedDisplayLabel(row.kind)
                        : row.expiryDate === null
                          ? '—'
                          : expiryPhraseForKind(row.kind, row.expiryDate)}
                  </td>
                  <td data-label="Status">
                    <StatusBadge status={row.status} expiryDate={row.expiryDate} today={today} kind={row.kind} />
                  </td>
                  <td className="whitespace-nowrap text-muted" data-label="Owner">{row.ownerName}</td>
                  {/* Price, not Billing, is the money-column call: every warranty row (the
                      bulk of this table) carries a price, while Billing is populated only for
                      the subscription/loan minority -- the figure worth putting beside the
                      headline is the one that is actually there to scan. */}
                  <td className="text-right cell-stack-amount" data-label="Price">
                    {row.priceCents === null ? <span className="text-subtle">—</span> : <Money cents={row.priceCents} plain />}
                  </td>
                  {/* review fix: cycle and amount are a validated pair (BILLING_PAIR_ERROR) --
                      show the value only when BOTH are set, matching the detail page. Showing
                      the amount alone used to silently drop a cycle the member actually chose. */}
                  <td className="whitespace-nowrap text-right text-muted" data-label="Billing">
                    {row.billingCycle !== null && row.billingAmountCents !== null ? (
                      <>
                        <Money cents={row.billingAmountCents} plain /> {billingCycleSuffixForKind(row.kind, row.billingCycle)}
                      </>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}

        {result.pageCount > 1 ? (
          <CardFooter>
            <nav className="flex items-center gap-3" aria-label="Pages">
              <span>Page {result.page} of {result.pageCount} · {result.total} items</span>
              {result.page > 1 ? (
                <Link href={pageHref(result.page - 1)} className="font-medium text-accent-text underline underline-offset-2">Prev</Link>
              ) : null}
              {result.page < result.pageCount ? (
                <Link href={pageHref(result.page + 1)} className="font-medium text-accent-text underline underline-offset-2">Next</Link>
              ) : null}
            </nav>
          </CardFooter>
        ) : null}
      </Card>
    </div>
  );
}
