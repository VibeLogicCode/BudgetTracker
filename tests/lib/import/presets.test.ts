import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { nowIso } from '@/lib/clock';
import { parseImportMapping, serializeImportMapping } from '@/lib/import/mapping';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
import {
  createProfile,
  deleteProfile,
  forkProfileIfBuiltin,
  getBuiltinPreset,
  getProfile,
  getProfileByName,
  getProfileUsage,
  hasReadableMapping,
  listProfiles,
  mappingsEqual,
  setAccountPinnedProfile,
  setAccountProfile,
  setProfileActive,
  updateProfileMapping,
} from '@/lib/import/presets';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('profile store', () => {
  it('lists the seven seeded built-ins with parsed mappings', () => {
    current = createSeededTestDb();
    const profiles = listProfiles();
    // v1.13.0 Task 9 adds RBC/BMO/CIBC (UNVERIFIED) to the original four.
    expect(profiles).toHaveLength(7);
    expect(profiles.every((p) => p.isBuiltin)).toBe(true);
    expect(profiles[0].mapping!.amountMode).toBe('debit_credit');
  });

  it('creates and reads back a custom profile', () => {
    current = createSeededTestDb();
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: { ...getBuiltinPreset('Scotiabank Chequing/Debit'), dateFormat: 'YYYY-MM-DD' },
    });
    const profile = getProfile(id);
    expect(profile).toMatchObject({ id, name: 'Tangerine Chequing', isBuiltin: false });
    expect(profile?.mapping?.dateFormat).toBe('YYYY-MM-DD');
    expect(getProfileByName('Tangerine Chequing')?.id).toBe(id);
  });

  it('rejects a duplicate profile name', () => {
    current = createSeededTestDb();
    expect(() =>
      createProfile({ name: 'TD Visa', institution: 'TD Canada Trust', mapping: getBuiltinPreset('TD Visa') }),
    ).toThrow();
  });
});

describe('copy-on-write built-ins', () => {
  it('never mutates a built-in in place', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    expect(() => updateProfileMapping(builtin.id, { ...builtin.mapping!, dateFormat: 'YYYY-MM-DD' })).toThrowError(
      /built-in/i,
    );
    expect(getProfile(builtin.id)?.mapping?.dateFormat).toBe('MM/DD/YYYY');
  });

  it('returns the same profile id when the mapping is unchanged', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    const id = forkProfileIfBuiltin({ profileId: builtin.id, accountName: 'Joint Visa', mapping: builtin.mapping! });
    expect(id).toBe(builtin.id);
    expect(listProfiles()).toHaveLength(7);
  });

  it('forks into a new named profile when the mapping is edited', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    const edited = { ...builtin.mapping!, dateFormat: 'YYYY-MM-DD' };
    const forkedId = forkProfileIfBuiltin({ profileId: builtin.id, accountName: 'Joint Visa', mapping: edited });
    expect(forkedId).not.toBe(builtin.id);

    const forked = getProfile(forkedId)!;
    expect(forked.isBuiltin).toBe(false);
    expect(forked.name).toBe('TD Visa (Joint Visa)');
    expect(forked.mapping!.dateFormat).toBe('YYYY-MM-DD');

    // built-in untouched
    expect(getProfile(builtin.id)?.mapping?.dateFormat).toBe('MM/DD/YYYY');
    expect(listProfiles()).toHaveLength(8);
  });

  it('does not collide when two accounts fork the same built-in', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    const a = forkProfileIfBuiltin({ profileId: builtin.id, accountName: 'Joint Visa', mapping: { ...builtin.mapping!, dateFormat: 'YYYY-MM-DD' } });
    const b = forkProfileIfBuiltin({ profileId: builtin.id, accountName: 'Joint Visa', mapping: { ...builtin.mapping!, dateFormat: 'DD/MM/YYYY' } });
    expect(a).not.toBe(b);
    expect(getProfile(b)?.name).toBe('TD Visa (Joint Visa) 2');
  });

  it('edits a non-built-in fork in place instead of forking again', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    const forkedId = forkProfileIfBuiltin({ profileId: builtin.id, accountName: 'Joint Visa', mapping: { ...builtin.mapping!, dateFormat: 'YYYY-MM-DD' } });
    const again = forkProfileIfBuiltin({ profileId: forkedId, accountName: 'Joint Visa', mapping: { ...builtin.mapping!, dateFormat: 'DD/MM/YYYY' } });
    expect(again).toBe(forkedId);
    expect(getProfile(forkedId)?.mapping?.dateFormat).toBe('DD/MM/YYYY');
    expect(listProfiles()).toHaveLength(8);
  });
});

