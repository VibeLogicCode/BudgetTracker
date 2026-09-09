/**
 * The request battery itself: given a base URL and a valid session token, hits every route in
 * scripts/smoke-routes.mjs and records a pass/fail/skip per check. Shared by scripts/smoke-test.mjs
 * (against the standalone server on the host) and scripts/smoke-test-image.mjs (against the
 * shipped container) -- neither script defines its own copy of "what a route must return," only
 * how to get a server running and a valid cookie minted. See scripts/smoke-routes.mjs's own
 * docblock for why sharing this is the point of the whole exercise.
 */

import {
  SESSION_COOKIE_NAME,
  GARBAGE_TOKEN,
  DEFAULT_PAGES,
  SPECIAL_PAGES,
  API_GETS,
  POST_ONLY_ROUTES,
} from './smoke-routes.mjs';

/**
 * Records a check as SKIPPED rather than passed or failed (review M-6). Skipped checks are
 * excluded from both the numerator and the denominator of the final "N/M checks passed" line, so
 * a platform-limited run reads as "M/M passed, K skipped" instead of quietly reporting the same
 * total M as a full run would -- the failure mode this exists to avoid is a developer misreading
 * a shorter denominator as a regression, or a passing count as having actually exercised the
 * check.
 */
export function createRunner(prefix = '[smoke]') {
  const results = [];
  function record(name, pass, detail) {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  }
  function skip(name, reason) {
    results.push({ name, pass: null, skipped: true });
    console.log(`SKIP  ${name}  (${reason})`);
  }
  return { prefix, results, record, skip };
}

/** Route path plus status only -- never a cookie value (this project never logs a session token). */
export async function request(baseUrl, pathname, { cookie } = {}) {
  const headers = {};
  if (cookie !== undefined) headers.cookie = `${SESSION_COOKIE_NAME}=${cookie}`;
  return fetch(`${baseUrl}${pathname}`, { redirect: 'manual', headers });
}

export async function expectStatus(runner, baseUrl, label, pathname, opts, expected) {
  const wanted = Array.isArray(expected) ? expected : [expected];
  let res;
  try {
    res = await request(baseUrl, pathname, opts);
  } catch (error) {
    runner.record(label, false, `request failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const ok = wanted.includes(res.status);
  runner.record(label, ok, ok ? `${res.status}` : `expected ${wanted.join('|')}, got ${res.status}`);
  return res;
}

export async function runPageChecks(runner, baseUrl, validToken) {
  for (const pathname of DEFAULT_PAGES) {
    await expectStatus(runner, baseUrl, `page anon   ${pathname}`, pathname, {}, [307]);
    await expectStatus(runner, baseUrl, `page auth   ${pathname}`, pathname, { cookie: validToken }, [200]);
  }
  for (const [pathname, anon, auth] of SPECIAL_PAGES) {
    await expectStatus(runner, baseUrl, `page anon   ${pathname}`, pathname, {}, anon);
    await expectStatus(runner, baseUrl, `page auth   ${pathname}`, pathname, { cookie: validToken }, auth);
  }
  // The one case only an end-to-end request can check (review O-01 / "Proposed smoke test"):
  // a garbage-but-present cookie passes src/proxy.ts (presence-only check) and must still be
  // redirected by requireUser() in src/app/(app)/layout.tsx.
  await expectStatus(runner, baseUrl, 'page garbage-cookie /dashboard', '/dashboard', { cookie: GARBAGE_TOKEN }, [307]);
}

export async function runApiChecks(runner, baseUrl, validToken) {
  await expectStatus(runner, baseUrl, 'api unauth  /api/health', '/api/health', {}, [200]);
  for (const [pathname, anon, auth] of API_GETS) {
    await expectStatus(runner, baseUrl, `api anon    ${pathname}`, pathname, {}, anon);
    await expectStatus(runner, baseUrl, `api auth    ${pathname}`, pathname, { cookie: validToken }, auth);
  }
  for (const pathname of POST_ONLY_ROUTES) {
    await expectStatus(runner, baseUrl, `api 405     ${pathname}`, pathname, { cookie: validToken }, [405]);
  }
}

export async function checkCspNonce(runner, baseUrl, validToken) {
  const res = await request(baseUrl, '/dashboard', { cookie: validToken });
  const csp = res.headers.get('content-security-policy') ?? '';
  const ok = res.status === 200 && /nonce-[A-Za-z0-9+/=]+/.test(csp);
  runner.record('csp nonce on a real response', ok, ok ? undefined : `content-security-policy: ${csp || '(missing)'}`);
}

/**
 * console.error always writes to stderr; a clean boot-and-serve run should produce none. The
 * caller collects stderrBuf its own way (the standalone script from the spawned server's own
 * pipe, the image script from `docker logs`'s stderr stream) -- collection differs by transport,
 * but "empty stderr is the only passing shape" is the same claim either way, so it lives here once.
 */
export function checkNoServerErrors(runner, stderrBuf) {
  const ok = stderrBuf.trim().length === 0;
  runner.record(
    'no console.error / stderr output from the server',
    ok,
    ok ? undefined : `${stderrBuf.split('\n').length} line(s) captured, see log above`,
  );
}

/** Prints and scores the final tally; returns the process exit code the caller should use. */
export function printSummary(runner) {
  const { prefix, results } = runner;
  const skipped = results.filter((r) => r.skipped);
  const scored = results.filter((r) => !r.skipped);
  const failed = scored.filter((r) => !r.pass);
  console.log('');
  console.log(
    `${prefix} ${scored.length - failed.length}/${scored.length} checks passed` +
      (skipped.length > 0 ? `, ${skipped.length} skipped` : ''),
  );
  if (skipped.length > 0) {
    console.log(`${prefix} SKIPPED (not scored -- see reason above): ${skipped.map((r) => r.name).join(', ')}`);
  }
  if (failed.length > 0) {
    console.log(`${prefix} FAILED: ${failed.map((r) => r.name).join(', ')}`);
    return 1;
  }
  return 0;
}
