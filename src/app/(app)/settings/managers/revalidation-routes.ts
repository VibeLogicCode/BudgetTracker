/**
 * Every route that renders a category's name or the category hierarchy to a user. Found by
 * grepping the app for `listCategories`/`categoryName`/`categoryId`
 * rather than trusting the three routes the bug report happened to name:
 *   - /settings/managers  -- this page; the category table itself.
 *   - /transactions       -- the per-row category and the filter list.
 *   - /reports            -- category breakdown and series.
 *   - /budgets            -- budgetProgress() rows, keyed by category, incl. nested children.
 *   - /dashboard          -- the "this month's budgets" table (budgetProgress() again) and
 *                            the account-setup callout's category-driven copy.
 * Review round (fold /review in): `/review` is gone from this list -- it is now `?review=1` on
 * `/transactions` (ruling R1), which already revalidates the category picker for every queued
 * row (review or not) as the same route. `/review` itself still exists as a route (ruling R6,
 * a bare redirect), but a redirect renders no category of its own to go stale.
 * A category mutation (create, rename, archive) must revalidate every one of these or Next's
 * client router cache serves the pre-mutation page for up to ~30s. Every category mutation
 * in actions.ts loops over this SAME constant -- and the test in
 * tests/app/managers-actions.test.ts reads it too -- so a route added here without a matching
 * revalidatePath call fails the test, instead of a future page silently joining the
 * "never revalidated" set the way /budgets, /reports and /dashboard did.
 *
 * This constant lives in its own module, separate from actions.ts, because actions.ts starts
 * with 'use server': a 'use server' file may export ONLY async functions, and an array export
 * there throws at require-time in production (every other export in that file already is an
 * async function, which is exactly why this was the one export that got away with it in dev
 * and in the vitest suite, neither of which apply 'use server' module semantics, and only broke
 * when the real Next server required the compiled module).
 */
export const CATEGORY_RENDERING_ROUTES = [
  '/settings/managers',
  '/transactions',
  '/reports',
  '/budgets',
  '/dashboard',
] as const;

/**
 * Every route that renders the import-profile list (spec 2026-08-22 v1.6.0, MUST-4.4),
 * whether the filtered picker offered at import time or the unfiltered admin-facing list on
 * the managers page:
 *   - /settings/managers  -- this page; every profile, active or not, with the
 *                            activate/deactivate toggle.
 *   - /import              -- the main import picker, filtered to active + readable.
 *   - /import/wizard       -- the "add a bank" wizard; it saves into the same
 *                            import_profiles table (its own name-uniqueness check reads every
 *                            row, active or not) and is where a later task may offer existing
 *                            profiles as a starting point.
 *   - /settings/accounts   -- shows which profile an account is pinned to (Task 5).
 * Activating or deactivating a profile must revalidate every one of these or Next's client
 * router cache can keep serving a stale picker for up to ~30s -- the exact class of bug
 * CATEGORY_RENDERING_ROUTES above exists to prevent, one feature later. This constant lives in
 * its own module for the same reason CATEGORY_RENDERING_ROUTES does (see its doc comment
 * above): actions.ts starts with 'use server', which may export only async functions.
 */
export const PROFILE_RENDERING_ROUTES = [
  '/settings/managers',
  '/import',
  '/import/wizard',
  '/settings/accounts',
] as const;
