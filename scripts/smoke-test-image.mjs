#!/usr/bin/env node
/**
 * Boot-and-request smoke test for the SHIPPED IMAGE (v1.32.0, lane L5 -- the gap left by
 * scripts/smoke-test.mjs, added in v1.31.0).
 *
 * WHY this exists: scripts/smoke-test.mjs boots `.next/standalone/server.js` directly on the
 * host, launched from the real project tree (see that file's own docblock on why `cwd: ROOT`).
 * That proves every route renders without throwing, but it can never catch:
 *   - a missing `COPY` line in the Dockerfile (a file the image forgot -- drizzle/, CHANGELOG.md,
 *     a native addon),
 *   - a read-only-rootfs violation (the host process never runs with one),
 *   - anything that only appears once the app is running as the image's own non-root user, in the
 *     image's own filesystem, with only the files the Dockerfile actually copied.
 * This is the mirror-image gap of the one Next 16's standalone tracing opened from the other
 * side: tracing copies too MUCH (the project tree, including gitignored internal notes -- see
 * .dockerignore's own docblock and tests/ops/docker.test.ts), while a missing COPY line copies
 * too LITTLE. Both are invisible to `next build` and to a smoke test that never runs the image.
 *
 * WHY the route list and the request battery are imported, not redefined: see
 * scripts/smoke-routes.mjs's docblock. This script and scripts/smoke-test.mjs hit the same 28
 * pages x 2 auth states, the same 8 API GETs, the same 11 POST-only 405 checks, the same garbage-
 * cookie case and the same CSP-nonce check -- one definition, two runners.
 *
 * WHY the fixture is seeded via `docker exec` instead of a pre-seeded database mounted in:
 * /data must be a tmpfs here, never a bind mount of any host directory -- this script must never
 * mount, read, copy or reference a host path that could hold the household's own real data. A
 * tmpfs starts empty, and the app itself creates and migrates /data/budget.db on first use (the
 * same boot path production uses, triggered here by the container's own HEALTHCHECK hitting GET
 * /api/health). Only once that has happened does scripts/smoke-seed.mjs -- which the image
 * already ships, see its own docblock -- have a database to seed a session into.
 *
 * WHY plain `docker run` instead of `docker compose up -f docker-compose.yml`: that file bind-
 * mounts `./data:/data` (a real, persistent host path) and hardcodes the image tag
 * `budget-tracker:latest`. Neither fits here -- this script must accept either a tag CI already
 * built or build its own, and must never touch a host path for /data. The container flags below
 * (`--read-only`, the two `--tmpfs` mounts, `--cap-drop ALL`, `--security-opt no-new-
 * privileges:true`) reproduce docker-compose.yml's hardening directly instead.
 *
 * Supports both a locally-built image and a CI-supplied one (SMOKE_IMAGE_TAG): CI already builds
 * an amd64-loadable image before pushing (release-image.yml's `build` job) and hands its tag to
 * this script; a developer running `npm run smoke:image` with no image built yet gets one built
 * here from the repo's own Dockerfile.
 *
 * Degrades honestly with no Docker: prints a SKIP (never a silent no-op, never a false PASS) and
 * exits 0. See checkDockerAvailable() below.
 *
 * Tears the container down on every exit path -- normal completion, a thrown error, or this
 * script itself being interrupted -- via a single `process.on('exit', ...)` cleanup, the only
 * place in Node guaranteed to run regardless of how the process is ending (see cleanup() below).
 *
 * NEVER mounts, reads, copies or references any host directory -- /data is always a tmpfs, ready
 * for a fresh container and gone when it stops. NEVER logs a session token, a cookie value, or
 * the container's SECRET_KEY.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createRunner,
  runPageChecks,
  runApiChecks,
  checkCspNonce,
  checkNoServerErrors,
  printSummary,
} from './smoke-checks.mjs';

const ROOT = process.cwd();
const PORT = Number(process.env.SMOKE_IMAGE_PORT ?? 3412);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DEFAULT_LOCAL_TAG = 'budget-tracker:image-smoke-local';
// Docker's own HEALTHCHECK (Dockerfile) uses --start-period=20s --interval=30s --retries=3; a
// container that is genuinely healthy usually reports so well inside that, but this budget is
// generous on purpose -- a slow CI runner or a cold layer cache should not turn into a flake.
const BOOT_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_S = 15;
const CONTAINER_NAME = `budget-tracker-image-smoke-${process.pid}`;

function log(line) {
  console.log(`[smoke:image] ${line}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 0. Degrade honestly if Docker is not available on this machine.
// ---------------------------------------------------------------------------

function checkDockerAvailable() {
  const res = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    const reason = res.error ? res.error.message : (res.stderr || 'docker daemon did not respond').trim();
    return { ok: false, reason };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 1. Build the image, or accept one CI already built.
// ---------------------------------------------------------------------------

function buildImage() {
  log(`no SMOKE_IMAGE_TAG given -- building ${DEFAULT_LOCAL_TAG} from ./Dockerfile (this can take a few minutes)`);
  const res = spawnSync('docker', ['build', '-t', DEFAULT_LOCAL_TAG, '.'], { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`docker build exited with code ${res.status}`);
  }
  return DEFAULT_LOCAL_TAG;
}

// ---------------------------------------------------------------------------
// 2. Run the container: tmpfs /data (never a host path), read-only rootfs, no capabilities --
//    the same hardening docker-compose.yml documents, reproduced with plain `docker run` flags
//    because docker-compose.yml itself bind-mounts a host path and hardcodes its own tag.
// ---------------------------------------------------------------------------

function runContainer(tag) {
  const secretKey = randomBytes(48).toString('base64');
  const args = [
    'run',
    '--detach',
    '--name', CONTAINER_NAME,
    '--publish', `127.0.0.1:${PORT}:3000`,
    '--read-only',
    // mode=1777 (world read/write/execute, sticky bit -- the same convention /tmp uses) is
    // required, not cosmetic: Dockerfile already `mkdir -p /data && chown -R node:node /data` so
    // the image has something to mount over, and a tmpfs mounted on top of a path that already
    // exists in the image inherits THAT path's permission bits (0755) with its owner reset to
    // root -- not the tmpfs filesystem's own bare default of 1777 you get mounting onto a path
    // that does not yet exist. Verified empirically while building this script: the exact same
    // `--tmpfs /data:rw,size=...` on a path pre-baked into an image came back `0755 root:root`
    // and refused a write from the non-root `node` user (SQLITE_CANTOPEN, "unable to open
    // database file") -- the very defect class this smoke test exists to catch, caught by
    // writing it. Explicit mode= here sidesteps the inheritance instead of relying on it.
    '--tmpfs', '/data:rw,mode=1777,size=128m',
    '--tmpfs', '/tmp:rw,noexec,nosuid,mode=1777,size=64m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--env', `SECRET_KEY=${secretKey}`,
    '--env', 'TRUST_PROXY=0',
    '--env', 'TZ=America/Toronto',
    '--env', 'NEXT_TELEMETRY_DISABLED=1',
    tag,
  ];
  const res = spawnSync('docker', args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`docker run failed (exit ${res.status}): ${(res.stderr || '').trim()}`);
  }
  return res.stdout.trim();
}

// ---------------------------------------------------------------------------
// 3. Wait on the container's own HEALTHCHECK -- never a fixed sleep.
// ---------------------------------------------------------------------------

function containerLogs(containerId) {
  const res = spawnSync('docker', ['logs', containerId], { encoding: 'utf8' });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

async function waitForHealthy(containerId) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = spawnSync('docker', ['inspect', '--format', '{{.State.Status}}|{{.State.Health.Status}}', containerId], {
      encoding: 'utf8',
    });
    if (state.status === 0) {
      const [containerStatus, healthStatus] = state.stdout.trim().split('|');
      if (healthStatus === 'healthy') return;
      if (containerStatus === 'exited' || healthStatus === 'unhealthy') {
        const logs = containerLogs(containerId);
        throw new Error(
          `container ${containerStatus === 'exited' ? 'exited' : 'reported unhealthy'} before passing its healthcheck` +
            `\n--- container stdout ---\n${logs.stdout}\n--- container stderr ---\n${logs.stderr}`,
        );
      }
    }
    await sleep(1000);
  }
  const logs = containerLogs(containerId);
  throw new Error(
    `container did not report healthy within ${BOOT_TIMEOUT_MS}ms` +
      `\n--- container stdout ---\n${logs.stdout}\n--- container stderr ---\n${logs.stderr}`,
  );
}

// ---------------------------------------------------------------------------
// 4. Seed the fixture inside the container (scripts/smoke-seed.mjs already shipped in the image
//    via Dockerfile's `COPY .../scripts ./scripts` -- see that file's docblock for why no new
//    COPY line or `docker cp` was needed).
// ---------------------------------------------------------------------------

function seedFixture(containerId) {
  const res = spawnSync('docker', ['exec', containerId, 'node', '/app/scripts/smoke-seed.mjs'], { encoding: 'utf8' });
  if (res.status !== 0) {
    // res.stderr is safe to surface: scripts/smoke-seed.mjs never writes the token there, only
    // to stdout, which this branch deliberately does NOT include.
    throw new Error(`docker exec smoke-seed.mjs failed (exit ${res.status}): ${(res.stderr || '').trim()}`);
  }
  const lastLine = res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  if (!lastLine) {
    throw new Error('smoke-seed.mjs produced no output');
  }
  const parsed = JSON.parse(lastLine);
  if (!parsed.validToken) {
    throw new Error('smoke-seed.mjs output did not include validToken');
  }
  return parsed.validToken;
}

// ---------------------------------------------------------------------------
// 5. Stop the container and verify the shutdown path -- a container's PID 1 is always a Linux
//    process (Docker Desktop on Windows runs containers inside a Linux VM), so unlike
//    scripts/smoke-test.mjs's spawned host process, `docker stop`'s SIGTERM reaches the app's
//    real shutdown handler on every platform, including a Windows dev machine.
// ---------------------------------------------------------------------------

function shutdownAndVerify(runner, containerId) {
  spawnSync('docker', ['stop', '--time', String(SHUTDOWN_TIMEOUT_S), containerId]);
  const inspect = spawnSync('docker', ['inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}', containerId], {
    encoding: 'utf8',
  });
  const [status, exitCodeStr] = (inspect.stdout || '').trim().split('|');
  const exitOk = status === 'exited' && exitCodeStr === '0';
  runner.record('graceful shutdown exit code', exitOk, `status ${status}, exit code ${exitCodeStr}`);
  const logs = containerLogs(containerId);
  const loggedShutdown = logs.stdout.includes('[shutdown] received SIGTERM, database closed, exiting');
  runner.record('graceful shutdown log line', loggedShutdown);
  return logs;
}

// ---------------------------------------------------------------------------
// 6. Teardown that cannot leak a running container. `process.on('exit', ...)` is the only place
//    in Node guaranteed to run on every exit path -- normal completion, a thrown-and-caught
//    error, or this script being killed by SIGINT/SIGTERM -- and it only permits synchronous
//    work, which `spawnSync('docker', ['rm', '-f', ...])` is. Unconditional and keyed by the
//    fixed --name (not a captured container id) on purpose: even a `docker run` that fails after
//    creating the container but before this script captures its id must not leak it, and removing
//    a name that was never created is a harmless no-op. A smoke test that leaks a running
//    container on failure will be disabled by the first person it annoys.
// ---------------------------------------------------------------------------

let containerId = null;

function cleanup() {
  spawnSync('docker', ['rm', '--force', CONTAINER_NAME]);
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const docker = checkDockerAvailable();
if (!docker.ok) {
  log(`SKIP: Docker is not available on this machine (${docker.reason}).`);
  log('0/0 checks run -- this is a SKIP, not a PASS. Install/start Docker to exercise this guard.');
  process.exitCode = 0;
} else {
  let exitCode = 0;
  const runner = createRunner('[smoke:image]');
  try {
    const tag = process.env.SMOKE_IMAGE_TAG || buildImage();
    log(`using image ${tag}`);

    containerId = runContainer(tag);
    log(`container ${containerId.slice(0, 12)} started, waiting for healthcheck`);

    await waitForHealthy(containerId);
    log('container is healthy');

    const validToken = await seedFixture(containerId);
    log('seeded one admin and one valid session inside the container');

    await runPageChecks(runner, BASE_URL, validToken);
    await runApiChecks(runner, BASE_URL, validToken);
    await checkCspNonce(runner, BASE_URL, validToken);

    const preStopLogs = containerLogs(containerId);
    checkNoServerErrors(runner, preStopLogs.stderr);

    shutdownAndVerify(runner, containerId);
  } catch (error) {
    console.error(`[smoke:image] fatal: ${error instanceof Error ? error.stack : String(error)}`);
    exitCode = 1;
  }

  const summaryExitCode = printSummary(runner);
  process.exitCode = exitCode || summaryExitCode;
}
