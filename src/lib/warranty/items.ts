import fs from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { addRateChange, setLoanAnchor } from '@/lib/loans';
import type { InterestBasis } from '@/lib/loans/interest';
import {
  loanAnchors, users, warrantyItemTypes, warrantyItems, warrantyReceipts } from '@/db/schema';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import { nowIso } from '@/lib/clock';
import { todayIso, isIsoDate } from '@/lib/dates';
import { computeExpiryDate } from '@/lib/warranty/expiry';
import { enqueueOcrJob } from '@/lib/warranty/ocr/queue';
import {
  MAX_RECEIPT_BYTES,
  adoptReceiptFile,
  deleteReceiptFile,
  receiptFileExists,
  sha256Bytes,
} from '@/lib/warranty/receipts';
import { sniffReceiptType, type ReceiptMime } from '@/lib/warranty/sniff';
import { deleteSidecar, deleteStagedOwner, findStagedReceipt, readSidecar, stagedByViewer } from '@/lib/warranty/staging';
import {
  billingAllowedForKind,
  BILLING_CYCLES,
  loanFieldsAllowedForKind,
  LOAN_DIRECTIONS,
  LOAN_DIRECTION_KIND_ERROR,
  type BillingCycle,
  type ItemKind,
  type LoanDirection,
} from '@/lib/warranty/constants';
import { findItemType } from '@/lib/warranty/types';

export const MAX_NAME_CHARS = 200;
export const MAX_TEXT_CHARS = 200;
export const MAX_NOTES_CHARS = 2000;
export const MIN_PURCHASE_DATE = '1970-01-01';

export const LIFETIME_WITH_TERM_ERROR =
  'A lifetime warranty has no length — clear the months or untick Lifetime.';
export const FUTURE_PURCHASE_DATE_ERROR = 'Purchase date cannot be in the future.';
/** v1.3.0 review fix: billing cycle and amount must be set together, or not at all. */
export const BILLING_PAIR_ERROR = 'Enter both a billing cycle and an amount, or neither.';

export interface WarrantyItemRow {
  id: number;
  name: string;
  vendor: string | null;
  model: string | null;
  serial: string | null;
  purchaseDate: string;
  warrantyMonths: number | null;
  isLifetime: boolean;
  expiryDate: string | null;
  priceCents: number | null;
  ownerUserId: number;
  ownerName: string;
  transactionId: number | null;
  /**
   * Delta T6 (spec §19.3): nullable -- NULL means "unclassified", there is no
   * Uncategorised row. typeName/isSubscription come from a LEFT JOIN onto
   * warranty_item_types, so an untyped item still lists normally (typeName null,
   * isSubscription false) instead of disappearing.
   */
  typeId: number | null;
  typeName: string | null;
  isSubscription: boolean;
  /**
   * v1.2.2: warranty / subscription / contract / loan, from the LEFT JOIN onto
   * warranty_item_types. An untyped item (or one whose type predates 0004) normalises to
   * 'warranty', the same default the column itself carries -- never null, matching
   * isSubscription's own null-to-false normalisation just above.
   */
  kind: ItemKind;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * v1.3.0: billing cycle + amount for subscriptions/contracts (§ user request). Always
   * present on a read row (NULL for every warranty/loan item, and for a subscription/
   * contract item that has not set them) -- never omitted, matching every other nullable
   * column above.
   */
  billingCycle: BillingCycle | null;
  billingAmountCents: number | null;
  /**
   * v1.3.1 (spec §11.2). Loan money. Always present on a read row (NULL for every
   * non-loan item), never omitted -- matching every other nullable column above.
   * interestRateBps is basis points (5.49% is 549). Since v1.47.0 it IS calculated with -- but
   * only through `interestRateBasis`, which says how the rate is charged, and only in
   * src/lib/loans/interest.ts (MUST-13.1').
   */
  principalCents: number | null;
  interestRateBps: number | null;
  /**
   * v1.47.0. HOW the rate is charged -- the one thing a bare rate cannot say, and without which
   * nothing may be computed from it (ruling I5). NULL is the value every existing loan carries and
   * means "nobody has told us": no estimate, no split, no change from before the upgrade.
   */
  interestRateBasis: InterestBasis | null;
  /**
   * v1.48.0, ledger spec C1/S3. Optional because the LIST query does not select them -- a row in
   * a list has no use for a posting day or a CSV mapping, and widening that query to carry two
   * columns nothing reads would cost every list render for one form.
   */
  postingDay?: number | null;
  statementCsvColumns?: string | null;
  currentBalanceCents: number | null;
  balanceUpdatedAt: string | null;
  /**
   * v1.13.0 ruling R11 / micro-ruling M9. The read-side link between a bill and a budget
   * category. NULL means "not linked", which is every row before v1.13.0. Set only through
   * setBudgetCategory(), never through WarrantyInput -- see that function's docblock.
   */
  budgetCategoryId: number | null;
  /**
   * v1.14.0 (spec BU, ruling P3). Which way a loan points -- 'owed' (the household owes this,
   * every row before v1.14.0) or 'lent' (owed to the household). Always present, never NULL:
   * every non-loan item carries 'owed' forever, same as the column's own DEFAULT.
   */
  loanDirection: LoanDirection;
}

export interface WarrantyReceiptRow {
  id: number;
  warrantyItemId: number;
  originalFilename: string;
  storedFilename: string;
  mime: ReceiptMime;
  sizeBytes: number;
  sha256: string;
  ocrStatus: 'pending' | 'done' | 'failed';
  ocrError: string | null;
  createdAt: string;
  /** MUST-4.10: a row whose file is absent is a display state, not an error. */
  fileExists: boolean;
}

/** What the client posts back after staging: the id plus the display name it uploaded. */
export interface StagedReceiptRef {
  stagingId: string;
  originalFilename: string;
}

