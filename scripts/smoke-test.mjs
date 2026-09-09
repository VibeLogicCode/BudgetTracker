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
 * database, using the same tokenHash = sha256(token) scheme src/lib/auth/session.ts uses. This
 * row-shape (and the ARGON2_OPTIONS it depends on) lives in scripts/smoke-fixtures.mjs, shared
 * with scripts/smoke-test-image.mjs (v1.32.0, lane L5) -- see that file's docblock.
 *
 * WHY plain `better-sqlite3` + `drizzle-orm` here instead of importing `@/db/client` and
 * `@/db/seed`: this script runs with Node's native TypeScript stripping, which has no notion of
 * the `@/*` -> `src/*` path alias Next's bundler and vitest's config resolve -- there is no
 * bundler in front of it. Rather than add a bespoke path-alias loader (a new, untested failure
 * mode for a CI job that must stay simple to debug when it goes red), this mirrors the existing
 * convention in scripts/reset-admin-password.ts: talk to better-sqlite3 and argon2 directly.
 *
 * WHY the route list and the request battery live in scripts/smoke-routes.mjs and
 * scripts/smoke-checks.mjs instead of here: this project's most-repeated defect shape is one idea
 * implemented in more than one place with nothing tying the copies together. scripts/smoke-test-
 * image.mjs (v1.32.0) needs the exact same routes and the exact same expectations against a
 * running container instead of a spawned host process -- sharing one definition means a changed
 * expectation changes both runs at once, instead of two lists quietly disagreeing later.
 *
 * NEVER touches .tmp-data/ -- the fixture lives under a fresh os.tmpdir() directory, created
 * here and removed at the end of this script, regardless of pass or fail.
 *
 * NEVER logs a session token or a cookie value -- only route paths and status codes.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { randomBytes } from 'node:crypto';
import { seedFixtureDb } from './smoke-fixtures.mjs';
import { createRunner, runPageChecks, runApiChecks, checkCspNonce, checkNoServerErrors, printSummary } from './smoke-checks.mjs';

const ROOT = process.cwd();
const PORT = Number(process.env.SMOKE_PORT ?? 3411);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;

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

const { userId, validToken } = await seedFixtureDb(sqlite);
sqlite.close();
log(`seeded one admin (id ${userId}) and one valid session`);

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
// 3. Request battery (scripts/smoke-checks.mjs, routes from scripts/smoke-routes.mjs).
// ---------------------------------------------------------------------------

const runner = createRunner('[smoke]');

// ---------------------------------------------------------------------------
// 4. Run everything, then verify the shutdown path.
// ---------------------------------------------------------------------------

async function shutdownAndVerify() {
  server.kill('SIGTERM');
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (!serverExit && Date.now() < deadline) {
    await sleep(200);
  }
  if (process.platform === 'win32') {
    // Node maps SIGTERM to TerminateProcess on Windows (documented Node.js behaviour), which
    // kills the process immediately and never runs its 'SIGTERM' handler -- so the app's own
    // graceful-shutdown code (the exit-0 path and the '[shutdown] ...' log line) genuinely
    // cannot run here, on any build, regardless of the tree. This is not flaky; it is
    // unreachable on this platform. CI runs this script on ubuntu-latest, where SIGTERM does
    // reach the handler and both checks below are scored for real (review M-6). Skipping them
    // here -- rather than either faking a pass or letting them fail as noise -- is what keeps a
    // developer running the strongest gate locally on Windows from mistaking a shorter total for
    // a regression.
    //
    // scripts/smoke-test-image.mjs does NOT need this skip: a container's PID 1 is always a
    // Linux process (Docker Desktop on Windows runs containers inside a Linux VM), so `docker
    // stop`'s SIGTERM reaches the app's real handler even when this script is run on Windows.
    runner.skip('graceful shutdown exit code', "SIGTERM maps to TerminateProcess on win32; the app's shutdown handler cannot run -- see ubuntu-latest CI for this check");
    runner.skip('graceful shutdown log line', "SIGTERM maps to TerminateProcess on win32; the app's shutdown handler cannot run -- see ubuntu-latest CI for this check");
    if (!serverExit) server.kill('SIGKILL');
    return;
  }
  if (!serverExit) {
    runner.record('graceful shutdown', false, `did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of SIGTERM`);
    server.kill('SIGKILL');
    return;
  }
  const exitOk = serverExit.code === 0;
  runner.record('graceful shutdown exit code', exitOk, `code ${serverExit.code}, signal ${serverExit.signal}`);
  const loggedShutdown = stdoutBuf.includes('[shutdown] received SIGTERM, database closed, exiting');
  runner.record('graceful shutdown log line', loggedShutdown);
}

let exitCode = 0;
try {
  await waitForHealth();
  log('server is healthy');
  await runPageChecks(runner, BASE_URL, validToken);
  await runApiChecks(runner, BASE_URL, validToken);
  await checkCspNonce(runner, BASE_URL, validToken);
  checkNoServerErrors(runner, stderrBuf);
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

const summaryExitCode = printSummary(runner);
process.exit(exitCode || summaryExitCode);
