'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireUser, type SessionUser } from '@/lib/auth/session';
import { isSelfScoped, NOT_YOURS_ERROR, ownerScope } from '@/lib/auth/viewer';
import { acceptsTransactions, getAccount, getOrCreateCashAccount, listAccounts } from '@/lib/accounts';
import { setLastAccountId } from '@/lib/auth/users';
import {
  assignTransactionToLoan,
  createLoanFromTransaction,
  loanLinksForTransactions,
  unassignTransactionFromLoan,
  type NewLoanResult,
} from '@/lib/loans';
import { formatCents, parseAmountToCents } from '@/lib/money';
import { setTransactionSplits } from '@/lib/splits';
import { getWarrantyItem } from '@/lib/warranty/items';
import { isLoanRepayment, loanAssignedMessage, LOAN_DIRECTIONS } from '@/lib/warranty/constants';
import { isIsoDate } from '@/lib/dates';
import {
  bulkSetAttribution,
  bulkSetCategory,
  bulkSetTransfer,
  createManualTransaction,
  getTransaction,
  transactionOwners,
  updateTransactionNotes,
} from '@/lib/transactions';
import {
  applyCategoryToMatching,
  clearCategory,
  confirmCategory,
  setTransactionDisplayName,
  setTransferFlag,
  upsertRenameRule,
  type CategoryMatchResult,
  type RuleGuardedWriteResult,
} from '@/lib/categorize/engine';
import { ruleOwnedError } from '@/lib/categorize/rules';

export interface ActionState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

const idList = z
  .string()
  .transform((value) => value.split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v > 0));

/**
 * v1.13.0 ruling R2 fix round 2 (controller finding): none of the write actions in this file
 * resolved their target row(s) through the viewer before writing, so a self viewer could POST a
 * `transactionId`/`ids` value belonging to somebody else and change its category, transfer flag or
 * attribution -- listTransactions' own filter never runs on a write path, only on the page's own
 * read. getTransaction(id, viewer) returns null for a row outside the viewer's scope, the
 * deliberately same answer as "no such row" (see its own doc comment in src/lib/transactions.ts),
 * so a scoped loop over every id in the request is the one place this needs checking: every
 * single id must resolve, or the whole action refuses and writes nothing. A household viewer's
 * ownerScope() is always null, so getTransaction never refuses for one -- this is a no-op for
 * every existing (household) test in this file.
 *
 * v1.13.1 (item BL, ruling P14): the loop above was one full-row fetch per id. It is now one
 * narrow query, and BOTH refusals it used to make are kept explicitly -- an id with no row at
 * all, and an id owned by somebody else. Losing the first would have let a household viewer
 * bulk-write against ids that do not exist.
 */
function allTransactionsVisible(ids: number[], viewer: SessionUser): boolean {
  const owners = transactionOwners(ids);
  for (const id of ids) if (!owners.has(id)) return false;
  const scope = ownerScope(viewer);
  if (scope === null) return true;
  for (const owner of owners.values()) if (owner !== scope) return false;
  return true;
}

/**
 * bulkSetCategory and bulkSetTransfer (src/lib/transactions.ts) both skip -- never fail -- a
 * split transaction: see the guard on confirmCategory/setTransferFlag in
 * src/lib/categorize/engine.ts, the manual counterpart of Task 2b's automatic-engine
 * exclusion (spec ruling 2a). Silence here would let a person believe every selected row was
 * changed when a split one quietly was not, so both bulk actions below report the skip in
 * plain language instead.
 */
/**
 * v1.14.1: this file's own split-refusal wording for a row edit differs from /review's
 * ('This transaction is split — clear its split first, then change its category.' vs. this
 * constant) -- the two are separate sentences for separate actions, and porting one must not
 * quietly rewrite the other. This helper and SPLIT_ROW_ERROR are review/actions.ts's own
 * guardedWriteError/SPLIT_ROW_ERROR, moved verbatim for the three actions ported below.
 */