export interface WarrantyInput {
  name: string;
  vendor: string | null;
  model: string | null;
  serial: string | null;
  purchaseDate: string;
  warrantyMonths: number | null;
  isLifetime: boolean;
  priceCents: number | null;
  ownerUserId: number;
  transactionId: number | null;
  /** Delta T6: nullable -- NULL is a legitimate "unclassified" value, not an omission. */
  typeId: number | null;
  notes: string | null;
  /**
   * v1.3.0: optional -- a caller that predates this feature (or a test fixture) simply
   * omits them and gets NULL, same as passing null explicitly. Normalised to null (never
   * left undefined) before either reaches the database; see createWarrantyItem/
   * updateWarrantyItem.
   */
  billingCycle?: BillingCycle | null;
  billingAmountCents?: number | null;
  /**
   * v1.3.1: optional, same normalise-to-null-before-either-writer treatment as the billing
   * pair above.
   */
  principalCents?: number | null;
  interestRateBps?: number | null;
  /**
   * v1.47.0. HOW the rate is charged -- the one thing a bare rate cannot say, and without which
   * nothing may be computed from it (ruling I5). Omitted or NULL is what every existing loan
   * carries and means "nobody has told us": no estimate, no split, no change from before.
   */
  interestRateBasis?: InterestBasis | null;
  currentBalanceCents?: number | null;
  balanceUpdatedAt?: string | null;
  /**
   * v1.48.0, ledger spec D3. The date the balance above is true AS OF -- the loan's first
   * statement, in effect. Omitted means the borrowed date, which is right whenever the balance
   * typed in is the original amount, and that is the common case on a new loan.
   */
  balanceAsOfDate?: string | null;
  /** v1.48.0, ledger spec C1. The day of the month interest posts. NULL: the borrowed date's day. */
  postingDay?: number | null;
  /**
   * v1.48.0, ruling R2. WHEN a changed rate starts applying. Omitted means today, so a correction
   * typed in now does not silently restate what a closed period was charged.
   */
  rateEffectiveFrom?: string | null;
  /** v1.48.0, ruling S3. The confirmed CSV column mapping for this lender's statements. */
  statementCsvColumns?: string | null;
  /**
   * v1.48.0. Which path is writing this loan's first statement. Defaults to 'form', the item form;
   * createLoanFromTransaction says 'first-entry', because a loan born from a transaction was never
   * typed into a form at all and its opening figure is dated the day before that transaction.
   */
  balanceAnchorSource?: 'form' | 'first-entry';
  /**
   * v1.14.0: optional -- omitted defaults to 'owed', same as every pre-v1.14.0 caller and
   * every non-loan item. Whether 'lent' is ALLOWED for this item's kind needs a DB lookup
   * (assertLoanDirectionMatchesKind, below) and so cannot live in this shape alone.
   */
  loanDirection?: LoanDirection;
}

/**
 * M5: strip characters that would be unsafe in a future Content-Disposition header or as a
 * plain display string -- forward slash, backslash, double quote, and every control
 * character (built from a numeric code-point comparison against plain hex integers, not a
 * regex escape literal, for the same corruption-avoidance reason documented next to
 * search.ts's isControlCodePoint) -- before the 255-char display cap. originalFilename is
 * ALWAYS display-only: storedFilename (a fresh randomUUID) is the only name ever touched by
 * the filesystem, regardless of what this function produces.
 */
function sanitizeOriginalFilename(name: string): string {
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f || code === 0x7f;
    const isUnsafePunctuation = ch === '/' || ch === '\\' || ch === '"';
    if (!isControl && !isUnsafePunctuation) out += ch;
  }
  return out;
}

/** Blank optional text is stored as NULL, never as an empty string. */
function optionalText(max: number) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? null : value),
    z.string().trim().max(max).nullable(),
  );
}

/**
 * MUST-13.7: zod on every action input. `today` is injected (never read from a clock in
 * here) so the future-date rule is deterministic in tests and honours TZ at the boundary.
 */
