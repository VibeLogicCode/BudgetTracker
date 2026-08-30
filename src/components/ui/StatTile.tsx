/**
 * The big-number display. Money is the content of this product, so the tile is
 * mostly whitespace around one figure: an eyebrow that names what is counted,
 * the number, and at most one line of context under it.
 *
 * `tone` colours the figure — 'positive'/'negative' are the money pair and are
 * the same two tokens used everywhere else an amount is signed.
 * `emphasis` promotes one tile per row to the hero size; a grid of equally loud
 * numbers has no hierarchy at all.
 *
 * `delta` is the dashboard's "+2.4% vs last month" line the design reference has and this app's
 * tiles previously did not: a trend the page already computes, printed under the value rather
 * than folded into `hint`, because a tile can carry both a plain caption AND a trend at once
 * (a hint saying what the number means, a delta saying which way it moved). `deltaTone` is a
 * SEPARATE choice from `tone`, on purpose -- whether a move is good news is not implied by its
 * arithmetic sign. Spending up is bad news (`negative`) even though "spending" itself is not a
 * signed figure the way `tone` colours one; income up is good news (`positive`). Getting the two
 * confused is exactly the bug this prop exists to prevent: "spending rose" shown in green would
 * read as praise for the wrong thing.
 */
export type StatTone = 'default' | 'positive' | 'negative' | 'accent';
export type DeltaTone = 'positive' | 'negative' | 'default';

const TONE_CLASS: Record<StatTone, string> = {
  default: 'text-ink',
  positive: 'money-pos',
  negative: 'money-neg',
  accent: 'text-accent-text',
};

const DELTA_TONE_CLASS: Record<DeltaTone, string> = {
  default: 'text-muted',
  positive: 'money-pos',
  negative: 'money-neg',
};

export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
  emphasis = false,
  delta,
  deltaTone = 'default',
  footer,
  className = '',
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: StatTone;
  emphasis?: boolean;
  delta?: React.ReactNode;
  deltaTone?: DeltaTone;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card flex flex-col gap-2 p-4 sm:p-5 ${className}`}>
      <span className="eyebrow">{label}</span>
      <span className={`${emphasis ? 'money-xl' : 'money-lg'} ${TONE_CLASS[tone]}`}>{value}</span>
      {hint ? <p className="text-sm text-muted">{hint}</p> : null}
      {delta ? <p className={`text-xs font-medium ${DELTA_TONE_CLASS[deltaTone]}`}>{delta}</p> : null}
      {footer ? <div className="mt-1">{footer}</div> : null}
    </div>
  );
}
