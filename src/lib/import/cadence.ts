/**
 * The import cadence an account can declare (spec 2026-09-28 §2.2), and the one rule the reminder
 * applies to it.
 *
 * PURE, and it must stay that way: no imports at all. settings/accounts/accounts-manager.tsx is
 * 'use client' and value-imports this module for the select, and the client-bundle guard
 * (tests/ops/client-bundle.test.ts) walks every value import from a client file looking for a
 * path to @/db/client. Its sibling files in src/lib/import/ reach the database; this one may not.
 *
 * THE STORED NUMBER IS A THRESHOLD, NOT A CADENCE. accounts.expected_import_weeks carries the same
 * meaning staleImportWeeks (Settings -> Notifications) has always had -- "this many weeks with no
 * import, then remind" -- so the evaluator keeps one rule for both. The labels are what a person
 * means; the numbers carry one week of slack past the cadence they name, so a statement that
 * arrives a few days late does not produce a reminder. One module owns both halves so the accounts
 * page, the action and the evaluator cannot disagree about what "Monthly" means.
 */
export interface ImportCadenceOption {
  /** The form value. '' is the household default, exactly as ownerField's '' is Joint. */
  value: string;
  /** What the column stores. null = household default; 0 = never remind. */
  weeks: number | null;
  label: string;
}

export const IMPORT_CADENCE_OPTIONS: readonly ImportCadenceOption[] = [
  { value: '', weeks: null, label: 'Household default' },
  { value: '2', weeks: 2, label: 'Weekly' },
  { value: '3', weeks: 3, label: 'Every two weeks' },
  { value: '5', weeks: 5, label: 'Monthly' },
  { value: '53', weeks: 53, label: 'Yearly' },
  { value: '0', weeks: 0, label: 'Never remind me' },
];

/**
 * undefined = not a value at all. null and 0 are both real answers.
 *
 * Any small non-negative integer is accepted, not only the offered six: a value written by SQL or
 * by another build must survive a save aimed at the account's name, the same way a dormant mapping
 * pin does (accounts-manager.tsx). The select constrains what is OFFERED; the column accepts what
 * it already holds.
 */
export function cadenceWeeksFromForm(value: string): number | null | undefined {
  if (value === '') return null;
  if (!/^\d{1,3}$/.test(value)) return undefined;
  return Number(value);
}

export function cadenceFormValue(weeks: number | null): string {
  return weeks === null ? '' : String(weeks);
}

export function cadenceLabel(weeks: number | null): string {
  const option = IMPORT_CADENCE_OPTIONS.find((candidate) => candidate.weeks === weeks);
  return option === undefined ? `Every ${weeks} weeks` : option.label;
}

/** The accounts page's subtitle word, or null when the account rides the household default. */
export function cadenceSubtitle(weeks: number | null): string | null {
  if (weeks === null) return null;
  if (weeks === 0) return 'no import reminders';
  return `imported ${cadenceLabel(weeks).toLowerCase()}`;
}

/**
 * THE ONE RULE, and the only place the fallback is spelled. 0 comes back as 0: the caller treats it
 * as "never" and excludes the account rather than comparing against it.
 */
export function staleThresholdWeeks(accountWeeks: number | null, householdWeeks: number): number {
  return accountWeeks === null ? householdWeeks : accountWeeks;
}