const SPLIT_ROW_ERROR = 'That transaction has splits and cannot be recategorized this way.';

function guardedWriteError(result: RuleGuardedWriteResult | CategoryMatchResult): string {
  return result.ok
    ? ''
    : result.reason === 'owned_by_another'
      ? ruleOwnedError(result.ownerName)
      : SPLIT_ROW_ERROR;
}

function splitSkipSentence(skipped: number): string | null {
  if (skipped <= 0) return null;
  const noun = skipped === 1 ? 'transaction' : 'transactions';
  const verb = skipped === 1 ? 'was' : 'were';
  const pronoun = skipped === 1 ? 'its' : 'their';
  return `${skipped} split ${noun} ${verb} skipped, clear ${pronoun} split first.`;
}

export async function manualEntryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const rawAmount = String(formData.get('amount') ?? '');
  const amountCents = parseAmountToCents(rawAmount);
  if (amountCents === null) return { error: 'Amount is not a number.' };

  const direction = String(formData.get('direction') ?? 'spend');
  const signed = direction === 'income' ? Math.abs(amountCents) : -Math.abs(amountCents);

  const accountRaw = String(formData.get('accountId') ?? '');
  const accountId = accountRaw === 'cash' ? getOrCreateCashAccount(user.id, user.name) : Number(accountRaw);
  const account = getAccount(accountId);
  if (!account) return { error: 'Choose an account.' };
  // Ruling R10: an asset account holds a typed balance and nothing else. The picker already
  // filters them out (page.tsx / QuickAddTransaction only ever list accounts that
  // acceptsTransactions()); this is the second gate, because a select is a suggestion and a POST
  // is a fact.
  if (!acceptsTransactions(account.type)) return { error: 'That account only holds a balance you type in.' };

  // v1.13.0 ruling R2 fix round 3 (item I3). getAccount() above is UNSCOPED (it is the internal
  // resolver micro-ruling M3 documents, meant for ids this codebase produced itself) -- so
  // without this, a self viewer could POST any accountId and write a manual transaction into an
  // account (and therefore a household) they cannot even see. listAccounts({}, user) is the same
  // scoped read every page already trusts for "which accounts can this viewer act through".
  const scope = ownerScope(user);
  if (scope !== null && !listAccounts({}, user).some((a) => a.id === accountId)) {
    return { error: NOT_YOURS_ERROR };
  }

  const date = String(formData.get('date') ?? '');
  if (!isIsoDate(date)) return { error: 'Date must be YYYY-MM-DD.' };

  const categoryRaw = String(formData.get('categoryId') ?? '');
  const attributedRaw = String(formData.get('attributedUserId') ?? '');
  const rawNote = String(formData.get('notes') ?? '').trim();

  try {
    createManualTransaction({
      accountId,
      date,
      description: String(formData.get('description') ?? ''),
      amountCents: signed,
      categoryId: categoryRaw === '' ? null : Number(categoryRaw),
      // v1.13.0 ruling R2 fix round 3 (item I3): a self viewer's attribution is always and only
      // themselves -- forced here, server-side, rather than trusted from whatever
      // `attributedUserId` a hand-crafted request claims. QuickAddTransaction already hides the
      // person picker for a self viewer, so this is the write-side backstop for that same rule.
      attributedUserId: scope !== null ? scope : attributedRaw === '' ? null : Number(attributedRaw),
      // Ruling R13: the column, the action and the help page's promise all existed; only this
      // line was missing. It was `notes: null` from v1.0.0 to v1.12.1. Quick-add itself never
      // shows a notes field (R7's six-control budget has no room), so this is always '' there
      // and null here -- the note sub-row in the kebab is where a note actually gets typed.
      notes: rawNote.length === 0 ? null : rawNote,
      userId: user.id,
      // v1.13.0 ruling R4 (item I4): the ACTOR's role, not a hardcoded 'admin' -- so a member's
      // quick-add can never silently overwrite a merchant rule someone else in the household owns.
      actorRole: user.role,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not save the transaction.' };
  }
  // Ruling R7 / micro-ruling M5: remembered per person, so the next quick-add starts where this
  // one finished. Written after the transaction, so a failed write never moves the default.
  setLastAccountId(user.id, accountId);
  revalidatePath('/transactions');
  revalidatePath('/dashboard');
  return { message: 'Transaction added.' };
}

/**
 * clearCategory (src/lib/categorize/engine.ts) now refuses -- returns false, writes nothing --
 * for a split transaction, the same guard confirmCategory below it already had. In normal use
 * this branch is unreachable for a split row: the transactions page shows a "Split" badge
 * instead of this very category form once a row has parts. Only a stale form resubmit (the
 * page had this form open before the row got split) or a second household member's
 * unrefreshed session can still POST an empty categoryId for one, so the refusal is surfaced
 * as a plain error rather than silently claiming "Category updated." for a write that never
 * happened.
 */
export async function setCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const transactionId = Number(formData.get('transactionId'));
  const raw = String(formData.get('categoryId') ?? '');
  if (!Number.isInteger(transactionId) || transactionId <= 0) return { error: 'Invalid request.' };
  // Ruling R2 fix round 2: resolve the row through the viewer BEFORE either write path below.
  if (getTransaction(transactionId, user) === null) return { error: NOT_YOURS_ERROR };

  if (raw === '') {
    // deleteRule: false -- ruling R4/P5. See clearCategory's docblock.
    if (!clearCategory({ transactionId, userId: user.id, deleteRule: false })) {
      return { error: 'This transaction is split — clear its split first, then change its category.' };
    }
  } else {
    // v1.14.1 ruling R3: a category pick means two different things, and the FORM decides which.
    // Plain per-row edit (teach absent, or any value but '1'): createRule: false, ruling R4's
    // existing behaviour, unchanged -- this select tags THIS row only and does not create or
    // overwrite a household-wide exact merchant rule that files every future import for everyone.
    // Review mode (the row sends teach=1): createRule: true -- the pick doubles as the
    // categorizer's own confirmation, exactly what /review's fixCategoryAction always did before
    // this action absorbed it.
    //
    // v1.13.0 ruling R4: actorRole threaded through so a member can never silently overwrite a
    // rule someone else in the household owns -- confirmCategory refuses (`owned_by_another`)
    // rather than overwrite, and reports the sentence ruleOwnedError provides instead of the
    // usual "Category updated."
    const teach = formData.get('teach') === '1';
    const result = confirmCategory({ transactionId, categoryId: Number(raw), userId: user.id, createRule: teach, actorRole: user.role });
    if (!result.ok) {
      return {
        error:
          result.reason === 'owned_by_another'
            ? ruleOwnedError(result.ownerName)
            : 'This transaction is split — clear its split first, then change its category.',
      };
    }
  }

  revalidatePath('/transactions');
  revalidatePath('/review');
  return { message: 'Category updated.' };
}

