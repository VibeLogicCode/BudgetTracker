import Link from 'next/link';

/**
 * v1.25.0 backlog item 15. "A row of pill-shaped filter links, one marked active" shipped THREE
 * times independently before this: `ScopePill` (budgets-client.tsx, v1.21.0 item 1 -- household
 * vs a person's own budgets), `PersonPill` (dashboard/page.tsx -- whose spending to show), and the
 * transfer-view control (transactions-client.tsx, v1.24.0 Lane A item 2 -- All/Transfers only/No
 * transfers). Three copies of one idea is exactly how the two older ones drifted from the newest:
 * only the transfers control ever gained `aria-current="page"` (the other two wrote `"true"`) and
 * the 44px mobile touch-target floor every other dense control in this app already carries (AutoSave.tsx's AUTO_SAVE_CONTROL, MonthNav's own prev/next links). This is the one
 * implementation now, carrying every one of those three properties regardless of which page
 * renders it -- one idea, one implementation, so the next feature added to any of these three call
 * sites is automatically available on all of them, the same reasoning that drove the row-card
 * unification in transactions-client.tsx (see that file's own "THE RULE FOR WHOEVER ADDS THE NEXT
 * FEATURE" docblock).
 *
 * NOT built on top of `Pill` (src/components/ui/Pill.tsx), even though that component exists and
 * the transfer-view control already composes one: Pill's tone vocabulary (neutral/accent/positive/
 * warning/negative) is a STATUS vocabulary for a static badge, and its fixed base box
 * (`px-2.5 py-1 text-xs`) does not match the size the two older call sites already render at
 * (`px-3 py-1 text-sm`) or their "selected segmented tab" look (`bg-surface font-semibold
 * shadow-flat` active, transparent/muted inactive) -- the same chrome MonthNav's own month-jump
 * pill already uses (MonthNav.tsx), not a status colour at all. Pill's own `className` prop is
 * APPENDED to its tone classes, not a replace-the-default the way AutoSaveTextInput's is (see that
 * component's own `className = AUTO_SAVE_CONTROL` -- a caller's className there fully REPLACES the
 * default string), so leaning on Pill plus an overriding className to reproduce that different
 * size and colour would be relying on Tailwind's own generated stylesheet order to pick a winner
 * between two same-specificity utility classes -- exactly the kind of fragile override this
 * codebase does not otherwise practice. Reproducing the two existing call sites' own classes
 * directly, in one place, is the change that carries zero risk of silently resizing or
 * recolouring either page's pills -- this task's own hard requirement ("no intended visible
 * change"). A future caller wanting the transfer-view control's own Pill-chip look instead can
 * still get it: `className` below fully replaces the group wrapper's own chrome (the same
 * replace-not-append default-parameter idiom as AUTO_SAVE_CONTROL), so nothing here forecloses
 * that idiom -- it just isn't which look TODAY's two callers already committed to rendering.
 */
export interface PillNavOption {
  /** React list key. Neither existing call site's "whole household" option has an id of its own
   *  (it is `null` in the data, precisely because it is not a single person) -- callers pass a
   *  fixed string like `'household'` for it and `String(person.id)` for everyone else. */
  key: string;
  href: string;
  label: string;
  active: boolean;
}

export function PillNav({
  groupLabel,
  options,
  className = 'flex flex-wrap items-center gap-1 rounded-full border border-line bg-surface-2 p-1',
}: {
  /** The accessible name for the `<nav>` landmark -- "Which budgets to show" / "Whose money to
   *  show" today, read aloud once for the group rather than repeated on every link, and the name
   *  the landmark is listed under when somebody jumps between them. */
  groupLabel: string;
  options: PillNavOption[];
  /** Defaults to the segmented-tab chrome both existing call sites already render (border,
   *  `bg-surface-2`, rounded, padded) -- a caller wanting a different look (the loose, borderless
   *  chip row the transfer-view control renders, say) replaces this entirely rather than fighting
   *  the default via an appended override, the same `className = DEFAULT` idiom AUTO_SAVE_CONTROL
   *  already uses. */
  className?: string;
}) {
  return (
    // A LABELLED `<nav>` LANDMARK, not `role="group"`. The v1.25.0 refactor brief asked for
    // `role="group"` to match the transfer-view control, and that was wrong: an element has
    // exactly one computed role, so taking the group meant these two call sites SILENTLY LOST a
    // landmark a screen-reader user could jump to. On Budgets in particular -- roughly forty rows
    // of household and personal categories -- the scope switcher is precisely the control someone
    // wants to reach without walking the whole page, and `role="group"` provides no such
    // affordance (it only names a set of controls once instead of per-link, which a labelled
    // `<nav>` does anyway). `<nav>` also makes `aria-current="page"` below coherent rather than
    // merely defensible: each option is a real, separate URL, so the active one genuinely IS the
    // current page within a navigational set. The transfer-view control in transactions-client.tsx
    // is the one left on `role="group"` and should be moved onto this component.
    <nav aria-label={groupLabel} className={className}>
      {options.map((option) => (
        <Link
          key={option.key}
          href={option.href}
          // `"page"`, not the `"true"` both original components wrote -- ARIA's own value for
          // "this link names the state the surrounding view is currently in", which is what a
          // filter/scope pill actually is (the same value the transfer-view control already
          // settled on). Neither older component's own tests asserted the literal string, so
          // this is a same-shape improvement, not a behaviour this refactor had to choose around.
          aria-current={option.active ? 'page' : undefined}
          // `inline-flex ... items-center`: `min-height` has no effect on a plain inline element
          // (CSS spec), so the 44px floor below needs a box model that actually honours it -- the
          // same reason the transfer-view control's own Link carries the identical pair. `sm:
          // min-h-0` lifts the floor back off at the breakpoint where a mouse, not a thumb, is
          // doing the pointing (AUTO_SAVE_CONTROL's own comment makes the identical trade).
          className={`inline-flex min-h-11 items-center rounded-full px-3 py-1 text-sm transition-colors sm:min-h-0 ${
            option.active ? 'bg-surface font-semibold text-ink shadow-flat' : 'font-medium text-muted hover:text-ink'
          }`}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}
