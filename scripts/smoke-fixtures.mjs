/**
 * Seeds one admin user, a handful of categories, and one valid session into an already-open,
 * already-migrated better-sqlite3 handle. This is the one definition of "what a smoke fixture
 * looks like," shared by two very differently-shaped callers:
 *
 *   - scripts/smoke-test.mjs runs on the host: it creates a throwaway database file itself and
 *     runs drizzle's migrate() before calling this.
 *   - scripts/smoke-seed.mjs runs INSIDE the shipped container (via `docker exec`, from
 *     scripts/smoke-test-image.mjs): by the time it runs, the app's own boot has already created
 *     and migrated /data/budget.db through the real production code path
 *     (src/db/client.ts openDatabase()), so it only opens a second handle on that same file and
 *     calls this function -- no migrate() call of its own.
 *
 * Keeping the row shapes in one place means the image smoke test exercises the exact same
 * fixture state the standalone smoke test does, so a status-code difference between the two runs
 * means the image genuinely behaves differently, never that the two fixtures quietly drifted
 * apart.
 *
 * WHY the session is minted directly instead of driving the real POST /login form: see
 * scripts/smoke-test.mjs's top-of-file docblock -- the login page submits through a React Server
 * Action, not a plain HTML form POST, and reproducing that wire protocol by hand would be fragile
 * scaffolding that only re-tests loginAction(), which already has full coverage elsewhere.
 *
 * NEVER logs a session token or a cookie value -- callers must not either; only route paths and
 * status codes ever reach a log line for these checks.
 */

import { randomBytes, createHash } from 'node:crypto';
import argon2 from 'argon2';

/** Must stay identical to ARGON2_OPTIONS in src/lib/auth/password.ts. */
export const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 };

const nowIso = () => new Date().toISOString();

/**
 * @param {import('better-sqlite3').Database} sqlite an open handle on an already-migrated database
 * @returns {Promise<{ userId: number, validToken: string }>}
 */
export async function seedFixtureDb(sqlite) {
  const ADMIN_USERNAME = 'smoke-admin';
  // Random, throwaway, never logged -- the fixture database is discarded at the end of the run.
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
  // (tokenHash = sha256(token) hex, 30-day expiry).
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

  return { userId, validToken };
}
