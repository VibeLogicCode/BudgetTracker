'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { TransactionsIcon } from '@/components/icons';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { Field, inputClass, labelClass, selectClass } from '@/components/ui/form';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { categoryOptions, type CategoryLike } from '@/lib/category-order';
import { type ResolvedRange } from '@/lib/date-range';
import type { LoanLink } from '@/lib/loans';
import { formatCents, parseAmountToCents, sumCents } from '@/lib/money';
import type { SplitRow } from '@/lib/splits';
import type { TransactionPage, TransactionRow } from '@/lib/transactions';
import {
  assignToLoanAction,
  bulkCategorizeAction,
  bulkTransferAction,
  manualEntryAction,
  renameTransactionAction,
  saveSplitsAction,
  setAttributionAction,
  setCategoryAction,
  unassignFromLoanAction,
  type ActionState,
} from './actions';

interface Option { id: number; name: string; parentId?: number | null; isArchived?: boolean }
interface LoanOption { id: number; name: string }

/** Draft state for one row of the split editor. Amounts are kept as the raw dollar text the
 *  person is typing (parsed with parseAmountToCents only at remainder/submit time) so a
 *  half-typed value like "12." never gets silently rewritten under someone's cursor. */
interface SplitPartDraft {
  categoryId: string;
  amount: string;
  note: string;
}

const blankSplitPart = (): SplitPartDraft => ({ categoryId: '', amount: '', note: '' });

const initial: ActionState = {};

/** The dense per-row controls: small, quiet, and not competing with the amounts. */
const rowControl = 'field-control w-auto max-w-[11rem] px-2 py-1 text-xs';

