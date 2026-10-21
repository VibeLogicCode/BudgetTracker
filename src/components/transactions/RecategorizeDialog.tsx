'use client';

import Link from 'next/link';
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
 * result; mount it with `key={row.id}` so a different row gets a fresh picker.
 *
 * Spec §2.4: for a row a rule or the guesser filed (and a viewer who may author rules) the form also
 * asks what happens to future rows of the merchant: `keep` changes this transaction only; `teach`
 * posts teach=1 so setCategoryAction authors the rule itself (the rule-authoring path stays in that
 * action); `ask` posts no teach, closes, and hands over to the caller's Always ask dialog. The "wins
 * over" hint relies on an exact rule outranking a wider one (`outranks` in the rules engine); this
 * dialog never retargets the wider rule, so other rows it files keep their category.
 */
export function RecategorizeDialog({
  row,
  options,
  action,
  canAuthorRules,
  isAdmin,
  onClose,
  onAlwaysAsk,
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
  const [choice, setChoice] = useState<RuleChoice>('keep');
  // Spec §2.4: only a row a rule or the guesser filed, and only for a viewer who may author rules.
  const offerChoice = canAuthorRules && (row.source === 'rule' || row.source === 'bayes');
  const filedBy = row.filedBy;
  // An amount-bounded filing rule outranks a new exact rule, so the teach option would promise
  // something that does not happen; with Uncategorized picked there is no category to teach.
  const teachOffered = filedBy?.bounded !== true;
  const teachDisabled = picked === null;
  const effective: RuleChoice = choice === 'teach' && (teachDisabled || !teachOffered) ? 'keep' : choice;
  const currentLabel = options.find((o) => o.id === row.categoryId)?.label ?? 'its category';
  const teachHint =
    filedBy !== null && filedBy.matchType === 'exact' && filedBy.pattern === row.normalizedMerchant
      ? `Changes the rule ${row.normalizedMerchant} → ${currentLabel} to the category you pick.`
      : filedBy !== null
        ? `Adds a rule for ${row.normalizedMerchant} that wins over ${filedBy.pattern} (${filedBy.matchType}). Other ${filedBy.pattern} rows keep their rule.`
        : row.source === 'rule'
          ? // v1.57.1: a rule filed the row but no current rule accounts for it, so none can be named,
            // and the teach may update an exact rule that already exists rather than add one.
            `Set by a rule (it has changed since). Saves an exact rule for ${row.normalizedMerchant} with the category you pick.`
          : `Adds a rule for ${row.normalizedMerchant}; the guesser learns from it too.`;

  return (
    <RowDialog
      dialogId="recategorize-dialog"
      title={`Category for ${row.merchant}`}
      description={`${row.date} · ${formatCents(row.amountCents)}`}
      onClose={onClose}
    >
      <form
        action={action}
        onSubmit={() => {
          onClose();
          if (offerChoice && effective === 'ask') onAlwaysAsk();
        }}
        className="flex flex-col gap-4"
      >
        <input type="hidden" name="transactionId" value={row.id} />
        {offerChoice && effective === 'teach' ? <input type="hidden" name="teach" value="1" /> : null}
        <CategoryCombobox name="categoryId" label="Category" options={options} value={picked} onChange={setPicked} />
        {offerChoice ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-ink">{`Future ${row.normalizedMerchant} rows`}</legend>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="ruleChoice" value="keep" checked={effective === 'keep'} onChange={() => setChoice('keep')} className="mt-1" />
              <span>Change this transaction only</span>
            </label>
            {teachOffered ? (
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="ruleChoice" value="teach" checked={effective === 'teach'} disabled={teachDisabled} onChange={() => setChoice('teach')} className="mt-1" />
                <span>
                  {`Also file ${row.normalizedMerchant} this way from now on`}
                  <span className="block text-xs text-muted">{teachHint}</span>
                </span>
              </label>
            ) : null}
            {row.alwaysAsked ? null : (
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="ruleChoice" value="ask" checked={effective === 'ask'} onChange={() => setChoice('ask')} className="mt-1" />
                <span>
                  {`Always ask about ${row.normalizedMerchant} from now on`}
                  <span className="block text-xs text-muted">This transaction is filed as you pick; then you set the Always ask rule.</span>
                </span>
              </label>
            )}
            {isAdmin && filedBy !== null ? (
              <Link
                href={`/settings/merchant-rules?kind=category&q=${encodeURIComponent(filedBy.pattern)}`}
                className="text-xs font-medium text-accent hover:underline"
              >
                Edit the rule under Settings
              </Link>
            ) : null}
          </fieldset>
        ) : null}
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
