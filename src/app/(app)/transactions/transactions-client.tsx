'use client';

import Link from 'next/link';
import { Fragment, useActionState, useEffect, useState } from 'react';
import { FormError } from '@/components/FormError';
import { QuickAddTransaction } from '@/components/QuickAddTransaction';
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
import { AutoSaveSelect } from '@/components/ui/AutoSave';
import { RowMenu, RowMenuButton, RowMenuForm, RowMenuLink } from '@/components/ui/RowMenu';
import { categoryOptions, type CategoryLike } from '@/lib/category-order';
import { type ResolvedRange } from '@/lib/date-range';
import type { LoanLink } from '@/lib/loans';
import { formatCents, parseAmountToCents, sumCents } from '@/lib/money';
import type { SplitRow } from '@/lib/splits';
import type { TransactionPage, TransactionRow } from '@/lib/transactions';
import { LOAN_DIRECTIONS, LOAN_DIRECTION_LABELS } from '@/lib/warranty/constants';
import {
  assignToLoanAction,
  bulkCategorizeAction,
  bulkTransferAction,
  createLoanFromTransactionAction,
  renameTransactionAction,
  saveNoteAction,
  saveSplitsAction,
  setAttributionAction,
  setCategoryAction,
  unassignFromLoanAction,
  type ActionState,
} from './actions';

// The table's own <colgroup> below carries one <col> per column: checkbox, date, account,
// description, amount, category, person, kebab. The note sub-row spans all of them, read off
// here rather than hardcoded a second time at the point of use.
const COLUMN_COUNT = 8;

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

/**
 * The auto-save controls take `(formData) => Promise<{ error?: string }>`. Both actions are
 * declared `(prevState, formData)` for useActionState, so the first argument is bound here --
 * once, at module level, rather than in a closure whose identity changes on every render.
 */