/**
 * v1.14.1: ported from src/app/(app)/review/actions.ts (Lane 2 deletes that file once every row
 * everywhere renders through this page). Guards, refusal messages and actorRole argument are
 * byte-identical to the review-page original -- only revalidatePath('/review') became
 * revalidatePath('/transactions') here; the row-editing guard above (household-only, review is
 * unscoped by construction) is unchanged, since this remains a review-mode-only kebab item
 * (inventory item 5).
 */
export async function acceptGuessAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  if (isSelfScoped(user)) return { error: 'Review is not available on this account.' };

  const transactionId = Number(formData.get('transactionId'));
  const row = getTransaction(transactionId, user);
  if (!row || row.categoryId === null) return { error: 'There is no guess to accept on that row.' };
  const result = confirmCategory({ transactionId, categoryId: row.categoryId, userId: user.id, actorRole: user.role });
  if (!result.ok) return { error: guardedWriteError(result) };
  revalidatePath('/transactions');
  return { message: 'Accepted.' };
}

/**
 * v1.14.1: ported from src/app/(app)/review/actions.ts, byte-identical guards and messages
 * (inventory item 7, review-mode-only kebab item).
 */
export async function applyToAllMatchingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  if (isSelfScoped(user)) return { error: 'Review is not available on this account.' };

  const normalizedMerchant = String(formData.get('normalizedMerchant') ?? '');
  const categoryId = Number(formData.get('categoryId'));
  if (normalizedMerchant.length === 0 || !Number.isInteger(categoryId) || categoryId <= 0) return { error: 'Pick a category.' };
  const result = applyCategoryToMatching({ normalizedMerchant, categoryId, userId: user.id, actorRole: user.role });
  if (!result.ok) return { error: guardedWriteError(result) };
  revalidatePath('/transactions');
  return { message: `Applied to ${result.count} transactions and created a rule.` };
}

