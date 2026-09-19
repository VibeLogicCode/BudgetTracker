import Link from 'next/link';
import type { RuleLinkedPayment } from '@/lib/loans';
import { Card, CardHeader } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';
import { UnlinkRulePaymentForm } from '@/components/UnlinkRulePaymentForm';
import { formatCents } from '@/lib/money';

/**
 * R27b (docs/PENDING-FIXES.md): "rule-linked loan payments could land in the review queue rather
 * than applying silently, so a wrong link costs a click instead of going unnoticed."
 *
 * WHY THIS IS THE ITEM THAT MATTERED of the three the R27 ruling spawned. That ruling closed the
 * rename question by pointing out what the real exposure was: a loan can be repaid by e-transfer,
 * cash or bank draft, those descriptions are generic, the matcher is a substring test, and a wrong
 * match does not merely mislabel a row — it MOVES A LOAN BALANCE. Until now the only way to catch
 * one was to happen to open that row's menu.
 *
 * NOT THE CATEGORY REVIEW QUEUE, despite R27b's wording. That queue answers "what is this charge?"
 * and is driven by REVIEW_WHERE over uncategorized and Bayes-guessed rows; a loan link answers a
 * different question ("is this the loan I think it is?") about rows that usually have no category
 * problem at all. Folding one into the other would make both lists mean less. This is the same
 * move RuleReviewCard made for import-time category rules, for the same reason and on the same
 * page.
 *
 * RULE-MADE ONLY. `loan_payments.source` has distinguished 'rule' from 'manual' since the table
 * existed, so this needed no migration. A manual assign is a person naming THIS row and needs no
 * second opinion — the same asymmetry the R27 ruling itself drew when it decided only a manual
 * assign earns a rename.
 *
 * SELF-HIDING, like every other attention card on this page, and windowed rather than complete: a
 * link from eight months ago the household has lived with is not news, and a list that only grows
 * is one nobody reads.
 */
export const RULE_LINKED_ROW_LIMIT = 5;

export function RuleLinkedPaymentsCard({ payments }: { payments: RuleLinkedPayment[] }) {
  if (payments.length === 0) return null;

  const shown = payments.slice(0, RULE_LINKED_ROW_LIMIT);
  const hiddenCount = payments.length - shown.length;

  return (
    <Card>
      <CardHeader
        title="A rule linked these to a loan"
        description="Matching rules go on merchant text, which is often generic on a repayment. These moved a balance — worth a glance that they are the right loan."
      />
      <ul className="border-t border-line text-sm">
        {shown.map((payment) => (
          <ListRow
            key={`${payment.txnId}-${payment.itemId}`}
            title={payment.itemName}
            meta={`${payment.date} · ${payment.description} · ${formatCents(payment.appliedCents)} off the balance`}
            trailing={<UnlinkRulePaymentForm txnId={payment.txnId} itemId={payment.itemId} itemName={payment.itemName} />}
          />
        ))}
        {hiddenCount > 0 ? (
          <li className="border-b border-line px-4 py-3 last:border-b-0 sm:px-5">
            {/* The same overflow shape RuleReviewCard uses: point at the surface that lists every
                one of them rather than inventing a page for this overflow line alone. */}
            <Link href="/warranties" className="text-accent-text underline">
              {`${hiddenCount} more on Loans & Coverage`}
            </Link>
          </li>
        ) : null}
      </ul>
    </Card>
  );
}