export function warrantyInputSchema(today: string) {
  return z
    .object({
      name: z.string().trim().min(1, 'Name is required').max(MAX_NAME_CHARS),
      vendor: optionalText(MAX_TEXT_CHARS),
      model: optionalText(MAX_TEXT_CHARS),
      // §17.25: serial is stored but deliberately NOT unique and NOT validated. An OCR
      // mis-read and a blank must both be storable.
      serial: optionalText(MAX_TEXT_CHARS),
      purchaseDate: z
        .string()
        .refine(isIsoDate, 'Purchase date must be YYYY-MM-DD')
        .refine((value) => value <= today, FUTURE_PURCHASE_DATE_ERROR)
        .refine((value) => value >= MIN_PURCHASE_DATE, 'Purchase date is before 1970-01-01'),
      // v1.2.2: kind-agnostic wording -- same reasoning as readMonths() in actions.ts. Old
      // text was 'Warranty length must be at least one month.' -- wrong once a
      // Contract/Loan's form legend says 'Term (months)'.
      warrantyMonths: z.number().int().positive('The term must be at least one month').nullable(),
      isLifetime: z.boolean(),
      priceCents: z.number().int('Price must be a whole number of cents').nonnegative().nullable(),
      ownerUserId: z.number().int().positive(),
      transactionId: z.number().int().positive().nullable(),
      // Delta T6: nullable is a legitimate value ("unclassified") -- there is no
      // Uncategorised row to fall back to, so null must parse, not just be omitted.
      typeId: z.number().int().positive().nullable(),
      notes: optionalText(MAX_NOTES_CHARS),
      // v1.3.0: shape-only here (a real string enum value, or null/omitted). Whether billing
      // is even ALLOWED for this item's kind is a separate check in createWarrantyItem/
      // updateWarrantyItem, below -- that requires a DB lookup of the type's kind, which has
      // no place inside a synchronous shape schema like this one.
      billingCycle: z
        .enum(BILLING_CYCLES, { errorMap: () => ({ message: 'Billing must be Monthly or Annual.' }) })
        .nullable()
        .optional(),
      // Shape only, exactly like billingCycle above: whether 'lent' is ALLOWED for this item's
      // kind needs a DB lookup and therefore lives in the writers, not in a synchronous schema.
      loanDirection: z.enum(LOAN_DIRECTIONS).default('owed'),
      // review fix: 0 is a legal amount (a free subscription) -- `.nonnegative()` accepts it,
      // so the message must not claim the rule is stricter than that.
      billingAmountCents: z
        .number()
        .int('The amount must be a whole number of cents')
        .nonnegative("The amount can't be negative.")
        .nullable()
        .optional(),
      principalCents: z
        .number()
        .int('The original amount must be a whole number of cents')
        .nonnegative()
        .nullable()
        .optional(),
      // MUST-14.4: 0-10000%, range-checked in zod as well as in SQL.
      interestRateBps: z.number().int().min(0).max(1_000_000, 'That rate is out of range.').nullable().optional(),
      interestRateBasis: z
        .enum(['none', 'apr_monthly', 'apr_semiannual', 'per_month', 'simple_on_principal', 'apr_daily'])
        .nullable()
        .optional(),
      currentBalanceCents: z
        .number()
        .int('The balance must be a whole number of cents')
        .nonnegative()
        .nullable()
        .optional(),
      balanceUpdatedAt: z.string().min(1).nullable().optional(),
      // v1.48.0, ledger spec D3/C1/R2. Shape only; the actions layer has already refused anything
      // malformed with a message a person can act on, and the writers hold the cross-field rules.
      balanceAsOfDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the as-of date as YYYY-MM-DD.')
        .nullable()
        .optional(),
      postingDay: z.number().int().min(1).max(31, 'The posting day must be a day of the month.').nullable().optional(),
      rateEffectiveFrom: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the effective-from date as YYYY-MM-DD.')
        .nullable()
        .optional(),
      statementCsvColumns: z.string().nullable().optional(),
    })
    .superRefine((value, ctx) => {
      // MUST-3.5, enforced by zod at the action boundary AND by a CHECK in 0002.
      if (value.isLifetime && value.warrantyMonths !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['warrantyMonths'], message: LIFETIME_WITH_TERM_ERROR });
      }
      // review fix: cycle and amount are a pair -- neither surface (detail, list) can render
      // one alone without either lying (a blank placeholder next to "/ month") or silently dropping the other value the
      // member actually entered. Both null/omitted (no billing at all) is fine; both set is
      // fine; exactly one set is rejected.
      const cycleSet = value.billingCycle !== null && value.billingCycle !== undefined;
      const amountSet = value.billingAmountCents !== null && value.billingAmountCents !== undefined;
      if (cycleSet !== amountSet) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['billingCycle'], message: BILLING_PAIR_ERROR });
      }
      // MUST-11.7, at the schema boundary as well as in the writers.
      const balanceSet = value.currentBalanceCents !== null && value.currentBalanceCents !== undefined;
      const anchorSet = value.balanceUpdatedAt !== null && value.balanceUpdatedAt !== undefined;
      if (balanceSet !== anchorSet) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['currentBalanceCents'], message: BALANCE_ANCHOR_ERROR });
      }
    });
}

const ITEM_COLUMNS = {
  id: warrantyItems.id,
  name: warrantyItems.name,
  vendor: warrantyItems.vendor,
  model: warrantyItems.model,
  serial: warrantyItems.serial,
  purchaseDate: warrantyItems.purchaseDate,
  warrantyMonths: warrantyItems.warrantyMonths,
  isLifetime: warrantyItems.isLifetime,
  expiryDate: warrantyItems.expiryDate,
  priceCents: warrantyItems.priceCents,
  ownerUserId: warrantyItems.ownerUserId,
  ownerName: users.name,
  transactionId: warrantyItems.transactionId,
  typeId: warrantyItems.typeId,
  typeName: warrantyItemTypes.name,
  isSubscription: warrantyItemTypes.isSubscription,
  kind: warrantyItemTypes.kind,
  notes: warrantyItems.notes,
  createdAt: warrantyItems.createdAt,
  updatedAt: warrantyItems.updatedAt,
  billingCycle: warrantyItems.billingCycle,
  billingAmountCents: warrantyItems.billingAmountCents,
  principalCents: warrantyItems.principalCents,
  interestRateBps: warrantyItems.interestRateBps,
  interestRateBasis: warrantyItems.interestRateBasis,
  postingDay: warrantyItems.postingDay,
  statementCsvColumns: warrantyItems.statementCsvColumns,
  currentBalanceCents: warrantyItems.currentBalanceCents,
  balanceUpdatedAt: warrantyItems.balanceUpdatedAt,
  budgetCategoryId: warrantyItems.budgetCategoryId,
  loanDirection: warrantyItems.loanDirection,
};

/**
 * Delta T6: the LEFT JOIN onto warrantyItemTypes means isSubscription comes back `null`
 * for an untyped item (no matching type row) rather than `false` -- normalise it here so
 * every caller sees a plain boolean, never a three-state value. v1.2.2: `kind` gets the same
 * treatment, normalising to 'warranty' instead of null.
 */
function toItemRow<T extends { isSubscription: boolean | null; kind: ItemKind | null }>(
  row: T,
): Omit<T, 'isSubscription' | 'kind'> & { isSubscription: boolean; kind: ItemKind } {
  return { ...row, isSubscription: row.isSubscription ?? false, kind: row.kind ?? 'warranty' };
}

/** MUST-12.2: reworded, because a loan may now carry a billing pair. */
export const BILLING_KIND_ERROR = 'Billing details only apply to subscriptions, contracts and loans.';
export const LOAN_KIND_ERROR = 'Loan amounts only apply to loans.';
/** MUST-11.7: the cross-column rule that deliberately has no SQL representation. */
export const BALANCE_ANCHOR_ERROR = 'A balance and the date it was set must both be present, or both absent.';

