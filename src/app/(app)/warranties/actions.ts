'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import BetterSqlite3 from 'better-sqlite3';
import { appendAudit } from '@/lib/audit';
import { CROSS_ORIGIN_ERROR, isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { NOT_YOURS_ERROR, canActOnOwner } from '@/lib/auth/viewer';
import { nowIso } from '@/lib/clock';
import { todayIso } from '@/lib/dates';
import {
  MAX_RULES_PER_LOAN,
  backfillLoanRule,
  checkLoanBackfill,
  deleteLoanRule,
  listLoanRules,
  saveLoanRule,
} from '@/lib/loans';
import { formatCents, parseAmountToCents } from '@/lib/money';
import {
  attachStagedReceipts,
  countReceiptsWithSha,
  createWarrantyItem,
  deleteWarrantyItem,
  deleteWarrantyReceipt,
  getWarrantyItem,
  getWarrantyReceipt,
  resetReceiptForReOcr,
  updateWarrantyItem,
  warrantyInputSchema,
  type StagedReceiptRef,
} from '@/lib/warranty/items';
import { MAX_FILES_PER_UPLOAD } from '@/lib/warranty/receipts';
import { STAGING_ID_RE } from '@/lib/warranty/staging';
import { findItemType } from '@/lib/warranty/types';
import {
  addInstallment,
  listInstallments,
  markInstallmentPaid,
  removeInstallment,
  unmarkInstallmentPaid,
  INSTALLMENT_DUE_SOON_DAYS,
} from '@/lib/warranty/installments';
import {
  ITEM_KIND_LABELS,
  ITEM_TYPE_IMMUTABLE_ERROR,
  isBillingCycle,
  INSTALLMENT_KIND_ERROR,
  MATCHING_KIND_ERROR,
  installmentsAllowedForKind,
  matchingAllowedForKind,
  type BillingCycle,
  type ItemKind,
} from '@/lib/warranty/constants';

export interface WarrantyActionState {
  error?: string;
  message?: string;
}

/**
 * CROSS_ORIGIN_ERROR is deliberately NOT re-exported here: Next 15 allows only async
 * function exports from a 'use server' file. `next build` fails on any other export from a
 * module carrying this directive, and npm test/typecheck cannot catch that class of error.
 * The canonical string lives in @/lib/auth/csrf (a plain module) and is imported directly by
 * both this file and its test.
 */

/**
 * Warranty items are household-VISIBLE and owner-EDITABLE (v1.13.0, ruling R3, spec
 * docs/superpowers/specs/2026-08-27-kids-scope-and-household-features-design.md).
 *
 * This file used to say: "owner_user_id is ATTRIBUTION, not access control, so there is deliberately
 * no requireAdmin() anywhere in this file." That was defensible for two adults and wrong for a
 * household with a fourteen-year-old and a login each: it meant any signed-in member could delete any
 * other member's item and its receipts, and no row recorded who did it (review 2026-08-27, SEC-2).
 *
 * What changed, and only this: the two DESTRUCTIVE actions are now owner-or-admin, via
 * canActOnOwner() in @/lib/auth/viewer, and both append an audit_log row. Creating and EDITING an
 * item stay open to every member -- a household shares its subscriptions and its contracts, and
 * requiring an admin to fix a typo would be the wrong lesson from a deletion problem. There is still
 * no requireAdmin() in this file, and that is still deliberate. Changing an item's type is likewise
 * not an admin action (type-deltas.md T8 / MUST-19.15). Only the type LIST is admin-maintained
 * (settings/item-types).
 */

const idField = z.coerce.number().int().positive();

const stagedSchema = z
  .array(
    z.object({
      stagingId: z.string().regex(STAGING_ID_RE),
      originalFilename: z.string().trim().min(1).max(255),
    }),
  )
  // M4: an unbounded array would otherwise reach the write transaction untouched.
  .max(MAX_FILES_PER_UPLOAD);

const UPLOAD_INVALID_ERROR = 'That upload is no longer valid — please choose the files again.';

/**
 * IMPORTANT 2: `JSON.parse` throws a raw SyntaxError ("Unexpected token…") and
 * `stagedSchema.parse` throws a ZodError whose `.message` is a JSON dump. Neither is fit to
 * show a user. Both collapse to the same written message here; safeParse (not parse) means
 * a malformed payload never reaches messageOf()/failure()'s generic "is this a real Error"
 * fallback with the wrong text attached.
 */
function readStaged(formData: FormData): StagedReceiptRef[] {
  const raw = String(formData.get('staged') ?? '[]');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(UPLOAD_INVALID_ERROR);
  }
  const parsed = stagedSchema.safeParse(json);
  if (!parsed.success) throw new Error(UPLOAD_INVALID_ERROR);
  return parsed.data;
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '');
}

