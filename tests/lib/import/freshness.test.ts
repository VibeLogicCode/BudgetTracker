import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { setAccountActive } from '@/lib/accounts';
import { HOUSEHOLD_VIEWER, type Viewer } from '@/lib/auth/viewer';
import { latestImportIso } from '@/lib/import/freshness';

let t: TestDb;
let userId = 0;
afterEach(() => t.cleanup());

function setup(): void {
  t = createSeededTestDb();
  userId = insertTestUser(t.db, { username: 'importer' });
}

function importAt(accountId: number, createdAt: string): void {
  t.db.run(
    sql`insert into imports (account_id, profile_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
        values (${accountId}, null, ${'export.csv'}, ${userId}, 0, 0, 0, ${createdAt})`,
  );
}

/**
 * Spec 2026-09-28 §2.1. The one fact the digest line states: when was anything last imported, among
 * accounts this viewer may see. Same ownership rule listAccounts applies (ruling R2).
 */
describe('latestImportIso', () => {
  it('is null when nothing has ever been imported', () => {
    setup();
    insertTestAccount(t.db);
    expect(latestImportIso(HOUSEHOLD_VIEWER)).toBeNull();
  });

  it('is the newest import across every active account, as a date', () => {
    setup();
    const a = insertTestAccount(t.db, { name: 'Chequing' });
    const b = insertTestAccount(t.db, { name: 'Amex', type: 'credit' });
    importAt(a, '2026-08-10T12:00:00.000Z');
    importAt(b, '2026-08-16T23:59:00.000Z');
    expect(latestImportIso(HOUSEHOLD_VIEWER)).toBe('2026-08-16');
  });

  it('ignores a deactivated account', () => {
    setup();
    const a = insertTestAccount(t.db, { name: 'Chequing' });
    const closed = insertTestAccount(t.db, { name: 'Old Card', type: 'credit' });
    importAt(a, '2026-08-10T12:00:00.000Z');
    importAt(closed, '2026-08-16T12:00:00.000Z');
    setAccountActive(closed, false);
    expect(latestImportIso(HOUSEHOLD_VIEWER)).toBe('2026-08-10');
  });

  /** Review focus 2. A joint account (owner NULL) is not theirs -- listAccounts' own rule. */
  it('a self-scoped viewer sees only their own accounts, never the joint one', () => {
    setup();
    const bob = insertTestUser(t.db, { username: 'bob', role: 'member' });
    const joint = insertTestAccount(t.db, { name: 'Joint Chequing' });
    const bobs = insertTestAccount(t.db, { name: 'Bob Visa', type: 'credit', ownerUserId: bob });
    importAt(joint, '2026-08-16T12:00:00.000Z');
    importAt(bobs, '2026-08-10T12:00:00.000Z');
    const self: Viewer = { id: bob, role: 'member', visibility: 'self' };
    expect(latestImportIso(self)).toBe('2026-08-10');
    expect(latestImportIso(HOUSEHOLD_VIEWER)).toBe('2026-08-16');
  });

  it('is null for a self-scoped viewer whose own accounts have no imports, even when the household has some', () => {
    setup();
    const bob = insertTestUser(t.db, { username: 'bob', role: 'member' });
    const joint = insertTestAccount(t.db, { name: 'Joint Chequing' });
    insertTestAccount(t.db, { name: 'Bob Visa', type: 'credit', ownerUserId: bob });
    importAt(joint, '2026-08-16T12:00:00.000Z');
    expect(latestImportIso({ id: bob, role: 'member', visibility: 'self' })).toBeNull();
  });

  /** Final review F4. Another member's OWNED account is not theirs either -- only their own is. */
  it('a self-scoped viewer never sees another member’s own account, however recent its import', () => {
    setup();
    const bob = insertTestUser(t.db, { username: 'bob', role: 'member' });
    const robin = insertTestUser(t.db, { username: 'robin', role: 'member' });
    const bobs = insertTestAccount(t.db, { name: 'Bob Visa', type: 'credit', ownerUserId: bob });
    const robins = insertTestAccount(t.db, { name: 'Robin Chequing', ownerUserId: robin });
    importAt(bobs, '2026-08-10T12:00:00.000Z');
    importAt(robins, '2026-08-16T12:00:00.000Z');
    expect(latestImportIso({ id: bob, role: 'member', visibility: 'self' })).toBe('2026-08-10');
  });
});
