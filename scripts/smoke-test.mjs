#!/usr/bin/env node
/**
 * Boot-and-request smoke test (review 2026-09-02, finding O-01, ruling R9).
 *
 * WHY this exists: `tsc`, vitest and `next build` all pass on a page that throws on every
 * request -- v1.29.0 shipped exactly that (a Server Component value-importing a non-component
 * binding from a 'use client' module), because nothing in CI ever started the app and issued a
 * real request. The source-level guards in tests/ops/client-bundle.test.ts catch a few known
 * shapes of that defect; this script is the backstop for the shapes nobody has enumerated yet.
 * It builds the app, boots the real standalone server against a throwaway database, and GETs
 * every page and every safe API route the way a browser or an API client would. Any route that
 * throws at render time -- the one thing a passing `next build` cannot prove, because every page
 * here is `force-dynamic` and is therefore never pre-rendered -- fails this script.
 *
 * WHY a hand-rolled request battery instead of a browser (Playwright etc.): this only needs to
 * prove each route's server-rendered response is well-formed (status code, no server-side
 * console.error, the expected redirect/auth split) -- it never needs to execute client JS,
 * click anything, or read a rendered DOM. A real browser would cost more CI time for zero
 * additional coverage of the defect class this exists to catch.
 *
 * WHY the session is minted directly in the fixture database instead of driving the real
 * POST /login form: the login page submits through a React Server Action, not a plain HTML
 * form POST -- reproducing that wire protocol by hand (the hidden action-id field, Next's own
 * built-in Origin/Referer check, the RSC action-argument encoding) would be fragile scaffolding
 * that breaks on any Next upgrade, and it would only be re-testing loginAction(), which already
 * has full coverage in tests/app/*login*. What this script actually needs to prove -- that a
 * valid session cookie is accepted end to end and an invalid one is rejected end to end by
 * requireUser() -- is exercised identically by a session row written straight into the fixture
 * database, using the same tokenHash = sha256(token) scheme src/lib/auth/session.ts uses.
 *
 * WHY plain `better-sqlite3` + `drizzle-orm` here instead of importing `@/db/client` and
 * `@/db/seed`: this script runs with Node's native TypeScript stripping, which has no notion of
 * the `@/*` -> `src/*` path alias Next's bundler and vitest's config resolve -- there is no
 * bundler in front of it. Rather than add a bespoke path-alias loader (a new, untested failure
 * mode for a CI job that must stay simple to debug when it goes red), this mirrors the existing
 * convention in scripts/reset-admin-password.ts: talk to better-sqlite3 and argon2 directly.
 * ARGON2_OPTIONS below must stay identical to src/lib/auth/password.ts, the same invariant
 * tests/scripts/reset-admin-password.test.ts already pins for that script.
 *
 * NEVER touches .tmp-data/ -- the fixture lives under a fresh os.tmpdir() directory, created
 * here and removed at the end of this script, regardless of pass or fail.
 *
 * NEVER logs a session token or a cookie value -- only route paths and status codes.
 */

import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import argon2 from 'argon2';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const ROOT = process.cwd();
const PORT = Number(process.env.SMOKE_PORT ?? 3411);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const SESSION_COOKIE_NAME = 'bt_session';

/** Must stay identical to ARGON2_OPTIONS in src/lib/auth/password.ts -- see docblock above. */
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 };

const nowIso = () => new Date().toISOString();

function log(line) {
  console.log(`[smoke] ${line}`);
}

// ---------------------------------------------------------------------------
// 1. Fixture database: fresh temp dir, migrated schema, one admin, one valid session.
// ---------------------------------------------------------------------------

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-smoke-'));
log(`fixture data dir: ${dataDir}`);

const dbPath = path.join(dataDir, 'budget.db');
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');
// Same window as src/db/client.ts openDatabase(): OFF for the migration transaction, ON right after.
sqlite.pragma('foreign_keys = OFF');
migrate(drizzle(sqlite), { migrationsFolder: path.join(ROOT, 'drizzle') });
sqlite.pragma('foreign_keys = ON');

const ADMIN_USERNAME = 'smoke-admin';
// Random, throwaway, never logged -- the fixture database is discarded at the end of this run.
const ADMIN_PASSWORD = randomBytes(16).toString('base64url');
const passwordHash = await argon2.hash(ADMIN_PASSWORD, ARGON2_OPTIONS);

