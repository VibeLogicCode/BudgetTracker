import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accounts, importProfiles, imports } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { parseImportMapping, serializeImportMapping, type ImportMapping } from './mapping';

export const BUILTIN_PRESET_NAMES = [
  'TD Chequing/Debit',
  'TD Visa',
  'Scotiabank Chequing/Debit',
  'Amex Canada',
] as const;

export type BuiltinPresetName = (typeof BUILTIN_PRESET_NAMES)[number];

export interface BuiltinPreset {
  name: BuiltinPresetName;
  institution: string;
  mapping: ImportMapping;
}

/**
 * Best-effort defaults (spec section 3). Every FIRST import of an account runs the
 * preview step, where the user confirms or edits the mapping; editing a built-in
 * forks it into a per-account profile (copy-on-write, Task 8).
 */
export const BUILTIN_PRESETS: Record<BuiltinPresetName, BuiltinPreset> = {
  'TD Chequing/Debit': {
    name: 'TD Chequing/Debit',
    institution: 'TD Canada Trust',
    mapping: {
      hasHeader: false,
      headerRows: 0,
      dateCol: 0,
      // Real export (fixture-validated 2026-08-16): quote-all fields, LF-only, ISO date.
      dateFormat: 'YYYY-MM-DD',
      descCols: [1],
      amountMode: 'debit_credit',
      amountCol: null,
      debitCol: 2,
      creditCol: 3,
      signConvention: 'negative_is_spend',
      encoding: 'auto',
      skipRules: null,
      // None of the four built-ins name a cardholder column — each is a single-person
      // account layout as shipped. cardCol (v1.6.0) is set on a per-account fork instead,
      // the same copy-on-write path any other mapping edit already takes.
      cardCol: null,
    },
  },
  // The two TD presets shipped with byte-identical mappings originally, which read as a
  // copy-paste slip. They are no longer identical and the difference is real, not a typo:
  // the chequing/debit export is ISO-dated (fixture-validated above) while the Visa export
  // is MM/DD/YYYY. Everything else genuinely does match — same headerless four-column
  // debit/credit layout — so keep both entries rather than aliasing one to the other.
  'TD Visa': {
    name: 'TD Visa',
    institution: 'TD Canada Trust',
    mapping: {
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
      cardCol: null,
    },
  },
  'Scotiabank Chequing/Debit': {
    name: 'Scotiabank Chequing/Debit',
    institution: 'Scotiabank',
    mapping: {
      hasHeader: false,
      headerRows: 0,
      dateCol: 0,
      dateFormat: 'MM/DD/YYYY',
      descCols: [3],
      amountMode: 'signed',
      amountCol: 1,
      debitCol: null,
      creditCol: null,
      signConvention: 'negative_is_spend',
      encoding: 'auto',
      skipRules: null,
      cardCol: null,
    },
  },
  'Amex Canada': {
    name: 'Amex Canada',
    institution: 'American Express Canada',
    mapping: {
      hasHeader: true,
      headerRows: 1,
      dateCol: 0,
      // Real export (fixture-validated 2026-08-16): 17 columns, "DD Mon YYYY" dates —
      // dates.ts's 'DD-MMM-YYYY' regex already accepts the space-separated form.
      dateFormat: 'DD-MMM-YYYY',
      // Real column order pushes Description/Amount right of the preset's original
      // guess: Date, Date Processed, Description, Card Member, Account #, Amount, ...
      descCols: [2],
      amountMode: 'signed',
      amountCol: 5,
      debitCol: null,
      creditCol: null,
      // Amex reports charges as POSITIVE numbers.
      signConvention: 'positive_is_spend',
      encoding: 'auto',
      skipRules: null,
      // The real Amex Canada export has both a Card Member name column (index 3) and an
      // Account # suffix column (index 4) that could serve as cardCol (spec 2026-08-22) —
      // deliberately left null here anyway: this is the shared preset, and per-card
      // attribution is account-specific (which suffix belongs to which household member),
      // so it is set on the per-account fork, not baked into the shared built-in.
      cardCol: null,
    },
  },
};

export function getBuiltinPreset(name: BuiltinPresetName): ImportMapping {
  return BUILTIN_PRESETS[name].mapping;
}

// ---- appended in Task 8 ----

