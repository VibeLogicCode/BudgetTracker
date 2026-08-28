import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, type TestDb } from '../helpers/db';

const FAKE_USER: { id: number; name: string; username: string; role: 'admin' | 'member'; visibility: 'household' | 'self' } = {
  id: 1,
  name: 'Alice',
  username: 'alice',
  role: 'admin',
  visibility: 'household',
};

let requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => FAKE_USER),
}));

vi.mock('next/headers', () => ({
  headers: async () => requestHeaders,
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { saveWizardProfileAction, setCardPersonAction } from '@/app/(app)/import/actions';
import { getBuiltinPreset, getProfileByName, listProfiles } from '@/lib/import/presets';
import { writeStagedFile, stagedFilePath } from '@/lib/import/staging';
import { insertTestAccount, insertTestUser } from '../helpers/db';
import { listAccountCardPeople } from '@/lib/import/card-people';

let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
  FAKE_USER.visibility = 'household';
  FAKE_USER.role = 'admin';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-wizard-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  current = createSeededTestDb();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
  current?.cleanup();
  current = null;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe('saveWizardProfileAction (new-bank wizard)', () => {
  it('saves a new named profile from the mapping and deletes the staged sample file', async () => {
    const stagingId = writeStagedFile(Buffer.from('sample'));
    const mapping = getBuiltinPreset('Scotiabank Chequing/Debit');

    const result = await saveWizardProfileAction(
      {},
      formData({
        name: 'Tangerine Chequing',
        institution: 'Tangerine',
        mapping: JSON.stringify(mapping),
        stagingId,
      }),
    );

    expect(result.message).toMatch(/Saved "Tangerine Chequing"/);
    const saved = getProfileByName('Tangerine Chequing');
    expect(saved).toMatchObject({ name: 'Tangerine Chequing', institution: 'Tangerine', isBuiltin: false });
    expect(saved!.mapping).toEqual(mapping);
    expect(fs.existsSync(stagedFilePath(stagingId))).toBe(false);
  });

  it('rejects a duplicate profile name without creating a second row', async () => {
    const before = listProfiles().length;
    const mapping = getBuiltinPreset('Scotiabank Chequing/Debit');

    const result = await saveWizardProfileAction(
      {},
      formData({ name: 'TD Chequing/Debit', institution: 'TD Canada Trust', mapping: JSON.stringify(mapping) }),
    );

    expect(result.error).toMatch(/already exists/i);
    expect(listProfiles()).toHaveLength(before);
  });

  it('rejects a cross-origin request before creating a profile (I2)', async () => {
    const before = listProfiles().length;
    requestHeaders = new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' });

    const result = await saveWizardProfileAction(
      {},
      formData({ name: 'Attacker Bank', institution: 'Evil', mapping: JSON.stringify(getBuiltinPreset('TD Visa')) }),
    );

    expect(result.error).toBe('Cross-origin request rejected');
    expect(listProfiles()).toHaveLength(before);
    expect(getProfileByName('Attacker Bank')).toBeNull();
  });

  it('rejects a malformed mapping instead of saving a broken profile', async () => {
    const before = listProfiles().length;
    const result = await saveWizardProfileAction(
      {},
      formData({ name: 'Broken Bank', institution: 'Some Bank', mapping: JSON.stringify({ ...getBuiltinPreset('TD Visa'), descCols: [] }) }),
    );

    expect(result.error).toBeTruthy();
    expect(listProfiles()).toHaveLength(before);
    expect(getProfileByName('Broken Bank')).toBeNull();
  });

  it('Task 14 fix round 1: refuses a self-scoped viewer before validation, creating nothing', async () => {
    FAKE_USER.role = 'member';
    FAKE_USER.visibility = 'self';
    const before = listProfiles().length;
    const result = await saveWizardProfileAction(
      {},
      formData({ name: 'Kid Bank', institution: 'Some Bank', mapping: JSON.stringify(getBuiltinPreset('TD Visa')) }),
    );

    expect(result.error).toBeTruthy();
    expect(listProfiles()).toHaveLength(before);
    expect(getProfileByName('Kid Bank')).toBeNull();
  });
});

describe('setCardPersonAction (MUST-6.1: saves an account_card_people assignment immediately, independent of any import)', () => {
  it('assigns a card value to a person', async () => {
    const accountId = insertTestAccount(current!.db);
    const alexId = insertTestUser(current!.db, { name: 'Alex' });

    const result = await setCardPersonAction({}, formData({ accountId: String(accountId), cardValue: '-1001', person: String(alexId) }));

    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/saved/i);
    expect(listAccountCardPeople(accountId)).toMatchObject([{ cardValue: '-1001', userId: alexId, userName: 'Alex' }]);
  });

  it('normalizes the card value the same way the reader will (trim, collapse spaces, uppercase)', async () => {
    const accountId = insertTestAccount(current!.db);
    const alexId = insertTestUser(current!.db, { name: 'Alex' });

    await setCardPersonAction({}, formData({ accountId: String(accountId), cardValue: '  alex  morgan ', person: String(alexId) }));

    expect(listAccountCardPeople(accountId).map((r) => r.cardValue)).toEqual(['ALEX MORGAN']);
  });

  it('re-assigning the same value to a different person updates the row instead of adding a second one', async () => {
    const accountId = insertTestAccount(current!.db);
    const alexId = insertTestUser(current!.db, { name: 'Alex' });
    const samId = insertTestUser(current!.db, { name: 'Sam' });
    await setCardPersonAction({}, formData({ accountId: String(accountId), cardValue: '-1001', person: String(alexId) }));

    const result = await setCardPersonAction({}, formData({ accountId: String(accountId), cardValue: '-1001', person: String(samId) }));

    expect(result.error).toBeUndefined();
    expect(listAccountCardPeople(accountId)).toHaveLength(1);
    expect(listAccountCardPeople(accountId)[0]).toMatchObject({ userId: samId });
  });

  it('clearing back to "" (account owner) deletes the assignment rather than erroring', async () => {
    const accountId = insertTestAccount(current!.db);
    const alexId = insertTestUser(current!.db, { name: 'Alex' });
    await setCardPersonAction({}, formData({ accountId: String(accountId), cardValue: '-1001', person: String(alexId) }));

    const result = await setCardPersonAction({}, formData({ accountId: String(accountId), cardValue: '-1001', person: '' }));

    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/fall back to the account owner/i);
    expect(listAccountCardPeople(accountId)).toHaveLength(0);
  });

  it('permits assigning to a person who has since been deactivated (MUST-3.1: still valid and resolvable)', async () => {
    const accountId = insertTestAccount(current!.db);
    const retiredId = insertTestUser(current!.db, { name: 'Retired Member', isActive: false });

    const result = await setCardPersonAction({}, formData({ accountId: String(accountId), cardValue: '-1001', person: String(retiredId) }));

    expect(result.error).toBeUndefined();
    expect(listAccountCardPeople(accountId)).toMatchObject([{ userId: retiredId, userName: 'Retired Member', userIsActive: false }]);
  });

  it('refuses a person id that does not exist, without writing anything', async () => {
    const accountId = insertTestAccount(current!.db);
    const result = await setCardPersonAction({}, formData({ accountId: String(accountId), cardValue: '-1001', person: '999999' }));
    expect(result.error).toMatch(/no longer exists/i);
    expect(listAccountCardPeople(accountId)).toHaveLength(0);
  });

  it('refuses an account id that does not exist', async () => {
    const alexId = insertTestUser(current!.db, { name: 'Alex' });
    const result = await setCardPersonAction({}, formData({ accountId: '999999', cardValue: '-1001', person: String(alexId) }));
    expect(result.error).toMatch(/no longer exists/i);
  });

  it('refuses a malformed person field instead of writing an unusable value', async () => {
    const accountId = insertTestAccount(current!.db);
    const result = await setCardPersonAction({}, formData({ accountId: String(accountId), cardValue: '-1001', person: 'not-a-number' }));
    expect(result.error).toBeTruthy();
    expect(listAccountCardPeople(accountId)).toHaveLength(0);
  });

  it('rejects a cross-origin request before writing anything', async () => {
    const accountId = insertTestAccount(current!.db);
    const alexId = insertTestUser(current!.db, { name: 'Alex' });
    requestHeaders = new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' });

    const result = await setCardPersonAction({}, formData({ accountId: String(accountId), cardValue: '-1001', person: String(alexId) }));

    expect(result.error).toBe('Cross-origin request rejected');
    expect(listAccountCardPeople(accountId)).toHaveLength(0);
  });

  it('Task 14 fix round 1: refuses a self-scoped viewer, writing nothing', async () => {
    const accountId = insertTestAccount(current!.db);
    const alexId = insertTestUser(current!.db, { name: 'Alex' });
    FAKE_USER.role = 'member';
    FAKE_USER.visibility = 'self';

    const result = await setCardPersonAction({}, formData({ accountId: String(accountId), cardValue: '-1001', person: String(alexId) }));

    expect(result.error).toBeTruthy();
    expect(listAccountCardPeople(accountId)).toHaveLength(0);
  });
});