/**
 * v1.14.1: ported from review/actions.ts's markTransferAction and renamed -- ruling R4 offers
 * this on EVERY row, not just review mode, so it now reads an `isTransfer` field instead of
 * hardcoding `true`, and works both ways ("Mark as transfer" / "Not a transfer"). Every other
 * guard, the refusal messages, and the actorRole argument are byte-identical to the original.
 */
export async function setRowTransferAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  if (isSelfScoped(user)) return { error: 'Review is not available on this account.' };

  const parsed = z.object({ transactionId: z.coerce.number().int().positive() }).safeParse({
    transactionId: formData.get('transactionId'),
  });
  if (!parsed.success) return { error: 'Invalid request.' };
  const isTransfer = formData.get('isTransfer') === '1';
  try {
    const result = setTransferFlag({
      transactionId: parsed.data.transactionId,
      isTransfer,
      userId: user.id,
      actorRole: user.role,
    });
    if (!result.ok) return { error: guardedWriteError(result) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not update that transaction.' };
  }
  revalidatePath('/transactions');
  return { message: isTransfer ? 'Marked as a transfer and learned an exact rule.' : 'Marked as not a transfer.' };
}

// '' means "household/unattributed"; anything else must be a positive integer user id.
// Number(raw) on a garbage string (e.g. a tampered <select> value) is NaN, which must
// never reach attributed_user_id, hence the digits-only check before coercing.
const attributedUserIdField = z.string().trim().refine((v) => v === '' || /^\d+$/.test(v), { message: 'Invalid person selection.' });

export async function setAttributionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const ids = idList.parse(String(formData.get('ids') ?? ''));
  const parsed = attributedUserIdField.safeParse(String(formData.get('attributedUserId') ?? ''));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid person selection.' };
  // v1.13.0 ruling R2 fix round 3 (item I3): a self viewer may attribute a row to nobody but
  // themself -- not to another person, and not back to household/unattributed either, both of
  // which would move money the viewer supposedly owns off of them. allTransactionsVisible below
  // already keeps them off ROWS outside their scope; this keeps them off DESTINATION people too.
  const scope = ownerScope(user);
  if (scope !== null && parsed.data !== String(scope)) return { error: NOT_YOURS_ERROR };
  // Ruling R2 fix round 2: every id must resolve through the viewer, or nothing is written.
  if (!allTransactionsVisible(ids, user)) return { error: NOT_YOURS_ERROR };
  bulkSetAttribution(ids, parsed.data === '' ? null : Number(parsed.data));
  revalidatePath('/transactions');
  return { message: `Attribution updated for ${ids.length} transactions.` };
}

