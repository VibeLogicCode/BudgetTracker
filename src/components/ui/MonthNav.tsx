'use client';

import { addMonths, isMonthKey, monthLabel } from '@/lib/dates';
import { ChevronDownIcon } from '@/components/icons';

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
 *
 * Ruling U1 (2026-08-30 plan): v1.17.0 shipped this control's centre pill AND a separate,
 * visible `<input type="month">` beside it -- two interactive statements of the same fact next
 * to a dashboard eyebrow that stated it a third time. The pill IS the picker now: a `<label>`
 * wrapping the real `<input type="month">`, so clicking or tapping anywhere on the pill forwards
 * to the input the way a native `<label for>` always does, and for a month input that is exactly
 * what opens the browser's own calendar/month picker -- no client JS needed to "open" anything.
 * The input still exists in the DOM (keyboards and mobile browsers need the real control, not an
 * imitation), just positioned exactly over its own label at full size and fully transparent --
 * never `display:none` or `visibility:hidden`, either of which would drop it from the tab order
 * and make the app's own `:focus-visible` ring invisible along with it. Prev/next print `Jul` /
 * `Sep`, never `2026-07` / `2026-09` -- one control must not print two date formats.
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
          ← {shortMonthLabel(previous)}
        </a>
        {/* The hidden extraParams fields and the jump input both need to live inside the same
            <form> that submits the GET (see the docblock above), so the form wraps only the
            pill rather than the whole nav -- the prev/next <a> links are plain navigation and
            were never part of any form. */}
        <form method="get" action={basePath} className="flex items-center">
          {Object.entries(extraParams).map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={value} />
          ))}
          <label
            htmlFor="month-nav-jump"
            className="relative flex min-h-11 cursor-pointer items-center gap-1 rounded-full bg-surface px-3 py-1 text-sm font-semibold shadow-flat sm:min-h-0"
          >
            {monthLabel(month)}
            <ChevronDownIcon className="h-3.5 w-3.5 text-muted" />
            <input
              id="month-nav-jump"
              type="month"
              name="month"
              defaultValue={month}
              // Overridden here rather than left to the wrapping <label>'s own visible text --
              // "August 2026" names the month shown, not what activating the control DOES, and a
              // screen reader announcing the control needs the latter.
              aria-label="Jump to month"
              // Absolutely positioned over its own label at full size, opacity 0 rather than
              // display:none/visibility:hidden -- see this file's own docblock for why. Still a
              // real, focusable, clickable input: Tab reaches it, the browser's own
              // :focus-visible ring outlines the whole pill when it does, and a click anywhere on
              // the label forwards to it exactly as a native <label for> always does.
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              onChange={(event) => {
                // Only a value the rest of the app can already parse ever navigates. Some mobile
                // browsers commit an in-progress edit (e.g. the year half-typed) on every
                // keystroke rather than only once a full YYYY-MM exists, and firing a request for
                // one of those would just be a malformed `?month=` the server falls back on
                // anyway (ruling T7) -- pointless traffic and a page flash for nothing.
                if (isMonthKey(event.currentTarget.value)) event.currentTarget.form?.requestSubmit();
              }}
            />
          </label>
        </form>
        <a className="btn btn--ghost btn--sm min-h-11 rounded-full sm:min-h-0" href={hrefFor(next)}>
          {shortMonthLabel(next)} →
        </a>
      </nav>
    </div>
  );
}

/** 'August 2026' -> 'Aug'. Every month's standard three-letter abbreviation is exactly its full
 *  name's first three letters, so this reuses monthLabel's own table rather than duplicating it
 *  -- this file has no reason to add a second export to dates.ts for a two-line slice. */
function shortMonthLabel(month: string): string {
  return monthLabel(month).slice(0, 3);
}
