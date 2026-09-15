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

/**
 * 2026-09-15, `$impeccable critique` P2: "two badge systems on one screen". `.badge--*` and this
 * component both rendered on the dashboard at once -- the nav review count as a badge, a
 * NeedsALookCard kind label as a Pill -- at two paddings, two weights and two line-heights. Two
 * sizes of the same idea, which is the kind of small inconsistency that makes a careful product
 * read as assembled rather than designed.
 *
 * The two VOCABULARIES both earn their place and are kept: `.badge--*` is hue-named because
 * warranty status is specified by colour (spec 10.2 -- active neutral, expiring amber, expired
 * red, lifetime blue) and renaming those after semantic tokens would lose the mapping; Pill is
 * semantic because MetricCard's tones are. What is now shared is the GEOMETRY. Pill maps its tone
 * onto the hue class that already carries the same tokens, so there is one chip shape in the app
 * and `.badge` in globals.css is the single place its padding and weight are decided.
 */
const TONE_CLASS: Record<PillTone, string> = {
  neutral: 'badge--slate',
  accent: 'badge--accent',
  positive: 'badge--green',
  warning: 'badge--amber',
  negative: 'badge--red',
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
      // `.badge` carries the shape (radius, padding, size, weight, nowrap); `shrink-0` is the one
      // thing this component adds, because a Pill sits in a flex row beside a title that may wrap.
      className={`badge shrink-0 ${TONE_CLASS[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
