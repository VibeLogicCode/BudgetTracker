import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { deleteAccountCardPerson, listAccountCardPeople, upsertAccountCardPerson } from '@/lib/import/card-people';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('account card-person map', () => {
  it('starts empty for a fresh account', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    expect(listAccountCardPeople(accountId)).toEqual([]);
  });

  it('upserts an assignment and lists it back with the person resolved', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });

    upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: alex });

    const rows = listAccountCardPeople(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId, cardValue: '-1001', userId: alex, userName: 'Alex', userIsActive: true });
  });

  it('normalizes the card value on write: odd spacing and case still land on the same row', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const sam = insertTestUser(current.db, { name: 'Sam', username: 'sam' });

    upsertAccountCardPerson({ accountId, cardValue: '  alex   morgan ', userId: alex });
    // Re-assigning the SAME value (different spacing/case) to a different person must be an
    // UPDATE on the one normalized row, not a second row — this is the whole point of
    // normalizing before the unique-index lookup, not after.
    upsertAccountCardPerson({ accountId, cardValue: 'Alex Morgan', userId: sam });

    const rows = listAccountCardPeople(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cardValue: 'ALEX MORGAN', userId: sam });
  });

  it('scopes assignments to their own account', () => {
    current = createSeededTestDb();
    const accountA = insertTestAccount(current.db, { name: 'Amex A' });
    const accountB = insertTestAccount(current.db, { name: 'Amex B' });
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });

    upsertAccountCardPerson({ accountId: accountA, cardValue: '-1001', userId: alex });

    expect(listAccountCardPeople(accountA)).toHaveLength(1);
    expect(listAccountCardPeople(accountB)).toEqual([]);
  });

  it('refuses an assignment to a user id that does not exist', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    expect(() => upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: 999999 })).toThrow();
    expect(listAccountCardPeople(accountId)).toEqual([]);
  });

  it('refuses an assignment whose normalized card value is empty', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    expect(() => upsertAccountCardPerson({ accountId, cardValue: '   ', userId: alex })).toThrow();
  });

  it('keeps an assignment valid and resolvable after the assigned user is deactivated', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: alex });

    current.sqlite.prepare('update users set is_active = 0 where id = ?').run(alex);

    const rows = listAccountCardPeople(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: alex, userName: 'Alex', userIsActive: false });
  });

  it('deletes an assignment looked up with different spacing/case than it was written with', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: alex });

    deleteAccountCardPerson(accountId, '  -1001 ');

    expect(listAccountCardPeople(accountId)).toEqual([]);
  });

  it('deleting an assignment that does not exist is a harmless no-op', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    expect(() => deleteAccountCardPerson(accountId, '-9999')).not.toThrow();
  });
});