/** '' -> null; anything else must parse as money, as a positive magnitude (§17.26). */
function readPriceCents(formData: FormData): number | null {
  const raw = str(formData, 'price').trim();
  if (raw.length === 0) return null;
  const cents = parseAmountToCents(raw);
  if (cents === null) throw new Error('Price is not a number.');
  return Math.abs(cents);
}

/** '' -> null; anything else must be one of the two billing cycle values (§ user request). */
function readBillingCycle(formData: FormData): BillingCycle | null {
  const raw = str(formData, 'billingCycle').trim();
  if (raw.length === 0) return null;
  if (!isBillingCycle(raw)) throw new Error('Billing must be Monthly or Annual.');
  return raw;
}

/** '' -> null; anything else must parse as money, as a non-negative magnitude, same as price. */
function readBillingAmountCents(formData: FormData): number | null {
  const raw = str(formData, 'billingAmount').trim();
  if (raw.length === 0) return null;
  const cents = parseAmountToCents(raw);
  if (cents === null) throw new Error('The amount is not a number.');
  return Math.abs(cents);
}

/** '' -> null; anything else must parse as money, as a non-negative magnitude, same as price. */
function readPrincipalCents(formData: FormData): number | null {
  const raw = str(formData, 'principal').trim();
  if (raw.length === 0) return null;
  const cents = parseAmountToCents(raw);
  if (cents === null) throw new Error('The original amount is not a number.');
  return Math.abs(cents);
}

/**
 * MUST-14.4: parsed as a decimal PERCENT and stored as BASIS POINTS -- 5.49% is 549. The
 * 0-10000% range is checked here, in zod, and again by the CHECK in 0007.
 * MUST-13.1: this is the only arithmetic the rate is ever subject to, and it is a unit
 * conversion at the form boundary, not a calculation.
 */
function readInterestRateBps(formData: FormData): number | null {
  const raw = str(formData, 'interestRate').trim();
  if (raw.length === 0) return null;
  const percent = Number(raw);
  if (!Number.isFinite(percent)) throw new Error('The interest rate is not a number.');
  if (percent < 0 || percent > 10_000) throw new Error('That rate is out of range.');
  return Math.round(percent * 100);
}

function readBalanceCents(formData: FormData): number | null {
  const raw = str(formData, 'currentBalance').trim();
  if (raw.length === 0) return null;
  const cents = parseAmountToCents(raw);
  if (cents === null) throw new Error('The balance is not a number.');
  return Math.abs(cents);
}

/**
 * Fix wave item 4: `currentBalanceSeed` is a hidden field warranty-detail-client.tsx posts
 * alongside the visible one, carrying the balance the form was RENDERED with (the item prop
 * at mount), untouched by anything the user does in the tab afterwards. Unlike the visible
 * field it is never required to parse as a valid amount -- a malformed or absent seed (an
 * old cached page, a form this app didn't render) just means "no seed", so readItemInput
 * falls back to treating the post as an edit rather than throwing on it.
 */