/** typeId null (unclassified) normalises to 'warranty', same as toItemRow()'s own read-side default. */
function kindForTypeId(typeId: number | null): ItemKind {
  if (typeId === null) return 'warranty';
  return findItemType(typeId)?.kind ?? 'warranty';
}

/**
 * v1.3.0: server-side enforcement that billing_cycle/billing_amount_cents are NULL for
 * every warranty item -- mirrors how typeExistsOrNull() in actions.ts already looks up
 * the type before trusting a write, except this lookup has to happen in the data layer
 * itself (not just the 'use server' action) so createWarrantyItem/updateWarrantyItem stay
 * correct for every caller, not only the ones that route through actions.ts.
 */
function assertBillingMatchesKind(
  typeId: number | null,
  billingCycle: BillingCycle | null,
  billingAmountCents: number | null,
): void {
  if (billingCycle === null && billingAmountCents === null) return;
  if (!billingAllowedForKind(kindForTypeId(typeId))) throw new Error(BILLING_KIND_ERROR);
}

/** Loan-only money, by the same app-layer argument billing already lives under. */
function assertLoanFieldsMatchKind(
  typeId: number | null,
  values: {
    principalCents: number | null;
    interestRateBps: number | null;
    currentBalanceCents: number | null;
    balanceUpdatedAt: string | null;
    interestRateBasis: InterestBasis | null;
  },
): void {
  const empty =
    values.principalCents === null &&
    values.interestRateBps === null &&
    values.currentBalanceCents === null &&
    values.balanceUpdatedAt === null &&
    values.interestRateBasis === null;
  if (empty) return;
  if (!loanFieldsAllowedForKind(kindForTypeId(typeId))) throw new Error(LOAN_KIND_ERROR);
}

/**
 * Ruling I6: the cross-column rules the basis brings with it.
 *
 * These are app-layer for the reason 0007 already gave about the other loan columns -- SQLite
 * cannot add a CHECK to an existing table and have it re-validate the rows already in it. The SQL
 * CHECK on the column itself only says the value is one of the six.
 *
 * Each rule exists because breaking it would make the app compute something it cannot mean: a
 * basis with no rate has nothing to multiply; an interest-free loan carrying a rate is two
 * contradictory claims; and charging on the original amount needs an original amount to charge on.
 */
function assertInterestBasisIsUsable(values: {
  interestRateBasis: InterestBasis | null;
  interestRateBps: number | null;
  principalCents: number | null;
}): void {
  const basis = values.interestRateBasis;
  if (basis === null) {
    /*
      D1, reversing ruling I5's "no default". A rate with no period cannot be multiplied, and a
      rate nothing is computed from is a number a household typed for no reason -- a loan could
      show 10% and no interest at all, which is exactly the state this release exists to fix. So
      the form now insists, and the select defaults to a yearly rate charged monthly.

      Zero is still allowed without one, because a zero rate says there is nothing to charge --
      which is what an interest-free loan is, and what the 'none' basis records deliberately.
    */
    if ((values.interestRateBps ?? 0) !== 0) {
      throw new Error('Say how the rate is charged. A rate on its own cannot be turned into interest.');
    }
    return;
  }

  if (basis === 'none') {
    if ((values.interestRateBps ?? 0) !== 0) {
      throw new Error('An interest-free loan cannot also carry an interest rate. Clear the rate, or choose how it is charged.');
    }
    return;
  }
  if (values.interestRateBps === null) {
    throw new Error('Saying how a rate is charged needs an interest rate to charge.');
  }
  if (basis === 'simple_on_principal' && values.principalCents === null) {
    throw new Error('A rate charged on the original amount needs that original amount recorded.');
  }
}

/**
 * Ruling P3. 'owed' is the value every non-loan row carries forever, so only 'lent' is a
 * cross-table claim worth refusing. Deliberately NOT folded into assertLoanFieldsMatchKind:
 * that one asks "are all four money columns absent?", and direction is never absent.
 */
function assertLoanDirectionMatchesKind(typeId: number | null, direction: LoanDirection): void {
  if (direction === 'owed') return;
  if (!loanFieldsAllowedForKind(kindForTypeId(typeId))) throw new Error(LOAN_DIRECTION_KIND_ERROR);
}

/**
 * MUST-11.7: current_balance_cents and balance_updated_at are both set or both NULL. This
 * is a CROSS-COLUMN invariant, and 0007 deliberately does not express it as a SQL CHECK:
 * ALTER TABLE ADD COLUMN does not re-validate existing rows against a CHECK added that way,
 * so the constraint would be weaker than it looks while being riskier to add. It is enforced
 * here, beside assertBillingMatchesKind, by the same argument that migration's header makes.
 */
function assertBalanceAnchorPairing(currentBalanceCents: number | null, balanceUpdatedAt: string | null): void {
  if ((currentBalanceCents === null) !== (balanceUpdatedAt === null)) throw new Error(BALANCE_ANCHOR_ERROR);
}

/**
 * v1.13.0 ruling R2/R3: `viewer` is REQUIRED, and null for another owner id. That null is what turns
 * src/app/(app)/warranties/[id]/page.tsx into a notFound() with no extra branch on the page -- the
 * review's confirmed-exploitable finding (SEC-1) closes here, in the query, rather than in a check a
 * future page could forget to copy.
 */
export function getWarrantyItem(id: number, viewer: Viewer): WarrantyItemRow | null {
  const scope = ownerScope(viewer);
  const where = scope === null
    ? eq(warrantyItems.id, id)
    : and(eq(warrantyItems.id, id), eq(warrantyItems.ownerUserId, scope));
  const row = getDb()
    .select(ITEM_COLUMNS)
    .from(warrantyItems)
    .innerJoin(users, eq(users.id, warrantyItems.ownerUserId))
    // LEFT, not INNER: a typeId of null (or a type that got deleted, though that path is
    // blocked at the app layer) must not make the item itself disappear (spec §19.3).
    .leftJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(where)
    .get();
  return row ? toItemRow(row) : null;
}

