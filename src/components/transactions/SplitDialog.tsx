'use client';

import { useState } from 'react';
import { CategoryCombobox } from '@/components/CategoryCombobox';
import { SubmitButton } from '@/components/SubmitButton';
import { RowDialog } from '@/components/ui/RowDialog';
import { inputClass } from '@/components/ui/form';
import { buttonClass } from '@/components/ui/Button';
import { categoryOptions, type CategoryLike } from '@/lib/category-order';
import { formatCents, parseAmountToCents, sumCents } from '@/lib/money';
import type { SplitRow } from '@/lib/splits';

/** The transaction a split editor is open on: captured at open time so the dialog names the
 *  row (merchant, date, amount) in its own header once the row is out of view behind the
 *  backdrop. */
export interface SplitTarget {
  id: number;
  merchant: string;
  date: string;
  amountCents: number;
}

/** Draft state for one row of the split editor. Amounts are kept as the raw dollar text the
 *  person is typing (parsed with parseAmountToCents only at remainder/submit time) so a
 *  half-typed value like "12." never gets silently rewritten under someone's cursor. */
interface SplitPartDraft {
  categoryId: string;
  amount: string;
  note: string;
}

const blankSplitPart = (): SplitPartDraft => ({ categoryId: '', amount: '', note: '' });

/**
 * The split editor as a modal dialog, shared by the Transactions page and the Budgets card
 * (spec 2026-10-21 (fix from Budgets) §2.2).
 *
 * Unify-the-editors task (2026-08-30): the dimmed/blurred backdrop, role=dialog/aria-modal, the
 * focus trap, Escape, body-scroll lock and focus-restore-to-trigger all live once in RowDialog
 * (see its own docblock) rather than being hand-wired here. The caller owns the dispatcher
 * (useActionState over saveSplitsAction) and reads its result; this component owns only the
 * form's own DATA (the draft parts and the remainder math). Mount it with `key={target.id}` so
 * replacing one row's editor with another's, without passing through null, gets a fresh dialog
 * and a fresh draft.
 */
export function SplitDialog({
  target,
  existing,
  categories,
  action,
  onClose,
}: {
  target: SplitTarget;
  /** Existing parts; [] opens two blank parts. */
  existing: SplitRow[];
  /**
   * Every category, archived ones included (v1.57.2): each part lists live categories plus, when
   * that part holds an archived one, that one disabled (categoryOptions' assignment kind).
   */
  categories: CategoryLike[];
  /** The caller's useActionState dispatcher for saveSplitsAction; the caller reads the result. */
  action: (formData: FormData) => void;
  onClose: () => void;
}) {
  // Seeded once from the existing parts (or two blank parts for a fresh split).
  const [parts, setParts] = useState<SplitPartDraft[]>(() =>
    existing.length > 0
      ? existing.map((part) => ({
          categoryId: String(part.categoryId),
          amount: (Math.abs(part.amountCents) / 100).toFixed(2),
          note: part.note ?? '',
        }))
      : [blankSplitPart(), blankSplitPart()],
  );

  const updateSplitPart = (index: number, patch: Partial<SplitPartDraft>) => {
    setParts((prev) => prev.map((part, i) => (i === index ? { ...part, ...patch } : part)));
  };
  const addSplitPart = () => {
    setParts((prev) => [...prev, blankSplitPart()]);
  };
  const removeSplitPart = (index: number) => {
    setParts((prev) => prev.filter((_, i) => i !== index));
  };

  // Amounts are always typed as a plain positive dollar figure -- the parent's own sign is
  // applied here rather than asked of the person, so splitting a $50 expense means typing
  // "30.00" and "20.00", never "-30.00". parseAmountToCents (not hand-rolled parsing) does the
  // actual decimal-to-cents conversion; an unparsable/blank amount counts as 0 toward the
  // remainder rather than blocking every other keystroke with an error.
  const splitSign = target.amountCents < 0 ? -1 : 1;
  const draftPartCents = (part: SplitPartDraft): number => {
    const parsed = parseAmountToCents(part.amount);
    return parsed === null ? 0 : Math.abs(parsed) * splitSign;
  };
  // A blank row added by "Add a part" and never given a category is dropped rather than
  // submitted (and left out of the remainder math below) -- it was never really a part.
  const activeSplitParts = parts.filter((part) => part.categoryId !== '');
  const splitPartsPayload = activeSplitParts.map((part) => ({
    categoryId: Number(part.categoryId),
    amountCents: draftPartCents(part),
    note: part.note.trim() === '' ? null : part.note.trim(),
  }));
  const splitRemainderCents = target.amountCents - sumCents(activeSplitParts.map(draftPartCents));

  return (
    <RowDialog
      dialogId="split-dialog"
      title={`Split ${target.merchant}`}
      description={
        <>
          {`${target.date} · ${formatCents(target.amountCents)} — `}
          Divide this transaction across more than one category. The parts must add up to the full amount.
        </>
      }
      onClose={onClose}
    >
      <form action={action} onSubmit={onClose} className="flex flex-col gap-4">
        <input type="hidden" name="txnId" value={target.id} />
        <input type="hidden" name="parts" value={JSON.stringify(splitPartsPayload)} />
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2 text-xs font-medium text-muted">
            <span className="w-44">Category</span>
            <span className="w-24">Amount</span>
            <span className="flex-1">Note</span>
          </div>
          {parts.map((part, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              {/* Backlog BZ (deferred half): a split is where a long category list is worst
                  -- several parts, each needing a different branch. Same unchosen semantics as
                  the recategorize dialog. */}
              <CategoryCombobox
                options={categoryOptions(categories, { kind: 'assign', current: part.categoryId === '' ? null : Number(part.categoryId) })}
                value={part.categoryId === '' ? null : Number(part.categoryId)}
                onChange={(id) => updateSplitPart(index, { categoryId: id === null ? '' : String(id) })}
                label={`Category for part ${index + 1}`}
                includeUncategorized={false}
                placeholder="Choose a category"
                className="w-44"
              />
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
                disabled={parts.length <= 2}
                className={buttonClass('ghost', 'sm', 'px-2 text-xs')}
              >
                Remove part
              </button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={addSplitPart} className={buttonClass('secondary', 'sm')}>
            Add a part
          </button>
          <span className="text-sm text-muted">Remaining to assign: {formatCents(splitRemainderCents)}</span>
        </div>
        <div className="flex gap-2">
          <SubmitButton disabled={splitRemainderCents !== 0}>Save split</SubmitButton>
          <button type="button" onClick={onClose} className={buttonClass('secondary')}>
            Cancel
          </button>
        </div>
      </form>
      <form action={action} onSubmit={onClose}>
        <input type="hidden" name="txnId" value={target.id} />
        <input type="hidden" name="parts" value="[]" />
        <SubmitButton variant="secondary">Remove split</SubmitButton>
      </form>
    </RowDialog>
  );
}