const insertUser = sqlite.prepare(
  `insert into users
     (name, username, password_hash, role, totp_secret_encrypted, totp_enabled, is_active,
      created_at, must_change_password, totp_last_counter, visibility, can_sign_in, last_account_id)
   values (?, ?, ?, 'admin', null, 0, 1, ?, 0, null, 'household', 1, null)`,
);
const userId = Number(insertUser.run('Smoke Admin', ADMIN_USERNAME, passwordHash, nowIso()).lastInsertRowid);

// A handful of categories -- enough for pages that render a category picker or a spend-by-category
// chart to have a non-empty path, without reproducing src/db/seed.ts's full taxonomy.
const insertCategory = sqlite.prepare(
  `insert into categories (name, parent_id, icon, color, is_income, is_archived, sort_order, tax_relevant)
   values (?, ?, ?, ?, ?, 0, ?, 0)`,
);
const incomeId = Number(insertCategory.run('Income', null, '💵', '#16a34a', 1, 0).lastInsertRowid);
insertCategory.run('Salary', incomeId, '💵', '#16a34a', 1, 1);
const housingId = Number(insertCategory.run('Housing', null, '🏠', '#0ea5e9', 0, 100).lastInsertRowid);
insertCategory.run('Rent/Mortgage', housingId, '🏠', '#0ea5e9', 0, 101);

// A valid session, minted the same way src/lib/auth/session.ts's createSession() does
// (tokenHash = sha256(token) hex, 30-day expiry) -- see the docblock above for why this
// script mints the row directly instead of driving the real login form.
const validToken = randomBytes(32).toString('base64url');
const validTokenHash = createHash('sha256').update(validToken).digest('hex');
const sessionCreatedAt = nowIso();
const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
sqlite
  .prepare(
    `insert into sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
     values (?, ?, ?, ?, ?, null, null)`,
  )
  .run(validTokenHash, userId, sessionCreatedAt, sessionExpiresAt, sessionCreatedAt);

sqlite.close();
log(`seeded one admin (id ${userId}) and one valid session`);

// A cookie value that is well-formed but matches no session row -- the "third case" the review
// calls out: it passes src/proxy.ts (which only checks cookie *presence*) and must still be
// bounced by requireUser() in src/app/(app)/layout.tsx, which is the one thing only a real
// end-to-end request can prove.
const GARBAGE_TOKEN = 'not-a-real-session-token-00000000000000000000000';

// ---------------------------------------------------------------------------
// 2. Boot the standalone server built by `npm run build`.
// ---------------------------------------------------------------------------

const serverEntry = path.join(ROOT, '.next', 'standalone', 'server.js');
if (!fs.existsSync(serverEntry)) {
  console.error(`[smoke] ${serverEntry} does not exist -- run "npm run build" first.`);
  process.exit(1);
}

const secretKey = randomBytes(48).toString('base64');
let stderrBuf = '';
let stdoutBuf = '';