/**
 * v1.13.0 ruling R11 / micro-ruling M9. The read-side link between a bill and a budget category.
 * Deliberately its own tiny writer rather than a field on updateWarrantyItem: it changes no limit, no
 * rollover and no total, and folding it into the big item update would invite a future reader to
 * think it does.
 */
export function setBudgetCategory(itemId: number, categoryId: number | null): void {
  getDb()
    .update(warrantyItems)
    .set({ budgetCategoryId: categoryId, updatedAt: nowIso() })
    .where(eq(warrantyItems.id, itemId))
    .run();
}

/**
 * MUST-6.8: one DB transaction per item. The row and every staged receipt land together
 * or not at all. Files are moved inside it; a throw unlinks whatever was already adopted.
 */
export function createWarrantyItem(
  input: WarrantyInput,
  staged: StagedReceiptRef[] = [],
  at: string = nowIso(),
  claimedBy?: number,
): number {
  // v1.3.0: checked BEFORE the transaction even opens -- a mismatch here writes nothing,
  // exactly like typeExistsOrNull's early return in actions.ts.
  const billingCycle = input.billingCycle ?? null;
  const billingAmountCents = input.billingAmountCents ?? null;
  const principalCents = input.principalCents ?? null;
  const interestRateBps = input.interestRateBps ?? null;
  const postingDay = input.postingDay ?? null;
  const currentBalanceCents = input.currentBalanceCents ?? null;
  /*
    v1.48.0, D3/D5. A balance now arrives with an AS-OF DATE rather than a timestamp, so the
    MUST-11.8 anchor stamp is derived from it when the caller did not supply one. It keeps its old
    meaning -- "when did a person last tell us the truth about this balance" -- but it is no longer
    the moment the form was submitted, which is what made an evening save in one timezone print
    tomorrow's date on the loan page.
  */
  const balanceUpdatedAt =
    input.balanceUpdatedAt !== undefined
      ? input.balanceUpdatedAt
      : currentBalanceCents === null
        ? null
        : `${input.balanceAsOfDate ?? input.purchaseDate}T00:00:00.000Z`;
  const interestRateBasis = input.interestRateBasis ?? null;
  const loanDirection = input.loanDirection ?? 'owed';
  assertBillingMatchesKind(input.typeId, billingCycle, billingAmountCents);
  assertLoanFieldsMatchKind(input.typeId, { principalCents, interestRateBps, currentBalanceCents, balanceUpdatedAt, interestRateBasis });
  assertBalanceAnchorPairing(currentBalanceCents, balanceUpdatedAt);
  assertLoanDirectionMatchesKind(input.typeId, loanDirection);
  assertInterestBasisIsUsable({ interestRateBasis, interestRateBps, principalCents });

  const db = getDb();
  const expiryDate = computeExpiryDate(input);
  // Ruling P9: tracked DURING the adoption loop (append as each rename succeeds inside
  // commitStaged), not reconstructed after the fact -- so a mid-transaction throw only
  // unlinks files that were actually renamed onto disk, never ones that were skipped.
  const adopted: string[] = [];
  // IMPORTANT 3: side effects that must NOT run while the write transaction below is still
  // open -- see commitStaged's docblock. Flushed only once db.transaction() has returned
  // successfully; abandoned untouched (never run) if it throws.
  const deferred: Array<() => void> = [];
  try {
    const id = db.transaction((tx) => {
      const row = tx
        .insert(warrantyItems)
        // billingCycle/billingAmountCents/the four loan fields override input's own (possibly
        // undefined) values with the normalised-to-null values computed above -- undefined
        // would otherwise reach better-sqlite3's bind step for an omitted column.
        .values({
          ...input,
          billingCycle,
          billingAmountCents,
          principalCents,
          interestRateBps,
          currentBalanceCents,
          balanceUpdatedAt,
          loanDirection,
          postingDay,
          expiryDate,
          createdAt: at,
          updatedAt: at,
        })
        .returning({ id: warrantyItems.id })
        .get();
      commitStaged(tx, row.id, staged, at, adopted, deferred, claimedBy);
      return row.id;
    });
    for (const effect of deferred) effect();
    /*
      D3. The loan's FIRST statement, written here and nowhere else.

      v1.47.0 declared a 'form' anchor source and never used it, so a loan created through this
      form had no confirmed figure at all -- and the interest engine, which starts from one, had
      nothing to start from. A loan could carry a rate AND a basis and still show no interest.

      After the transaction, not inside it: setLoanAnchor and addRateChange each open their own,
      and addRateChange goes on to post every period that has already closed -- which is what puts
      two months of interest on the page the moment a loan borrowed in July is saved in September.
    */
    seedLoanLedger(id, input, { currentBalanceCents, interestRateBps, interestRateBasis, postingDay }, at);
    return id;
  } catch (error) {
    // MUST-4.7: if the insert throws, every file this call adopted is unlinked. `deferred`
    // is simply left unflushed here: the transaction rolled back, so the receipt rows this
    // loop inserted no longer exist, and their sidecars/OCR jobs must stay exactly as they
    // were before this call ever ran.
    for (const name of adopted) deleteReceiptFile(name);
    throw error;
  }
}