export async function bulkCategorizeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const ids = idList.parse(String(formData.get('ids') ?? ''));
  const categoryId = Number(formData.get('categoryId'));
  if (!Number.isInteger(categoryId) || categoryId <= 0) return { error: 'Pick a category first.' };
  // Ruling R2 fix round 2: every id must resolve through the viewer, or nothing is written.
  if (!allTransactionsVisible(ids, user)) return { error: NOT_YOURS_ERROR };
  const createRules = formData.get('createRules') === 'on';
  // Ruling R4 fix round 2 (controller finding): actorRole threaded through -- bulkSetCategory
  // refuses the WHOLE batch (writes nothing) rather than silently overwriting a rule someone
  // else in the household owns.
  const result = bulkSetCategory(ids, categoryId, user.id, createRules, user.role);
  if (!result.ok) return { error: ruleOwnedError(result.ownerName) };
  revalidatePath('/transactions');
  revalidatePath('/review');
  const changedSentence = `Categorized ${result.changed} transaction${result.changed === 1 ? '' : 's'}.`;
  const skipSentence = splitSkipSentence(result.skipped);
  return { message: skipSentence ? `${changedSentence} ${skipSentence}` : changedSentence };
}

export async function bulkTransferAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const ids = idList.parse(String(formData.get('ids') ?? ''));
  const isTransfer = formData.get('isTransfer') === '1';
  // Ruling R2 fix round 2: every id must resolve through the viewer, or nothing is written.
  if (!allTransactionsVisible(ids, user)) return { error: NOT_YOURS_ERROR };
  // Ruling R4 fix round 2 (controller finding): actorRole threaded through -- bulkSetTransfer
  // refuses the WHOLE batch (writes nothing) rather than silently overwriting a rule someone
  // else in the household owns.
  const result = bulkSetTransfer(ids, isTransfer, user.id, user.role);
  if (!result.ok) return { error: ruleOwnedError(result.ownerName) };
  revalidatePath('/transactions');
  const verb = isTransfer ? 'Marked' : 'Unmarked';
  const noun = result.changed === 1 ? 'transaction' : 'transactions';
  const complement = result.changed === 1 ? 'a transfer' : 'transfers';
  const changedSentence = `${verb} ${result.changed} ${noun} as ${complement}.`;
  const skipSentence = splitSkipSentence(result.skipped);
  return { message: skipSentence ? `${changedSentence} ${skipSentence}` : changedSentence };
}

export async function saveNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const parsed = z.object({ transactionId: z.coerce.number().int().positive() }).safeParse({
    transactionId: formData.get('transactionId'),
  });
  if (!parsed.success) return { error: 'Invalid request.' };
  if (!getTransaction(parsed.data.transactionId, user)) return { error: 'That transaction no longer exists.' };

  const note = String(formData.get('notes') ?? '').trim();
  updateTransactionNotes(parsed.data.transactionId, note.length === 0 ? null : note);
  revalidatePath('/transactions');
  return { message: 'Note saved.' };
}

/**
 * Spec v1.4 two-scope rename.
 *   scope = 'one'  -> display_source = 'manual', no rule, never overwritten.
 *   scope = 'all'  -> creates/updates a rename rule on the normalized merchant
 *                     and bulk-applies it to every non-manual matching row.
 * An empty name clears the override and hands the row back to the rules.
 */
export async function renameTransactionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const transactionId = Number(formData.get('transactionId'));
  if (!Number.isInteger(transactionId) || transactionId <= 0) return { error: 'Invalid request.' };

  const row = getTransaction(transactionId, user);
  if (!row) return { error: 'That transaction no longer exists.' };

  const parsed = z
    .object({ displayName: z.string().trim().max(200), scope: z.enum(['one', 'all']) })
    .safeParse({ displayName: String(formData.get('displayName') ?? ''), scope: String(formData.get('scope') ?? 'one') });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };

  if (parsed.data.displayName.length === 0) {
    setTransactionDisplayName({ transactionId, displayDescription: null, userId: user.id });
    revalidatePath('/transactions');
    revalidatePath('/review');
    return { message: 'Display name cleared — showing the bank text again.' };
  }

  if (parsed.data.scope === 'one') {
    setTransactionDisplayName({ transactionId, displayDescription: parsed.data.displayName, userId: user.id });
    revalidatePath('/transactions');
    revalidatePath('/review');
    return { message: 'Renamed this transaction only.' };
  }

  if (row.normalizedMerchant.length === 0) {
    return { error: 'This transaction has no merchant to match on — use "this transaction only".' };
  }
  // v1.13.0 ruling R4: actorRole threaded through, and a refusal (someone else in the household
  // owns this merchant's rename rule) is surfaced with ruleOwnedError -- the row is left exactly
  // as it was, no rule written, nothing bulk-applied.
  const result = upsertRenameRule({
    pattern: row.normalizedMerchant,
    matchType: 'exact',
    renameTo: parsed.data.displayName,
    userId: user.id,
    actorRole: user.role,
  });
  if (!result.ok) return { error: ruleOwnedError(result.ownerName) };
  revalidatePath('/transactions');
  revalidatePath('/review');
  revalidatePath('/settings/managers');
  return {
    message: `Renamed ${result.rowsUpdated} matching transaction${result.rowsUpdated === 1 ? '' : 's'} and created a rule for future imports.`,
  };
}

