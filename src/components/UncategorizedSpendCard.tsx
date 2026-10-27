import { CardActionRow } from '@/components/ui/CardActionRow';
import { WarningIcon } from '@/components/ui/icons';
import { MetricCard } from '@/components/ui/MetricCard';
import { Pill } from '@/components/ui/Pill';
import type { UncategorizedSpend } from '@/lib/budgets';
import { formatCents } from '@/lib/money';

/**
 * Spec 2026-10-21 §2.2, decision 12. Budgets' first card: money spent that no category holds yet.
 * It reads as needing attention in both themes through a warning border and a warning icon tile
 * (tokens defined for light and dark), the attention icon and the "Needs attention" label, never
 * colour alone. The card keeps the surface background because dark --subtle text on
 * --warning-soft is 4.12:1, under the 4.5 floor, so the border, the icon tile, the icon and the
 * label carry the signal. Renders nothing at zero.
 */
export function UncategorizedSpendCard({
  spend,
  href,
}: {
  spend: UncategorizedSpend | null;
  href: string;
}): React.ReactElement | null {
  if (spend === null || spend.count === 0) return null;
  return (
    <MetricCard
      tone="warning"
      icon={<WarningIcon className="h-5 w-5" data-testid="needs-attention-icon" />}
      title="Not categorized yet"
      pill={<Pill tone="warning">Needs attention</Pill>}
      value={formatCents(spend.totalCents)}
      status={spend.count === 1 ? '1 transaction' : `${spend.count} transactions`}
      action={<CardActionRow href={href}>Categorize</CardActionRow>}
    />
  );
}