/** MUST-3.6: any write that touches purchase_date, months or lifetime recomputes expiry. */
export function updateWarrantyItem(id: number, input: WarrantyInput, at: string = nowIso()): boolean {
  // v1.3.0: same kind check as createWarrantyItem, run before the write.
  const billingCycle = input.billingCycle ?? null;
  const billingAmountCents = input.billingAmountCents ?? null;
  const principalCents = input.principalCents ?? null;
  const interestRateBps = input.interestRateBps ?? null;
  const postingDay = input.postingDay ?? null;
  const currentBalanceCents = input.currentBalanceCents ?? null;
  /*
    v1.48.0, D3/D5. A balance now arrives with an AS-OF DATE rather than a timestamp, so the
    MUST-11.8 anchor stamp is derived from it when the caller did not supply one. It keeps its old
    meaning -- "when did a person last tell us the truth about this balance" -- but it is no longer
    the moment the form was submitted, which is what made an evening save in one timezone print
    tomorrow's date on the loan page.
  */
  const balanceUpdatedAt =
    input.balanceUpdatedAt !== undefined
      ? input.balanceUpdatedAt
      : currentBalanceCents === null
        ? null
        : `${input.balanceAsOfDate ?? input.purchaseDate}T00:00:00.000Z`;
  const interestRateBasis = input.interestRateBasis ?? null;
  const loanDirection = input.loanDirection ?? 'owed';
  assertBillingMatchesKind(input.typeId, billingCycle, billingAmountCents);
  assertLoanFieldsMatchKind(input.typeId, { principalCents, interestRateBps, currentBalanceCents, balanceUpdatedAt, interestRateBasis });
  assertBalanceAnchorPairing(currentBalanceCents, balanceUpdatedAt);
  assertLoanDirectionMatchesKind(input.typeId, loanDirection);
  assertInterestBasisIsUsable({ interestRateBasis, interestRateBps, principalCents });

  /*
    D4, REVERSED from the ledger spec, and the tests are why.

    The spec said the balance field should go read-only once a loan has a statement, so that
    Reconcile became the only way to move it. That would have removed something the app already
    documents and pins: editing a loan and typing a new balance writes a fresh anchor, and fix-wave
    item 4 went to some trouble to make "untouched" mean untouched. The reason given for the clamp
    was "two paths to one number is how they disagree" -- but the edit path is not an uncontrolled
    second path once it writes an anchor of its own, which is what it does below.

    So the field stays editable, and a balance typed here becomes a statement like any other.
  */
  const existing = getDb()
    .select({
      balance: warrantyItems.currentBalanceCents,
      balanceUpdatedAt: warrantyItems.balanceUpdatedAt,
      rateBps: warrantyItems.interestRateBps,
      basis: warrantyItems.interestRateBasis,
    })
    .from(warrantyItems)
    .where(eq(warrantyItems.id, id))
    .get();
  const result = getDb()
    .update(warrantyItems)
    .set({
      ...input,
      billingCycle,
      billingAmountCents,
      principalCents,
      interestRateBps,
      interestRateBasis,
      currentBalanceCents,
      balanceUpdatedAt,
      loanDirection,
      postingDay,
      expiryDate: computeExpiryDate(input),
      updatedAt: at,
    })
    .where(eq(warrantyItems.id, id))
    .run();

  /*
    R2. A rate that MOVED gets a history row, dated from when it started applying -- today unless
    the form said otherwise. A closed period keeps the rate it was charged at, so correcting a typo
    in September never restates July, and a variable-rate mortgage is representable without a
    second table.
  */
  /*
    A6. THE STATEMENT FIRST, then the rate.

    addRateChange ends by posting every closed period, so running it before the anchor existed
    posted them against the OLD statement at the NEW rate -- and the correction that followed then
    had to undo work that should never have happened. Writing the balance's statement first means
    the rate change posts against the figure a person just confirmed.
  */
  if (
    result.changes > 0 &&
    currentBalanceCents !== null &&
    existing !== undefined &&
    existing.balance !== currentBalanceCents
  ) {
    try {
      setLoanAnchor({
        itemId: id,
        asOfDate: input.balanceAsOfDate ?? todayIso(new Date(at)),
        balanceCents: currentBalanceCents,
        source: 'form',
        actorUserId: null,
        at: new Date(at),
      });
    } catch (error) {
      console.error('[loans] could not record the edited balance as a statement for item ' + id, error);
    }
  }

  if (
    result.changes > 0 &&
    interestRateBasis !== null &&
    interestRateBps !== null &&
    existing !== undefined &&
    (existing.rateBps !== interestRateBps || existing.basis !== interestRateBasis)
  ) {
    addRateChange({
      itemId: id,
      effectiveFrom: input.rateEffectiveFrom ?? todayIso(new Date(at)),
      rateBps: interestRateBps,
      basis: interestRateBasis,
      actorUserId: null,
      at: new Date(at),
    });
  }

  return result.changes > 0;
}

/**
 * D3. A new loan's first statement and its first rate, written once, after the item exists.
 *
 * Nothing happens for an item with no balance -- there is no figure to confirm -- or for anything
 * that is not a loan, which is why the balance is the test rather than the type: a warranty carries
 * no balance at all.
 */
function seedLoanLedger(
  itemId: number,
  input: WarrantyInput,
  normalised: {
    currentBalanceCents: number | null;
    interestRateBps: number | null;
    interestRateBasis: InterestBasis | null;
    postingDay: number | null;
  },
  at: string,
): void {
  if (normalised.currentBalanceCents === null) return;
  // The borrowed date whenever the balance is simply the amount borrowed, which is the usual case
  // on a new loan; an as-of date when a household is entering a loan part-way through.
  const asOfDate = input.balanceAsOfDate ?? input.purchaseDate;
  /*
    Same bound as the reconcile form: a balance cannot be true as of a day that has not happened.

    The later of the two readings of "today" -- the household's local day, and the day the caller's
    own timestamp names. A caller that stamps midnight UTC is on the previous local day west of
    Greenwich, and refusing its own date would be an off-by-one about timezones rather than the
    mistyped year this exists to catch.
  */
  const latestAllowed = [todayIso(new Date(at)), at.slice(0, 10)].sort().at(-1)!;
  if (asOfDate > latestAllowed) {
    throw new Error('The date a balance is true as of cannot be after today.');
  }
  try {
    /*
      THE RATE FIRST, then the statement. Both of them post what is due, and the anchor is what
      lets a posting happen at all -- so writing the anchor first would post the whole catch-up
      with no rate in force and charge nothing for it. Those zero rows are already-closed periods,
      so nothing would ever go back and correct them.
    */
    if (normalised.interestRateBasis !== null && normalised.interestRateBps !== null) {
      addRateChange({
        itemId,
        effectiveFrom: asOfDate,
        rateBps: normalised.interestRateBps,
        basis: normalised.interestRateBasis,
        actorUserId: null,
        at: new Date(at),
      });
    }
    setLoanAnchor({
      itemId,
      asOfDate,
      balanceCents: normalised.currentBalanceCents,
      source: input.balanceAnchorSource ?? 'form',
      actorUserId: null,
      rateBps: normalised.interestRateBps,
      basis: normalised.interestRateBasis,
      at: new Date(at),
    });
  } catch (error) {
    // A loan that exists with no opening statement is recoverable -- a reconcile fixes it. Losing
    // the loan because its ledger could not be seeded is not.
    console.error('[loans] could not seed the opening statement for item ' + itemId, error);
  }
}

