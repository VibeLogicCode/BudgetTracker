'use client';

import { addMonths, isMonthKey, monthLabel } from '@/lib/dates';

/**
 * The one month navigator, shared by Budgets and the dashboard (savings-targets plan, Lane 3
 * item 2). Budgets used to hand-roll its own bare prev/next links
 * (budgets-client.tsx, previously around lines 408-421) and the dashboard had no month control
 * at all -- ruling T7 needs the dashboard to follow `?month=`, and two independent
 * prev/next implementations is exactly how the two pages would drift again. This is the one
 * place "change the month" is decided, for both.
 *
 * Deliberately NOT a client-side router. Prev/next are real <a> links -- a full navigation,
 * so following one works with no client JS at all -- and the <input type="month"> sits inside
 * a real `<form method="get">`, so jumping to an arbitrary month or year is also a plain GET
 * the server resolves the same way. The only reason this file carries 'use client' is that
 * submitting that form on change (rather than waiting for a "Go" button nobody asked for) needs
 * an onChange handler.
 */
export function MonthNav({
  month,
  basePath,
  extraParams = {},
  className = '',
}: {
  /** The month currently shown, already validated to YYYY-MM by the caller -- both pages fall
   *  back to the current month for anything malformed (ruling T7) before this ever renders. */
  month: string;
  /** Where the links and the jump form point -- '/budgets' or '/dashboard'. */
  basePath: string;
  /** Any OTHER query params this page's URL carries (the dashboard's `person=<id>` scope pill)
   *  that must survive a month change -- dropping one here would silently reset an unrelated
   *  filter every time somebody changed the month. */
  extraParams?: Record<string, string>;
  className?: string;
}) {
  const previous = addMonths(month, -1);
  const next = addMonths(month, 1);

  const hrefFor = (target: string): string => {
    const params = new URLSearchParams(extraParams);
    params.set('month', target);
    return `${basePath}?${params.toString()}`;
  };

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <nav
        aria-label="Change month"
        className="flex items-center gap-1 rounded-full border border-line bg-surface-2 p-1"
      >
        {/* min-h-11 sm:min-h-0: the 44px tap-target floor this codebase already applies to
            every other dense control on a phone (AutoSave.tsx's AUTO_SAVE_CONTROL, the review
            picker, the filters toggle) -- .btn's own padding alone clears well under that. */}
        <a className="btn btn--ghost btn--sm min-h-11 rounded-full sm:min-h-0" href={hrefFor(previous)}>
          ← {previous}
        </a>
        <strong className="rounded-full bg-surface px-3 py-1 text-sm font-semibold shadow-flat">
          {monthLabel(month)}
        </strong>
        <a className="btn btn--ghost btn--sm min-h-11 rounded-full sm:min-h-0" href={hrefFor(next)}>
          {next} →
        </a>
      </nav>
      {/* A native month input, not a text field: every browser ships its own month/year picker
          for free, so reaching a month from three years back is one control instead of walking
          every month in between with the prev arrow. Submitting is a real GET (not
          router.push), so this component never needs to know how its host page navigates --
          only where. */}
      <form method="get" action={basePath} className="flex items-center gap-1.5">
        {Object.entries(extraParams).map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
        <label htmlFor="month-nav-jump" className="sr-only">
          Jump to month
        </label>
        <input
          id="month-nav-jump"
          type="month"
          name="month"
          defaultValue={month}
          // field-control's own mobile media query already floors this at 44px
          // (src/app/globals.css) -- see that rule's own comment for why .field-control needed
          // one when .btn elsewhere in this file needed an explicit min-h-11 instead.
          className="field-control w-auto px-2 py-1 text-sm"
          onChange={(event) => {
            // Only a value the rest of the app can already parse ever navigates. Some mobile
            // browsers commit an in-progress edit (e.g. the year half-typed) on every keystroke
            // rather than only once a full YYYY-MM exists, and firing a request for one of those
            // would just be a malformed `?month=` the server falls back on anyway (ruling T7) --
            // pointless traffic and a page flash for nothing.
            if (isMonthKey(event.currentTarget.value)) event.currentTarget.form?.requestSubmit();
          }}
        />
      </form>
    </div>
  );
}
