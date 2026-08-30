/**
 * The verdict chip, top-right of a card -- a category's "92%", a warranty's "Expiring", a
 * review row's "Needs a category". `.badge--*` (globals.css) already does this job for hue-named
 * statuses (warranty's active/expiring/expired/lifetime, spec section 10.2), but this component
 * exists for the newer MetricCard family, whose tones are semantic (positive/warning/negative)
 * rather than hue-named, so it maps straight onto the same tokens `ProgressBar` and `Money` use
 * rather than introducing a second colour vocabulary next to `.badge`'s.
 *
 * Ruling D3: these are OUR tokens, not the design reference's. `bg-secondary` in that reference
 * became `neutral`, `bg-primary`/`bg-success` became `accent`/`positive`, `bg-destructive`
 * became `negative` -- and every one of those Tailwind classes below resolves through the same
 * `--color-*` custom properties globals.css defines for light AND dark, so this component never
 * has to know which theme is active.
 */
export type PillTone = 'neutral' | 'accent' | 'positive' | 'warning' | 'negative';

const TONE_CLASS: Record<PillTone, string> = {
  neutral: 'bg-neutral-soft text-neutral-soft-fg',
  accent: 'bg-accent-soft text-accent-soft-fg',
  positive: 'bg-positive-soft text-positive-soft-fg',
  warning: 'bg-warning-soft text-warning-soft-fg',
  negative: 'bg-negative-soft text-negative-soft-fg',
};

export function Pill({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: React.ReactNode;
  tone?: PillTone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium leading-none ${TONE_CLASS[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