const loanLinkSchema = z.object({
  transactionId: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
});

/**
 * MUST-13.13: nothing is derived from the client but txnId and itemId, both zod-validated as
 * positive integers and both existence-checked server-side. Warranty items are
 * household-shared with owner_user_id as attribution only, so any signed-in user may assign
 * a transaction to any loan -- the same posture the existing warranty actions take, and a
 * deliberate consistency rather than an oversight.
 *
 * MUST-14.12: no rate limit, consistent with every existing warranty and transaction action.
 */
export async function assignToLoanAction(formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  // F12 fix-round: checked BEFORE the generic schema parse so an omitted/blank selection (the
  // client now also guards this with `required`, but a stripped or hand-crafted request can
  // still arrive without it) reads as a friendly prompt rather than zod's generic
  // "Invalid request." -- the same courtesy every other choose-first control in this app owes
  // a person who submitted before picking anything.
  if (String(formData.get('itemId') ?? '').trim().length === 0) return { error: 'Pick a loan first.' };

  const parsed = loanLinkSchema.safeParse({
    transactionId: formData.get('transactionId'),
    itemId: formData.get('itemId'),
  });
  if (!parsed.success) return { error: 'Invalid request.' };

  let result: { linked: boolean; appliedCents: number };
  try {
    result = assignTransactionToLoan({ txnId: parsed.data.transactionId, itemId: parsed.data.itemId });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not assign that transaction.' };
  }
  revalidatePath('/transactions');
  revalidatePath('/dashboard');
  revalidatePath('/reports');
  if (!result.linked) return { message: 'That transaction is already linked to this loan.' };

  // MUST-14.10: over-linking SUCCEEDS and warns. A refusal here would block a legitimate
  // combined payment; silence would hide a typo. This still takes priority over the F2 honest
  // amount-and-direction copy below -- a person linking a SECOND loan to the same money needs
  // to know that first, regardless of what happened to either loan's own balance.
  const txn = getTransaction(parsed.data.transactionId, user);
  const links = loanLinksForTransactions([parsed.data.transactionId]).get(parsed.data.transactionId) ?? [];
  const totalLinked = links.reduce((sum, link) => sum + link.amountCents, 0);
  if (txn !== null && totalLinked > Math.abs(txn.amountCents)) {
    return { message: 'Assigned. Note that this transaction is now linked to more than its own amount.' };
  }

  // F2 fix-round: "Assigned." on its own told a person a click registered, not what it DID to
  // the number on the loan they were looking at -- the whole reason to click this control.
  // txn.amount_cents is immutable (tests/lib/loans/invariants.test.ts), so its sign is a safe
  // read of direction even after the fact; result.appliedCents is the exact, already-clamped
  // figure assignTransactionToLoan moved (or didn't).
  //
  // Review round (Lane A): `txn.amountCents < 0` alone only means "a repayment" for an `owed`
  // loan. For a `lent` loan the SAME outgoing money is an advance that RAISES what's owed to
  // the household -- isLoanRepayment re-expresses the sign in the loan's own frame first, the
  // same helper link() itself uses, so this copy can never disagree with what the balance
  // actually did. The item is read once, up front, for both branches below.
  const item = getWarrantyItem(parsed.data.itemId, user);
  const direction = item?.loanDirection ?? 'owed';
  const isRepayment = txn !== null && isLoanRepayment(direction, txn.amountCents);
  return {
    message: loanAssignedMessage({
      direction,
      isRepayment,
      appliedCents: result.appliedCents,
      // Review round: a null item here means the READ came back empty (the assign itself
      // already succeeded -- see assignTransactionToLoan, which performs no owner check at
      // all), not that the balance is unanchored. Those are different facts (loanAssignedMessage
      // docblock, src/lib/warranty/constants.ts) -- `item === null` reads as balance 0, the same
      // as any other loan whose balance genuinely sits at zero.
      balanceAfterCents: item === null ? 0 : item.currentBalanceCents,
    }),
  };
}

