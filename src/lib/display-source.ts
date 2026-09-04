/**
 * v1.31.0 review finding R-03 (P2), controller ruling R24. THE ONE PLACE that says which writer
 * of `transactions.display_description` outranks which.
 *
 *   manual > loan > rename > unset
 *
 * WHY THIS MODULE EXISTS AT ALL. Until v1.31.0 the order was written down twice and agreed on
 * only by luck. `applyRenameRules` (src/lib/categorize/engine.ts) had it as a docblock -- "manual
 * > rename > unset", written before `'loan'` existed -- and `applyLoanDescription`
 * (src/lib/loans.ts) had a COPY of that sentence claiming to "mirror applyRenameRules' own rule",
 * written for a third source the original had never heard of. Each refused only `'manual'`, so
 * each happily overwrote the other: linking a WALMART transaction to a loan showed "Loan to
 * <name>", and the next rename pass (saving, disabling or deleting ANY rename rule, installing or
 * updating a pack, or a plain re-run over that row) rewrote it to "Walmart" and stamped
 * `display_source = 'rename'` -- after which unlinking reverted nothing, because
 * `revertLoanDescription` only clears a row still labelled `'loan'`, and the loan pages showed the
 * merchant name where the loan label belonged. Reverse the order of the two passes and you get the
 * reverse answer. That is this repo's most-repeated defect shape: one idea implemented in more
 * than one place with nothing tying the copies together.
 *
 * WHY THIS ORDER (ruling R24). An explicit per-row link beats a pattern rule. A loan link is a
 * relationship the household created deliberately, on that one transaction; a rename rule is a
 * bulk cosmetic preference that matches text. So when both apply, the loan label wins and a rename
 * never overwrites it: the specific beats the general, and the household can always see and change
 * the link on the row, whereas a silently-lost loan label leaves a real payment looking like an
 * ordinary purchase. `'manual'` stays above both for the same reason one step further -- a person
 * typed that text for that row by hand.
 *
 * THE ALTERNATIVE REJECTED. Last-writer-wins, which is what shipped until now: whichever pass ran
 * most recently decides, so the same household with the same data sees a different label depending
 * on unrelated activity. That is worse than either fixed order, because it is not reproducible --
 * it cannot be tested, and a person cannot learn it. ("rename > loan" was the other candidate and
 * was refused with the argument above.)
 *
 * HOW IT STAYS ONE DEFINITION. Both writers ask this module rather than restating the order:
 * `applyRenameRules` excludes `displaySourcesAbove('rename')` in its own SELECT, and
 * `applyLoanDescription` gates its write on `displaySourceMayWrite('loan', row.displaySource)`.
 * Adding a fourth source therefore means editing this array and nothing else -- and any writer
 * that forgets to consult it is the one thing a reader of this file should look for.
 *
 * Deliberately its OWN module rather than a constant in engine.ts: engine.ts already imports
 * src/lib/loans.ts (`applyPaymentMatchers`), so loans.ts importing from engine.ts would close an
 * import cycle. This file is pure, has no DB access and no notion of "today", so it costs either
 * side nothing to depend on.
 */

/** Exactly the enum on `transactions.display_source` (src/db/schema.ts). */
export type DisplaySource = 'manual' | 'loan' | 'rename';

/**
 * Strongest first. `null` (the bank's own text, unlabelled) is weaker than every entry and is not
 * listed: it is the absence of a claim, not a claim of its own.
 */
export const DISPLAY_SOURCE_PRECEDENCE: readonly DisplaySource[] = ['manual', 'loan', 'rename'];

/**
 * The sources that outrank `source` -- i.e. exactly the labels a pass writing `source` must leave
 * alone. Derived by position, so it can never disagree with the array above.
 */
export function displaySourcesAbove(source: DisplaySource): DisplaySource[] {
  return DISPLAY_SOURCE_PRECEDENCE.slice(0, DISPLAY_SOURCE_PRECEDENCE.indexOf(source));
}

/**
 * May a pass that writes `writer` label a row currently labelled `current`?
 *
 * An unlabelled row (`null`) is always writable, and a source may always REWRITE ITS OWN label --
 * a rename pass refreshing a renamed row, a loan re-link relabelling a loan row -- so the test is
 * "is the current label strictly above the writer", not "is it different".
 */
export function displaySourceMayWrite(writer: DisplaySource, current: DisplaySource | null): boolean {
  if (current === null) return true;
  return !displaySourcesAbove(writer).includes(current);
}
