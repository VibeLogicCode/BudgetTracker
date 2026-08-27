import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readEnv } from '@/lib/env';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbInstance {
  db: Db;
  sqlite: BetterSqlite3.Database;
}

let instance: DbInstance | null = null;

// BUDGET_DB_PATH / BUDGET_MIGRATIONS_DIR are dev/test-only overrides (not documented in
// README/.env.example, not set by docker-compose.yml): the container path always resolves
// through DATA_DIR and process.cwd()/drizzle below.
export function databasePath(): string {
  const override = process.env.BUDGET_DB_PATH;
  if (override && override.length > 0) return override;
  return path.join(readEnv().dataDir, 'budget.db');
}

export function migrationsFolder(): string {
  return process.env.BUDGET_MIGRATIONS_DIR ?? path.join(process.cwd(), 'drizzle');
}

/**
 * The ONLY place a better-sqlite3 Database is constructed.
 * Every connection gets journal_mode=WAL, busy_timeout=5000 and foreign_keys=ON,
 * with Drizzle migrations applied (idempotent) in between.
 *
 * v1.12.0: foreign keys are OFF for the migration pass and back ON immediately after. This is
 * required, not defensive. Drizzle's SQLite dialect runs every pending migration inside one
 * explicit BEGIN ... COMMIT, and SQLite documents `PRAGMA foreign_keys` as a NO-OP inside a
 * transaction -- so the pragma cannot be set from inside a .sql file at all, and a table rebuild
 * is impossible unless it is set here. drizzle/0011_bill_installments.sql is the first migration
 * that needs one: SQLite cannot ALTER a CHECK, and warranty_item_types has a child table.
 *
 * A pragma-driven orphan sweep runs immediately afterwards and refuses to start on any orphan.
 * Turning enforcement off for a window means a bad migration could leave one behind silently;
 * this makes that loud on the very next boot rather than at some unrelated read months later.
 *
 * If migrate() itself throws -- a broken .sql file, a partial upgrade -- the pragma still has to
 * come back ON (a stray disabled connection is its own hazard) and the handle must not be handed
 * back to the caller half-migrated with enforcement off, so it is closed here and the error
 * rethrown instead.
 */
export function openDatabase(filePath: string): DbInstance {
  const sqlite = new BetterSqlite3(filePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = OFF');
  const db = drizzle(sqlite, { schema });
  let migrationError: unknown;
  try {
    migrate(db, { migrationsFolder: migrationsFolder() });
  } catch (err) {
    migrationError = err;
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }
  if (migrationError) {
    sqlite.close();
    throw migrationError;
  }
  const orphans = sqlite.pragma('foreign_key_check') as unknown[];
  if (orphans.length > 0) {
    sqlite.close();
    throw new Error(`Database has ${orphans.length} orphaned row(s) after migration; refusing to start.`);
  }
  return { db, sqlite };
}

function ensureInstance(): DbInstance {
  if (!instance) {
    instance = openDatabase(databasePath());
  }
  return instance;
}

export function getDb(): Db {
  return ensureInstance().db;
}

export function getSqlite(): BetterSqlite3.Database {
  return ensureInstance().sqlite;
}

/** Test seam: point the module-level singleton at a temp database. */
export function setDbForTests(next: DbInstance | null): void {
  instance = next;
}

export function closeDb(): void {
  instance?.sqlite.close();
  instance = null;
}