describe('mappingsEqual', () => {
  it('ignores key order and compares by value', () => {
    const a = getBuiltinPreset('TD Visa');
    const b = { ...a };
    expect(mappingsEqual(a, b)).toBe(true);
    expect(mappingsEqual(a, { ...a, descCols: [1, 2] })).toBe(false);
    expect(mappingsEqual(a, { ...a, skipRules: { containsAny: ['X'] } })).toBe(false);
  });
});

describe('cardCol upgrade compatibility (MUST-2.2, spec 2026-08-22 v1.6.0)', () => {
  /**
   * The real risk this guards against: on upgrade, every built-in's stored mapping JSON
   * literally has no `cardCol` key (it predates the field). If mappingsEqual or
   * forkProfileIfBuiltin treated "key absent" and "key present with value null" as
   * different, then the very first preview screen a user opens after upgrading — which
   * round-trips the mapping through the schema before calling forkProfileIfBuiltin — would
   * fork a duplicate profile for every account, every time, forever. Both sides must pass
   * through the same schema and land on the same default.
   */
  function legacyTdVisaJson(): string {
    // Verbatim pre-1.6.0 shape: no cardCol key. Field values match presets.ts's TD Visa entry.
    return JSON.stringify({
      hasHeader: false,
      headerRows: 0,
      dateCol: 0,
      dateFormat: 'MM/DD/YYYY',
      descCols: [1],
      amountMode: 'debit_credit',
      amountCol: null,
      debitCol: 2,
      creditCol: 3,
      signConvention: 'negative_is_spend',
      encoding: 'auto',
      skipRules: null,
    });
  }

  it('mappingsEqual treats a legacy mapping missing the cardCol key as equal to the same mapping with cardCol: null', () => {
    const legacy = parseImportMapping(legacyTdVisaJson());
    const explicit = { ...legacy, cardCol: null };
    expect(mappingsEqual(legacy, explicit)).toBe(true);
  });

  it('a legacy mapping round-tripped through serialize/parse is still equal to itself', () => {
    const legacy = parseImportMapping(legacyTdVisaJson());
    const roundTripped = parseImportMapping(serializeImportMapping(legacy));
    expect(mappingsEqual(legacy, roundTripped)).toBe(true);
    expect(roundTripped.cardCol).toBeNull();
  });

  it('forkProfileIfBuiltin does not fork a built-in whose DB row predates cardCol when the mapping comes back unchanged', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    // Overwrite the seeded row with the literal legacy JSON shape (no cardCol key), simulating
    // an install that has never been touched since before v1.6.0.
    current.sqlite.prepare('update import_profiles set mapping = ? where id = ?').run(legacyTdVisaJson(), builtin.id);

    const reread = getProfile(builtin.id)!;
    expect(reread.mapping?.cardCol).toBeNull();

    // Simulate the real call path: the preview screen round-trips the mapping it read back
    // through the schema (e.g. via JSON.stringify(mapping) in a hidden form field, then
    // parseImportMapping on submit) before ever calling forkProfileIfBuiltin.
    const roundTripped = parseImportMapping(serializeImportMapping(reread.mapping!));
    const id = forkProfileIfBuiltin({ profileId: builtin.id, accountName: 'Joint Visa', mapping: roundTripped });

    expect(id).toBe(builtin.id);
    expect(listProfiles()).toHaveLength(7); // no spurious fork created
  });

  it('forkProfileIfBuiltin still forks correctly when cardCol itself is the actual, intentional change', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    const edited = { ...builtin.mapping!, cardCol: 4 };
    const forkedId = forkProfileIfBuiltin({ profileId: builtin.id, accountName: 'Joint Visa', mapping: edited });

    expect(forkedId).not.toBe(builtin.id);
    expect(getProfile(forkedId)?.mapping?.cardCol).toBe(4);
    expect(getProfile(builtin.id)?.mapping?.cardCol).toBeNull(); // built-in untouched
  });
});

