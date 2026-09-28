import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, type TestDb } from '../helpers/db';
import { getAccount, listAccounts, setAccountImportCadence } from '@/lib/accounts';
import { HOUSEHOLD_VIEWER } from '@/lib/auth/viewer';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/** Spec 2026-09-28 §2.2: the account's own threshold, read wherever the account is read. */
describe('setAccountImportCadence', () => {
  it('is null on a fresh account and comes back through getAccount and listAccounts', () => {
    current = createSeededTestDb();
    const id = insertTestAccount(current.db, { name: 'Amex', type: 'credit' });
    expect(getAccount(id)?.expectedImportWeeks).toBeNull();

    setAccountImportCadence(id, 5);
    expect(getAccount(id)?.expectedImportWeeks).toBe(5);
    expect(listAccounts({}, HOUSEHOLD_VIEWER).find((account) => account.id === id)?.expectedImportWeeks).toBe(5);
  });

  it('stores 0 as 0 and null as null -- never is not the same as default', () => {
    current = createSeededTestDb();
    const id = insertTestAccount(current.db);
    setAccountImportCadence(id, 0);
    expect(getAccount(id)?.expectedImportWeeks).toBe(0);
    setAccountImportCadence(id, null);
    expect(getAccount(id)?.expectedImportWeeks).toBeNull();
  });
});