const saveCategory = (formData: FormData) => setCategoryAction({}, formData);
const saveAttribution = (formData: FormData) => setAttributionAction({}, formData);

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
  defaultAccountId = null,
  selfScoped = false,
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
  /** v1.13.0 ruling R7: quick-add's own default account for this person (users.last_account_id). */
  defaultAccountId?: number | null;
  /** v1.13.0 ruling R2: a self viewer's own id already forces the person filter server-side
   *  (page.tsx), so the pill that would let them ask for someone else is not rendered at all. */
  selfScoped?: boolean;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [renaming, setRenaming] = useState<{ id: number; current: string; merchant: string } | null>(null);
  const [splitting, setSplitting] = useState<{ id: number; amountCents: number; parts: SplitPartDraft[] } | null>(null);
  // Mirrors `renaming` exactly (ruling R13): one nullable slot of state, so opening the note
  // sub-row on a different row always replaces whichever one was already open.
  const [noting, setNoting] = useState<{ id: number; current: string } | null>(null);
  // Addendum A, ruling A1: mirrors `noting` exactly -- one nullable slot, so opening the
  // "Assign to new loan…" sub-row on a different row always replaces whichever one was open.
  //
  // Review round: `name` is carried in this state (a CONTROLLED input below), not left as an
  // uncontrolled DOM value, because React resets a `<form action={...}>`'s uncontrolled fields
  // to their defaults once the action settles -- on a refusal just as much as a success. Without
  // this, the very name a person typed when the refusal happened would vanish from the input
  // the instant the action's promise resolved, even though the form itself stays open.
  const [newLoan, setNewLoan] = useState<{ id: number; name: string } | null>(null);
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
  const [noteState, noteAction] = useActionState(saveNoteAction, initial);
  const [newLoanState, newLoanAction] = useActionState(createLoanFromTransactionAction, initial);

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
  // manualEntryAction's own message/error surfaces inside QuickAddTransaction now (it owns its
  // own useActionState instance), so this banner no longer merges it in. noteState IS merged in,
  // the same as renaming/splitting: the sub-row's own form closes on submit (setNoting(null)),
  // before the action settles, so the top banner is the only place its result is ever seen.
  // Review round: newLoanState now goes FIRST in both chains, not last. The new-loan sub-row
  // stays open across a refusal (below) instead of closing on submit like every other editor on
  // this page, so its own message/error can still be the freshest thing that happened by the
  // time this renders again -- putting it last let a STALE message from an earlier, unrelated
  // action (assignState, say) mask a fresh create's own result.
  const notice =
    newLoanState.message ??
    attrState.message ?? bulkCatState.message ?? bulkTfrState.message ??
    renameState.message ?? assignState.message ?? unassignState.message ?? splitState.message ?? noteState.message;
  const error =
    newLoanState.error ??
    attrState.error ?? bulkCatState.error ?? bulkTfrState.error ??
    renameState.error ?? assignState.error ?? unassignState.error ?? splitState.error ?? noteState.error;

  // Review round: unlike renaming/noting/splitting (which close their own <form onSubmit> right
  // away, before the action even settles), the new-loan editor must stay open on a REFUSAL --
  // closing unconditionally discarded whatever name a person had just typed the moment they hit
  // a refusal (lent + incoming money, already linked, a blank name), leaving only the top banner
  // to explain why. So this closes it only on the action's own success, the same idiom
  // warranty-detail-client.tsx uses for its edit form: keyed on the newLoanState object itself,
  // which useActionState only replaces when the action actually ran, so this fires exactly once
  // per real create rather than on every render while the editor is open.
  useEffect(() => {
    if (newLoanState.message && !newLoanState.error) {
      setNewLoan(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newLoanState]);

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

      <PageGuide>
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

      <QuickAddTransaction
        variant="page"
        accounts={accounts}
        categories={categories}
        people={people}
        today={today}
        defaultAccountId={defaultAccountId}
      />

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
            {/* Ruling R2: for a self viewer the person filter is already forced to their own id
                server-side (page.tsx's readFilter), so the pill that would let them ask for
                somebody else is not rendered at all rather than shown-but-ineffective. */}
            {selfScoped ? null : (
              <Field label="Person">
                <select name="person" className={selectClass}>
                  <option value="">Everyone</option>
                  <option value="unattributed">Household/unattributed</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </Field>
            )}
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
          {/* Item BO: for a self viewer every choice here returns NOT_YOURS_ERROR, so it is not
              rendered at all rather than shown-but-ineffective -- the same rule as the person
              filter at :382-384. */}
          {selfScoped ? null : (
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
          )}
          <form action={bulkTfrAction} className="flex items-center gap-2">
            <input type="hidden" name="ids" value={selected.join(',')} />
            <input type="hidden" name="isTransfer" value="1" />
            <SubmitButton variant="secondary">Mark transfer</SubmitButton>
          </form>
        </div>
      ) : null}

      <Card as="div">
        {/* minWidth is the colgroup's own total (3+7+9+15+7+13+11+3 = 68rem). Without it this
            table could not exceed its container, so the scroll container had nothing to scroll
            and the browser shrank every column instead -- see TableWrap's minWidth docblock. */}
        <TableWrap bare fixed minWidth="68rem">
          <colgroup>
            {/* Just the checkbox, plus the 1rem of cell padding either side. */}
            <col style={{ width: '3rem' }} />
            {/* An ISO date in tabular figures, which is the same width on every row. */}
            <col style={{ width: '7rem' }} />
            {/* Wide enough to READ an account name -- a `title` is no answer on a phone. */}
            <col style={{ width: '9rem' }} />
            {/* An explicit width, NOT elastic: left unsized this collapsed to one character on
                a narrow screen and spelled merchant names vertically (v1.10.1). */}
            <col style={{ width: '15rem' }} />
            {/* A signed five-figure amount on one line. */}
            <col style={{ width: '7rem' }} />
            {/* The category select plus its 1rem status slot. It no longer carries a Save
                button, which is where part of this table's old width went. */}
            <col style={{ width: '13rem' }} />
            {/* Same shape, shorter values -- a person's name or "Household". */}
            <col style={{ width: '11rem' }} />
            {/* The kebab: one 2rem button plus padding. This column used to be 11rem of link,
                button and select, and it was the column that clipped at the card's edge. The
                menu itself is position:fixed, so it is not constrained by this width. */}
            <col style={{ width: '3rem' }} />
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
              <Fragment key={row.id}>
              <tr>
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
                    {/* Renaming happens from the row menu now. The title stays: it is the only
                        place the bank's own text is visible once a row has been renamed. */}
                    <span
                      className="font-medium text-ink"
                      title={row.displayDescription ? `Bank text: ${row.rawDescription}` : undefined}
                    >
                      {row.displayDescription ?? row.rawDescription}
                    </span>
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
                  {/* v1.7.0 Task 4: a split transaction has no ONE category -- its money is
                      divided across its parts -- so it shows a badge instead of a control.
                      Editing the parts happens through Split… in the row menu. */}
                  {(splits[row.id] ?? []).length > 0 ? (
                    <span className="badge badge--blue">{`Split · ${(splits[row.id] ?? []).length} parts`}</span>
                  ) : (
                    <AutoSaveSelect
                      name="categoryId"
                      defaultValue={row.categoryId === null ? '' : String(row.categoryId)}
                      /* Live categories grouped under their parent, then the ARCHIVED ones flat
                         and disabled. That coverage is deliberate: a row whose category was
                         archived after the fact must still have a real <option>, or the browser
                         silently selects "Uncategorized" -- and with auto-save a stray change
                         would then clear (and untrain) a legitimate historical categorization. */
                      options={[
                        { value: '', label: 'Uncategorized' },
                        ...groupedCategories.map((opt) => ({
                          value: String(opt.id),
                          label: '  '.repeat(opt.depth) + opt.label,
                        })),
                        ...categories
                          .filter((c) => c.isArchived)
                          .map((c) => ({ value: String(c.id), label: `${label(c.id)} (archived)`, disabled: true })),
                      ]}
                      fields={{ transactionId: String(row.id) }}
                      action={saveCategory}
                      ariaLabel={`Category for transaction ${row.id}`}
                    />
                  )}
                </td>
                <td>
                  {selfScoped ? (
                    // Item BO: plain text, not nothing -- the column keeps its width and the row
                    // keeps its meaning. The <AutoSaveSelect below stays in this file on purpose:
                    // it is a conditional render, and tests/ops/row-controls.test.ts counts the
                    // token.
                    <span className="text-muted">{row.attributedUserName ?? 'Household'}</span>
                  ) : (
                    <AutoSaveSelect
                      name="attributedUserId"
                      defaultValue={row.attributedUserId === null ? '' : String(row.attributedUserId)}
                      options={[
                        { value: '', label: 'Household' },
                        ...people.map((person) => ({ value: String(person.id), label: person.name })),
                      ]}
                      fields={{ ids: String(row.id) }}
                      action={saveAttribution}
                      ariaLabel={`Person for transaction ${row.id}`}
                    />
                  )}
                </td>
                {/* One menu instead of a link, a button and a select-with-button. The label
                    names the ROW, not the column: "Actions" repeated identically down a table
                    tells a screen reader nothing about which row it is on.
                    v1.13.1 (item M): the description alone was not enough either -- two identical
                    coffee-shop charges on one statement produced two buttons with the same name
                    and nothing else to tell them apart. Date AND amount, because the named
                    collision case is usually same-merchant AND same-date.
                    MUST-11.1/11.2: a purchase can carry a warranty, a transfer cannot.
                    MUST-11.3: the URL carries ONLY the id; the add page derives the rest.
                    MUST-14.8: a transfer never carries a loan control. MUST-14.10 stays
                    reachable because assign items are always offered alongside existing links,
                    never replaced by them. */}
                <td className="text-right">
                  <RowMenu
                    label={`Actions for ${row.displayDescription ?? row.rawDescription} on ${row.date}, ${formatCents(row.amountCents)}`}
                  >
                    <RowMenuButton
                      onSelect={() =>
                        setRenaming({
                          id: row.id,
                          current: row.displayDescription ?? row.rawDescription,
                          merchant: row.normalizedMerchant,
                        })
                      }
                    >
                      Rename…
                    </RowMenuButton>
                    {/* Ruling R13: the row's notes column existed since v1.0.0 but had no way in
                        -- saveNoteAction (./actions.ts) was dead code until this menu item. */}
                    <RowMenuButton onSelect={() => setNoting({ id: row.id, current: row.notes ?? '' })}>
                      Note…
                    </RowMenuButton>
                    {row.isTransfer ? null : (
                      <>
                        <RowMenuButton onSelect={() => openSplitEditor(row)}>Split…</RowMenuButton>
                        <RowMenuLink href={`/warranties/new?transactionId=${row.id}`}>Create warranty</RowMenuLink>
                      </>
                    )}
                    {row.isTransfer
                      ? null
                      : (loanLinks[row.id] ?? []).map((link) => (
                          // v1.14.0 (ruling P15): "moves back up" was only ever true for a loan
                          // the household owes -- a lent loan's balance moves back DOWN. Rather
                          // than plumb a direction through LoanLink and
                          // loanLinksForTransactions for one sentence, this says what is true
                          // in both frames.
                          <RowMenuForm
                            key={`unassign-${link.id}`}
                            action={unassignLoan}
                            fields={{ transactionId: String(row.id), itemId: String(link.itemId) }}
                            confirm={`Unassign this transaction from ${link.itemName}? That loan's balance moves back to what it was.`}
                          >
                            {`Unassign from ${link.itemName}`}
                          </RowMenuForm>
                        ))}
                    {row.isTransfer
                      ? null
                      : loanOptions.map((loan) => (
                          <RowMenuForm
                            key={`assign-${loan.id}`}
                            action={assignLoan}
                            fields={{ transactionId: String(row.id), itemId: String(loan.id) }}
                          >
                            {`Assign to ${loan.name}`}
                          </RowMenuForm>
                        ))}
                    {/* Addendum A, ruling A1: last in this block so the existing
                        "Assign to <loan>" items keep their order. */}
                    {row.isTransfer ? null : (
                      <RowMenuButton onSelect={() => setNewLoan({ id: row.id, name: '' })}>Assign to new loan…</RowMenuButton>
                    )}
                  </RowMenu>
                </td>
              </tr>
              {noting?.id === row.id ? (
                <tr>
                  {/* Ruling R13: an inline sub-row, not a dialog -- the note is about the row
                      above it, and a modal would hide the charge the note is explaining. NOT an
                      auto-save (v1.11.0's rule): a free-text field that saves on blur loses a
                      half-typed sentence, which is the one thing a note must never do. */}
                  <td colSpan={COLUMN_COUNT}>
                    <form
                      action={noteAction}
                      onSubmit={() => setNoting(null)}
                      className="flex flex-col gap-2 py-2"
                    >
                      <input type="hidden" name="transactionId" value={row.id} />
                      <Field label={`Note for ${row.displayDescription ?? row.rawDescription}`}>
                        <textarea name="notes" defaultValue={noting.current} rows={2} className={inputClass} />
                      </Field>
                      <div className="flex gap-2">
                        <SubmitButton className="w-fit">Save note</SubmitButton>
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNoting(null)}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  </td>
                </tr>
              ) : null}
              {newLoan?.id === row.id ? (
                <tr>
                  <td colSpan={COLUMN_COUNT}>
                    <form
                      action={newLoanAction}
                      className="flex flex-col gap-2 py-2"
                      data-testid="new-loan-form"
                    >
                      <input type="hidden" name="transactionId" value={row.id} />
                      {/* Review round: shown INLINE, under the form a refusal leaves open, not
                          only through the top banner (that still gets it too, via `error`
                          above) -- the person is looking here, not at the top of the page. */}
                      <FormError message={newLoanState.error} />
                      <Field label="Loan name" hint="Who the loan is with — a name you will recognise later.">
                        <input
                          name="loanName"
                          value={newLoan.name}
                          onChange={(e) => setNewLoan({ id: row.id, name: e.target.value })}
                          required
                          maxLength={80}
                          autoFocus
                          className={inputClass}
                        />
                      </Field>
                      <Field label="Direction">
                        <select name="loanDirection" defaultValue="lent" className={selectClass}>
                          {LOAN_DIRECTIONS.map((direction) => (
                            <option key={direction} value={direction}>{LOAN_DIRECTION_LABELS[direction]}</option>
                          ))}
                        </select>
                      </Field>
                      <div className="flex gap-2">
                        <SubmitButton className="w-fit">Create loan</SubmitButton>
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNewLoan(null)}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  </td>
                </tr>
              ) : null}
              </Fragment>
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
    </div>
  );
}