describe('setAccountProfile', () => {
  it('remembers the profile on the account', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db, { name: 'Joint Visa', type: 'credit' });
    const builtin = getProfileByName('TD Visa')!;
    setAccountProfile(accountId, builtin.id);
    const row = current.sqlite.prepare('select import_profile_id from accounts where id = ?').get(accountId) as {
      import_profile_id: number;
    };
    expect(row.import_profile_id).toBe(builtin.id);
  });
});

describe('setAccountPinnedProfile (spec 2026-08-22 v1.6.0, MUST-5.1: set or clear a pin without importing)', () => {
  it('pins an account to a profile, the same column setAccountProfile writes', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db, { name: 'Joint Chequing', type: 'chequing' });
    const builtin = getProfileByName('TD Chequing/Debit')!;

    setAccountPinnedProfile(accountId, builtin.id);

    const row = current.sqlite.prepare('select import_profile_id from accounts where id = ?').get(accountId) as {
      import_profile_id: number | null;
    };
    expect(row.import_profile_id).toBe(builtin.id);
  });

  it('clears an existing pin back to null, which setAccountProfile has no way to express', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    const accountId = insertTestAccount(current.db, { name: 'Joint Visa', type: 'credit', importProfileId: builtin.id });

    setAccountPinnedProfile(accountId, null);

    const row = current.sqlite.prepare('select import_profile_id from accounts where id = ?').get(accountId) as {
      import_profile_id: number | null;
    };
    expect(row.import_profile_id).toBeNull();
  });

  it('does not disturb the pinned profile when it does not match the account being pinned', () => {
    current = createSeededTestDb();
    const chequing = getProfileByName('TD Chequing/Debit')!;
    const visa = getProfileByName('TD Visa')!;
    const account1 = insertTestAccount(current.db, { name: 'Account 1', importProfileId: chequing.id });
    const account2 = insertTestAccount(current.db, { name: 'Account 2', importProfileId: visa.id });

    setAccountPinnedProfile(account1, null);

    const row2 = current.sqlite.prepare('select import_profile_id from accounts where id = ?').get(account2) as {
      import_profile_id: number | null;
    };
    expect(row2.import_profile_id).toBe(visa.id);
  });
});

describe('deleteProfile (a mapping could not previously be deleted by anyone; clears references instead of refusing)', () => {
  it('refuses to delete a built-in profile', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    expect(() => deleteProfile(builtin.id)).toThrowError(/built-in/i);
    expect(listProfiles()).toHaveLength(7);
  });

  it('deletes an unused custom profile, reporting nothing cleared', () => {
    current = createSeededTestDb();
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    expect(deleteProfile(id)).toEqual({ accountsCleared: 0, importsCleared: 0 });
    expect(getProfile(id)).toBeNull();
    expect(listProfiles()).toHaveLength(7);
  });

  it('deletes a profile an account still uses, nulling the account reference instead of refusing', () => {
    current = createSeededTestDb();
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    const accountId = insertTestAccount(current.db, { name: 'Joint Chequing', importProfileId: id });

    expect(deleteProfile(id)).toEqual({ accountsCleared: 1, importsCleared: 0 });

    expect(getProfile(id)).toBeNull();
    const row = current.sqlite.prepare('select import_profile_id from accounts where id = ?').get(accountId) as {
      import_profile_id: number | null;
    };
    expect(row.import_profile_id).toBeNull();
  });

  it('deletes a profile a past import still references, nulling the import reference instead of refusing', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { name: 'Admin', username: 'admin' });
    const accountId = insertTestAccount(current.db, { name: 'Old Account' });
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    const inserted = current.sqlite
      .prepare(
        `insert into imports (account_id, profile_id, filename, imported_by, created_at) values (?, ?, ?, ?, ?)`,
      )
      .run(accountId, id, 'old.csv', userId, nowIso());
    const importId = Number(inserted.lastInsertRowid);

    expect(deleteProfile(id)).toEqual({ accountsCleared: 0, importsCleared: 1 });

    expect(getProfile(id)).toBeNull();
    const row = current.sqlite.prepare('select profile_id from imports where id = ?').get(importId) as {
      profile_id: number | null;
    };
    expect(row.profile_id).toBeNull();
  });

  it('clears both an account and a past import in one call', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { name: 'Admin', username: 'admin' });
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    const accountId = insertTestAccount(current.db, { name: 'Joint Chequing', importProfileId: id });
    current.sqlite
      .prepare(
        `insert into imports (account_id, profile_id, filename, imported_by, created_at) values (?, ?, ?, ?, ?)`,
      )
      .run(accountId, id, 'old.csv', userId, nowIso());

    expect(deleteProfile(id)).toEqual({ accountsCleared: 1, importsCleared: 1 });
    expect(getProfile(id)).toBeNull();
  });

  it('throws for an unknown profile id', () => {
    current = createSeededTestDb();
    expect(() => deleteProfile(999999)).toThrowError(/no import profile/i);
  });
});

