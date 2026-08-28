import { z } from 'zod';

export type AmountMode = 'signed' | 'debit_credit';
export type SignConvention = 'negative_is_spend' | 'positive_is_spend';
export type EncodingChoice = 'auto' | 'utf-8' | 'windows-1252';

/**
 * v1.13.0 (Task 9): an OFX/QFX file (src/lib/import/ofx.ts) has no ImportMapping at all — the
 * format names its own fields, so commitStagedImport passes `mapping: null` for one rather than
 * inventing a mapping to describe it.
 */
export interface ImportMapping {
  hasHeader: boolean;
  /** Number of leading lines to discard (usually 1 when hasHeader). */
  headerRows: number;
  /** 0-based column index. */
  dateCol: number;
  /** One of DATE_FORMATS in src/lib/dates.ts. */
  dateFormat: string;
  /** 0-based column indexes joined with a single space to form raw_description. */
  descCols: number[];
  amountMode: AmountMode;
  amountCol: number | null;
  debitCol: number | null;
  creditCol: number | null;
  /**
   * Only meaningful when amountMode === 'signed'.
   * In 'debit_credit' mode the debit column is always money out (negative cents)
   * and the credit column is always money in (positive cents).
   */
  signConvention: SignConvention;
  encoding: EncodingChoice;
  /** Rows whose joined raw text contains any of these strings are silently skipped. */
  skipRules: { containsAny: string[] } | null;
  /**
   * 0-based column index holding a per-row cardholder key (a name like "Card Member", or an
   * account-suffix column like "Account #"), for statements covering more than one person.
   * null means "this file has no such column" — the whole import attributes to the account
   * owner, today's behaviour. Added in v1.6.0 (spec 2026-08-22): every mapping JSON stored by
   * v1.5.1 and earlier lacks this key entirely, so it MUST default to null for absent input
   * rather than being required — see the schema's `.nullable().default(null)` below and the
   * back-compat test in mapping.test.ts. A required field here would flip every pre-existing
   * profile (including all four built-in bank presets) to "unreadable mapping"
   * (src/lib/import/presets.ts's ProfileRecord/hasReadableMapping guard, shipped in v1.5.1
   * specifically to survive a bad mapping row) on every existing install's very next boot.
   */
  cardCol: number | null;
  /**
   * 0-based column index holding a per-row RUNNING BALANCE — the account's balance
   * immediately after that row's own transaction, as the bank itself states it (e.g. TD
   * Chequing/Debit's real export carries one at index 4). null means "this file has no such
   * column" — no balance is read for any row, and no balance snapshot is written from this
   * import at all, today's behaviour for every mapping before v1.8.0. Added in v1.8.0 (spec
   * 2026-08-23): every mapping JSON stored by v1.7.0 and earlier lacks this key entirely, so
   * it MUST default to null for absent input rather than being required — see the schema's
   * `.nullable().default(null)` below and the back-compat test in mapping.test.ts. This is the
   * exact same precedent cardCol set in v1.6.0 (see its doc comment above): a required field
   * here would flip every pre-existing profile (including all four built-in bank presets) to
   * "unreadable mapping" (src/lib/import/presets.ts's ProfileRecord/hasReadableMapping guard,
   * shipped in v1.5.1 specifically to survive a bad mapping row) on every existing install's
   * very next boot.
   */
  balanceCol: number | null;
}

const baseSchema = z.object({
  hasHeader: z.boolean(),
  headerRows: z.number().int().min(0).max(20),
  dateCol: z.number().int().min(0).max(200),
  dateFormat: z.string().min(1),
  descCols: z.array(z.number().int().min(0).max(200)).min(1),
  amountMode: z.enum(['signed', 'debit_credit']),
  amountCol: z.number().int().min(0).max(200).nullable(),
  debitCol: z.number().int().min(0).max(200).nullable(),
  creditCol: z.number().int().min(0).max(200).nullable(),
  signConvention: z.enum(['negative_is_spend', 'positive_is_spend']),
  encoding: z.enum(['auto', 'utf-8', 'windows-1252']),
  skipRules: z.object({ containsAny: z.array(z.string().min(1)) }).nullable(),
  // See the ImportMapping.cardCol doc comment above: absent input (every mapping stored by
  // v1.5.1 or earlier) MUST still parse, defaulting to null, not fail as a missing required
  // field.
  cardCol: z.number().int().min(0).max(200).nullable().default(null),
  // See the ImportMapping.balanceCol doc comment above: absent input (every mapping stored by
  // v1.7.0 or earlier) MUST still parse, defaulting to null, not fail as a missing required
  // field — same back-compat shape as cardCol immediately above.
  balanceCol: z.number().int().min(0).max(200).nullable().default(null),
});

export const importMappingSchema = baseSchema.superRefine((value, ctx) => {
  if (value.amountMode === 'signed' && value.amountCol === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amountCol is required when amountMode is "signed"' });
  }
  if (value.amountMode === 'debit_credit' && value.debitCol === null && value.creditCol === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'debitCol or creditCol is required when amountMode is "debit_credit"',
    });
  }
}) as unknown as z.ZodType<ImportMapping>;

export function parseImportMapping(value: unknown): ImportMapping {
  const input = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return importMappingSchema.parse(input);
}

export function serializeImportMapping(mapping: ImportMapping): string {
  return JSON.stringify(importMappingSchema.parse(mapping));
}

/**
 * The single normalization rule for `account_card_people.card_value` (spec 2026-08-22,
 * v1.6.0 Task 3 onward): trim, collapse internal whitespace runs to one space, uppercase.
 * Every reader and writer of that column must go through this — a value read off a row via
 * `mapping.cardCol` (e.g. "ALEX MORGAN", " -1001 ") and a value an admin types into the
 * card->person assignment UI both need to normalize identically, or the same card silently
 * fails to match its own assignment.
 */
export function normalizeCardValue(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}
