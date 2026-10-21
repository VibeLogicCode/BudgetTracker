'use client';

import { useState } from 'react';
import { CategoryCombobox } from '@/components/CategoryCombobox';
import { SubmitButton } from '@/components/SubmitButton';
import { buttonClass } from '@/components/ui/Button';
import { RowDialog } from '@/components/ui/RowDialog';
import type { CategoryOption } from '@/lib/category-order';
import { formatCents } from '@/lib/money';
// Type-only and relative: erased at compile time, so the client bundle never follows it into the
// server module (tests/ops/client-bundle.test.ts).
import type { FiledByRule } from '../../app/(app)/budgets/category-transactions-action';

/** The row a category change is open on, captured at open time. */
export interface RecategorizeRow {
  id: number;
  merchant: string;
  normalizedMerchant: string;
  date: string;
  amountCents: number;
  categoryId: number | null;
  source: 'rule' | 'bayes' | 'manual' | 'none';
  filedBy: FiledByRule | null;
  alwaysAsked: boolean;
}

export type RuleChoice = 'keep' | 'teach' | 'ask';

/**
 * Spec 2026-10-21 (fix from Budgets) §2.1. Change one transaction's category from the Budgets
 * card. The caller owns the dispatcher (useActionState over setCategoryAction) and reads its
 * result; mount it with `key={row.id}` so a different row gets a fresh picker. The rule choice
 * (keep, file this merchant this way, always ask) is added on top of this form later.
 */
export function RecategorizeDialog({
  row,
  options,
  action,
  onClose,
}: {
  row: RecategorizeRow;
  options: CategoryOption[];
  /** The caller's useActionState dispatcher for setCategoryAction. */
  action: (formData: FormData) => void;
  /** False for a self-scoped viewer: no rule choice at all. */
  canAuthorRules: boolean;
  /** The Rules page link. */
  isAdmin: boolean;
  onClose: () => void;
  /** 'ask' was chosen and the category posted. */
  onAlwaysAsk: () => void;
}) {
  const [picked, setPicked] = useState<number | null>(row.categoryId);

  return (
    <RowDialog
      dialogId="recategorize-dialog"
      title={`Category for ${row.merchant}`}
      description={`${row.date} · ${formatCents(row.amountCents)}`}
      onClose={onClose}
    >
      <form action={action} onSubmit={onClose} className="flex flex-col gap-4">
        <input type="hidden" name="transactionId" value={row.id} />
        <CategoryCombobox name="categoryId" label="Category" options={options} value={picked} onChange={setPicked} />
        <div className="flex gap-2">
          <SubmitButton>Save category</SubmitButton>
          <button type="button" onClick={onClose} className={buttonClass('ghost')}>
            Cancel
          </button>
        </div>
      </form>
    </RowDialog>
  );
}
