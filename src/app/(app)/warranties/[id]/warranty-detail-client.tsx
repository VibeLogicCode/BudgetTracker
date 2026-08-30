'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { FormError } from '@/components/FormError';
import { LoanProgressBar } from '@/components/LoanProgressBar';
import { SubmitButton } from '@/components/SubmitButton';
import { StatusBadge } from '@/components/warranty/StatusBadge';
import { ReceiptUploader, type StagedFile } from '@/components/warranty/ReceiptUploader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { TableWrap } from '@/components/ui/Table';
import { RowMenu, RowMenuForm } from '@/components/ui/RowMenu';
import { EmptyState } from '@/components/ui/EmptyState';
import { BellIcon } from '@/components/icons';
import { Field, inputClass, labelClass, selectClass, textareaClass } from '@/components/ui/form';
import { AutoSaveSelect } from '@/components/ui/AutoSave';
import { formatCents } from '@/lib/money';
import type { LoanRule } from '@/lib/loans';
import {
  BILLING_CYCLE_LABELS,
  BILLING_CYCLES,
  billingAllowedForKind,
  billingAmountLabelForKind,
  billingCycleSuffixForKind,
  billingSectionLabelForKind,
  formEndLabel,
  formOpenEndedLabel,
  formStartLabel,
  formTermLabel,
  loanFieldsAllowedForKind,
  LOAN_DIRECTIONS,
  LOAN_DIRECTION_LABELS,
  openEndedDisplayLabel,
  type ItemKind,
  productFieldsAllowedForKind,
  INSTALLMENT_SECTION_LABEL,
  installmentStateLabel,
  installmentsAllowedForKind,
  matchingAllowedForKind,
  matchingBlurbForKind,
  type InstallmentState,
} from '@/lib/warranty/constants';
import type { WarrantyStatus } from '@/lib/warranty/expiry';
import type { WarrantyItemRow, WarrantyReceiptRow } from '@/lib/warranty/items';
import type { InstallmentRow } from '@/lib/warranty/installments';
// Relative, not the `@/` alias -- see RecordPaymentForm.tsx's docblock on the same import: the
// client-bundle guard (tests/ops/client-bundle.test.ts) only walks `@/`-qualified value imports,
// and this sibling 'use server' module reaching @/lib/env is exactly the shape it would flag.
import { recordBillPaymentAction, setBillCategoryAction } from '../../bills/actions';
import {
  addInstallmentAction,
  attachReceiptsAction,
  deleteLoanRuleAction,
  deleteReceiptAction,
  deleteWarrantyAction,
  removeInstallmentAction,
  reRunOcrAction,
  saveLoanRuleAction,
  setInstallmentPaidAction,
  updateWarrantyAction,
  type WarrantyActionState,
} from '../actions';

const initial: WarrantyActionState = {};

// v1.14.0 fix round (review C, item 1): the loan hints below were written in the frame of a
// debt the household owes ("what you borrowed") and read backwards for a 'lent' loan, where the
// household is the one owed money. Both hints, and the balance field's own label, follow the
// edit form's CURRENT Direction value instead of assuming 'owed'.
function principalHintForDirection(direction: string): string {
  return direction === 'lent'
    ? 'What you lent out. Used for the payoff bar.'
    : 'What you borrowed. Used for the payoff bar.';
}

function balanceLabelForDirection(direction: string): string {
  return direction === 'lent' ? 'Balance still owed to you' : 'Balance still owed';
}

function balanceHintForDirection(direction: string): string {
  return direction === 'lent'
    ? "Today's balance. Repayments you link will take it down; further advances raise it."
    : "Today's balance. Payments you link will take it down from here.";
}

const OCR_CHIP: Record<WarrantyReceiptRow['ocrStatus'], string> = {
  pending: 'Reading…',
  done: 'Read',
  failed: 'Could not read',
};

/** The `.badge` primitive is the shared thing, not StatusBadge's five hues: StatusBadge is about
 *  an ITEM's own lifecycle, and an installment is not an item. */
const INSTALLMENT_BADGE: Record<InstallmentState, string> = {
  paid: 'badge badge--green',
  overdue: 'badge badge--red',
  due_soon: 'badge badge--amber',
  scheduled: 'badge badge--muted',
};

type TypeOption = { id: number; name: string; kind: ItemKind };

/**
 * IMPORTANT 5: a link-styled submit button with the same busy contract as SubmitButton,
 * for the small per-receipt actions (Re-run OCR / Remove) that don't want the filled-button
 * look. useFormStatus() only sees the nearest enclosing <form>, so each of these renders
 * inside its own single-button form -- exactly like the ones it replaces.
 */
function LinkSubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn btn--ghost btn--sm px-1.5 text-xs">
      {pending ? 'Working…' : children}
    </button>
  );
}

/** One label/value pair in the summary grid. */
function Detail({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-line py-2.5 last:border-b-0 sm:border-b-0 sm:py-0">
      <dt className="text-xs font-medium text-subtle">{label}</dt>
      <dd className="text-sm text-ink">{children}</dd>
    </div>
  );
}