const newLoanSchema = z.object({
  transactionId: z.coerce.number().int().positive(),
  loanName: z.string().trim().min(1, 'Give the loan a name.').max(80, 'Keep the loan name under 80 characters.'),
  loanDirection: z.enum(LOAN_DIRECTIONS),
});

/**
 * Addendum A. Thin by design: every rule (the seed, the double-submit guard, the lent-loan
 * refusal, owner resolution) lives in createLoanFromTransaction (src/lib/loans.ts, ruling A4's
 * one db transaction) -- this action only parses the form, calls it with the signed-in viewer,
 * and turns a thrown refusal into the same { error } shape every sibling action here returns.
 */
export async function createLoanFromTransactionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const parsed = newLoanSchema.safeParse({
    transactionId: formData.get('transactionId'),
    loanName: formData.get('loanName') ?? '',
    loanDirection: formData.get('loanDirection') ?? 'lent',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };

  let created: NewLoanResult;
  try {
    created = createLoanFromTransaction(
      { txnId: parsed.data.transactionId, name: parsed.data.loanName, direction: parsed.data.loanDirection },
      user,
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not create that loan.' };
  }
  revalidatePath('/transactions');
  revalidatePath('/dashboard');
  revalidatePath('/reports');

  // Ruling A9: both facts, in the order they happened -- the second half word-for-word the
  // sentence the plain assign already says (ruling A8), never a bespoke one for this path.
  const txn = getTransaction(parsed.data.transactionId, user);
  return {
    message: `Created ${created.name}. ${loanAssignedMessage({
      direction: created.direction,
      isRepayment: txn !== null && isLoanRepayment(created.direction, txn.amountCents),
      appliedCents: created.appliedCents,
      balanceAfterCents: created.balanceAfterCents,
    })}`,
  };
}

export async function unassignFromLoanAction(formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();
  const parsed = loanLinkSchema.safeParse({
    transactionId: formData.get('transactionId'),
    itemId: formData.get('itemId'),
  });
  if (!parsed.success) return { error: 'Invalid request.' };

  // Read BEFORE unassigning: amount_cents is immutable (src/db/schema.ts), so this still
  // reflects the link's direction after the loan_payments row is gone (NEW-3).
  const txn = getTransaction(parsed.data.transactionId, user);

  let unassigned: boolean;
  let appliedCents = 0;
  try {
    // The link's own appliedCents is read here too, inside the SAME try/catch as the
    // reversal itself (NEW-1's guarantee) -- unassignTransactionFromLoan deletes the row and
    // only returns a boolean, so this is the one chance to know how much (if anything)
    // actually moved (F1 fix-round). A residual DB failure on EITHER read must still come
    // back as a normal action error, never a thrown stack trace.
    const linkBefore = (loanLinksForTransactions([parsed.data.transactionId]).get(parsed.data.transactionId) ?? []).find(
      (link) => link.itemId === parsed.data.itemId,
    );
    appliedCents = linkBefore?.appliedCents ?? 0;
    unassigned = unassignTransactionFromLoan({ txnId: parsed.data.transactionId, itemId: parsed.data.itemId });
  } catch (error) {
    // NEW-1 fix-round: the reversal itself is now clamped at zero and should not throw in
    // ordinary use, but a residual failure must still come back as a normal action error,
    // never a stack trace.
    return { error: error instanceof Error ? error.message : 'Could not unassign that transaction.' };
  }
  if (!unassigned) return { error: 'That transaction is not linked to this loan.' };

  revalidatePath('/transactions');
  revalidatePath('/dashboard');
  revalidatePath('/reports');

  // F1 fix-round: a link recorded against an UNKNOWN (or already-zero) balance moved nothing
  // in the first place (link()'s NEW-2 guard) -- claiming the balance "went up/down by exactly
  // what came off it" would be false in exactly the case MUST-11.14's own docblock calls out.
  if (appliedCents === 0) {
    return { message: "Unassigned. That link never moved the balance, so there's nothing to restore." };
  }

  // NEW-3 fix-round: the old message ("gone back up") was FALSE for a disbursement, whose
  // unassign moves the balance back DOWN. Same sign-recovery the engine itself relies on
  // (unassignTransactionFromLoan / reverseLoanLinksForTransactions): negative = a payment, so
  // reversing it raises the balance; positive = a disbursement/adjustment, so reversing it
  // lowers it. F1 fix-round adds the actual amount, matching F2's assign-side voice.
  if (txn !== null && txn.amountCents > 0) {
    return { message: `Unassigned. The balance has gone back down by ${formatCents(appliedCents)}.` };
  }
  return { message: `Unassigned. The balance has gone back up by ${formatCents(appliedCents)}.` };
}

const splitPartSchema = z.object({
  categoryId: z.number().int().positive(),
  amountCents: z.number().int(),
  note: z.string().nullable().optional(),
});
const splitPartsSchema = z.array(splitPartSchema);

/**
 * setTransactionSplits (src/lib/splits.ts) owns every business rule for a split -- part
 * count, sign, sum-to-parent, archived categories, transfers -- so this action validates
 * only the JSON shape and who may act, then hands whatever comes through to the library and
 * returns its own error message verbatim. A generic "Could not save" here would hide exactly
 * the information (the sum mismatch and its size, which category is archived, that a
 * transfer cannot be split) a person needs in order to fix the form.
 *
 * Who may act: any signed-in member, the same as every other action in this file. The spec
 * originally asked for "admin OR the account's owner", and that was withdrawn on review: a
 * member can already recategorize, rename and reattribute a transaction on someone else's
 * account through the actions above, so restricting only splits would add household friction
 * ("why can you not split the charge on my card?") while protecting nothing a member cannot
 * already change. If transaction editing is ever scoped per account, it has to be scoped for
 * all of these together, not for splits alone.
 */
export async function saveSplitsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const txnIdParsed = z.coerce.number().int().positive().safeParse(formData.get('txnId'));
  if (!txnIdParsed.success) return { error: 'Invalid request.' };

  const row = getTransaction(txnIdParsed.data, user);
  if (!row) return { error: 'That transaction no longer exists.' };

  let rawParts: unknown;
  try {
    rawParts = JSON.parse(String(formData.get('parts') ?? '[]'));
  } catch {
    return { error: 'Could not read the split parts.' };
  }

  const partsParsed = splitPartsSchema.safeParse(rawParts);
  if (!partsParsed.success) return { error: 'Invalid split parts.' };
  const parts = partsParsed.data.map((part) => ({
    categoryId: part.categoryId,
    amountCents: part.amountCents,
    note: part.note ?? null,
  }));

  try {
    setTransactionSplits({ txnId: txnIdParsed.data, parts, userId: user.id });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not save the split.' };
  }

  revalidatePath('/transactions');
  revalidatePath('/review');
  return { message: parts.length === 0 ? 'Split removed.' : 'Split saved.' };
}