/**
 * MUST-4.8 delete order: rows first (inside the transaction, so the FTS triggers fire),
 * then the files, best effort.
 */
export function deleteWarrantyItem(id: number): boolean {
  const db = getDb();
  const stored = db
    .select({ storedFilename: warrantyReceipts.storedFilename })
    .from(warrantyReceipts)
    .where(eq(warrantyReceipts.warrantyItemId, id))
    .all()
    .map((row) => row.storedFilename);

  // warranty_receipts rows cascade with the item (ON DELETE CASCADE in 0002).
  const result = db.delete(warrantyItems).where(eq(warrantyItems.id, id)).run();
  if (result.changes === 0) return false;
  for (const name of stored) deleteReceiptFile(name);
  return true;
}

function toReceiptRow(row: {
  id: number;
  warrantyItemId: number;
  originalFilename: string;
  storedFilename: string;
  mime: ReceiptMime;
  sizeBytes: number;
  sha256: string;
  ocrStatus: 'pending' | 'done' | 'failed';
  ocrError: string | null;
  createdAt: string;
}): WarrantyReceiptRow {
  return { ...row, fileExists: receiptFileExists(row.storedFilename) };
}

const RECEIPT_COLUMNS = {
  id: warrantyReceipts.id,
  warrantyItemId: warrantyReceipts.warrantyItemId,
  originalFilename: warrantyReceipts.originalFilename,
  storedFilename: warrantyReceipts.storedFilename,
  mime: warrantyReceipts.mime,
  sizeBytes: warrantyReceipts.sizeBytes,
  sha256: warrantyReceipts.sha256,
  ocrStatus: warrantyReceipts.ocrStatus,
  ocrError: warrantyReceipts.ocrError,
  createdAt: warrantyReceipts.createdAt,
};

export function listWarrantyReceipts(itemId: number): WarrantyReceiptRow[] {
  return getDb()
    .select(RECEIPT_COLUMNS)
    .from(warrantyReceipts)
    .where(eq(warrantyReceipts.warrantyItemId, itemId))
    .orderBy(warrantyReceipts.id)
    .all()
    .map(toReceiptRow);
}

export function getWarrantyReceipt(id: number): WarrantyReceiptRow | null {
  const row = getDb().select(RECEIPT_COLUMNS).from(warrantyReceipts).where(eq(warrantyReceipts.id, id)).get();
  return row ? toReceiptRow(row) : null;
}

export function attachStagedReceipts(
  itemId: number,
  staged: StagedReceiptRef[],
  at: string = nowIso(),
  claimedBy?: number,
): number[] {
  const db = getDb();
  // Ruling P9: same during-the-loop tracking as createWarrantyItem's adoption pass.
  const adopted: string[] = [];
  // IMPORTANT 3: same deferred-until-committed pattern as createWarrantyItem.
  const deferred: Array<() => void> = [];
  try {
    const receiptIds = db.transaction((tx) => commitStaged(tx, itemId, staged, at, adopted, deferred, claimedBy).receiptIds);
    for (const effect of deferred) effect();
    return receiptIds;
  } catch (error) {
    for (const name of adopted) deleteReceiptFile(name);
    throw error;
  }
}

/**
 * MUST-6.8, per staging id: re-validate the file still exists, is still a sane size, AND
 * still sniffs to an accepted type, rename it into receipts/ under a fresh stored_filename,
 * insert the row with the sidecar's text/status when present (otherwise 'pending', for the
 * sweep to pick up), then queue the sidecar for deletion and (if there was no sidecar) an
 * OCR job. The staging id is NEVER trusted as a path. findStagedReceipt applies the UUID
 * guard.
 *
 * Ruling P9: `adopted` is the caller's own tracking array, pushed to IMMEDIATELY after each
 * successful rename (i.e. during the loop, not reconstructed from the return value after
 * the fact) so a throw partway through this loop -- e.g. the INSERT below violating a CHECK
 * constraint -- still lets the caller's catch block unlink exactly the files that made it to
 * disk before the throw, not zero of them and not files that were only ever skipped.
 *
 * IMPORTANT 3: `deferred` is likewise the caller's own array, and for the same reason --
 * deleteSidecar and enqueueOcrJob must NOT run while `tx`'s write transaction is still open.
 * A later staged ref in this very loop can still throw (a CHECK violation, a forced test
 * failure, anything), which rolls the whole transaction back INCLUDING this receipt's row --
 * at that point its sidecar must still exist on disk and no OCR job should ever have been
 * queued for a receipt that, from the database's point of view, was never created.
 * enqueueOcrJob is doubly unsafe to call synchronously from inside the transaction beyond
 * that: it immediately kicks off runReceiptJob in the background, which itself
 * SELECTs/UPDATEs warranty_receipts -- reentering the database while this same call stack's
 * write transaction is still open. The caller flushes `deferred` only after db.transaction()
 * has returned successfully, and abandons it untouched if db.transaction() throws.
 */
