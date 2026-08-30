'use client';

import Link from 'next/link';
import { Fragment, useActionState, useEffect, useState } from 'react';
import { FormError } from '@/components/FormError';
import { QuickAddTransaction } from '@/components/QuickAddTransaction';
import { SubmitButton } from '@/components/SubmitButton';
import { CheckIcon, TransactionsIcon } from '@/components/icons';
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
import { categoryOptionGroups, categoryOptions, type CategoryLike, type CategoryOptionGroup } from '@/lib/category-order';
import { type ResolvedRange } from '@/lib/date-range';
import type { LoanLink } from '@/lib/loans';
import { formatCents, parseAmountToCents, sumCents } from '@/lib/money';
import type { SplitRow } from '@/lib/splits';
import type { TransactionPage, TransactionRow } from '@/lib/transactions';
import { LOAN_DIRECTIONS, LOAN_DIRECTION_LABELS } from '@/lib/warranty/constants';
import {
  acceptGuessAction,
  applyToAllMatchingAction,
  assignToLoanAction,
  bulkCategorizeAction,
  bulkTransferAction,
  createLoanFromTransactionAction,
  renameTransactionAction,
  saveNoteAction,
  saveSplitsAction,
  setAttributionAction,
  setCategoryAction,
  setRowTransferAction,
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
 * Review round (fold /review in): the card list's own "This transaction only" and "apply to
 * all" selects, ported byte-for-byte from review-client.tsx's `pickerClass` -- dense enough to
 * sit alongside the row's kebab without shouting, with the same explicit `min-h-11 sm:min-h-0`
 * floor AUTO_SAVE_CONTROL uses (`field-control`'s own padding/line-height alone clear only
 * ~38px, short of the 44px these need on the phones this household uses).
 */
const REVIEW_PICKER_CLASS = 'field-control w-auto max-w-[12rem] px-2 py-1 text-xs min-h-11 sm:min-h-0';

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
  reviewMode = false,
  reviewCount = 0,
  matchingCounts = {},
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
  /**
   * Review round (fold /review in): true when `?review=1` narrowed this page to the review
   * queue -- always `false` for a self viewer (ruling R2, forced server-side in page.tsx, never
   * re-derived here). Swaps the table for the card list (ruling R5), turns on the review-only
   * kebab items ("Accept <category>", "Apply a category to all N…"), the review teaching
   * PageGuide and the review empty state.
   */
  reviewMode?: boolean;
  /** reviewQueueCount(), for the "Needs review (N)" chip -- always passed, even when
   *  `reviewMode` is false or the viewer is self-scoped; the CLIENT decides whether to render
   *  the chip (never for a self viewer, ruling R2), not the caller. */
  reviewCount?: number;
  /** Review-mode-only, keyed by transaction id: how many OTHER transactions share this row's
   *  merchant (Lane 1's countMatchingMerchant). Empty outside review mode -- the "Apply a
   *  category to all N matching…" kebab item never appears for a table row. */
  matchingCounts?: Record<number, number>;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [renaming, setRenaming] = useState<{ id: number; current: string; merchant: string } | null>(null);
  const [splitting, setSplitting] = useState<{ id: number; amountCents: number; parts: SplitPartDraft[] } | null>(null);
  // Mirrors `renaming` exactly (ruling R13): one nullable slot of state, so opening the note
  // sub-row on a different row always replaces whichever one was already open.
  const [noting, setNoting] = useState<{ id: number; current: string } | null>(null);
  // Addendum A, ruling A1: mirrors `noting` exactly -- one nullable slot, so opening the
  // "Assign to loan…" sub-row on a different row always replaces whichever one was open.
  //
  // Review round: `name` is carried in this state (a CONTROLLED input below), not left as an
  // uncontrolled DOM value, because React resets a `<form action={...}>`'s uncontrolled fields
  // to their defaults once the action settles -- on a refusal just as much as a success. Without
  // this, the very name a person typed when the refusal happened would vanish from the input
  // the instant the action's promise resolved, even though the form itself stays open.
  //
  // Backlog BY: `itemId` is this same editor's own "Assign to" select, carried in state for the
  // same reason `name` already is -- an existing-loan choice must survive a refusal exactly like
  // a typed name does. '' means "New loan…" (the name/direction fields below apply); any other
  // value is an existing loan's id, and Save posts straight to assignToLoanAction instead.
  const [newLoan, setNewLoan] = useState<{ id: number; name: string; itemId: string } | null>(null);
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
  // Review round (fold /review in): ruling R4's per-row transfer toggle, offered on every row in
  // both modes.
  const [rowTransferState, rowTransferAction] = useActionState(setRowTransferAction, initial);
  // Review-mode-only actions (inventory #5/#7).
  const [acceptState, acceptAction] = useActionState(acceptGuessAction, initial);
  const [applyAllState, applyAllAction] = useActionState(applyToAllMatchingAction, initial);
  // One nullable slot of state, the same shape `noting`/`newLoan` already use: opening the
  // "Apply a category to all N…" editor on a different row replaces whichever one was open.
  const [applyAllRow, setApplyAllRow] = useState<number | null>(null);

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

  // Backlog BZ: the same rows as groupedCategories, arranged for an <optgroup> instead of NBSP
  // indentation -- a parent WITH children becomes a group named after it (itself included as
  // the group's first option), a childless top-level category stays a plain option.
  const categoryGroups: CategoryOptionGroup[] = categoryOptionGroups(categories);
  // AutoSaveSelect's own option shape (src/components/ui/AutoSave.tsx): a group is
  // { label, options }, a childless category is passed through directly.
  const categorySelectOptions = categoryGroups.map((group) =>
    group.label === null
      ? { value: String(group.options[0].id), label: group.options[0].label }
      : { label: group.label, options: group.options.map((opt) => ({ value: String(opt.id), label: opt.label })) },
  );
  // The same groups, rendered as real <option>/<optgroup> elements for the two plain <select>s
  // in this file that still need one (the apply-to-all editor, the splits editor).
  function categoryOptGroups(groups: CategoryOptionGroup[]) {
    return groups.map((group) =>
      group.label === null ? (
        <option key={group.options[0].id} value={group.options[0].id}>{group.options[0].label}</option>
      ) : (
        <optgroup key={`group-${group.label}`} label={group.label}>
          {group.options.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </optgroup>
      ),
    );
  }

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
  // Review round (fold /review in): applyAllState goes right after newLoanState, for the same
  // reason -- its own inline editor (below) must stay open on a refusal and show ITS OWN fresh
  // error, which a stale message further down this chain could otherwise mask. acceptState and
  // rowTransferState are plain one-off actions with no editor of their own, so they join the
  // rest of that set at the end, the same as assignState/unassignState.
  const notice =
    newLoanState.message ?? applyAllState.message ??
    attrState.message ?? bulkCatState.message ?? bulkTfrState.message ??
    renameState.message ?? assignState.message ?? unassignState.message ?? splitState.message ?? noteState.message ??
    acceptState.message ?? rowTransferState.message;
  const error =
    newLoanState.error ?? applyAllState.error ??
    attrState.error ?? bulkCatState.error ?? bulkTfrState.error ??
    renameState.error ?? assignState.error ?? unassignState.error ?? splitState.error ?? noteState.error ??
    acceptState.error ?? rowTransferState.error;

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

  // Backlog BY: the same editor now also posts an EXISTING-loan choice to assignToLoanAction
  // (assignState), so it must close on that action's own success too, for the same reason as
  // newLoanState just above -- a refusal (no loan picked, already linked at the DB layer) must
  // leave the editor open with the choice still made.
  useEffect(() => {
    if (assignState.message && !assignState.error) {
      setNewLoan(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignState]);

  // Same idiom as newLoan above: the "Apply a category to all N…" editor stays open on a
  // refusal (a rule someone else in the household owns) so its own inline error is visible
  // where the person is looking, and closes only on the action's own success.
  useEffect(() => {
    if (applyAllState.message && !applyAllState.error) {
      setApplyAllRow(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyAllState]);

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

  /**
   * Review round (fold /review in): the ONE row menu, shared by the table row (`<tr>`) and the
   * review card list (`<li>`) below -- the Goal this release is built around ("every feature
   * built for Transactions is automatically available while reviewing") is exactly what a
   * second, hand-maintained copy of this menu would quietly stop being true for. Rename…,
   * Note…, Split…, Create warranty and every loan item are unchanged from the table's own menu;
   * the transfer toggle (ruling R4) is new on every row in both modes; Accept/Apply-to-all are
   * new and review-mode-only (inventory #5/#7).
   */
  function rowMenu(row: TransactionRow) {
    // Backlog BX: matchingCounts is populated for every row IN review mode (page.tsx) and empty
    // outside it -- so a MISSING entry (rather than a low one) is exactly "we're outside review
    // mode and never counted", and gets the generic label instead of a real number.
    const matchingCount = matchingCounts[row.id];
    const hasMatchingCount = matchingCount !== undefined;
    return (
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
        <RowMenuButton onSelect={() => setNoting({ id: row.id, current: row.notes ?? '' })}>
          Note…
        </RowMenuButton>
        {/* Ruling R4: offered on EVERY row, both directions -- not gated on reviewMode, and not
            gated on row.isTransfer either, since it is the control that flips that very flag.
            setRowTransferAction (Lane 1) reads `isTransfer` off the form, so this one item works
            both ways depending on the row's current state. */}
        <RowMenuForm
          action={rowTransferAction}
          fields={{ transactionId: String(row.id), isTransfer: row.isTransfer ? '0' : '1' }}
        >
          {row.isTransfer ? 'Not a transfer' : 'Mark as transfer'}
        </RowMenuForm>
        {row.isTransfer ? null : (
          <>
            <RowMenuButton onSelect={() => openSplitEditor(row)}>Split…</RowMenuButton>
            <RowMenuLink href={`/warranties/new?transactionId=${row.id}`}>Create warranty</RowMenuLink>
          </>
        )}
        {row.isTransfer
          ? null
          : (loanLinks[row.id] ?? []).map((link) => (
              <RowMenuForm
                key={`unassign-${link.id}`}
                action={unassignLoan}
                fields={{ transactionId: String(row.id), itemId: String(link.itemId) }}
                confirm={`Unassign this transaction from ${link.itemName}? That loan's balance moves back to what it was.`}
              >
                {`Unassign from ${link.itemName}`}
              </RowMenuForm>
            ))}
        {/* Backlog BY: one item, not one per loan -- it opens the same inline editor as before,
            now extended with a select for an existing loan (Save -> assignToLoanAction) or
            "New loan…" (Save -> createLoanFromTransactionAction, unchanged). */}
        {row.isTransfer ? null : (
          <RowMenuButton onSelect={() => setNewLoan({ id: row.id, name: '', itemId: '' })}>
            Assign to loan…
          </RowMenuButton>
        )}
        {/* Review-mode-only, inventory #5: only when the categorizer itself guessed this row and
            nobody has confirmed it yet. */}
        {reviewMode && row.source === 'bayes' && row.categoryId !== null ? (
          <RowMenuForm action={acceptAction} fields={{ transactionId: String(row.id) }}>
            {`Accept ${row.categoryName}`}
          </RowMenuForm>
        ) : null}
        {/* Backlog BX: offered on every row, not gated on reviewMode any more. Inside review
            mode (inventory #7) matchingCounts is real and gates on >1, same as before -- outside
            it there is nothing to gate on (matchingCounts is never populated there), so the item
            is offered with a merchant-named label instead and the server counts on submit. */}
        {hasMatchingCount ? (
          matchingCount > 1 ? (
            <RowMenuButton onSelect={() => setApplyAllRow(row.id)}>
              {`Apply a category to all ${matchingCount} matching…`}
            </RowMenuButton>
          ) : null
        ) : (
          <RowMenuButton onSelect={() => setApplyAllRow(row.id)}>
            {`Apply this category to every "${row.normalizedMerchant}"…`}
          </RowMenuButton>
        )}
      </RowMenu>
    );
  }

  /**
   * Fix round (item CB, regression): this used to be a `<tr>` sub-row rendered ONLY from the
   * table branch below, so opening it from the review card list's kebab did nothing -- the same
   * dead-editor bug noteEditor's docblock describes. Pulled out to a plain function so both
   * branches can render its contents (a table `<tr><td colSpan>`, a card `<div>`), with no
   * change to the fields, action or behaviour themselves.
   */
  function noteEditor(row: TransactionRow) {
    if (noting?.id !== row.id) return null;
    return (
      // Ruling R13: an inline sub-row, not a dialog -- the note is about the row above it, and a
      // modal would hide the charge the note is explaining. NOT an auto-save (v1.11.0's rule): a
      // free-text field that saves on blur loses a half-typed sentence, which is the one thing a
      // note must never do.
      <form action={noteAction} onSubmit={() => setNoting(null)} className="flex flex-col gap-2 py-2">
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
    );
  }

  /**
   * Fix round (item CB, regression): same dead-editor bug as noteEditor, for the "Assign to
   * loan…" sub-row -- pulled out so the review card list can render it too.
   *
   * Backlog BY, folded in here: this is now ALSO the existing-loan assign form, not just the
   * new-loan one. `newLoan.itemId` is the "Assign to" select's own value: '' means "New loan…"
   * (the name/direction fields below apply, posting to createLoanFromTransactionAction exactly
   * as before); any other value is an existing loan's id, and Save posts straight to
   * assignToLoanAction instead. One <form>, whose `action` picks the right dispatcher at submit
   * time -- the fields either action reads (transactionId always; loanName/loanDirection or
   * itemId depending on the choice) are exactly what's rendered below.
   */
  function newLoanEditor(row: TransactionRow) {
    if (newLoan?.id !== row.id) return null;
    const isNew = newLoan.itemId === '';
    return (
      <form
        action={(formData: FormData) => {
          if (isNew) newLoanAction(formData);
          else assignLoan(formData);
        }}
        className="flex flex-col gap-2 py-2"
        data-testid="new-loan-form"
      >
        <input type="hidden" name="transactionId" value={row.id} />
        {/* Shown INLINE, under the form a refusal leaves open, not only through the top banner
            (that still gets it too, via `error` above) -- the person is looking here, not at the
            top of the page. Whichever action was actually posted owns this message. */}
        <FormError message={isNew ? newLoanState.error : assignState.error} />
        <Field label="Assign to">
          <select
            name="itemId"
            value={newLoan.itemId}
            onChange={(e) => setNewLoan({ ...newLoan, itemId: e.target.value })}
            className={selectClass}
          >
            {loanOptions.map((loan) => (
              <option key={loan.id} value={String(loan.id)}>{loan.name}</option>
            ))}
            <option value="">New loan…</option>
          </select>
        </Field>
        {isNew ? (
          <>
            <Field label="Loan name" hint="Who the loan is with — a name you will recognise later.">
              <input
                name="loanName"
                value={newLoan.name}
                onChange={(e) => setNewLoan({ ...newLoan, name: e.target.value })}
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
          </>
        ) : null}
        <div className="flex gap-2">
          <SubmitButton className="w-fit">Save</SubmitButton>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNewLoan(null)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  /**
   * Backlog BX: this editor used to live only in the card branch, gated on reviewMode through
   * the kebab item that opens it. Now the item is offered on every row, so this must render from
   * the table branch too -- pulled out for the same reason noteEditor/newLoanEditor were.
   */
  function applyAllEditor(row: TransactionRow) {
    if (applyAllRow !== row.id) return null;
    const matchingCount = matchingCounts[row.id];
    const hasMatchingCount = matchingCount !== undefined;
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border border-line p-3">
        <p className="text-xs font-semibold text-ink">
          {hasMatchingCount ? (
            <>Every &quot;{row.normalizedMerchant}&quot; — {matchingCount} transactions, plus future imports</>
          ) : (
            <>Every &quot;{row.normalizedMerchant}&quot;, plus future imports</>
          )}
        </p>
        <p className="text-xs text-muted">
          Only for merchants that are always one category (coffee shop, streaming).
          Walmart, Amazon, e-transfers: use the select above.
        </p>
        {/* Shown inline, under the editor a refusal leaves open, not only through the top banner
            (that still gets it too, via `error` above) -- the same idiom the new-loan editor
            already uses. */}
        <FormError message={applyAllState.error} />
        <form action={applyAllAction} className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
          <input type="hidden" name="normalizedMerchant" value={row.normalizedMerchant} />
          <select
            name="categoryId"
            defaultValue={row.categoryId ?? ''}
            aria-label={
              hasMatchingCount
                ? `Category for all ${matchingCount} matching ${row.normalizedMerchant} — every transaction`
                : `Category for every ${row.normalizedMerchant} — every transaction`
            }
            className={REVIEW_PICKER_CLASS}
          >
            <option value="">{hasMatchingCount ? `Choose for all ${matchingCount}…` : 'Choose a category…'}</option>
            {categoryOptGroups(categoryGroups)}
          </select>
          <SubmitButton variant="secondary" size="sm" className="w-fit">
            {hasMatchingCount ? `Apply to all ${matchingCount} matching + create rule` : 'Apply to all matching + create rule'}
          </SubmitButton>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setApplyAllRow(null)}>
            Cancel
          </button>
        </form>
      </div>
    );
  }

  return (
    // data-page-width: this table needs more than the shell's 6xl reading cap (see globals.css).
    <div data-page-width="wide" className="flex flex-col gap-6">
      <PageHeader title="Transactions" description="Every line from every account, with what it was spent on." />

      {/* Review round (fold /review in): review mode gets the review page's own three teaching
          paragraphs instead of the ordinary Transactions guide -- ported verbatim from
          review-client.tsx, only "this screen" -> "this filter" since it is no longer a
          separate page. Guard 3 (tests/ops/onboarding-coverage.test.ts) only greps this file's
          SOURCE for the literal `<PageGuide`, so having exactly one branch of a conditional
          render it still satisfies that guard. */}
      {reviewMode ? (
        <PageGuide>
          <p>
            Every import runs each new transaction past the categorizer. Anything it could not
            place with confidence waits here instead of being filed under a guess, so this filter
            is the one place where a wrong category is a decision you made rather than one the
            app made quietly.
          </p>
          <p>
            Accepting a guess or correcting it does two things: it files that transaction, and it
            teaches the categorizer what that merchant is. The same merchant arrives already
            sorted next time. The count beside a row is every transaction with that merchant,
            plus future imports, and offers to apply your choice to all of them at once.
          </p>
          <p>
            This queue is not a one-time setup step. It empties, then refills the next time you
            import a statement, so clearing it is part of the monthly routine rather than
            something you finish once.
          </p>
        </PageGuide>
      ) : (
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
      )}

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
                      {/* Backlog BZ: an <optgroup> per parent instead of the flat NBSP-indented
                          list -- categoryOptGroups() already excludes archived categories,
                          matching this select's own live-category-only rule. */}
                      {categoryOptGroups(categoryGroups)}
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
            {/* Ruling R1: `review=1` is a filter like any other on this form, so re-submitting
                it (changing the account, say) must not silently drop out of the review queue --
                carried forward as a hidden field rather than a visible control, the same way
                every OTHER already-applied value on this GET form has no widget of its own
                either. */}
            {reviewMode ? <input type="hidden" name="review" value="1" /> : null}
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
            {/* Inventory #3 / ruling R2: the review page's own "N waiting" eyebrow, repointed as
                a filter chip on this page instead of a second page's header. Hidden entirely for
                a self viewer -- the queue is household-wide by construction, and `reviewMode` is
                already forced `false` for one server-side (page.tsx), so a self viewer clicking
                this (were it shown) would just get their own ordinary list back, not a refusal.
                Shown once in review mode too (even if reviewCount has since dropped to 0), so the
                one control that got a person INTO the filter is also the one that gets them back
                OUT of it. */}
            {!selfScoped && (reviewCount > 0 || reviewMode) ? (
              <Link
                href={reviewMode ? '/transactions' : '/transactions?review=1'}
                className={`badge ${reviewMode ? 'badge--amber' : 'badge--slate'} min-h-11 items-center px-3 sm:min-h-0`}
              >
                Needs review ({reviewCount})
              </Link>
            ) : null}
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

      {/* Ruling R5: review mode renders the card list INSTEAD of the table -- never both, which
          would give every control two DOM nodes and break label-based queries across the
          suite. */}
      {reviewMode ? (
        page.rows.length === 0 ? (
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
        ) : (
          <>
            <ul className="flex flex-col gap-3">
              {page.rows.map((row) => {
                const noteForm = noteEditor(row);
                const newLoanForm = newLoanEditor(row);
                const applyAllForm = applyAllEditor(row);
                return (
                  <li key={row.id} className="card flex flex-col gap-3 p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <span className="text-sm">
                        {/* Renaming happens from the row menu, same as the table row -- the
                            title stays the only place the bank's own text is visible once a
                            row has been renamed. */}
                        <strong
                          className="font-semibold text-ink"
                          title={row.displayDescription ? `Bank text: ${row.rawDescription}` : undefined}
                        >
                          {row.displayDescription ?? row.normalizedMerchant}
                        </strong>
                        {/* v1.13.3 / fix round on 5439851: a raw description that is identical to
                            the already-normalized merchant name (on the same NFC-normalized,
                            trimmed, collapsed-whitespace, uppercased footing normalizeMerchant
                            itself uses -- src/lib/categorize/normalize.ts) adds nothing, so it is
                            shown only when it says something different. Ported verbatim from
                            review-client.tsx. */}
                        {row.normalizedMerchant !==
                        row.rawDescription.trim().replace(/\s+/g, ' ').normalize('NFC').toUpperCase() ? (
                          <>
                            {' '}
                            <span className="text-muted">— {row.rawDescription}</span>
                          </>
                        ) : null}
                        {row.displaySource === 'manual' ? <span className="badge badge--blue ml-1.5">renamed</span> : null}
                        {row.displaySource === 'rename' ? <span className="badge badge--blue ml-1.5">rule</span> : null}
                        {/* Backlog CA: one badge per loan link, naming the loan, beside the
                            renamed/rule badges above -- the table row gets the same treatment
                            below. */}
                        {(loanLinks[row.id] ?? []).map((link) => (
                          <span key={`loan-badge-${link.id}`} className="badge badge--blue ml-1.5">{link.itemName}</span>
                        ))}
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
                      {/* v1.13.3: the "Set" button is gone -- picking a category IS the decision.
                          The placeholder is `disabled` so it can only ever be the starting state.
                          Ruling R3: `teach: '1'` is the whole difference from the table's own
                          per-row select -- in review mode a category pick teaches the
                          categorizer (createRule: true server-side); outside it, it does not. */}
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-1.5">
                        <span className="text-xs font-medium text-muted">This transaction only</span>
                        <AutoSaveSelect
                          name="categoryId"
                          defaultValue={row.categoryId === null ? '' : String(row.categoryId)}
                          options={[
                            { value: '', label: 'Choose for this one…', disabled: true },
                            ...categorySelectOptions,
                          ]}
                          fields={{ transactionId: String(row.id), teach: '1' }}
                          action={saveCategory}
                          ariaLabel={`Category for ${row.normalizedMerchant} — this transaction only`}
                          className={REVIEW_PICKER_CLASS}
                        />
                      </div>
                      {rowMenu(row)}
                    </div>
                    {/* Fix round (item CB): noteEditor/newLoanEditor's own contents, rendered as
                        a plain <div> here so they actually reach a person reviewing from the
                        card list -- see those functions' docblocks. */}
                    {noteForm ? <div>{noteForm}</div> : null}
                    {newLoanForm ? <div>{newLoanForm}</div> : null}
                    {applyAllForm}
                  </li>
                );
              })}
            </ul>
            <p className="text-sm text-muted">
              Page {page.page} of {page.pageCount} — {page.total} transactions
            </p>
          </>
        )
      ) : (
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
            {page.rows.map((row) => {
              // Fix round (item CB): computed once per row so the <tr> sub-rows below don't
              // call each editor function twice (the open-state check and the content itself).
              const noteForm = noteEditor(row);
              const newLoanForm = newLoanEditor(row);
              const applyAllForm = applyAllEditor(row);
              return (
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
                    {/* Backlog CA: one badge per loan link, naming the loan. */}
                    {(loanLinks[row.id] ?? []).map((link) => (
                      <span key={`loan-badge-${link.id}`} className="badge badge--blue">{link.itemName}</span>
                    ))}
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
                      /* Live categories grouped under their parent (backlog BZ), then the
                         ARCHIVED ones flat and disabled. That coverage is deliberate: a row whose
                         category was archived after the fact must still have a real <option>, or
                         the browser silently selects "Uncategorized" -- and with auto-save a
                         stray change would then clear (and untrain) a legitimate historical
                         categorization. */
                      options={[
                        { value: '', label: 'Uncategorized' },
                        ...categorySelectOptions,
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
                {/* The shared `rowMenu()` above -- byte-identical to what this cell used to
                    render inline, plus the transfer toggle (ruling R4) every row gets now. */}
                <td className="text-right">{rowMenu(row)}</td>
              </tr>
              {/* Fix round (item CB): noteEditor/newLoanEditor/applyAllEditor's own contents --
                  the SAME functions the review card list renders below -- see those functions'
                  docblocks for why a second, table-only copy of each used to leave the card
                  list's kebab dead in review mode. */}
              {noteForm ? (
                <tr>
                  {/* Ruling R13: an inline sub-row, not a dialog -- the note is about the row
                      above it, and a modal would hide the charge the note is explaining. */}
                  <td colSpan={COLUMN_COUNT}>{noteForm}</td>
                </tr>
              ) : null}
              {newLoanForm ? (
                <tr>
                  <td colSpan={COLUMN_COUNT}>{newLoanForm}</td>
                </tr>
              ) : null}
              {applyAllForm ? (
                <tr>
                  <td colSpan={COLUMN_COUNT}>{applyAllForm}</td>
                </tr>
              ) : null}
              </Fragment>
              );
            })}
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
      )}
    </div>
  );
}