export interface ProfileRecord {
  id: number;
  name: string;
  institution: string;
  isBuiltin: boolean;
  /**
   * null when the stored JSON for this row does not satisfy importMappingSchema (hand-edited
   * row, a schema tightened after the row was written, DB corruption, ...). listProfiles() and
   * getProfile() used to let parseImportMapping's throw propagate, which meant ONE bad row took
   * down every caller that lists profiles -- including the managers page, which is the only UI
   * that can delete a profile. A row like that is now still returned, with mapping: null and
   * mappingError set, so it stays visible and deletable instead of taking the page down. It is
   * never silently replaced with a default mapping, which would risk that default getting
   * saved back over the real (recoverable, if the DB is inspected by hand) stored value.
   */
  mapping: ImportMapping | null;
  mappingError: string | null;
  /**
   * v1.6.0 (spec 2026-08-22, `import_profiles.is_active`, migration 0008, default true).
   * A profile hidden this way stays fully in place -- still listed here, still deletable
   * (or not, per the built-in rule below), still referenced by any account or import row
   * that already pointed at it. Only the import picker (MUST-4.1) reads this to decide what
   * to offer; the managers page always shows every profile regardless of it.
   */
  isActive: boolean;
}

/**
 * Type guard for the common case: most callers (the import picker, the pack exporter) need an
 * actually-usable mapping and have no business offering a row that has none. Filtering with
 * this instead of `p.mapping !== null` also narrows the array element type, so the mapping
 * field downstream is ImportMapping, not ImportMapping | null.
 */
export function hasReadableMapping(profile: ProfileRecord): profile is ProfileRecord & { mapping: ImportMapping } {
  return profile.mapping !== null;
}

function toRecord(row: {
  id: number;
  name: string;
  institution: string;
  isBuiltin: boolean;
  mapping: string;
  isActive: boolean;
}): ProfileRecord {
  try {
    return {
      id: row.id,
      name: row.name,
      institution: row.institution,
      isBuiltin: row.isBuiltin,
      mapping: parseImportMapping(row.mapping),
      mappingError: null,
      isActive: row.isActive,
    };
  } catch (error) {
    return {
      id: row.id,
      name: row.name,
      institution: row.institution,
      isBuiltin: row.isBuiltin,
      mapping: null,
      mappingError: error instanceof Error ? error.message : 'This mapping could not be read.',
      isActive: row.isActive,
    };
  }
}

export function listProfiles(): ProfileRecord[] {
  return getDb().select().from(importProfiles).orderBy(importProfiles.id).all().map(toRecord);
}

export function getProfile(profileId: number): ProfileRecord | null {
  const row = getDb().select().from(importProfiles).where(eq(importProfiles.id, profileId)).get();
  return row ? toRecord(row) : null;
}

export function getProfileByName(name: string): ProfileRecord | null {
  const row = getDb().select().from(importProfiles).where(eq(importProfiles.name, name)).get();
  return row ? toRecord(row) : null;
}

export function createProfile(input: { name: string; institution: string; mapping: ImportMapping }): number {
  const row = getDb()
    .insert(importProfiles)
    .values({
      name: input.name,
      institution: input.institution,
      isBuiltin: false,
      mapping: serializeImportMapping(input.mapping),
      createdAt: nowIso(),
    })
    .returning({ id: importProfiles.id })
    .get();
  return row.id;
}

export function updateProfileMapping(profileId: number, mapping: ImportMapping): void {
  const existing = getProfile(profileId);
  if (!existing) throw new Error(`No import profile ${profileId}`);
  if (existing.isBuiltin) {
    throw new Error('Built-in profiles are shared and cannot be edited in place — fork it instead');
  }
  getDb()
    .update(importProfiles)
    .set({ mapping: serializeImportMapping(mapping) })
    .where(eq(importProfiles.id, profileId))
    .run();
}

/**
 * Deactivation (spec 2026-08-22 v1.6.0, MUST-4.2/MUST-4.3). Hides a profile from the import
 * picker without deleting it. Unlike updateProfileMapping/deleteProfile above, this deliberately
 * carries NO built-in guard -- a built-in is the entire reason this flag exists: it cannot be
 * deleted (the refusal above is unchanged), so for a household that does not bank with, say,
 * Scotia, deactivation is the ONLY way to get the shared Scotiabank preset off the picker.
 *
 * Nothing that references this profile is touched here: accounts.importProfileId (an account's
 * pin) and imports.profileId (past import history) both stay exactly as they were. A pinned
 * account's mapping simply goes dormant while its profile is inactive -- the picker (which
 * filters on isActive, see hasReadableMapping's callers) treats that account as unpinned -- and
 * resumes working with no further action the moment the profile is reactivated. This is the
 * opposite of deleteProfile's reference-clearing: deactivation must stay fully reversible.
 */
export function setProfileActive(profileId: number, isActive: boolean): void {
  const existing = getProfile(profileId);
  if (!existing) throw new Error(`No import profile ${profileId}`);
  getDb().update(importProfiles).set({ isActive }).where(eq(importProfiles.id, profileId)).run();
}

export interface ProfileUsage {
  accounts: number;
  imports: number;
}