function commitStaged(
  tx: ReturnType<typeof getDb>,
  itemId: number,
  staged: StagedReceiptRef[],
  at: string,
  adopted: string[],
  deferred: Array<() => void>,
  claimedBy?: number,
): { receiptIds: number[] } {
  const receiptIds: number[] = [];

  for (const ref of staged) {
    /*
      D7, the other half. The poll endpoint now refuses a staging id its caller did not stage, and
      so does this: a save that names somebody else's staged upload attaches nothing, silently,
      exactly as a purged one does. Skipping rather than throwing is this loop's existing
      convention -- one unusable receipt never fails a member's whole save.

      claimedBy is optional because the two library-level callers that have no session behind them
      (the loan created from a transaction) stage nothing.
    */
    if (claimedBy !== undefined && !stagedByViewer(ref.stagingId, claimedBy)) continue;

    const found = findStagedReceipt(ref.stagingId);
    // Purged by the 24 h sweep, or lost to a restart. Skip it; the save still succeeds.
    if (found === null) continue;
    const buf = fs.readFileSync(found.path);
    // M4: re-validate size at commit time too, not just at upload -- a staged file can sit
    // around for a while before the member saves. Skip just this one receipt rather than
    // failing the WHOLE item via warranty_receipts' `size_bytes > 0 AND size_bytes <=
    // 10485760` CHECK, exactly like the re-sniff below skips one receipt rather than failing
    // the save.
    if (buf.length === 0 || buf.length > MAX_RECEIPT_BYTES) continue;
    // Re-sniff: the file must STILL be an accepted type at commit time, not just at upload.
    const mime = sniffReceiptType(buf);
    if (mime === null) continue;

    const sidecar = readSidecar(ref.stagingId);
    const storedFilename = adoptReceiptFile(found.path, mime);
    adopted.push(storedFilename);

    // M5: strip path separators, quotes and control characters before the display cap --
    // this name is rendered and will eventually back a Content-Disposition header; it is
    // NEVER used as a path component regardless (storedFilename is what the filesystem sees).
    const sanitizedOriginal = sanitizeOriginalFilename(ref.originalFilename);

    const inserted = tx
      .insert(warrantyReceipts)
      .values({
        warrantyItemId: itemId,
        // MUST-3.8: display only. Capped at 255 and never a path component.
        originalFilename: sanitizedOriginal.slice(0, 255) || `receipt.${storedFilename.split('.').pop()}`,
        storedFilename,
        mime,
        sizeBytes: buf.length,
        sha256: sha256Bytes(buf),
        ocrText: sidecar?.status === 'done' ? (sidecar.text ?? null) : null,
        ocrStatus: sidecar === null ? 'pending' : sidecar.status,
        ocrError: sidecar?.status === 'failed' ? (sidecar.error ?? null) : null,
        createdAt: at,
      })
      .returning({ id: warrantyReceipts.id })
      .get();

    receiptIds.push(inserted.id);
    const stagingId = ref.stagingId;
    deferred.push(() => {
      deleteSidecar(stagingId);
      // D7: the uploader record goes with the sidecar it sat beside, so tmp is left as it was.
      deleteStagedOwner(stagingId);
    });
    // No sidecar means OCR had not finished when the member saved: record 'pending' and let
    // the queue (and, after a crash, the scheduler sweep) pick it up (§7.5).
    if (sidecar === null) {
      const receiptId = inserted.id;
      deferred.push(() => {
        enqueueOcrJob({ kind: 'receipt', receiptId });
      });
    }
  }

  return { receiptIds };
}

export function deleteWarrantyReceipt(id: number): boolean {
  const db = getDb();
  const row = db
    .select({ storedFilename: warrantyReceipts.storedFilename })
    .from(warrantyReceipts)
    .where(eq(warrantyReceipts.id, id))
    .get();
  if (!row) return false;
  // Row first (the FTS trigger fires), file afterwards, best effort (MUST-4.8).
  db.delete(warrantyReceipts).where(eq(warrantyReceipts.id, id)).run();
  deleteReceiptFile(row.storedFilename);
  return true;
}

/**
 * MUST-7.16: reset to 'pending', clear text and error, enqueue. Idempotent: a second
 * click on a claimed row is a no-op inside enqueueOcrJob().
 */
export function resetReceiptForReOcr(id: number): boolean {
  const result = getDb()
    .update(warrantyReceipts)
    .set({ ocrStatus: 'pending', ocrText: null, ocrError: null })
    .where(eq(warrantyReceipts.id, id))
    .run();
  if (result.changes === 0) return false;
  enqueueOcrJob({ kind: 'receipt', receiptId: id });
  return true;
}

export function listStoredFilenames(): string[] {
  return getDb()
    .select({ storedFilename: warrantyReceipts.storedFilename })
    .from(warrantyReceipts)
    .all()
    .map((row) => row.storedFilename);
}

/** MUST-6.9: a duplicate is a user judgement, so this WARNS. It never blocks. */
export function sha256AlreadyOnItem(itemId: number, sha256: string): boolean {
  const row = getDb()
    .select({ id: warrantyReceipts.id })
    .from(warrantyReceipts)
    .where(and(eq(warrantyReceipts.warrantyItemId, itemId), eq(warrantyReceipts.sha256, sha256)))
    .get();
  return row !== undefined;
}

/** How many receipts on this item carry the same digest. Two or more is the duplicate case. */
export function countReceiptsWithSha(itemId: number, sha256: string): number {
  const row = getDb()
    .select({ count: sql<number>`count(*)` })
    .from(warrantyReceipts)
    .where(and(eq(warrantyReceipts.warrantyItemId, itemId), eq(warrantyReceipts.sha256, sha256)))
    .get();
  return row?.count ?? 0;
}