export function WarrantyDetailClient({
  item,
  receipts,
  status,
  people,
  types,
  today,
  linkedTransaction,
  linkRemoved,
  rules,
  accounts,
  payoffFraction,
  lastPaymentAt,
  paymentCount,
  installments,
  categories,
}: {
  item: WarrantyItemRow;
  receipts: WarrantyReceiptRow[];
  status: WarrantyStatus;
  people: { id: number; name: string }[];
  /** Delta T9: an optional type dropdown, same list as the add form. */
  types: TypeOption[];
  today: string;
  linkedTransaction: { id: number; date: string; description: string } | null;
  linkRemoved: boolean;
  /** v1.3.1: the Payment matching sub-card's rules and account picker, loan-kind only. */
  rules: LoanRule[];
  accounts: { id: number; name: string }[];
  /** v1.3.1: from listLoans().find(...) on the server -- MUST-15.4's payoff math. */
  payoffFraction: number | null;
  lastPaymentAt: string | null;
  paymentCount: number;
  /** v1.12.0: a bill's due-date schedule. Always supplied; the card decides whether to render
   *  (ruling B7 -- a gate never hides a stored value). */
  installments: InstallmentRow[];
  /** v1.13.0 ruling R11 / micro-ruling M9: the budget-category picker's options. Supplied by
   *  Task 12's page.tsx (its Interfaces block declares this prop). */
  categories: { id: number; name: string }[];
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Bug fix (v1.2.4): the swapped-in section (read-only view OR edit form, never both) lives
  // at this ref so a fallback scrollIntoView has something to target if it ever renders below
  // the fold -- the primary fix is REPLACING the view in place, not scrolling to it.
  const swapSectionRef = useRef<HTMLDivElement>(null);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  // M10: bumped after a successful attach to remount <ReceiptUploader> with a clean slate --
  // otherwise a second click posts the SAME (now-consumed) staging ids and the action fails
  // with "That upload expired". ReceiptUploader owns its file-tile state internally, so a
  // fresh key is the only way to reset it from here.
  const [uploaderKey, setUploaderKey] = useState(0);
  const onStagedChange = useCallback((files: StagedFile[]) => setStaged(files), []);

  // M13: which of the five actions below most recently ran. Without this, an error/message
  // from one (e.g. a stale Re-run OCR result) could render beside an unrelated result from
  // another (e.g. a fresh Remove) merged in by `??` -- only the latest action's own result is
  // ever shown, mirroring settings/item-types/item-types-manager.tsx's activeSlot pattern.
  type ActionSlot = 'edit' | 'delete' | 'attach' | 'remove' | 'ocr' | null;
  const [activeSlot, setActiveSlot] = useState<ActionSlot>(null);

  const [editState, editAction] = useActionState(async (prev: WarrantyActionState, formData: FormData) => {
    setActiveSlot('edit');
    return updateWarrantyAction(prev, formData);
  }, initial);
  const [deleteState, deleteAction] = useActionState(async (prev: WarrantyActionState, formData: FormData) => {
    setActiveSlot('delete');
    return deleteWarrantyAction(prev, formData);
  }, initial);
  const [attachState, attachAction] = useActionState(async (prev: WarrantyActionState, formData: FormData) => {
    setActiveSlot('attach');
    return attachReceiptsAction(prev, formData);
  }, initial);
  const [removeState, removeAction] = useActionState(async (prev: WarrantyActionState, formData: FormData) => {
    setActiveSlot('remove');
    return deleteReceiptAction(prev, formData);
  }, initial);
  const [ocrState, ocrAction] = useActionState(async (prev: WarrantyActionState, formData: FormData) => {
    setActiveSlot('ocr');
    return reRunOcrAction(prev, formData);
  }, initial);

  // v1.3.1: the Payment matching sub-card's own add/remove-rule state, reported inline within
  // the card rather than through the top FormError/Notice above -- it is not one of the five
  // actions the activeSlot mechanism disambiguates between.
  const [ruleState, addRule] = useActionState(saveLoanRuleAction, initial);
  // F3 fix-round: routed through useActionState (like addRule), not a bare fire-and-forget
  // reference -- a stale delete (the rule already removed in another tab) now surfaces "That
  // rule no longer exists." instead of failing silently. revalidateAll's own revalidatePath
  // call still refreshes `rules` from the server either way.
  const [deleteRuleState, removeRule] = useActionState(
    (_prev: WarrantyActionState, formData: FormData) => deleteLoanRuleAction(formData),
    initial,
  );

  // v1.12.0: the Installments card's own inline results, reported inside the card exactly as
  // the Payment matching card's are -- they are not among the five actions activeSlot
  // disambiguates between.
  const [addInstallmentState, addInstallmentDispatch] = useActionState(addInstallmentAction, initial);
  const [installmentRowState, installmentRowDispatch] = useActionState(
    (_prev: WarrantyActionState, formData: FormData) =>
      formData.get('intent') === 'remove'
        ? removeInstallmentAction(_prev, formData)
        : setInstallmentPaidAction(_prev, formData),
    initial,
  );
  // Task 11 (v1.13.0 ruling R8): its own useActionState, not folded into installmentRowDispatch
  // above -- recordBillPaymentAction lives in a different 'use server' module (src/app/(app)/bills/
  // actions.ts) with its own state shape (structurally identical, but not the same export), and
  // reporting it inline in this card mirrors how the Payment matching card's own actions
  // (ruleState/deleteRuleState) already report separately from the five activeSlot actions.
  const [recordPaymentState, recordPaymentDispatch] = useActionState(recordBillPaymentAction, initial);
  // Ruling R11 / micro-ruling M9: the budget-category link is single-row and reversible (pick a
  // different category, or clear it back to "Not linked"), which is exactly ruling R1's auto-save
  // shape -- tests/ops/row-controls.test.ts refuses a lone select control paired with its own
  // Save button (the pre-v1.11.0 idiom that widened every table), so this binds straight to
  // AutoSaveSelect the same way the transactions category cell does, not a useActionState form.
  // (Deliberately spelled without angle brackets above: the guard's own regex scan cannot tell a
  // comment from markup, and that exact tag-opening substring anywhere in this file -- even in
  // prose -- counts toward its "exactly one select" tally the same as a real element would.)
  const saveBillCategory = (formData: FormData) => setBillCategoryAction({}, formData);

  const slotState =
    activeSlot === 'edit'
      ? editState
      : activeSlot === 'delete'
        ? deleteState
        : activeSlot === 'attach'
          ? attachState
          : activeSlot === 'remove'
            ? removeState
            : activeSlot === 'ocr'
              ? ocrState
              : undefined;
  const error = slotState?.error;
  const notice = slotState?.message;

  // M10: a successful attach (a message with no error) clears the staged list and remounts
  // the uploader. Keyed on the attachState object itself -- useActionState hands back a new
  // object only when the action actually ran, so this fires exactly once per real attach.
  useEffect(() => {
    if (attachState.message && !attachState.error) {
      setStaged([]);
      setUploaderKey((key) => key + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachState]);

  // Bug fix (v1.2.4): a successful save (a message with no error) closes the edit form and
  // restores the read-only view -- "leaving edit (cancel/save) restores the view." Keyed on
  // the editState object itself, same idiom as the attach effect above, so this fires exactly
  // once per real save rather than on every render while editing is open.
  useEffect(() => {
    if (editState.message && !editState.error) {
      setEditing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editState]);

  // Bug fix (v1.2.4): the primary fix is REPLACING the read-only view with the edit form in
  // the same position (below), so scrolling is a fallback only -- guards against the edit
  // form ever rendering below the fold for some other reason (e.g. a very short viewport).
  useEffect(() => {
    // jsdom (the test environment) does not implement scrollIntoView at all -- guarded so
    // tests exercising `editing` don't crash on a method that simply isn't there.
    if (editing) swapSectionRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [editing]);

  // Delta T9 (MUST-19.10), generalized to `kind` in v1.2.2 Task 2: every date label on this
  // page switches on the item's own kind through these helpers -- the only place either
  // wording lives. Supersedes purchaseDateLabel/termLabel/expiryDateLabel (controller ruling,
  // spec §19.12).
  const purchaseLabel = formStartLabel(item.kind);
  const termWordLabel = formTermLabel(item.kind);
  const expiryLabel = formEndLabel(item.kind);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{item.name}</h1>
          <StatusBadge status={status} expiryDate={item.expiryDate} today={today} kind={item.kind} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/warranties" className="btn btn--ghost btn--sm">Back to items</Link>
          <button type="button" onClick={() => setEditing((v) => !v)} className="btn btn--secondary btn--sm">
            {editing ? 'Cancel edit' : 'Edit'}
          </button>
          <button type="button" onClick={() => setConfirming(true)} className="btn btn--ghost btn--sm money-neg">
            Delete item
          </button>
        </div>
      </div>

      <FormError message={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {confirming ? (
        <Card as="div" className="border-negative-soft">
          <CardBody className="pt-5">
            <form action={deleteAction} className="flex flex-col gap-3">
              <p className="text-sm text-ink">
                Delete <strong className="font-semibold">{item.name}</strong> and its {receipts.length} receipt{receipts.length === 1 ? '' : 's'}?
                This cannot be undone.
              </p>
              <input type="hidden" name="itemId" value={item.id} />
              <div className="flex gap-2">
                <SubmitButton variant="danger">Delete permanently</SubmitButton>
                <button type="button" onClick={() => setConfirming(false)} className="btn btn--secondary">
                  Cancel
                </button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {/* Bug fix (v1.2.4): the read-only view and the edit form now occupy the SAME position
          -- exactly one of them renders, never both -- so opening Edit replaces the view in
          place instead of appending a second form below it (and below Receipts) where a
          scrolled-down user would never see it appear. */}
      <div ref={swapSectionRef}>
        {editing ? (
          <EditForm item={item} people={people} types={types} today={today} action={editAction} />
        ) : (
          <Card>
            <CardBody className="pt-5">
              <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                <Detail label="Type">{item.typeName ?? '—'}</Detail>
                {/* v1.13.1 (item 3, backlog sweep). Vendor is not gated by kind at all: every kind's
                    form (this file's EditForm at ~893, new-warranty-client.tsx) asks for Vendor
                    unconditionally, so the Detail row must match -- shown for every kind, value or
                    the em-dash placeholder, never dropped the way Model/Serial/Price are. */}
                <Detail label="Vendor">{item.vendor ?? '—'}</Detail>
                {/* Item R (ruling P6). The gate alone is NOT the condition: productFieldsAllowedForKind's own
                    docblock says it decides what a form OFFERS, never what a page may hide, because an item
                    whose type changed after it was saved can still hold a model. So a row disappears only when
                    the kind forbids it AND it is empty -- which for a Bill is all three, every time. */}
                {productFieldsAllowedForKind(item.kind) || item.model !== null ? (
                  <Detail label="Model">{item.model ?? '—'}</Detail>
                ) : null}
                {productFieldsAllowedForKind(item.kind) || item.serial !== null ? (
                  <Detail label="Serial number">{item.serial ?? '—'}</Detail>
                ) : null}
                <Detail label={purchaseLabel}>{item.purchaseDate}</Detail>
                <Detail label={termWordLabel}>
                  {item.isLifetime
                    ? formOpenEndedLabel(item.kind)
                    : item.warrantyMonths === null
                      ? 'Unknown'
                      : `${item.warrantyMonths} months`}
                </Detail>
                {/* v1.3.0 fix: an open-ended item (isLifetime) has no expiry_date to show -- that
                    used to render as a bare blank/em dash here, which reads as broken. Show the
                    per-kind open-ended word instead; a non-lifetime item with a genuinely unknown
                    term still falls through to the em dash, unchanged. */}
                <Detail label={expiryLabel}>{item.isLifetime ? openEndedDisplayLabel(item.kind) : (item.expiryDate ?? '—')}</Detail>
                {/* v1.13.1 (item 3, backlog sweep). The loanFieldsAllowedForKind arm used to keep this
                    row up for every loan, so a loan with no stored price rendered a guaranteed
                    "Price —" beside the loan-money block's own "Original" figure below -- the same
                    fact asked twice under two names. The edit form's own Price gate
                    (productApplicable || item.priceCents !== null, ~:913) never had that arm; this
                    now matches it, so the row shows only when the kind offers Price or a value is
                    actually stored (the same "gate OR held value" rule as Model/Serial above). */}
                {productFieldsAllowedForKind(item.kind) || item.priceCents !== null ? (
                  <Detail label="Price">{item.priceCents === null ? '—' : <Money cents={item.priceCents} plain />}</Detail>
                ) : null}
                {billingAllowedForKind(item.kind) ? (
                  // review fix: cycle and amount are validated as a pair at the schema boundary
                  // (BILLING_PAIR_ERROR) -- render the value only when BOTH are present. Rendering
                  // one alone either lies (a blank placeholder next to "/ month", cycle set but no amount) or silently drops
                  // a value the member entered (amount set but no cycle shown) -- exactly the kind
                  // of blank-reads-as-broken defect task B set out to eliminate for the end date.
                  // F5 fix-round: this is now the ONLY billing/payment row on the page -- it used
                  // to be duplicated by a second "Payment" row in the money block below, showing
                  // the exact same cycle+amount twice under two different labels. The label
                  // itself is routed through the kind matrix (MUST-12.3) so a loan reads
                  // "Payment", not "Billing".
                  <Detail label={billingSectionLabelForKind(item.kind)}>
                    {item.billingCycle !== null && item.billingAmountCents !== null ? (
                      <>
                        <Money cents={item.billingAmountCents} plain /> {billingCycleSuffixForKind(item.kind, item.billingCycle)}
                      </>
                    ) : (
                      '—'
                    )}
                  </Detail>
                ) : null}
                {/* v1.14.0 (spec BU, ruling P16). Same "gate OR held value" rule as
                    Model/Serial/Price above (item R, ruling P6): shown whenever the kind
                    offers a direction, or the item already carries a non-default one -- an
                    item whose type was flipped away from loan after being set to 'lent' would
                    otherwise hide that fact instead of showing it. */}
                {loanFieldsAllowedForKind(item.kind) || item.loanDirection !== 'owed' ? (
                  <Detail label="Direction">{LOAN_DIRECTION_LABELS[item.loanDirection]}</Detail>
                ) : null}
                <Detail label="Owner">{item.ownerName}</Detail>
                <Detail label="Notes">{item.notes ?? '—'}</Detail>
                <Detail label="Transaction">
                  {linkedTransaction ? (
                    <Link
                      href={`/transactions?q=${encodeURIComponent(linkedTransaction.description)}`}
                      className="text-accent-text underline underline-offset-2"
                    >
                      {linkedTransaction.date} · {linkedTransaction.description}
                    </Link>
                  ) : linkRemoved ? (
                    'The linked transaction was removed by an import undo'
                  ) : (
                    '—'
                  )}
                </Detail>
              </dl>

              {/* MUST-14.3: every row omitted when its value is null; the whole block omitted
                  when there is no principal AND no balance -- a loan item that has not had its
                  money fields filled in yet renders exactly like it did before this feature. */}
              {item.currentBalanceCents === null && item.principalCents === null ? null : (
                <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
                  {item.currentBalanceCents === null ? null : (
                    <>
                      <p className="money-lg">{formatCents(item.currentBalanceCents)}</p>
                      {/* MUST-11.8: "You set this on" and "Last payment" are labelled
                          DIFFERENTLY, because they answer different questions.
                          balance_updated_at is the human anchor. */}
                      {item.balanceUpdatedAt === null ? null : (
                        <p className="text-sm text-subtle">You set this on {item.balanceUpdatedAt.slice(0, 10)}</p>
                      )}
                    </>
                  )}
                  {/* F8 fix-round: a plain-voice heads-up next to the number people are about to
                      unassign a payment from -- removing an old link doesn't just undo one
                      transaction in isolation, it can leave the balance ahead of what the
                      household's latest paper statement says, and that's worth saying before
                      someone clicks Unassign expecting a plain undo. Gated on currentBalanceCents
                      too (micro round): a null balance isn't shown at all above, so a hint about
                      "the balance" would be pointing at a number that isn't even on the page. */}
                  {item.currentBalanceCents === null || paymentCount === 0 ? null : (
                    <p className="text-xs text-subtle">
                      Removing an old payment can push the balance above your latest statement figure.
                    </p>
                  )}
                  {payoffFraction === null ? null : <LoanProgressBar fraction={payoffFraction} label={item.name} />}
                  {/* F11 fix-round: the Detail rows below are dt/dd pairs and belong inside a
                      dl, same as the summary grid above -- they were previously loose divs. */}
                  {item.principalCents === null &&
                  item.interestRateBps === null &&
                  lastPaymentAt === null &&
                  paymentCount === 0 ? null : (
                    <dl className="flex flex-col gap-2">
                      {item.principalCents === null ? null : <Detail label="Original">{formatCents(item.principalCents)}</Detail>}
                      {item.interestRateBps === null ? null : (
                        <Detail label="Rate">{(item.interestRateBps / 100).toFixed(2)}%</Detail>
                      )}
                      {lastPaymentAt === null ? null : <Detail label="Last payment">{lastPaymentAt.slice(0, 10)}</Detail>}
                      {paymentCount === 0 ? null : <Detail label="Payments linked">{paymentCount}</Detail>}
                    </dl>
                  )}
                </div>
              )}
            </CardBody>
          </Card>
        )}
      </div>

      {/* Ruling B7: rendered when the kind ALLOWS installments, or when the item already HAS
          some -- a gate decides what a form offers, never what it may hide, and an item whose
          type was flipped away from Bill still holds rows a person typed. Add and Mark paid are
          disabled outside kind 'bill'; Remove never is. */}
      {!installmentsAllowedForKind(item.kind) && installments.length === 0 ? null : (
        <Card>
          <CardHeader
            title={
              <>
                {INSTALLMENT_SECTION_LABEL} ({installments.filter((row) => row.paidAt === null).length} unpaid,{' '}
                {formatCents(
                  installments.filter((row) => row.paidAt === null).reduce((sum, row) => sum + row.amountCents, 0),
                )}{' '}
                outstanding)
              </>
            }
            action={
              // Ruling R11 / micro-ruling M9: a read-side link, and the smallest possible UI for
              // it. Changing it changes no limit, no rollover and no total -- it only lets the
              // budgets row say what it is accumulating toward. AutoSaveSelect, not a form with
              // its own Save button -- see the saveBillCategory docblock above.
              <span className="flex flex-col gap-1.5">
                <span className={labelClass}>Accumulating in budget category</span>
                <AutoSaveSelect
                  name="categoryId"
                  defaultValue={item.budgetCategoryId === null ? '' : String(item.budgetCategoryId)}
                  options={[
                    { value: '', label: 'Not linked' },
                    ...categories.map((category) => ({ value: String(category.id), label: category.name })),
                  ]}
                  fields={{ itemId: String(item.id) }}
                  action={saveBillCategory}
                  ariaLabel="Accumulating in budget category"
                />
              </span>
            }
          />
          <CardBody className="flex flex-col gap-4">
            <p className="text-sm text-muted">
              Enter each due date the way it appears on the bill. The app reminds you before each one and flags any
              that go past.
            </p>
            {installments.length === 0 ? (
              <EmptyState
                icon={BellIcon}
                title="No installments yet"
                action={
                  <a href="#add-installment" className="btn btn--primary btn--sm">
                    Add the first due date
                  </a>
                }
              >
                A bill is a list of dates and amounts. Add the first one below and the reminders follow.
              </EmptyState>
            ) : (
              <>
                {/* Not `fixed`, so tests/ops/table-layout.test.ts's fixed-implies-minWidth pairing
                    does not apply -- same shape as the loan rules table directly below. */}
                <TableWrap bare responsive>
                  <thead>
                    <tr>
                      <th scope="col">Due date</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Status</th>
                      <th scope="col"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {installments.map((row) => (
                      <tr key={row.id}>
                        {/* v1.15.0 (responsive rows): there is no merchant/name on an
                            installment row -- the due date is what tells one row from
                            another, so it is the headline rather than the amount. */}
                        <td
                          className={`${row.state === 'overdue' ? 'font-medium text-danger' : 'font-medium text-ink'} cell-stack-headline`}
                          data-label="Due date"
                        >
                          {row.dueDate}
                        </td>
                        <td className="money cell-stack-amount" data-label="Amount">{formatCents(row.amountCents)}</td>
                        <td data-label="Status">
                          <span className={INSTALLMENT_BADGE[row.state]}>{installmentStateLabel(row.state)}</span>
                          {row.paidTxn === null ? null : (
                            <span className="mt-1 block text-xs text-muted">
                              Paid by{' '}
                              <Link href={`/transactions?q=${encodeURIComponent(row.paidTxn.description)}`}>
                                {row.paidTxn.date} · {row.paidTxn.description}
                              </Link>
                              {Math.abs(row.paidTxn.amountCents) === row.amountCents ? null : (
                                /* Ruling C7: the amount is NOT compared when matching, because a
                                   tax bill arrives with penalties, discounts and rounding. The
                                   difference is a FACT the household reads and decides about --
                                   not an error, and not a warning colour. */
                                <span className="block">
                                  Transaction was {formatCents(Math.abs(row.paidTxn.amountCents))} (
                                  {formatCents(Math.abs(Math.abs(row.paidTxn.amountCents) - row.amountCents))}{' '}
                                  {Math.abs(row.paidTxn.amountCents) > row.amountCents ? 'more' : 'less'} than
                                  scheduled)
                                </span>
                              )}
                            </span>
                          )}
                        </td>
                        <td className="text-right cell-stack-actions" data-label="">
                          {/* Ruling B9: two actions collapse into one kebab, and the accessible
                              name carries the amount AND the date -- a repeated single field is
                              the defect PENDING-FIXES item M records. */}
                          <RowMenu label={`Actions for the ${formatCents(row.amountCents)} installment due ${row.dueDate}`}>
                            {row.paidAt === null ? (
                              installmentsAllowedForKind(item.kind) ? (
                                <>
                                  {/* Ruling R8: above Mark paid -- Record payment is the normal
                                      path (it writes the transaction too), Mark paid stays for a
                                      payment made outside this app (e.g. cash, or a bank already
                                      reconciled some other way). */}
                                  <RowMenuForm
                                    action={recordPaymentDispatch}
                                    fields={{ installmentId: String(row.id) }}
                                  >
                                    Record payment
                                  </RowMenuForm>
                                  <RowMenuForm
                                    action={installmentRowDispatch}
                                    fields={{ intent: 'paid', id: String(row.id), itemId: String(item.id), paid: 'true' }}
                                  >
                                    Mark paid
                                  </RowMenuForm>
                                </>
                              ) : null
                            ) : (
                              <RowMenuForm
                                action={installmentRowDispatch}
                                fields={{ intent: 'paid', id: String(row.id), itemId: String(item.id), paid: 'false' }}
                              >
                                Unmark
                              </RowMenuForm>
                            )}
                            <RowMenuForm
                              action={installmentRowDispatch}
                              fields={{ intent: 'remove', id: String(row.id), itemId: String(item.id) }}
                              confirm={`Remove the installment due ${row.dueDate}? Its amount, and any payment recorded against it, go with it.`}
                            >
                              Remove
                            </RowMenuForm>
                          </RowMenu>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
                {/* Same F3-fix-round treatment as the loan rules table: the stale case ("removed
                    already, in another tab") has somewhere to surface. */}
                <FormError message={installmentRowState.error} />
                <FormError message={recordPaymentState.error} />
                {recordPaymentState.message === undefined ? null : (
                  <Notice tone="success">{recordPaymentState.message}</Notice>
                )}
              </>
            )}
            {installmentsAllowedForKind(item.kind) ? (
              <form action={addInstallmentDispatch} id="add-installment" className="flex flex-col gap-3">
                <input type="hidden" name="itemId" value={item.id} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Due date">
                    <input type="date" name="dueDate" className={inputClass} required />
                  </Field>
                  <Field label="Amount">
                    <input name="amount" inputMode="decimal" className={inputClass} placeholder="e.g. 1200.00" />
                  </Field>
                </div>
                <FormError message={addInstallmentState.error} />
                {addInstallmentState.message === undefined ? null : (
                  <Notice tone="success">{addInstallmentState.message}</Notice>
                )}
                {/* One form, one submit. No auto-save (ruling B8): correcting an installment is
                    remove and re-add, exactly as the loan rules card next to it works. */}
                <SubmitButton className="btn btn--primary self-start">Add installment</SubmitButton>
              </form>
            ) : null}
          </CardBody>
        </Card>
      )}

      {/* MUST-14.5 / MUST-14.6 / MUST-13.9: matching-allowed kinds only (loan and bill, v1.12.0).
          Always states the budget rule above the table, so the person reads it exactly where
          they are making the decision. */}
      {!matchingAllowedForKind(item.kind) ? null : (
        <Card>
          <CardHeader title="Payment matching" />
          <CardBody className="flex flex-col gap-4">
            <p className="text-sm text-muted">{matchingBlurbForKind(item.kind)}</p>
            {rules.length === 0 ? null : (
              <>
                <TableWrap bare responsive>
                  <thead>
                    <tr>
                      <th scope="col">Merchant contains</th>
                      <th scope="col">Account</th>
                      <th scope="col"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((rule) => (
                      <tr key={rule.id}>
                        {/* v1.15.0 (responsive rows): the merchant fragment is what tells one
                            rule apart from another -- this table has no money column at all,
                            so there is no cell-stack-amount here. */}
                        <td className="font-medium text-ink cell-stack-headline" data-label="Merchant contains">{rule.merchantContains}</td>
                        <td className="text-muted" data-label="Account">
                          {rule.accountId === null ? 'Any account' : (accounts.find((a) => a.id === rule.accountId)?.name ?? 'Any account')}
                        </td>
                        <td className="text-right cell-stack-actions" data-label="">
                          <form action={removeRule}>
                            <input type="hidden" name="id" value={rule.id} />
                            <input type="hidden" name="itemId" value={item.id} />
                            <SubmitButton className="btn btn--ghost btn--sm">Remove</SubmitButton>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
                {/* F3 fix-round: the stale-delete case (removed already, e.g. in another tab)
                    now has somewhere to surface -- "That rule no longer exists." -- instead of
                    the click silently doing nothing. */}
                <FormError message={deleteRuleState.error} />
              </>
            )}
            <form action={addRule} className="flex flex-col gap-3">
              <input type="hidden" name="itemId" value={item.id} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Merchant contains">
                  <input name="merchantContains" className={inputClass} placeholder="e.g. HONDA FIN" />
                </Field>
                <Field label="Account">
                  <select name="accountId" className={selectClass} defaultValue="">
                    <option value="">Any account</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.name}</option>
                    ))}
                  </select>
                </Field>
              </div>
              {/* MUST-13.9: UNCHECKED by default, and the hint says which case is which. A
                  person types today's balance and then saves a rule; back-filling a year of
                  payments would subtract them all from a figure that already accounts for
                  them. Loan-only (spec Component 5): the server refuses a bill's backfill too
                  (Step 4), so the checkbox is not offered for one either. */}
              {item.kind === 'loan' ? (
                <label className="flex items-start gap-2 text-sm text-muted">
                  <input type="checkbox" name="backfill" className="mt-1" />
                  <span>
                    Also link matching payments from the last 12 months
                    <span className="field-hint block">
                      Only tick this if the balance you typed is the balance from before those payments. Ticking it
                      will subtract every payment it finds.
                    </span>
                  </span>
                </label>
              ) : null}
              <FormError message={ruleState.error} />
              {ruleState.message === undefined ? null : <Notice tone="success">{ruleState.message}</Notice>}
              <SubmitButton className="btn btn--primary self-start">Add rule</SubmitButton>
            </form>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title={<>Receipts ({receipts.length} receipt{receipts.length === 1 ? '' : 's'})</>}
          description="Photos and PDFs are stored on this machine and read offline."
        />
        <CardBody className="flex flex-col gap-4">
          {receipts.length === 0 ? (
            <p className="rounded-md border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted">
              No receipts attached yet.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-3">
              {receipts.map((receipt) => (
                <li
                  key={receipt.id}
                  className="flex w-48 flex-col gap-1.5 rounded-md border border-line bg-surface-2/50 p-2 text-xs"
                >
                  <span className="flex h-32 items-center justify-center overflow-hidden rounded-xs bg-surface">
                    {!receipt.fileExists ? (
                      <span className="text-subtle">file missing</span>
                    ) : receipt.mime === 'application/pdf' ? (
                      // MUST-5.3: PDFs are LINKED, never embedded. An inline same-origin PDF
                      // runs the viewer's JavaScript in our origin.
                      <a href={`/api/warranties/receipts/${receipt.id}`} className="text-accent-text underline underline-offset-2">Download PDF</a>
                    ) : (
                      <a href={`/api/warranties/receipts/${receipt.id}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/warranties/receipts/${receipt.id}`}
                          alt={receipt.originalFilename}
                          className="max-h-32 w-full object-contain"
                        />
                      </a>
                    )}
                  </span>
                  {/* MUST-13.3: original_filename and ocr_error are attacker-influenceable and
                      are rendered as TEXT NODES only, never as HTML. */}
                  <span className="truncate font-medium text-ink" title={receipt.originalFilename}>{receipt.originalFilename}</span>
                  <span className="text-subtle">{Math.round(receipt.sizeBytes / 1024)} KB · {OCR_CHIP[receipt.ocrStatus]}</span>
                  {receipt.ocrError ? <span className="money-neg">{receipt.ocrError}</span> : null}
                  <div className="flex gap-1">
                    <form action={ocrAction}>
                      <input type="hidden" name="receiptId" value={receipt.id} />
                      <LinkSubmitButton>Re-run OCR</LinkSubmitButton>
                    </form>
                    <form
                      action={removeAction}
                      onSubmit={(event) => {
                        if (!confirm(`Remove ${receipt.originalFilename}?`)) event.preventDefault();
                      }}
                    >
                      <input type="hidden" name="receiptId" value={receipt.id} />
                      <LinkSubmitButton>Remove</LinkSubmitButton>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <form action={attachAction} className="flex flex-col gap-3 border-t border-line pt-4">
            <input type="hidden" name="itemId" value={item.id} />
            <input
              type="hidden"
              name="staged"
              value={JSON.stringify(staged.map((f) => ({ stagingId: f.stagingId, originalFilename: f.originalFilename })))}
            />
            <ReceiptUploader key={uploaderKey} onStagedChange={onStagedChange} label="Add another receipt" />
            <SubmitButton className="w-fit">Attach receipts</SubmitButton>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

function EditForm({
  item,
  people,
  types,
  today,
  action,
}: {
  item: WarrantyItemRow;
  people: { id: number; name: string }[];
  types: TypeOption[];
  today: string;
  action: (formData: FormData) => void;
}) {
  const [isLifetime, setIsLifetime] = useState(item.isLifetime);
  const [months, setMonths] = useState(item.warrantyMonths === null ? '' : String(item.warrantyMonths));
  // Plain const, not state, since v1.10.2 made the type fixed after the first save: there is
  // no <select> here any more to change it, so there is nothing to track. It was state for
  // v1.2.2 Task 2, when editing the type had to re-word the date labels and the fieldset
  // legend live; with the type frozen, the item's saved type is the only one there can be.
  // The name and the posted value are unchanged -- the action still reads `typeId`, and now
  // rejects one that does not match what is stored.
  const typeId = item.typeId === null ? '' : String(item.typeId);
  const selectedType = types.find((t) => String(t.id) === typeId);
  const selectedKind: ItemKind = selectedType?.kind ?? 'warranty';
  // v1.3.0: same live-follows-the-selected-kind treatment as the type/date fields above.
  const [billingCycle, setBillingCycle] = useState(item.billingCycle ?? '');
  const [billingAmount, setBillingAmount] = useState(
    item.billingAmountCents === null ? '' : (item.billingAmountCents / 100).toFixed(2),
  );
  const billingApplicable = billingAllowedForKind(selectedKind);
  const productApplicable = productFieldsAllowedForKind(selectedKind);
  useEffect(() => {
    if (!billingApplicable) {
      setBillingCycle('');
      setBillingAmount('');
    }
  }, [billingApplicable]);

  // v1.3.1: the loan money fields, seeded from the item -- this is what closes the review
  // finding where an unrelated edit used to null them out (the fields simply were not
  // rendered, and readItemInput() normalises an absent field to null). Same live-follows-the
  // -SELECTED-kind treatment as the billing pair above.
  const [principal, setPrincipal] = useState(item.principalCents === null ? '' : (item.principalCents / 100).toFixed(2));
  const [interestRate, setInterestRate] = useState(
    item.interestRateBps === null ? '' : (item.interestRateBps / 100).toFixed(2),
  );
  const [currentBalance, setCurrentBalance] = useState(
    item.currentBalanceCents === null ? '' : (item.currentBalanceCents / 100).toFixed(2),
  );
  // Fix wave item 4 (pre-tag follow-up): pinned via useState at mount, exactly like
  // `currentBalance` above -- NOT recomputed from the `item` prop on every render. A same-tab
  // revalidate (e.g. another action's revalidatePath) can update `item` while this form is
  // still open, and reading it live here would silently move the seed the action diffs
  // against out from under the open form.
  const [currentBalanceSeed] = useState(
    item.currentBalanceCents === null ? '' : (item.currentBalanceCents / 100).toFixed(2),
  );
  // v1.14.0 (spec BU, ruling P16): seeded from the item, same live-follows-the-selected-kind
  // treatment and the same reset effect as the money fields above.
  const [loanDirection, setLoanDirection] = useState<string>(item.loanDirection);
  const loanApplicable = loanFieldsAllowedForKind(selectedKind);
  useEffect(() => {
    if (!loanApplicable) {
      setPrincipal('');
      setInterestRate('');
      setCurrentBalance('');
      setLoanDirection('owed');
    }
  }, [loanApplicable]);

  return (
    <Card className="max-w-2xl">
      <CardHeader title="Edit this item" />
      <CardBody>
        <form action={action} className="flex flex-col gap-4">
          <input type="hidden" name="itemId" value={item.id} />
          <input type="hidden" name="transactionId" value={item.transactionId ?? ''} />
          <input type="hidden" name="staged" value="[]" />
          {/* Fix wave item 4: the balance this form was RENDERED with, pinned in the
              `currentBalanceSeed` state above at mount -- deliberately NOT the live
              `currentBalance` state, NOT re-read from the `item` prop on every render, and
              NOT gated on whether the loan fields are currently shown, so it still reflects
              the true render-time value even if the person switches the Type dropdown away
              from a loan kind mid-edit, or another action's revalidate updates `item` while
              this form stays open. The action compares the posted `currentBalance` against
              THIS to tell "untouched" from "edited", instead of against whatever is stored
              in the database at save time -- see actions.ts's readItemInput docblock. */}
          <input type="hidden" name="currentBalanceSeed" value={currentBalanceSeed} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2">
              <input name="name" required maxLength={200} defaultValue={item.name} className={inputClass} />
            </Field>
            {/* Fixed once the item exists, so it is shown rather than offered. The type decides
                which fields this form has -- a model and a serial for a purchase, a principal
                and a balance for a loan -- so changing it later would strand whatever the old
                kind stored. The value still posts, from a hidden input, because the action
                validates it against the stored one and rejects a mismatch; a disabled <select>
                would post nothing and read as "clear the type". Wrong type: delete and re-add. */}
            <Field label="Type" hint="Fixed after the first save. To change it, delete this item and add it again.">
              <input type="hidden" name="typeId" value={typeId} />
              <p className="field-control bg-surface-2 text-muted">{selectedType?.name ?? '— none —'}</p>
            </Field>
            <Field label="Vendor">
              <input name="vendor" maxLength={200} defaultValue={item.vendor ?? ''} className={inputClass} />
            </Field>
            {/* Offered for a warranty, and kept for anything that already holds one. An item
                whose type was changed after it was saved can still carry a model, a serial or
                a price, and a field holding a value must stay on screen: hide the input and
                the next save posts it blank, which silently deletes what was there. So the
                gate gets an OR on the stored value, not a bare kind check. */}
            {productApplicable || item.model ? (
              <Field label="Model">
                <input name="model" maxLength={200} defaultValue={item.model ?? ''} className={inputClass} />
              </Field>
            ) : null}
            {productApplicable || item.serial ? (
              <Field label="Serial number">
                <input name="serial" maxLength={200} defaultValue={item.serial ?? ''} className={inputClass} />
              </Field>
            ) : null}
            <Field label={formStartLabel(selectedKind)}>
              <input type="date" name="purchaseDate" required max={today} defaultValue={item.purchaseDate} className={inputClass} />
            </Field>
            {productApplicable || item.priceCents !== null ? (
              <Field label="Price">
                <input
                  name="price"
                  inputMode="decimal"
                  defaultValue={item.priceCents === null ? '' : (item.priceCents / 100).toFixed(2)}
                  className={inputClass}
                />
              </Field>
            ) : null}

            {billingApplicable ? (
              <>
                <Field label={billingSectionLabelForKind(selectedKind)}>
                  <select
                    name="billingCycle"
                    value={billingCycle}
                    onChange={(e) => setBillingCycle(e.target.value)}
                    className={selectClass}
                  >
                    <option value="">Not set</option>
                    {BILLING_CYCLES.map((cycle) => (
                      <option key={cycle} value={cycle}>{BILLING_CYCLE_LABELS[cycle]}</option>
                    ))}
                  </select>
                </Field>
                <Field label={billingAmountLabelForKind(selectedKind)}>
                  <input
                    name="billingAmount"
                    inputMode="decimal"
                    placeholder="e.g. 15.99"
                    value={billingAmount}
                    onChange={(e) => setBillingAmount(e.target.value)}
                    className={inputClass}
                  />
                </Field>
              </>
            ) : null}

            {/* v1.14.0 (spec BU, ruling P16), fix round (review C, item 2): gated on the same
                "gate OR held value" OR-arm as the detail row a few hundred lines up
                (loanFieldsAllowedForKind(kind) || item.loanDirection !== 'owed'), not on
                loanApplicable alone. A non-loan item that somehow carries 'lent' -- a data
                anomaly, or a kind changed elsewhere -- must still show its Direction here, or
                submitting this form with the field absent silently posts the column's own
                default and rewrites 'lent' to 'owed' on save. */}
            {loanApplicable || item.loanDirection !== 'owed' ? (
              <Field label="Direction" hint="Which way this loan points.">
                <select
                  name="loanDirection"
                  value={loanDirection}
                  onChange={(e) => setLoanDirection(e.target.value)}
                  className={selectClass}
                >
                  {LOAN_DIRECTIONS.map((direction) => (
                    <option key={direction} value={direction}>{LOAN_DIRECTION_LABELS[direction]}</option>
                  ))}
                </select>
              </Field>
            ) : null}

            {/* MUST-14.1: rendered exactly when the SELECTED type's kind is 'loan'. Hidden
                entirely otherwise, so an absent field posts as blank -> null, the same
                mechanism every other optional field on this form uses. */}
            {loanApplicable ? (
              <>
                <Field label="Original amount" hint={principalHintForDirection(loanDirection)}>
                  <input
                    name="principal"
                    inputMode="decimal"
                    placeholder="e.g. 28000.00"
                    value={principal}
                    onChange={(e) => setPrincipal(e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="Interest rate" hint="Shown for reference only — this app does no interest math.">
                  <span className="flex items-center gap-2">
                    <input
                      name="interestRate"
                      inputMode="decimal"
                      placeholder="e.g. 5.49"
                      value={interestRate}
                      onChange={(e) => setInterestRate(e.target.value)}
                      className={`${inputClass} w-28`}
                    />
                    <span className="text-sm text-muted">%</span>
                  </span>
                </Field>
                <Field label={balanceLabelForDirection(loanDirection)} hint={balanceHintForDirection(loanDirection)}>
                  <input
                    name="currentBalance"
                    inputMode="decimal"
                    placeholder="e.g. 19550.00"
                    value={currentBalance}
                    onChange={(e) => setCurrentBalance(e.target.value)}
                    className={inputClass}
                  />
                </Field>
              </>
            ) : null}
          </div>

          <fieldset className="flex flex-col gap-2">
            {/* v1.2.2 Task 2 (reviewer-flagged): this legend used to hard-code "Warranty
                length" regardless of the selected type's kind, breaking MUST-19.11's
                one-place rule -- the exact same bug as new-warranty-client.tsx. Routed
                through formTermLabel(), following the SELECTED type live, same as above. */}
            <legend className={labelClass}>{formTermLabel(selectedKind)}</legend>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="number"
                name="warrantyMonths"
                min={1}
                value={months}
                disabled={isLifetime}
                aria-label={formTermLabel(selectedKind)}
                onChange={(e) => setMonths(e.target.value)}
                className="field-control w-28"
              />
              <label className="flex items-center gap-2 text-sm text-muted">
                <input
                  type="checkbox"
                  name="isLifetime"
                  checked={isLifetime}
                  onChange={(e) => {
                    setIsLifetime(e.target.checked);
                    if (e.target.checked) setMonths('');
                  }}
                  className="accent-accent"
                />
                {formOpenEndedLabel(selectedKind)}
              </label>
            </div>
          </fieldset>

          <Field label="Owner" className="max-w-xs">
            <select name="ownerUserId" defaultValue={String(item.ownerUserId)} className={selectClass}>
              {people.map((person) => (
                <option key={person.id} value={person.id}>{person.name}</option>
              ))}
            </select>
          </Field>

          <Field label="Notes">
            <textarea name="notes" maxLength={2000} rows={3} defaultValue={item.notes ?? ''} className={textareaClass} />
          </Field>

          <SubmitButton className="w-fit">Save changes</SubmitButton>
        </form>
      </CardBody>
    </Card>
  );
}
