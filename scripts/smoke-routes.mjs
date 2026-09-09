/**
 * The one definition of "which routes the smoke tests hit, and what each one must return."
 *
 * WHY this file exists (v1.32.0, lane L5): the standalone smoke test (scripts/smoke-test.mjs,
 * added in v1.31.0) boots the built app on the host and requests every route. It cannot catch a
 * missing Dockerfile COPY, a forgotten runtime file, or a read-only-rootfs violation, because it
 * never runs the shipped image. scripts/smoke-test-image.mjs is the image-level counterpart --
 * same expectations, a container instead of a host process. The project's own most-repeated
 * defect shape is one idea implemented in more than one place with nothing tying the copies
 * together (see docs/reviews/2026-09-02-review-for-opus.md and CHANGELOG.md's v1.31.0 entry), so
 * this route list is defined exactly once and imported by both scripts. If a route's expected
 * status ever changes, it changes here, for both smoke runs at once.
 *
 * Each entry's rationale was derived by reading the page or route's own redirect/auth logic --
 * see the comment on each list below -- never guessed.
 */

/** Must match src/lib/auth/session-constants.ts's SESSION_COOKIE_NAME. */
export const SESSION_COOKIE_NAME = 'bt_session';

/**
 * A cookie value that is well-formed but matches no session row -- the "third case" review
 * finding O-01 calls out: it passes src/proxy.ts (which only checks cookie *presence*) and must
 * still be bounced by requireUser() in src/app/(app)/layout.tsx, which only a real end-to-end
 * request (standalone OR image) can prove.
 */
export const GARBAGE_TOKEN = 'not-a-real-session-token-00000000000000000000000';

// 28 page routes (walked src/app/**/page.tsx). Default: 307 (-> /login) with no cookie, 200
// with a valid session. Listed exceptions were derived by reading each page's own redirect
// logic, not guessed -- see the smoke report for the source lines behind each one.
export const DEFAULT_PAGES = [
  '/dashboard',
  '/transactions',
  '/budgets',
  '/reports',
  '/goals',
  '/goals/new',
  '/import',
  '/import/wizard',
  '/warranties',
  '/warranties/new',
  '/help',
  '/settings',
  '/settings/accounts',
  '/settings/audit',
  '/settings/backups',
  '/settings/connections',
  '/settings/item-types',
  '/settings/managers',
  '/settings/merchant-rules',
  '/settings/notifications',
  '/settings/users',
];

// [path, anonExpected, authExpected]
export const SPECIAL_PAGES = [
  // src/app/page.tsx: always redirect()s based on isSetupRequired(), regardless of auth.
  ['/', [307], [307]],
  // src/app/(app)/review/page.tsx: folded into Transactions (ruling R6) -- unconditionally
  // redirect()s to /transactions?review=1 with no auth check of its own, so BOTH anon (the
  // proxy still 307s it to /login first, since /review carries no session cookie) and auth
  // (the page's own redirect) land on 307, just to different Location values.
  ['/review', [307], [307]],
  // src/app/(auth)/login/page.tsx never checks for a session; always renders the form.
  ['/login', [200], [200]],
  // src/app/(auth)/setup/page.tsx: setup is already done in this fixture, so it always
  // redirects to /login regardless of auth state.
  ['/setup', [307], [307]],
  // src/app/(auth)/setup/accounts/page.tsx is public-prefixed (proxy never blocks it) but
  // requireAdmin()s internally -- anon bounces to /login; authenticated with zero accounts
  // (this fixture's state) it renders the step.
  ['/setup/accounts', [307], [200]],
  // src/app/(auth)/change-password/page.tsx: not in PUBLIC_PREFIXES, so proxy 307s an
  // anonymous GET to /login; requireUser() passes for the seeded admin but
  // mustChangePassword is false, so the page itself redirects to /dashboard.
  ['/change-password', [307], [307]],
  // src/app/(app)/warranties/[id]/page.tsx: an id matching no row calls notFound().
  ['/warranties/999999', [307], [404]],
];

// 8 safe API GETs (spec's "Proposed smoke test" route list). [path, anonExpected, authExpected]
export const API_GETS = [
  ['/api/backup/download', [401], [200]],
  ['/api/reports/export', [401], [200]],
  // parseTaxYear() 400s with no ?year= -- always pass one so the auth-expected branch is 200.
  ['/api/reports/tax-export?year=2026', [401], [200]],
  ['/api/packs/rules/export', [401], [200]],
  ['/api/packs/profiles/export', [401], [200]],
  // Admin session, no SimpleFIN connection configured in this fixture -> the documented
  // "not connected" response, not a 500.
  ['/api/simplefin/accounts', [401], [409]],
  ['/api/warranties/receipts/999999', [401], [404]],
];

// The 11 POST-only routes (spec text says twelve; the actual route.ts files under src/app/api
// export exactly eleven POST handlers with no GET -- verified by grepping every
// `export (async )?function GET|POST` in src/app/api, not assumed from the review prose).
// A GET against each still proves the module loaded and the route registered (Next's own
// 405 for an unimplemented method on an existing route file).
export const POST_ONLY_ROUTES = [
  '/api/auth/logout',
  '/api/import/preview',
  '/api/import/raw-preview',
  '/api/import/commit',
  '/api/import/undo',
  '/api/packs/rules/import',
  '/api/packs/profiles/import',
  '/api/simplefin/claim',
  '/api/simplefin/link',
  '/api/simplefin/sync',
  '/api/warranties/receipts/stage',
];
