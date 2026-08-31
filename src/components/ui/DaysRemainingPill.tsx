import { Pill } from '@/components/ui/Pill';
import { WarningIcon } from '@/components/ui/icons';

/**
 * Item 3 (2026-08-30 one-design-language plan). The days-remaining chip beside a due date or an
 * expiry -- "92d", "22d", a warning-toned "7d" once seven days or fewer remain. Three call sites
 * had each implemented this exact rule on their own: ComingUpCard.tsx and
 * ExpiringSoonCard.tsx were byte-identical (a local `daysRemainingPill(days)` returning
 * `{label, tone}`), and warranties-client.tsx forked a third version under `(expiryDate, today)`
 * that also swapped in a lucide `WarningIcon` where the other two drew a bare "⚠" character.
 * This is the one component all three now share.
 *
 * Signature is `days: number`, not `(expiryDate, today)`: every existing caller already has (or
 * derives with `daysBetweenIso`) a day count before it decides whether to show a pill at all --
 * ComingUpCard skips this entirely for an overdue bill, ExpiringSoonCard's rows are always
 * non-negative by construction (`expiringSoonItems()` only ever selects status 'expiring',
 * which `warrantyStatus()` in expiry.ts defines as `today <= expiryDate`). Taking a date pair
 * instead would force the two callers that never need "today minus an expiry date" to compute
 * it anyway, just so warranties-client's own convenience became everyone's API.
 *
 * A negative `days` renders nothing, built into this component rather than left to callers:
 * "days remaining" has no negative reading, and warranties-client relies on exactly that to stay
 * silent once StatusBadge's own "expired" pill is already on the row -- a second, contradicting
 * number beside it would be worse than saying nothing. ComingUpCard and ExpiringSoonCard never
 * exercise that branch (their own callers already withhold overdue/negative rows before reaching
 * this component), so folding the guard in here costs them nothing and saves warranties-client
 * from needing an extra flag to ask for it.
 *
 * The icon: the "⚠" text glyph ComingUpCard/ExpiringSoonCard drew was drift, not an intentional
 * second design -- ui/icons.tsx already names `WarningIcon` for exactly this pill ("Inside a
 * week, the days-remaining pill goes warning-toned and gets this glyph"), and ruling D2
 * centralises every icon through that one file so a literal Unicode character never has to sit
 * next to a component drawing the "real" glyph from lucide. WarningIcon is kept; the "⚠"
 * character is retired everywhere.
 */
export function DaysRemainingPill({ days }: { days: number }): React.ReactElement | null {
  if (days < 0) return null;
  const withinWeek = days <= 7;
  return (
    <Pill tone={withinWeek ? 'warning' : 'neutral'}>
      {withinWeek ? <WarningIcon aria-hidden="true" className="mr-0.5 inline h-3 w-3" /> : null}
      {days}d
    </Pill>
  );
}