function readSeedBalanceCents(formData: FormData): number | null {
  const raw = str(formData, 'currentBalanceSeed').trim();
  if (raw.length === 0) return null;
  const cents = parseAmountToCents(raw);
  return cents === null ? null : Math.abs(cents);
}

function readMonths(formData: FormData): number | null {
  const raw = str(formData, 'warrantyMonths').trim();
  if (raw.length === 0) return null;
  // v1.2.2: kind-agnostic wording -- this validator has no access to (and does not thread
  // through) the selected type's kind, so it can't say "Term" vs "Warranty (months)" per
  // kind. "The term" reads correctly for every kind (warranty/subscription/contract/loan)
  // without hard-coding one of them. Old text was 'Warranty length must be a whole number of
  // months.' -- wrong once a Contract/Loan's form legend says 'Term (months)'.
  if (!/^\d+$/.test(raw)) throw new Error('The term must be a whole number of months.');
  return Number(raw);
}

function readOptionalId(formData: FormData, key: string): number | null {
  const raw = str(formData, key).trim();
  if (raw.length === 0) return null;
  const parsed = idField.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${key}.`);
  return parsed.data;
}

/**
 * Delta T8 (type-deltas.md): '' or 'none' -> null (unclassified, a legitimate value; there
 * is no Uncategorised row); anything else must be a positive integer. Existence against
 * warranty_item_types is checked separately, AFTER this shape check, so a bad id reads as
 * "That item type no longer exists." rather than a generic validation message.
 */
function readTypeId(formData: FormData): number | null {
  const raw = str(formData, 'typeId').trim();
  if (raw.length === 0 || raw === 'none') return null;
  const parsed = idField.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid item type.');
  return parsed.data;
}

/**
 * F6 fix-round: `existingBalance` is the item's balance/anchor AS ALREADY STORED, supplied
 * only by updateWarrantyAction (createWarrantyAction has no "existing" row, so a non-empty
 * balance there always gets a fresh anchor, unchanged).
 *
 * Fix wave item 4 (MEDIUM-adjacent LOW): the F6 fix-round comparison above used to be against
 * `existingBalance`, which updateWarrantyAction fetches FRESH, right before this call. That
 * made "was the balance touched by this submit" depend on whatever a matcher rule or another
 * admin did to the stored balance WHILE this form sat open in a browser tab, rather than on
 * whether the person actually typed into the field: the instant the stored value drifted from
 * what the open tab last rendered, an untouched field looked "edited", and its stale,
 * pre-drift figure silently clobbered the real (moved) one on save -- reverting an automatic
 * balance move for a name-only edit.
 *
 * The fix compares the posted balance against `currentBalanceSeed`, a hidden field
 * warranty-detail-client.tsx posts alongside the visible one, carrying the balance the form
 * was RENDERED with (the item prop at mount) and nothing the tab does afterwards. Only a
 * value that differs from that seed can be "user-edited"; an untouched field can therefore
 * never overwrite a balance that moved underneath the form -- it keeps whatever is on file
 * right now, anchor untouched, and a genuine edit still writes exactly as before.
 */
function readItemInput(
  formData: FormData,
  fallbackOwnerId: number,
  existingBalance?: { cents: number | null; updatedAt: string | null },
) {
  const owner = readOptionalId(formData, 'ownerUserId') ?? fallbackOwnerId;
  // Hoisted so the anchor written just below can be derived from the SAME parsed value,
  // rather than re-reading (and re-parsing) the balance field a second time.
  const balanceCents = readBalanceCents(formData);
  const seedCents = readSeedBalanceCents(formData);
  // No existing row (create) is always a fresh write, exactly as before this fix.
  const userEditedBalance = existingBalance === undefined || seedCents !== balanceCents;
  const effectiveBalanceCents = userEditedBalance ? balanceCents : existingBalance!.cents;
  return warrantyInputSchema(todayIso()).safeParse({
    name: str(formData, 'name'),
    vendor: str(formData, 'vendor'),
    model: str(formData, 'model'),
    serial: str(formData, 'serial'),
    purchaseDate: str(formData, 'purchaseDate'),
    warrantyMonths: readMonths(formData),
    // An HTML checkbox posts 'on' when ticked and nothing at all when not.
    isLifetime: formData.get('isLifetime') !== null,
    priceCents: readPriceCents(formData),
    ownerUserId: owner,
    transactionId: readOptionalId(formData, 'transactionId'),
    typeId: readTypeId(formData),
    notes: str(formData, 'notes'),
    billingCycle: readBillingCycle(formData),
    billingAmountCents: readBillingAmountCents(formData),
    principalCents: readPrincipalCents(formData),
    interestRateBps: readInterestRateBps(formData),
    currentBalanceCents: effectiveBalanceCents,
    // MUST-11.8: the HUMAN anchor. Written here and NOWHERE else -- never by a matched
    // payment, never by an unassign, never by an import undo. It answers "when did a person
    // last tell us the truth about this balance", which is exactly the question the debt
    // reconstruction needs. An untouched field (fix wave item 4) can never move it.
    balanceUpdatedAt:
      effectiveBalanceCents === null
        ? null
        : userEditedBalance
          ? nowIso()
          : (existingBalance!.updatedAt ?? nowIso()),
  });
}

/**
 * Delta T8: the type must still exist at write time: a race where an admin deletes an
 * unused type while this form is open. Returning early here (instead of letting the FK
 * throw) means the caller reads a plain readable message instead of a raw SQLite error.
 */
function typeExistsOrNull(typeId: number | null): boolean {
  return typeId === null || findItemType(typeId) !== null;
}

/**
 * MUST-19.11, generalized to success copy: an untyped item (or one whose type lookup somehow
 * misses) reads as a plain warranty, matching the same `?? 'warranty'` fallback the client
 * components use when following the selected/saved type's kind (see the note in
 * warranty-detail-client.tsx and new-warranty-client.tsx).
 */
function kindForTypeId(typeId: number | null): ItemKind {
  return (typeId !== null ? findItemType(typeId)?.kind : undefined) ?? 'warranty';
}

const ITEM_TYPE_MISSING_ERROR = 'That item type no longer exists.';

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/**
 * IMPORTANT 2c: ownerUserId and transactionId are only shape-checked by zod (positive
 * integer). Neither is confirmed to exist before the write, so a tampered value (or a
 * genuine race, e.g. the owner's account being deleted between page load and submit) reaches
 * the database and fails its FK constraint. Translate that raw SqliteError into the same
 * kind of written message a precheck would have produced, instead of leaking
 * "FOREIGN KEY constraint failed" through messageOf()'s generic Error branch. Modelled on
 * the identical idiom in settings/item-types/actions.ts's failure().
 */
function failure(error: unknown, fallback: string): WarrantyActionState {
  if (error instanceof BetterSqlite3.SqliteError && error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return { error: 'That person or transaction no longer exists.' };
  }
  return { error: messageOf(error, fallback) };
}

// MUST-14.14: a rule save can move a balance both /transactions and /reports render.
function revalidateAll(itemId?: number): void {
  revalidatePath('/warranties');
  revalidatePath('/dashboard');
  revalidatePath('/transactions');
  revalidatePath('/reports');
  if (itemId !== undefined) revalidatePath(`/warranties/${itemId}`);
}

export async function createWarrantyAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  // MUST-13.1: origin FIRST, before auth, before validation, before any read.
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  let itemId: number;
  try {
    const staged = readStaged(formData);
    const parsed = readItemInput(formData, user.id);
    // Kind-neutral fallback (MUST-19.11): nothing here has resolved a kind yet at the point a
    // shape-validation error fires, so "item" (not "warranty") is the generic noun -- same
    // reasoning as readMonths()'s "The term" above.
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Could not save that item.' };
    if (!typeExistsOrNull(parsed.data.typeId)) return { error: ITEM_TYPE_MISSING_ERROR };
    itemId = createWarrantyItem(parsed.data, staged);
  } catch (error) {
    return failure(error, 'Could not save that item.');
  }

  revalidateAll(itemId);
  // Outside the try: redirect() signals by throwing, and catching it would swallow it.
  redirect(`/warranties/${itemId}`);
}

export async function updateWarrantyAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const id = idField.safeParse(formData.get('itemId'));
  if (!id.success) return { error: 'Invalid request.' };

  // F6 fix-round: fetched BEFORE readItemInput so the anchor comparison has something to
  // compare against -- an unrelated edit (name only, the loan fieldset resubmitting the same
  // balance it was seeded with) must not re-stamp balance_updated_at to "now".
  const existing = getWarrantyItem(id.data, user);
  if (!existing) return { error: 'That item no longer exists.' };

  let savedKind: ItemKind = 'warranty';
  try {
    const parsed = readItemInput(formData, 0, { cents: existing.currentBalanceCents, updatedAt: existing.balanceUpdatedAt });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Could not save that item.' };
    if (!typeExistsOrNull(parsed.data.typeId)) return { error: ITEM_TYPE_MISSING_ERROR };
    // The type is fixed once the item exists. It decides which fields the form even offers --
    // a model and a serial for a purchase, a principal and a balance for a loan -- so changing
    // it later strands whatever the old kind had stored and asks the record to be read as
    // something it was never filled in as. Same principle as transactions.amount_cents being
    // immutable after insert: a value that governs how other values are INTERPRETED cannot
    // move under them.
    //
    // Enforced here, not just by the read-only control on the form: a disabled input is a
    // suggestion to a browser and nothing at all to a crafted POST. Getting the type wrong
    // stays fixable -- delete the item and add it again.
    if (parsed.data.typeId !== existing.typeId) return { error: ITEM_TYPE_IMMUTABLE_ERROR };
    if (!updateWarrantyItem(id.data, parsed.data)) return { error: 'That item no longer exists.' };
    // Bug fix (v1.2.4): this used to say "Warranty updated." unconditionally -- wrong for a
    // subscription/contract/loan. The saved type's kind decides the noun, the same fallback
    // the client components use for an untyped item (MUST-19.11, one place per wording rule).
    savedKind = kindForTypeId(parsed.data.typeId);
  } catch (error) {
    return failure(error, 'Could not save that item.');
  }

  revalidateAll(id.data);
  return { message: `${ITEM_KIND_LABELS[savedKind]} updated.` };
}

export async function deleteWarrantyAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const id = idField.safeParse(formData.get('itemId'));
  if (!id.success) return { error: 'Invalid request.' };

  // Ruling R3. Read the item as an ADMIN-equivalent viewer would -- getWarrantyItem(id, user) already
  // returns null for a self viewer, and for a household member it returns the row so canActOnOwner
  // can give the honest refusal below rather than "no longer exists".
  const item = getWarrantyItem(id.data, user);
  if (!item) return { error: 'That item no longer exists.' };
  if (!canActOnOwner(item.ownerUserId, user)) return { error: NOT_YOURS_ERROR };

  // M5: errors as return values, never thrown to the client. Same contract as every other
  // action, even though deleteWarrantyItem's own failure modes are narrow today.
  try {
    if (!deleteWarrantyItem(id.data)) return { error: 'That item no longer exists.' };
  } catch (error) {
    return failure(error, 'Could not delete that item.');
  }

  // AFTER the delete succeeds, so a refused or failed attempt leaves no row. The name is the detail
  // because an entity_id whose row is gone tells a reader nothing on its own.
  appendAudit({ userId: user.id, action: 'delete_item', entity: 'warranty_items', entityId: id.data, detail: item.name });

  revalidateAll();
  // Outside the try: redirect() signals by throwing, and catching it would swallow it.
  redirect('/warranties');
}

export async function attachReceiptsAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const id = idField.safeParse(formData.get('itemId'));
  if (!id.success) return { error: 'Invalid request.' };
  if (getWarrantyItem(id.data, user) === null) return { error: 'That item no longer exists.' };

  let attached: number[];
  let duplicate = false;
  try {
    const staged = readStaged(formData);
    attached = attachStagedReceipts(id.data, staged);
    // MUST-6.9: a duplicate digest on the same item WARNS; it never blocks. A duplicate is
    // a user judgement, not an error. Two rows sharing a digest is exactly that case.
    for (const receiptId of attached) {
      const row = getWarrantyReceipt(receiptId);
      if (row && countReceiptsWithSha(id.data, row.sha256) > 1) duplicate = true;
    }
  } catch (error) {
    return failure(error, 'Could not attach that receipt.');
  }

  revalidateAll(id.data);
  if (attached.length === 0) return { error: 'That upload expired — please choose the file again.' };
  return {
    message: duplicate
      ? `Added ${attached.length} receipt(s). This looks like a receipt you already added.`
      : `Added ${attached.length} receipt(s).`,
  };
}

export async function deleteReceiptAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const id = idField.safeParse(formData.get('receiptId'));
  if (!id.success) return { error: 'Invalid request.' };
  const receipt = getWarrantyReceipt(id.data);
  if (receipt === null) return { error: 'That receipt no longer exists.' };

  // Ruling R3: a receipt has no owner of its own -- it inherits its parent item's, which is why the
  // check resolves the item rather than guessing from the receipt row.
  const item = getWarrantyItem(receipt.warrantyItemId, user);
  if (!item || !canActOnOwner(item.ownerUserId, user)) return { error: NOT_YOURS_ERROR };

  // M5: errors as return values, never thrown to the client.
  try {
    deleteWarrantyReceipt(id.data);
  } catch (error) {
    return failure(error, 'Could not remove that receipt.');
  }
  appendAudit({
    userId: user.id,
    action: 'delete_receipt',
    entity: 'warranty_receipts',
    entityId: id.data,
    detail: item.name,
  });
  revalidateAll(receipt.warrantyItemId);
  return { message: 'Receipt removed.' };
}

export async function reRunOcrAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();

  const id = idField.safeParse(formData.get('receiptId'));
  if (!id.success) return { error: 'Invalid request.' };
  const receipt = getWarrantyReceipt(id.data);
  if (receipt === null) return { error: 'That receipt no longer exists.' };

  // MUST-7.16: idempotent and safe to click repeatedly. A second click on a claimed row
  // is a no-op inside enqueueOcrJob(). M5: errors as return values, never thrown.
  try {
    resetReceiptForReOcr(id.data);
  } catch (error) {
    return failure(error, 'Could not re-run OCR for that receipt.');
  }
  revalidateAll(receipt.warrantyItemId);
  return { message: 'Reading that receipt again — the status will update shortly.' };
}

const RULE_TOO_SHORT = 'Use at least three characters, or this will match almost everything.';
const RULE_LIMIT = 'Five rules per loan is the limit.';
const RULE_DUPLICATE = 'That rule already exists on this loan.';

const loanRuleSchema = z.object({
  itemId: z.coerce.number().int().positive(),
  merchantContains: z.string().trim().min(3, RULE_TOO_SHORT).max(120),
  accountId: z.coerce.number().int().positive().nullable(),
  backfill: z.boolean(),
});

export async function saveLoanRuleAction(_prev: WarrantyActionState, formData: FormData): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const accountRaw = str(formData, 'accountId').trim();
  const parsed = loanRuleSchema.safeParse({
    itemId: str(formData, 'itemId'),
    merchantContains: str(formData, 'merchantContains'),
    accountId: accountRaw.length === 0 ? null : accountRaw,
    // F9 fix-round: 'on' is the ONLY value a real checked checkbox ever posts -- checking
    // `!== null` also treated any other stray value as checked, which is stricter to get
    // wrong than it looks: MUST-13.9's whole point is that the backfill pass is opt-IN.
    backfill: formData.get('backfill') === 'on',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Could not save that rule.' };

  const item = getWarrantyItem(parsed.data.itemId, user);
  if (!item) return { error: 'That item no longer exists.' };
  // v1.12.0: bills carry matching rules too -- a match marks their earliest unpaid installment
  // paid instead of moving a balance. MUST-19.11: the sentence lives in constants.ts now.
  if (!matchingAllowedForKind(item.kind)) return { error: MATCHING_KIND_ERROR };
  if (listLoanRules(item.id).length >= MAX_RULES_PER_LOAN) return { error: RULE_LIMIT };

  let ruleId: number;
  try {
    ruleId = saveLoanRule({
      itemId: parsed.data.itemId,
      merchantContains: parsed.data.merchantContains,
      accountId: parsed.data.accountId,
      enabled: true,
    });
  } catch (error) {
    // MUST-14.7: the unique index's message, translated beside the existing FK translation.
    if (error instanceof BetterSqlite3.SqliteError && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { error: RULE_DUPLICATE };
    }
    return failure(error, 'Could not save that rule.');
  }

  let message = 'Rule saved. It will apply to payments that arrive from now on.';
  // Loan-only, deliberately. Retroactively marking a year of installments paid from a year of
  // transactions is exactly the mistake the checkbox's own hint warns about, and a bill has
  // three or four installments a year that are one click each. The checkbox is not rendered for
  // a bill either; this is the server half of the same rule.
  if (parsed.data.backfill && item.kind === 'loan') {
    // MUST-14.12: the ONE loan action with a limit, and the rule is still saved when it is
    // refused -- only the historical pass is skipped.
    const verdict = checkLoanBackfill();
    if (!verdict.allowed) {
      message = 'Rule saved, but the backfill was skipped: too many in the last few minutes.';
    } else {
      const { linked, appliedCents } = backfillLoanRule(ruleId);
      message = `Rule saved. ${linked} past payments linked, ${formatCents(appliedCents)} taken off the balance.`;
    }
  }
  revalidateAll(parsed.data.itemId);
  return { message };
}

export async function deleteLoanRuleAction(formData: FormData): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();
  const parsed = z
    .object({ id: z.coerce.number().int().positive(), itemId: z.coerce.number().int().positive() })
    .safeParse({ id: formData.get('id'), itemId: formData.get('itemId') });
  if (!parsed.success) return { error: 'Invalid request.' };
  // F10 fix-round: the rule must actually belong to the claimed itemId, not merely exist
  // somewhere -- a mismatched (tampered, or a stale-tab race against a rule that moved) pair
  // would otherwise delete an unrelated rule and revalidate the wrong item's page. Checking
  // via listLoanRules(itemId) rather than deleteLoanRule's own boolean return is what makes
  // this a real existence-under-this-item check rather than a global one.
  const rule = listLoanRules(parsed.data.itemId).find((r) => r.id === parsed.data.id);
  if (rule === undefined) return { error: 'That rule no longer exists.' };
  deleteLoanRule(parsed.data.id);
  revalidateAll(parsed.data.itemId);
  return { message: 'Rule removed. Payments already linked are untouched.' };
}

/**
 * v1.12.0: a bill's due-date schedule (spec 2026-08-24, Component 7).
 *
 * Each of these takes requireUser(), not requireAdmin -- deliberately, and matching every other
 * action in this file: an item's own household member manages that item's paperwork.
 *
 * The installment is always looked up THROUGH its claimed itemId rather than by id alone, the
 * same F10-fix-round discipline deleteLoanRuleAction uses: a mismatched pair (tampered, or a
 * stale tab racing a row that moved) would otherwise mutate an unrelated bill and revalidate the
 * wrong page.
 */
const installmentRefSchema = z.object({
  id: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
});

function findInstallment(itemId: number, id: number) {
  // The window is irrelevant to a lookup, but listInstallments' signature asks for one; today's
  // date and the page's own window keep the derived state honest if a caller ever reads it.
  return listInstallments(itemId, todayIso(), INSTALLMENT_DUE_SOON_DAYS).find((row) => row.id === id);
}

const INSTALLMENT_GONE = 'That installment no longer exists.';

export async function addInstallmentAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  // MUST-13.1: origin FIRST, before auth, before validation, before any read.
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const parsed = z
    .object({ itemId: z.coerce.number().int().positive() })
    .safeParse({ itemId: formData.get('itemId') });
  if (!parsed.success) return { error: 'Invalid request.' };

  const item = getWarrantyItem(parsed.data.itemId, user);
  if (!item) return { error: 'That item no longer exists.' };
  if (!installmentsAllowedForKind(item.kind)) return { error: INSTALLMENT_KIND_ERROR };

  const dueDate = str(formData, 'dueDate').trim();
  const cents = parseAmountToCents(str(formData, 'amount').trim());
  if (cents === null) return { error: 'Amount is not a number.' };
  // Magnitude, the same normalisation readPriceCents() applies: a person typing -1,200.00 for a
  // bill means the size of the bill, and the CHECK in drizzle/0011 refuses anything else anyway.
  const amountCents = Math.abs(cents);

  try {
    addInstallment({ itemId: item.id, dueDate, amountCents });
  } catch (error) {
    return failure(error, 'Could not add that installment.');
  }
  revalidateAll(item.id);
  return { message: `Installment added for ${dueDate}.` };
}

export async function removeInstallmentAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();
  const parsed = installmentRefSchema.safeParse({ id: formData.get('id'), itemId: formData.get('itemId') });
  if (!parsed.success) return { error: 'Invalid request.' };

  // Ruling B7: NO kind check here. Removing a stored row must stay possible after a type's kind
  // has been flipped away from bill, or ruling B6's kept rows would be unreachable as well as
  // invisible.
  if (findInstallment(parsed.data.itemId, parsed.data.id) === undefined) return { error: INSTALLMENT_GONE };
  // v1.12.1 (item BA / MON-3): removeInstallment now refuses a paid/linked row, so its return
  // value must actually be read -- this used to report "Installment removed." unconditionally,
  // even on the refused case.
  if (!removeInstallment(parsed.data.id)) {
    return { error: 'That installment could not be removed. If a payment is recorded against it, unmark it first.' };
  }
  revalidateAll(parsed.data.itemId);
  return { message: 'Installment removed.' };
}

/**
 * ONE action for mark and unmark. Two actions differing by a boolean are one action, and a single
 * revalidate path is easier to keep honest than two.
 *
 * Marking is gated on the kind; UNMARKING is not, for ruling B7's reason -- a gate decides what a
 * form offers, never what it may hide, and a person must always be able to undo a mark on a row
 * that already exists.
 */
export async function setInstallmentPaidAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();
  const parsed = installmentRefSchema.safeParse({ id: formData.get('id'), itemId: formData.get('itemId') });
  if (!parsed.success) return { error: 'Invalid request.' };
  const paid = str(formData, 'paid') === 'true';

  if (findInstallment(parsed.data.itemId, parsed.data.id) === undefined) return { error: INSTALLMENT_GONE };

  if (paid) {
    const item = getWarrantyItem(parsed.data.itemId, user);
    if (!item) return { error: 'That item no longer exists.' };
    if (!installmentsAllowedForKind(item.kind)) return { error: INSTALLMENT_KIND_ERROR };
    // Two people marking the same row: the second UPDATE is a no-op and markInstallmentPaid
    // still reports true, because the desired state holds. That is success, not a race to
    // report.
    markInstallmentPaid(parsed.data.id, nowIso());
  } else {
    unmarkInstallmentPaid(parsed.data.id);
  }
  revalidateAll(parsed.data.itemId);
  return { message: paid ? 'Marked as paid.' : 'Marked as unpaid.' };
}