/**
 * Read path for the delete confirm step: how many rows currently point at this profile.
 * Deliberately separate from deleteProfile's return value below -- the confirm text has to be
 * honest about what will happen BEFORE the admin commits to the delete, so it is computed by
 * its own read here rather than reused from a previous delete's result.
 */
export function getProfileUsage(profileId: number): ProfileUsage {
  const accountsUsing =
    getDb()
      .select({ c: sql<number>`count(*)` })
      .from(accounts)
      .where(eq(accounts.importProfileId, profileId))
      .get()?.c ?? 0;
  const importsUsing =
    getDb()
      .select({ c: sql<number>`count(*)` })
      .from(imports)
      .where(eq(imports.profileId, profileId))
      .get()?.c ?? 0;
  return { accounts: accountsUsing, imports: importsUsing };
}

export interface DeleteProfileResult {
  accountsCleared: number;
  importsCleared: number;
}

/**
 * There was no delete path at all, so a profile created for a test stayed forever. The
 * first version of this fix refused the delete whenever any row
 * referenced the profile -- but a mapping created for a test is almost always used to run at
 * least one test import, so imports.profileId would already reference it and the refusal
 * reproduced the exact "stays forever" symptom being fixed. Both FK columns
 * (accounts.importProfileId, imports.profileId) are nullable, so instead of refusing this
 * clears them and deletes, all in one transaction (same idiom as
 * src/lib/warranty/types.ts's setItemTypeKind) so a crash mid-way never leaves a row nulled
 * out without the profile actually being gone, or vice versa. Built-ins are still refused --
 * they are shared rows, same guard as updateProfileMapping above.
 */
export function deleteProfile(profileId: number): DeleteProfileResult {
  const existing = getProfile(profileId);
  if (!existing) throw new Error(`No import profile ${profileId}`);
  if (existing.isBuiltin) {
    throw new Error('Built-in profiles are shared and cannot be deleted');
  }

  return getDb().transaction((tx) => {
    const accountsCleared = tx
      .update(accounts)
      .set({ importProfileId: null })
      .where(eq(accounts.importProfileId, profileId))
      .run().changes;
    const importsCleared = tx
      .update(imports)
      .set({ profileId: null })
      .where(eq(imports.profileId, profileId))
      .run().changes;
    tx.delete(importProfiles).where(eq(importProfiles.id, profileId)).run();
    return { accountsCleared, importsCleared };
  });
}

export function mappingsEqual(a: ImportMapping, b: ImportMapping): boolean {
  return serializeImportMapping(a) === serializeImportMapping(b);
}

/**
 * Copy-on-write (spec section 3): the first time a user adjusts a built-in profile's
 * mapping at preview, fork it into a new profile named after the account.
 * Non-built-in profiles are edited in place.
 */
export function forkProfileIfBuiltin(input: { profileId: number; accountName: string; mapping: ImportMapping }): number {
  const existing = getProfile(input.profileId);
  if (!existing) throw new Error(`No import profile ${input.profileId}`);
  // existing.mapping is only null for a row whose stored JSON is unreadable (see
  // ProfileRecord's doc comment) — the profile picker never offers one of those, so this is
  // a defensive fallthrough, not the normal path: treat it the same as "different mapping"
  // rather than crashing on a null comparison.
  if (existing.mapping !== null && mappingsEqual(existing.mapping, input.mapping)) return existing.id;

  if (!existing.isBuiltin) {
    updateProfileMapping(existing.id, input.mapping);
    return existing.id;
  }

  let name = `${existing.name} (${input.accountName})`;
  let suffix = 1;
  while (getProfileByName(name) !== null) {
    suffix += 1;
    name = `${existing.name} (${input.accountName}) ${suffix}`;
  }
  return createProfile({ name, institution: existing.institution, mapping: input.mapping });
}

export function setAccountProfile(accountId: number, profileId: number): void {
  getDb().update(accounts).set({ importProfileId: profileId }).where(eq(accounts.id, accountId)).run();
}

/**
 * Manual set-or-clear for Settings → Accounts (spec 2026-08-22 v1.6.0, MUST-5.1). Distinct
 * from setAccountProfile above, which is flow.ts's AUTOMATIC remember-after-commit write and
 * only ever receives a real profile id -- that call and its behaviour are unchanged by this
 * task. This one is reachable without running an import at all, and `profileId: null` CLEARS
 * the pin, which setAccountProfile has no way to express. Whether the chosen profile is one an
 * admin should actually be allowed to pin (active + readable) is the caller's job, the same
 * layering setAccountOwnerAction already uses for validating a chosen owner id in
 * src/app/(app)/settings/accounts/actions.ts.
 */
export function setAccountPinnedProfile(accountId: number, profileId: number | null): void {
  getDb().update(accounts).set({ importProfileId: profileId }).where(eq(accounts.id, accountId)).run();
}