const server = spawn(
  process.execPath,
  [serverEntry],
  {
    // Deliberately NOT cwd: '.next/standalone' -- server.js is launched from the repo root so
    // that (a) Node's module resolution walks up from .next/standalone/ to the repo's own,
    // untraced node_modules for anything the standalone output's pruned copy is missing, and
    // (b) every process.cwd()-relative runtime read the app does (drizzle/ migrations,
    // vendor/ OCR assets, CHANGELOG.md) resolves against the real project tree, the same tree
    // this job already checked out and built -- exactly what the Dockerfile's explicit COPY
    // lines exist to reproduce inside a from-scratch image, which is not needed here.
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATA_DIR: dataDir,
      SECRET_KEY: secretKey,
      PORT: String(PORT),
      HOSTNAME: '127.0.0.1',
      TZ: 'America/Toronto',
      TRUST_PROXY: '0',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

server.stdout.on('data', (chunk) => {
  stdoutBuf += chunk;
  process.stdout.write(chunk);
});
server.stderr.on('data', (chunk) => {
  stderrBuf += chunk;
  process.stderr.write(chunk);
});

let serverExit = null;
server.once('exit', (code, signal) => {
  serverExit = { code, signal };
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (serverExit) {
      throw new Error(`server process exited early (code ${serverExit.code}, signal ${serverExit.signal})`);
    }
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`server did not report healthy within ${BOOT_TIMEOUT_MS}ms`);
}

// ---------------------------------------------------------------------------
// 3. Request battery.
// ---------------------------------------------------------------------------

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}

/** Route path plus status only -- never a cookie value (see docblock). */
async function request(pathname, { cookie } = {}) {
  const headers = {};
  if (cookie !== undefined) headers.cookie = `${SESSION_COOKIE_NAME}=${cookie}`;
  return fetch(`${BASE_URL}${pathname}`, { redirect: 'manual', headers });
}

async function expectStatus(label, pathname, opts, expected) {
  const wanted = Array.isArray(expected) ? expected : [expected];
  let res;
  try {
    res = await request(pathname, opts);
  } catch (error) {
    record(label, false, `request failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const ok = wanted.includes(res.status);
  record(label, ok, ok ? `${res.status}` : `expected ${wanted.join('|')}, got ${res.status}`);
  return res;
}

// 28 page routes (walked src/app/**/page.tsx). Default: 307 (-> /login) with no cookie, 200
// with a valid session. Listed exceptions were derived by reading each page's own redirect
// logic, not guessed -- see the smoke report for the source lines behind each one.
const DEFAULT_PAGES = [
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
const SPECIAL_PAGES = [
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

async function runPageChecks() {
  for (const pathname of DEFAULT_PAGES) {
    await expectStatus(`page anon   ${pathname}`, pathname, {}, [307]);
    await expectStatus(`page auth   ${pathname}`, pathname, { cookie: validToken }, [200]);
  }
  for (const [pathname, anon, auth] of SPECIAL_PAGES) {
    await expectStatus(`page anon   ${pathname}`, pathname, {}, anon);
    await expectStatus(`page auth   ${pathname}`, pathname, { cookie: validToken }, auth);
  }
  // The one case only an end-to-end request can check (review O-01 / "Proposed smoke test"):
  // a garbage-but-present cookie passes src/proxy.ts (presence-only check) and must still be
  // redirected by requireUser() in src/app/(app)/layout.tsx.
  await expectStatus('page garbage-cookie /dashboard', '/dashboard', { cookie: GARBAGE_TOKEN }, [307]);
}

// 8 safe API GETs (spec's "Proposed smoke test" route list). [path, anonExpected, authExpected]
const API_GETS = [
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
const POST_ONLY_ROUTES = [
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

async function runApiChecks() {
  await expectStatus('api unauth  /api/health', '/api/health', {}, [200]);
  for (const [pathname, anon, auth] of API_GETS) {
    await expectStatus(`api anon    ${pathname}`, pathname, {}, anon);
    await expectStatus(`api auth    ${pathname}`, pathname, { cookie: validToken }, auth);
  }
  for (const pathname of POST_ONLY_ROUTES) {
    await expectStatus(`api 405     ${pathname}`, pathname, { cookie: validToken }, [405]);
  }
}

async function checkCspNonce() {
  const res = await request('/dashboard', { cookie: validToken });
  const csp = res.headers.get('content-security-policy') ?? '';
  const ok = res.status === 200 && /nonce-[A-Za-z0-9+/=]+/.test(csp);
  record('csp nonce on a real response', ok, ok ? undefined : `content-security-policy: ${csp || '(missing)'}`);
}

// ---------------------------------------------------------------------------
// 4. Run everything, then verify the shutdown path.
// ---------------------------------------------------------------------------

async function shutdownAndVerify() {
  server.kill('SIGTERM');
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (!serverExit && Date.now() < deadline) {
    await sleep(200);
  }
  if (!serverExit) {
    record('graceful shutdown', false, `did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of SIGTERM`);
    server.kill('SIGKILL');
    return;
  }
  const exitOk = serverExit.code === 0;
  record('graceful shutdown exit code', exitOk, `code ${serverExit.code}, signal ${serverExit.signal}`);
  const loggedShutdown = stdoutBuf.includes('[shutdown] received SIGTERM, database closed, exiting');
  record('graceful shutdown log line', loggedShutdown);
}

function checkNoServerErrors() {
  // console.error always writes to stderr; a clean boot-and-serve run should produce none.
  // Checked here (after the request battery, before shutdown) so a route that renders its own
  // error boundary and still returns 200 -- exactly the gap a status-code-only check would
  // miss -- fails this run too.
  const ok = stderrBuf.trim().length === 0;
  record('no console.error / stderr output from the server', ok, ok ? undefined : `${stderrBuf.split('\n').length} line(s) captured, see log above`);
}

let exitCode = 0;
try {
  await waitForHealth();
  log('server is healthy');
  await runPageChecks();
  await runApiChecks();
  await checkCspNonce();
  checkNoServerErrors();
  await shutdownAndVerify();
} catch (error) {
  console.error(`[smoke] fatal: ${error instanceof Error ? error.stack : String(error)}`);
  exitCode = 1;
} finally {
  if (!serverExit) {
    server.kill('SIGKILL');
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log('');
console.log(`[smoke] ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(`[smoke] FAILED: ${failed.map((r) => r.name).join(', ')}`);
  exitCode = 1;
}
process.exit(exitCode);