export function TransactionsClient({
  page,
  accounts,
  categories,
  people,
  today,
  range = null,
  loanOptions = [],
  loanLinks = {},
  splits = {},
}: {
  page: TransactionPage;
  accounts: Option[];
  categories: CategoryLike[];
  people: Option[];
  today: string;
  range?: ResolvedRange | null;
  /** v1.3.1: loans with a balance still owed. Empty for a household with none (MUST-14.9). */
  loanOptions?: LoanOption[];
  loanLinks?: Record<number, LoanLink[]>;
  /** v1.7.0 Task 4: existing splits for the rows on this page, keyed by transaction id. A
   *  row absent from this map (or mapped to an empty array) has never been split. */
  splits?: Record<number, SplitRow[]>;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [renaming, setRenaming] = useState<{ id: number; current: string; merchant: string } | null>(null);
  const [splitting, setSplitting] = useState<{ id: number; amountCents: number; parts: SplitPartDraft[] } | null>(null);
  const [manualState, manualAction] = useActionState(manualEntryAction, initial);
  const [rowState, rowAction] = useActionState(setCategoryAction, initial);
  const [attrState, attrAction] = useActionState(setAttributionAction, initial);
  const [bulkCatState, bulkCatAction] = useActionState(bulkCategorizeAction, initial);
  const [bulkTfrState, bulkTfrAction] = useActionState(bulkTransferAction, initial);
  const [renameState, renameAction] = useActionState(renameTransactionAction, initial);
  const [assignState, assignLoan] = useActionState(
    (_prev: ActionState, formData: FormData) => assignToLoanAction(formData),
    initial,
  );
  const [unassignState, unassignLoan] = useActionState(
    (_prev: ActionState, formData: FormData) => unassignFromLoanAction(formData),
    initial,
  );
  const [splitState, splitAction] = useActionState(saveSplitsAction, initial);

  const label = (id: number | null) => {
    if (id === null) return 'Uncategorized';
    const category = categories.find((c) => c.id === id);
    if (!category) return 'Uncategorized';
    const parent = category.parentId ? categories.find((c) => c.id === category.parentId) : undefined;
    return parent ? `${parent.name} › ${category.name}` : category.name;
  };

  // Filters, bulk actions and new entries must only ever assign a live category, and
  // categoryOptions() excludes archived categories itself -- so all five category selects in
  // this file now share one ordering helper (Task 6, v1.8.0) rather than each mapping the flat
  // creation-order list on its own. That sharing IS the fix: the original report was that one
  // screen showed `Kids, Fees, Fees > Bank Fees, Kids > Education`, and a per-call-site loop is
  // exactly how a future new category reintroduces that on one select only.
  //
  // The per-row select below additionally appends the ARCHIVED categories, flat and disabled,
  // after the grouped live ones. That coverage is deliberate: a row already carrying a category
  // that was archived after the fact must still have a real <option> for it, or the browser's
  // initial selection cannot match, the select falls back to "Uncategorized", and an untouched
  // "save" click clears (and untrains) a legitimate historical categorization.
  const groupedCategories = categoryOptions(categories);

  const toggle = (id: number) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  // v1.7.0 bulk-guard fix: Categorize and Mark transfer both silently skip a split
  // transaction now (its money already lives in transaction_splits, not this row's own
  // category/transfer flag -- see the guard in src/lib/categorize/engine.ts). Selection
  // itself stays open to a split row on purpose, because bulk ATTRIBUTION is still valid on
  // one (ruling 1: attribution is whole-transaction) -- this count only powers a cheap
  // heads-up in the toolbar below, never a disabled checkbox.
  const selectedSplitCount = selected.filter((id) => (splits[id] ?? []).length > 0).length;
  const notice =
    manualState.message ?? rowState.message ?? attrState.message ?? bulkCatState.message ?? bulkTfrState.message ??
    renameState.message ?? assignState.message ?? unassignState.message ?? splitState.message;
  const error =
    manualState.error ?? rowState.error ?? attrState.error ?? bulkCatState.error ?? bulkTfrState.error ??
    renameState.error ?? assignState.error ?? unassignState.error ?? splitState.error;

  // Opens this row's split editor, prefilled from its existing parts (or two blank parts for
  // a fresh split) -- the same "one editor, one nullable slot of state" shape `renaming` uses,
  // so opening a different row's editor always replaces whichever one was already open.
  const openSplitEditor = (row: TransactionRow) => {
    const existing = splits[row.id] ?? [];
    setSplitting({
      id: row.id,
      amountCents: row.amountCents,
      parts:
        existing.length > 0
          ? existing.map((part) => ({
              categoryId: String(part.categoryId),
              amount: (Math.abs(part.amountCents) / 100).toFixed(2),
              note: part.note ?? '',
            }))
          : [blankSplitPart(), blankSplitPart()],
    });
  };

  const updateSplitPart = (index: number, patch: Partial<SplitPartDraft>) => {
    setSplitting((prev) => (prev ? { ...prev, parts: prev.parts.map((part, i) => (i === index ? { ...part, ...patch } : part)) } : prev));
  };
  const addSplitPart = () => {
    setSplitting((prev) => (prev ? { ...prev, parts: [...prev.parts, blankSplitPart()] } : prev));
  };
  const removeSplitPart = (index: number) => {
    setSplitting((prev) => (prev ? { ...prev, parts: prev.parts.filter((_, i) => i !== index) } : prev));
  };

  // Amounts are always typed as a plain positive dollar figure -- the parent's own sign is
  // applied here rather than asked of the person, so splitting a $50 expense means typing
  // "30.00" and "20.00", never "-30.00". parseAmountToCents (not hand-rolled parsing) does the
  // actual decimal-to-cents conversion; an unparsable/blank amount counts as 0 toward the
  // remainder rather than blocking every other keystroke with an error.
  const splitSign = splitting !== null && splitting.amountCents < 0 ? -1 : 1;
  const draftPartCents = (part: SplitPartDraft): number => {
    const parsed = parseAmountToCents(part.amount);
    return parsed === null ? 0 : Math.abs(parsed) * splitSign;
  };
  // A blank row added by "Add a part" and never given a category is dropped rather than
  // submitted (and left out of the remainder math below) -- it was never really a part.
  const activeSplitParts = splitting ? splitting.parts.filter((part) => part.categoryId !== '') : [];
  const splitPartsPayload = activeSplitParts.map((part) => ({
    categoryId: Number(part.categoryId),
    amountCents: draftPartCents(part),
    note: part.note.trim() === '' ? null : part.note.trim(),
  }));
  const splitRemainderCents = splitting ? splitting.amountCents - sumCents(activeSplitParts.map(draftPartCents)) : 0;

  return (
    // data-page-width: this table needs more than the shell's 6xl reading cap (see globals.css).
    <div data-page-width="wide" className="flex flex-col gap-6">
      <PageHeader title="Transactions" description="Every line from every account, with what it was spent on." />

      {/* `page.rows.length === 0` is the same test the table's own "Nothing matches these
          filters" state is rendered on, deliberately rather than a second count of the whole
          ledger: on a filtered view with no hits the reader is looking at an empty screen
          either way, and that is when the explanation of how the filters compose is worth
          having open. */}
      <PageGuide empty={page.rows.length === 0}>
        <p>
          Every line from every imported statement lands here. The filters above compose rather
          than replace one another, so a date range, an account, a category, a person and a
          search term all narrow the same list at once — and the address bar keeps whatever you
          picked, so a filtered view can be bookmarked or shared.
        </p>
        <p>
          One charge can belong to more than one category. Open a row and split it into parts,
          and each part counts towards its own category in Budgets and Reports instead of the
          whole amount landing on the first one.
        </p>
        <p>
          An imported amount is fixed here. You can rename the merchant, change the category,
          attribute the row to a person or mark it a transfer, but the figure itself comes from
          the statement — if that is wrong, undo the import on the Import page and bring the
          corrected file in again.
        </p>
      </PageGuide>

      <FormError message={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {renaming ? (
        <Card as="div">
          <CardHeader
            title="Rename this merchant"
            description="The bank's text is kept exactly as-is behind the scenes — renaming changes only what you see, and never affects duplicate detection or how the categorizer learns."
          />
          <CardBody>
            <form action={renameAction} onSubmit={() => setRenaming(null)} className="flex flex-col gap-4">
              <input type="hidden" name="transactionId" value={renaming.id} />
              <Field label="Display name" hint="Leave it empty to go back to the bank's wording." className="max-w-md">
                <input name="displayName" defaultValue={renaming.current} autoFocus className={inputClass} />
              </Field>
              <fieldset className="flex flex-col gap-2">
                <legend className={labelClass}>Apply to</legend>
                <label className="flex items-center gap-2 text-sm text-muted">
                  <input type="radio" name="scope" value="one" defaultChecked className="accent-accent" /> This transaction only
                </label>
                <label className="flex items-center gap-2 text-sm text-muted">
                  <input type="radio" name="scope" value="all" className="accent-accent" /> All matching{' '}
                  <code className="rounded bg-surface-2 px-1 font-mono text-xs text-ink">{renaming.merchant}</code> + future imports
                  (creates a rename rule)
                </label>
              </fieldset>
              <div className="flex gap-2">
                <SubmitButton>Save name</SubmitButton>
                <button type="button" onClick={() => setRenaming(null)} className="btn btn--secondary">
                  Cancel
                </button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {splitting ? (
        <Card as="div">
          <CardHeader
            title="Split this transaction"
            description="Divide this transaction across more than one category. The parts must add up to the full amount."
          />
          <CardBody className="flex flex-col gap-4">
            <form action={splitAction} onSubmit={() => setSplitting(null)} className="flex flex-col gap-4">
              <input type="hidden" name="txnId" value={splitting.id} />
              <input type="hidden" name="parts" value={JSON.stringify(splitPartsPayload)} />
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-2 text-xs font-medium text-muted">
                  <span className="w-44">Category</span>
                  <span className="w-24">Amount</span>
                  <span className="flex-1">Note</span>
                </div>
                {splitting.parts.map((part, index) => (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    <select
                      value={part.categoryId}
                      onChange={(e) => updateSplitPart(index, { categoryId: e.target.value })}
                      aria-label={`Category for part ${index + 1}`}
                      className={`${selectClass} w-44`}
                    >
                      <option value="">Choose a category</option>
                      {/* Task 6: children grouped directly under their parent via categoryOptions,
                          instead of the flat creation-order list every category select used to
                          show. categoryOptions() already excludes archived categories, matching
                          this select's own live-category-only rule. */}
                      {categoryOptions(categories).map((opt) => (
                        <option key={opt.id} value={opt.id}>{'\u00A0\u00A0'.repeat(opt.depth) + opt.label}</option>
                      ))}
                    </select>
                    <input
                      value={part.amount}
                      onChange={(e) => updateSplitPart(index, { amount: e.target.value })}
                      placeholder="0.00"
                      inputMode="decimal"
                      aria-label={`Amount for part ${index + 1}`}
                      className={`${inputClass} w-24`}
                    />
                    <input
                      value={part.note}
                      onChange={(e) => updateSplitPart(index, { note: e.target.value })}
                      placeholder="Note (optional)"
                      aria-label={`Note for part ${index + 1}`}
                      className={`${inputClass} flex-1 min-w-[10rem]`}
                    />
                    <button
                      type="button"
                      onClick={() => removeSplitPart(index)}
                      disabled={splitting.parts.length <= 2}
                      className="btn btn--ghost btn--sm px-2 text-xs"
                    >
                      Remove part
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={addSplitPart} className="btn btn--secondary btn--sm">
                  Add a part
                </button>
                <span className="text-sm text-muted">Remaining to assign: {formatCents(splitRemainderCents)}</span>
              </div>
              <div className="flex gap-2">
                <SubmitButton disabled={splitRemainderCents !== 0}>Save split</SubmitButton>
                <button type="button" onClick={() => setSplitting(null)} className="btn btn--secondary">
                  Cancel
                </button>
              </div>
            </form>
            <form action={splitAction} onSubmit={() => setSplitting(null)}>
              <input type="hidden" name="txnId" value={splitting.id} />
              <input type="hidden" name="parts" value="[]" />
              <SubmitButton variant="secondary">Remove split</SubmitButton>
            </form>
          </CardBody>
        </Card>
      ) : null}

      <Card as="div">
        <CardBody className="pt-5">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <Field label="Account">
              <select name="account" className={selectClass}>
                <option value="">All</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Category">
              <select name="category" className={selectClass}>
                <option value="">All</option>
                <option value="uncategorized">Uncategorized</option>
                {groupedCategories.map((opt) => (
                  <option key={opt.id} value={opt.id}>{'\u00A0\u00A0'.repeat(opt.depth) + opt.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Person">
              <select name="person" className={selectClass}>
                <option value="">Everyone</option>
                <option value="unattributed">Household/unattributed</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <DateRangePicker
              allowAny
              value={range?.preset ?? ''}
              from={range?.from ?? ''}
              to={range?.to ?? ''}
              today={today}
            />
            <Field label="Search" className="min-w-[12rem] flex-1">
              <input name="q" placeholder="Merchant text" className={inputClass} />
            </Field>
            <div className="flex flex-wrap items-center gap-4 py-2">
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" name="uncat" value="1" className="accent-accent" /> Uncategorized only
              </label>
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" name="transfers" value="0" className="accent-accent" /> Hide transfers
              </label>
            </div>
            <button type="submit" className="btn btn--primary">Filter</button>
          </form>
        </CardBody>
      </Card>

      {selected.length > 0 ? (
        <div className="flex flex-wrap items-end gap-4 rounded-lg border border-accent-soft bg-accent-soft px-4 py-3">
          <span className="py-2 text-sm font-semibold text-accent-soft-fg">{selected.length} selected</span>
          {selectedSplitCount > 0 ? (
            <p className="w-full text-xs text-accent-soft-fg">
              {selectedSplitCount} of {selected.length} selected {selectedSplitCount === 1 ? 'is' : 'are'} split and will be
              skipped by Categorize and Mark transfer.
            </p>
          ) : null}
          <form action={bulkCatAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="ids" value={selected.join(',')} />
            <select name="categoryId" aria-label="Category for the selected transactions" className={selectClass}>
              {groupedCategories.map((opt) => (
                <option key={opt.id} value={opt.id}>{'\u00A0\u00A0'.repeat(opt.depth) + opt.label}</option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-sm text-accent-soft-fg">
              <input type="checkbox" name="createRules" defaultChecked className="accent-accent" /> create rules
            </label>
            <SubmitButton>Categorize</SubmitButton>
          </form>
          <form action={attrAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="ids" value={selected.join(',')} />
            <select name="attributedUserId" aria-label="Person for the selected transactions" className={selectClass}>
              <option value="">Household/unattributed</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <SubmitButton>Attribute</SubmitButton>
          </form>
          <form action={bulkTfrAction} className="flex items-center gap-2">
            <input type="hidden" name="ids" value={selected.join(',')} />
            <input type="hidden" name="isTransfer" value="1" />
            <SubmitButton variant="secondary">Mark transfer</SubmitButton>
          </form>
        </div>
      ) : null}

      <Card as="div">
        {/* `fixed` because five of these eight columns carry controls, not text. Under auto
            layout the browser gave Description and Account every pixel their longest string
            asked for and the row grew past the shell's content width, so the actions column
            fell off the right edge of the card and read as truncated data.

            The widths below are sized from what each cell must show WITHOUT clipping, in that
            order of priority: a select is sized so its own selected value stays readable (the
            row's category and person are data), a link is sized so its label fits on one line,
            and Description takes what is left. That leaves Description narrow enough to wrap a
            long bank string over two or three lines, which is the deliberate trade: a taller
            row shows everything, a wider one would have to hide a control's value to pay for
            it. They sum to 67rem, inside the shell's 68rem content width, and the wrapper
            still scrolls below that so no column is ever cut off on a phone. */}
        {/* minWidth is the colgroup's own total. Without it this table could not exceed its
            container, so the scroll container had nothing to scroll and the browser shrank
            every column instead -- see TableWrap's minWidth docblock for what that did to a
            phone. */}
        <TableWrap bare fixed minWidth="76rem">
          <colgroup>
            {/* Just the checkbox, plus the 1rem of cell padding either side. */}
            <col style={{ width: '3rem' }} />
            {/* An ISO date in tabular figures, which is the same width on every row. */}
            <col style={{ width: '7rem' }} />
            {/* Wide enough to READ an account name. This was 5rem for one release, which
                truncated "Amex - Chequing" to "Amex…" -- and a `title` is no answer on a phone,
                where there is no hover. Buying a rem for the description by making a column
                unreadable is not a trade worth making. */}
            <col style={{ width: '9rem' }} />
            {/* An explicit width, NOT elastic. Left unsized it took "whatever the others do not
                need", which is generous on a wide monitor and nothing at all on a narrow one:
                the sized columns took their rem and this one collapsed to a single character,
                spelling merchant names vertically. A real width plus the table's min-width means
                narrow viewports scroll instead of crushing this column. */}
            <col style={{ width: '15rem' }} />
            {/* A signed five-figure amount on one line. */}
            <col style={{ width: '7rem' }} />
            {/* The widest control on the row: the category select has to show a name as long as
                "Uncategorized" beside its Save button. */}
            <col style={{ width: '13rem' }} />
            {/* Same shape, shorter values -- a person's name or "Household". */}
            <col style={{ width: '11rem' }} />
            {/* Holds "Create warranty", "Split…", and -- when loans exist -- an "Assign to
                loan" select beside its Assign button. 11rem keeps the first two on one line
                each rather than three separate lines, which is what tripled row height. */}
            <col style={{ width: '11rem' }} />
          </colgroup>
          <thead>
            <tr>
              {/* No width class on the header cells: the colgroup owns the widths now. */}
              <th scope="col" />
              <th scope="col">Date</th>
              <th scope="col">Account</th>
              <th scope="col">Description</th>
              <th scope="col" className="text-right">Amount</th>
              <th scope="col">Category</th>
              <th scope="col">Person</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.includes(row.id)}
                    onChange={() => toggle(row.id)}
                    aria-label={`Select transaction ${row.id}`}
                    className="accent-accent"
                  />
                </td>
                <td className="tabnum whitespace-nowrap text-muted">{row.date}</td>
                {/* Wraps rather than clips, and keeps the title as a courtesy for a very long
                    name. An ellipsis here relied on hover to recover the value, which a phone
                    does not have. */}
                <td className="text-muted" title={row.accountName}>{row.accountName}</td>
                <td>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setRenaming({ id: row.id, current: row.displayDescription ?? row.rawDescription, merchant: row.normalizedMerchant })}
                      title={row.displayDescription ? `Bank text: ${row.rawDescription}` : 'Click to rename'}
                      className="rounded-xs text-left font-medium text-ink hover:text-accent-text"
                    >
                      {row.displayDescription ?? row.rawDescription}
                    </button>
                    {row.displaySource === 'manual' ? <span className="badge badge--blue">renamed</span> : null}
                    {row.displaySource === 'rename' ? <span className="badge badge--blue">rule</span> : null}
                    {row.isTransfer ? <span className="badge badge--slate">transfer</span> : null}
                    {row.source === 'bayes' ? <span className="badge badge--amber">guess</span> : null}
                  </span>
                </td>
                <AmountCell className="whitespace-nowrap">
                  <Money cents={row.amountCents} />
                </AmountCell>
                <td>
                  {/* v1.7.0 Task 4: a split transaction no longer has ONE category to select
                      -- its money is divided across its parts' own categories -- so the
                      row's category cell shows a badge instead of the recategorize form.
                      Editing what those parts ARE happens through "Split…" below. */}
                  {(splits[row.id] ?? []).length > 0 ? (
                    <span className="badge badge--blue">{`Split · ${(splits[row.id] ?? []).length} parts`}</span>
                  ) : (
                    <form action={rowAction} className="flex items-center gap-1.5">
                      <input type="hidden" name="transactionId" value={row.id} />
                      <select
                        name="categoryId"
                        defaultValue={row.categoryId ?? ''}
                        aria-label={`Category for transaction ${row.id}`}
                        className={rowControl}
                      >
                        <option value="">Uncategorized</option>
                        {/* Task 6: live categories grouped under their parent via categoryOptions
                            (it excludes archived ones itself). Archived categories are appended
                            below, flat and disabled, rather than run through the same grouping --
                            full (archived-inclusive) COVERAGE stays on purpose: if this row's own
                            category was archived after the fact, it must still appear as a real
                            <option> so the browser's initial selection matches it. Otherwise the
                            select silently falls back to "Uncategorized" and an untouched "save"
                            click would clear (and untrain) a legitimate historical categorization. */}
                        {categoryOptions(categories).map((opt) => (
                          <option key={opt.id} value={opt.id}>{'\u00A0\u00A0'.repeat(opt.depth) + opt.label}</option>
                        ))}
                        {categories
                          .filter((c) => c.isArchived)
                          .map((c) => (
                            <option key={c.id} value={c.id} disabled>
                              {label(c.id)} (archived)
                            </option>
                          ))}
                      </select>
                      <button type="submit" className="btn btn--ghost btn--sm px-2 text-xs">Save</button>
                    </form>
                  )}
                </td>
                <td>
                  <form action={attrAction} className="flex items-center gap-1.5">
                    <input type="hidden" name="ids" value={row.id} />
                    <select
                      name="attributedUserId"
                      defaultValue={row.attributedUserId ?? ''}
                      aria-label={`Person for transaction ${row.id}`}
                      className={rowControl}
                    >
                      <option value="">Household</option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    <button type="submit" className="btn btn--ghost btn--sm px-2 text-xs">Save</button>
                  </form>
                </td>
                {/* No `whitespace-nowrap` any more: this column no longer widens for its
                    content, so holding the two links on one line would push them out over the
                    card's edge -- the very clipping this colgroup exists to fix. They wrap
                    instead, one per line. */}
                <td>
                  {/* MUST-11.1 / MUST-11.2: a purchase can carry a warranty; a transfer cannot.
                      MUST-11.3: the URL carries ONLY the id. The add page derives the date,
                      the abs() price and the vendor from the transaction row server-side. */}
                  {row.isTransfer ? null : (
                    <>
                      <Link href={`/warranties/new?transactionId=${row.id}`} className="btn btn--ghost btn--sm text-xs text-accent-text">
                        Create warranty
                      </Link>{' '}
                      <button
                        type="button"
                        onClick={() => openSplitEditor(row)}
                        aria-label={`Split transaction ${row.id}`}
                        className="btn btn--ghost btn--sm text-xs text-accent-text"
                      >
                        Split…
                      </button>
                    </>
                  )}
                  {/* MUST-14.8: a transfer never carries a loan control, and neither does a
                      page that was given no loans. The established precedent for a per-row
                      action is the link above.
                      F4 fix-round: EVERY link on the row gets its own line and its own
                      Unassign, not just the first -- a combined payment split across two
                      loans used to hide the second link entirely. The assign select is now
                      ALWAYS shown alongside existing links (not replaced by them), which is
                      what makes the over-link warn path (MUST-14.10) reachable from the UI at
                      all -- it used to be dead code once a row had one link, since the
                      control that could create a second one had already disappeared. */}
                  {row.isTransfer || loanOptions.length === 0 ? null : (
                    <span className="flex flex-col items-end gap-1">
                      {(loanLinks[row.id] ?? []).map((link) => (
                        <span key={link.id} className="flex items-center gap-1.5">
                          <span className="text-xs text-muted">{link.itemName}</span>
                          <form action={unassignLoan}>
                            <input type="hidden" name="transactionId" value={row.id} />
                            <input type="hidden" name="itemId" value={link.itemId} />
                            <SubmitButton className="btn btn--ghost btn--sm">Unassign</SubmitButton>
                          </form>
                        </span>
                      ))}
                      <form action={assignLoan} className="flex items-center gap-1.5">
                        <input type="hidden" name="transactionId" value={row.id} />
                        {/* F12 fix-round: `required` blocks the browser from submitting with
                            nothing picked, and the blank option is `disabled` so it can only
                            ever be the placeholder, never a real (empty) selection -- paired
                            with assignToLoanAction's own server-side check for the friendly
                            "Pick a loan first." message a stripped/tampered request would
                            otherwise get back as a bare "Invalid request." */}
                        <select
                          name="itemId"
                          defaultValue=""
                          required
                          aria-label={`Assign transaction ${row.id} to a loan`}
                          className={rowControl}
                        >
                          <option value="" disabled>Assign to loan…</option>
                          {loanOptions.map((loan) => (
                            <option key={loan.id} value={loan.id}>{loan.name}</option>
                          ))}
                        </select>
                        <button type="submit" className="btn btn--ghost btn--sm px-2 text-xs">Assign</button>
                      </form>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        {page.rows.length === 0 ? (
          <EmptyState
            icon={TransactionsIcon}
            title="Nothing matches these filters"
            action={
              <Link href="/transactions" className="btn btn--secondary btn--sm">
                Clear filters
              </Link>
            }
          >
            Widen the date range or clear the search — or import a statement to get some transactions in here.
          </EmptyState>
        ) : null}
        <CardFooter>
          Page {page.page} of {page.pageCount} — {page.total} transactions
        </CardFooter>
      </Card>

      <Card as="div" className="max-w-2xl">
        <CardHeader title="Add a transaction" description="For cash and anything the bank will never send you." />
        <CardBody>
          <form action={manualAction} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Date">
                <input type="date" name="date" defaultValue={today} required className={inputClass} />
              </Field>
              <Field label="Account">
                <select name="accountId" className={selectClass}>
                  <option value="cash">My cash</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Description" className="sm:col-span-2">
                <input name="description" required className={inputClass} />
              </Field>
              <Field label="Amount">
                <input name="amount" placeholder="12.34" required className={inputClass} />
              </Field>
              <Field label="Direction">
                <select name="direction" className={selectClass}>
                  <option value="spend">Money out</option>
                  <option value="income">Money in</option>
                </select>
              </Field>
              <Field label="Category">
                <select name="categoryId" className={selectClass}>
                  <option value="">Leave to the categorizer</option>
                  {groupedCategories.map((opt) => (
                    <option key={opt.id} value={opt.id}>{'\u00A0\u00A0'.repeat(opt.depth) + opt.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Person">
                <select name="attributedUserId" className={selectClass}>
                  <option value="">Account default</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </Field>
            </div>
            <SubmitButton className="w-fit">Add transaction</SubmitButton>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