describe('a profile row whose stored mapping does not parse (settings/managers 500, defect fixed in 1.5.1)', () => {
  /**
   * One row with malformed JSON in its `mapping` column used to make listProfiles() (and
   * therefore the settings/managers page, the only UI with a delete button for a profile)
   * throw for every profile, not just the bad one. The fix: toRecord() catches the parse
   * failure per row and returns mapping: null + mappingError instead of letting it propagate.
   */
  function insertUnparseableProfile(db: TestDb, rawMapping: string): number {
    const inserted = db.sqlite
      .prepare(`insert into import_profiles (name, institution, is_builtin, mapping, created_at) values (?, ?, 0, ?, ?)`)
      .run('Corrupted Bank', 'Some Bank', rawMapping, nowIso());
    return Number(inserted.lastInsertRowid);
  }

  it('listProfiles() returns the row marked unreadable instead of throwing for everyone', () => {
    current = createSeededTestDb();
    const id = insertUnparseableProfile(current, '{"amountMode": "not a real mode"}');

    const profiles = listProfiles();
    expect(profiles).toHaveLength(8);
    const broken = profiles.find((p) => p.id === id)!;
    expect(broken.mapping).toBeNull();
    expect(broken.mappingError).toBeTruthy();
    // The other seven (valid) rows are completely unaffected by the one bad row.
    expect(profiles.filter((p) => p.mapping !== null)).toHaveLength(7);
  });

  it('also survives mapping text that is not even valid JSON', () => {
    current = createSeededTestDb();
    const id = insertUnparseableProfile(current, 'not json at all {{{');

    const broken = getProfile(id)!;
    expect(broken.mapping).toBeNull();
    expect(broken.mappingError).toBeTruthy();
  });

  it('getProfile() returns the row marked unreadable instead of throwing', () => {
    current = createSeededTestDb();
    const id = insertUnparseableProfile(current, '{"hasHeader": "yes"}');

    const profile = getProfile(id);
    expect(profile).not.toBeNull();
    expect(profile!.mapping).toBeNull();
    expect(profile!.mappingError).toBeTruthy();
    expect(profile!.name).toBe('Corrupted Bank');
  });

  it('is still deletable — the row that broke the page is the one you need to be able to remove', () => {
    current = createSeededTestDb();
    const id = insertUnparseableProfile(current, '{"amountMode": "not a real mode"}');

    expect(deleteProfile(id)).toEqual({ accountsCleared: 0, importsCleared: 0 });
    expect(getProfile(id)).toBeNull();
    expect(listProfiles()).toHaveLength(7);
  });

  it('a broken row referenced by an account still clears the reference on delete, same as a valid row', () => {
    current = createSeededTestDb();
    const id = insertUnparseableProfile(current, '{"amountMode": "not a real mode"}');
    const accountId = insertTestAccount(current.db, { name: 'Joint Chequing', importProfileId: id });

    expect(deleteProfile(id)).toEqual({ accountsCleared: 1, importsCleared: 0 });
    const row = current.sqlite.prepare('select import_profile_id from accounts where id = ?').get(accountId) as {
      import_profile_id: number | null;
    };
    expect(row.import_profile_id).toBeNull();
  });
});

