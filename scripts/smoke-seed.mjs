#!/usr/bin/env node
/**
 * Seeds the image-level smoke fixture. Runs INSIDE the shipped container via `docker exec`
 * (scripts/smoke-test-image.mjs, v1.32.0, lane L5) -- never on the host, and never as part of the
 * container's own normal boot.
 *
 * WHY this file needs no new Dockerfile COPY line: Dockerfile already does
 * `COPY --from=builder --chown=node:node /app/scripts ./scripts` for the rescue tooling
 * documented in INSTALL.md (scripts/reset-admin-password.ts). That line copies the whole
 * directory, so this file -- and scripts/smoke-fixtures.mjs, which it imports -- ship inside the
 * image automatically. `docker cp`-ing a file into a running container was considered and
 * rejected: the shipped container runs with a read-only root filesystem (docker-compose.yml,
 * tests/ops/docker.test.ts), so writing a new file into it after start would fail exactly the
 * way a real deployment does.
 *
 * WHY no drizzle migrate() call here, unlike scripts/smoke-test.mjs: by the time
 * scripts/smoke-test-image.mjs runs this (after the container reports healthy), the app's own
 * boot has already created and migrated /data/budget.db through the real production code path
 * (src/db/client.ts openDatabase(), triggered by the HEALTHCHECK's own GET /api/health). Running
 * migrate() a second time here would be redundant at best and would be exercising a code path
 * (this script's own copy of migrationsFolder() resolution) that adds nothing to what the
 * container already proved on boot.
 *
 * Prints exactly one line of JSON to stdout -- {"userId":N,"validToken":"..."} -- and nothing
 * else. scripts/smoke-test-image.mjs captures this process's stdout into a buffer it parses and
 * then discards; it is never written to the smoke test's own console output, for the same reason
 * scripts/smoke-test.mjs never logs a cookie value.
 */

import path from 'node:path';
import Database from 'better-sqlite3';
import { seedFixtureDb } from './smoke-fixtures.mjs';

const dataDir = process.env.DATA_DIR && process.env.DATA_DIR.length > 0 ? process.env.DATA_DIR : '/data';
const dbPath = path.join(dataDir, 'budget.db');

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');

try {
  const { userId, validToken } = await seedFixtureDb(sqlite);
  process.stdout.write(`${JSON.stringify({ userId, validToken })}\n`);
} finally {
  sqlite.close();
}