describe('isActive / setProfileActive (spec 2026-08-22 v1.6.0, MUST-4.1-4.3: mapping deactivation)', () => {
  it('defaults every profile, built-in and custom, to active', () => {
    current = createSeededTestDb();
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    expect(listProfiles().every((p) => p.isActive)).toBe(true);
    expect(getProfile(id)?.isActive).toBe(true);
  });

  it('deactivates a BUILT-IN profile -- this is the entire point: a built-in cannot be deleted, so deactivation is the only way off the picker (MUST-4.2)', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('Scotiabank Chequing/Debit')!;
    setProfileActive(builtin.id, false);
    expect(getProfile(builtin.id)?.isActive).toBe(false);
    // still present, still built-in, still deletable-refusal unchanged -- just hidden.
    expect(getProfile(builtin.id)?.isBuiltin).toBe(true);
    expect(listProfiles()).toHaveLength(7);
  });

  it('reactivates a deactivated profile', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    setProfileActive(builtin.id, false);
    setProfileActive(builtin.id, true);
    expect(getProfile(builtin.id)?.isActive).toBe(true);
  });

  it('throws for an unknown profile id instead of silently no-op-ing', () => {
    current = createSeededTestDb();
    expect(() => setProfileActive(999999, false)).toThrowError(/no import profile/i);
  });

  it('leaves an account pinned to the profile UNTOUCHED in the database -- deactivation is reversible, not destructive (MUST-4.3)', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('Scotiabank Chequing/Debit')!;
    const accountId = insertTestAccount(current.db, { name: 'Joint Chequing', importProfileId: builtin.id });

    setProfileActive(builtin.id, false);

    const row = current.sqlite.prepare('select import_profile_id from accounts where id = ?').get(accountId) as {
      import_profile_id: number | null;
    };
    // Nothing nulled -- contrast with deleteProfile, which clears this same column.
    expect(row.import_profile_id).toBe(builtin.id);
  });

  it('the import picker filter (hasReadableMapping AND isActive) excludes a deactivated profile while listProfiles() (the managers page) still returns it -- proves both conditions combine the way page.tsx applies them', () => {
    current = createSeededTestDb();
    const scotia = getProfileByName('Scotiabank Chequing/Debit')!;
    setProfileActive(scotia.id, false);

    const managersView = listProfiles();
    expect(managersView.find((p) => p.id === scotia.id)).toBeDefined();

    const pickerView = listProfiles().filter(hasReadableMapping).filter((p) => p.isActive);
    expect(pickerView.find((p) => p.id === scotia.id)).toBeUndefined();
    expect(pickerView).toHaveLength(6); // the other six built-ins remain
  });

  it('reactivating restores the pinned account to the picker with no further action needed (MUST-4.3, other direction)', () => {
    current = createSeededTestDb();
    const scotia = getProfileByName('Scotiabank Chequing/Debit')!;
    insertTestAccount(current.db, { name: 'Joint Chequing', importProfileId: scotia.id });

    setProfileActive(scotia.id, false);
    expect(listProfiles().filter(hasReadableMapping).filter((p) => p.isActive).find((p) => p.id === scotia.id)).toBeUndefined();

    setProfileActive(scotia.id, true);
    const pickerView = listProfiles().filter(hasReadableMapping).filter((p) => p.isActive);
    expect(pickerView.find((p) => p.id === scotia.id)).toBeDefined();
  });
});

describe('getProfileUsage (read path for the delete confirm step)', () => {
  it('reports zero for a profile nothing references', () => {
    current = createSeededTestDb();
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    expect(getProfileUsage(id)).toEqual({ accounts: 0, imports: 0 });
  });

  it('counts accounts and past imports that reference the profile, without deleting anything', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { name: 'Admin', username: 'admin' });
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    const accountId = insertTestAccount(current.db, { name: 'Joint Chequing', importProfileId: id });
    current.sqlite
      .prepare(
        `insert into imports (account_id, profile_id, filename, imported_by, created_at) values (?, ?, ?, ?, ?)`,
      )
      .run(accountId, id, 'old.csv', userId, nowIso());

    expect(getProfileUsage(id)).toEqual({ accounts: 1, imports: 1 });
    expect(getProfile(id)).not.toBeNull();
  });
});

it('v1.13.0: the three new presets parse, are marked UNVERIFIED in source, and round-trip', () => {
  for (const name of ['RBC Chequing/Visa', 'BMO Chequing/Mastercard', 'CIBC Chequing/Visa'] as const) {
    const mapping = getBuiltinPreset(name);
    expect(() => parseImportMapping(serializeImportMapping(mapping))).not.toThrow();
    expect(mapping.cardCol).toBeNull();
    expect(mapping.balanceCol).toBeNull();
  }
  const source = fs.readFileSync(path.join(root, 'src/lib/import/presets.ts'), 'utf8');
  expect((source.match(/UNVERIFIED/g) ?? []).length).toBe(3);
});
