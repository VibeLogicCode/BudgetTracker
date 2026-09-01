import { acceptsTransactions, getAccount } from '@/lib/accounts';
import { runEngine, type EngineResult } from '@/lib/categorize/engine';
import { applyPaymentMatchers } from '@/lib/loans';
import { isSimplefinManaged } from '@/lib/simplefin/connection';
import { commitImport } from './commit';
import { computeRowHashes } from './dedup';
import type { ImportMapping } from './mapping';
import { looksLikeOfx, parseOfx } from './ofx';
import { parseCsv } from './parse';
import { forkProfileIfBuiltin, setAccountProfile } from './presets';
import { deleteStagedFile, readStagedFile } from './staging';
import { getDb } from '@/db/client';
import { transactions } from '@/db/schema';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

export interface CommitFlowResult {
  importId: number;
  profileId: number;
  rowsAdded: number;
  rowsDuplicate: number;
  rowsError: number;
  needsReview: number;
  /**
   * v1.26.0 Lane 2 item 4. How many of the rows this import ADDED came out of the engine carrying
   * `categorization_source = 'rule'` -- the number the owner's objection is about ("i dont just want
   * to auto apply rules and never see what happened on my import"). Distinct from
   * EngineResult.categorized, which counts rule and Bayes assignments together, and from
   * `needsReview` above, which by construction EXCLUDES every one of these rows: REVIEW_WHERE
   * (src/lib/categorize/engine.ts) treats a rule assignment as settled, which is exactly why it
   * needs reporting somewhere else.
   *
   * Reported at the moment of import so the result screen can offer the audit view straight away,
   * rather than making the UI go and ask unreviewedRuleImports (src/lib/import/commit.ts) for a
   * number this call already has in hand. 0 is the common and unremarkable answer.
   */
  rulesApplied: number;
  /** SHOULD-3.6, passed straight through from CommitResult — see its doc comment. */
  attributionSummary: string | null;
  engine: EngineResult;
  /** true when runEngine threw after the rows were already committed (review-review finding 2). */
  engineFailed: boolean;
  loanLinksCreated: number;
  /** F5 fix-round: true when applyPaymentMatchers's own internal catch (MUST-13.5) fired. */
  loanMatchFailed: boolean;
}

export function commitStagedImport(input: {
  stagingId: string;
  filename: string;
  accountId: number;
  profileId: number;
  mapping: ImportMapping;
  userId: number;
}): CommitFlowResult {
  const account = getAccount(input.accountId);
  if (!account) throw new Error(`No account ${input.accountId}`);

  // v1.13.0 ruling R10 (item I6): an asset account holds a typed balance and takes no
  // transactions or imports at all -- the account picker already filters these out on every
  // page that leads here, and the manual-entry write path (transactions/actions.ts) has this
  // same second gate. commitStagedImport had no equivalent: an asset account's id posted
  // directly to /api/import/commit reached this far unchecked.
  if (!acceptsTransactions(account.type)) throw new Error('That account only holds a balance you type in.');

  // Spec section 3: an account is CSV-managed or SimpleFIN-managed, never both.
  if (isSimplefinManaged(input.accountId)) {
    throw new Error(
      `"${account.name}" is synced from SimpleFIN. Importing a CSV into it would create duplicates, because the two sources dedup differently. Unlink it under Settings → Connections first.`,
    );
  }

  const buf = readStagedFile(input.stagingId);

  // Parse (and thereby validate: byte-size cap, row-count cap, per-row
  // errors) BEFORE touching the account's profile pointer. A 413/row-cap
  // failure here must throw before any fork is created or the account is
  // repointed — otherwise the account would end up pointed at a profile
  // that was never actually used to import anything (review finding 3).
  //
  // v1.13.0 ruling R9: an OFX/QFX file skips the CSV mapping entirely -- there is nothing to
  // map, because the format names its own fields. Everything downstream is identical:
  // computeRowHashes still runs (commitImport ignores the hash for a row carrying an
  // externalId, commit.ts:196-198), commitImport is the same call, and undoImport partitions
  // by transaction_imports and has never looked at how a row was deduped.
  const ofx = looksLikeOfx(input.filename, buf) ? parseOfx(buf) : null;
  const parsed = ofx ?? parseCsv(buf, input.mapping);
  const hashed = computeRowHashes(input.accountId, parsed.rows);

  // The fork/repoint pair is skipped for an OFX file -- an OFX import has no mapping to fork,
  // so pointing the account at a profile it did not use would be a lie.
  const profileId = ofx
    ? input.profileId
    : forkProfileIfBuiltin({
        profileId: input.profileId,
        accountName: account.name,
        mapping: input.mapping,
      });
  if (!ofx) setAccountProfile(input.accountId, profileId);

  const committed = commitImport({
    accountId: input.accountId,
    profileId,
    filename: input.filename,
    importedBy: input.userId,
    rows: hashed,
    errors: parsed.errors,
    // MUST-3.3: this is what actually turns per-card attribution on for the real import
    // path (the wizard and the main import screen both call commitStagedImport, never
    // commitImport directly) — without passing it through, mapping.cardCol would parse,
    // save and round-trip correctly everywhere but never be consulted at commit time.
    // An OFX file has no mapping at all, so null here (never input.mapping) -- ruling R9.
    mapping: ofx ? null : input.mapping,
    // v1.8.0 Task 3: the real file's detected direction, so closingBalancesByDate picks the
    // correct physical row of a same-date group. Only this real CSV path (and SimpleFIN,
    // which has no file to detect direction from and omits this) ever has one to pass.
    dateOrder: parsed.dateOrder,
  });

  // Spec section 5 step 5: transfer detection + categorizer run after the insert.
  // The rows are already committed at this point, so a failure here must
  // never surface as an import failure to the user (review finding 2) —
  // the rows just stay categoryless, which the review queue already
  // recognises without any extra bookkeeping.
  let engine: EngineResult;
  let engineFailed = false;
  try {
    engine = runEngine(committed.insertedTransactionIds);
  } catch {
    engineFailed = true;
    engine = { processed: 0, categorized: 0, transfers: 0, skipped: 0, changed: 0 };
  } finally {
    // The staged file has done its job the moment commitImport succeeds —
    // clean it up regardless of what happens to categorization.
    deleteStagedFile(input.stagingId);
  }

  let needsReview = 0;
  if (committed.insertedTransactionIds.length > 0) {
    const row = getDb()
      .select({ c: sql<number>`count(*)` })
      .from(transactions)
      .where(
        and(
          inArray(transactions.id, committed.insertedTransactionIds),
          eq(transactions.isTransfer, false),
          or(isNull(transactions.categoryId), eq(transactions.categorizationSource, 'bayes')),
        ),
      )
      .get();
    needsReview = row?.c ?? 0;
  }

  // v1.26.0 Lane 2 item 4. A second small count over the same id list rather than a CASE folded
  // into the one above: that query is the definition of `needsReview` and has its own history, and
  // this question ("which rows did a RULE claim") is the complement of it, not a variation on it.
  //
  // NOTHING IS WRITTEN TO imports.rules_reviewed_at HERE, on purpose. A fresh import must be
  // UNREVIEWED, and the column is nullable with no default precisely so that is the state a new
  // imports row already has -- so there is nothing for this function to remember to do, and nothing
  // for the other paths that create imports rows (SimpleFIN sync, a restore) to forget. Writing a
  // timestamp here would mark every import as already checked at the instant it arrived, which is
  // the exact opposite of the feature. See drizzle/0019_import_audit.sql's own header.
  let rulesApplied = 0;
  if (committed.insertedTransactionIds.length > 0) {
    const row = getDb()
      .select({ c: sql<number>`count(*)` })
      .from(transactions)
      .where(and(inArray(transactions.id, committed.insertedTransactionIds), eq(transactions.categorizationSource, 'rule')))
      .get();
    rulesApplied = row?.c ?? 0;
  }

  // MUST-13.7: a post-commit side effect outside the commit transaction, exactly as
  // runEngine already is. applyPaymentMatchers is internally guarded (MUST-13.5) and returns 0
  // on failure rather than throwing an import away; the loanMatchReport out-param is how
  // this caller learns that happened (F5 fix-round) without applyPaymentMatchers's own return
  // type changing for every other call site.
  const loanMatchReport = { failed: false };
  const loanLinksCreated = applyPaymentMatchers(committed.insertedTransactionIds, undefined, loanMatchReport);

  return {
    importId: committed.importId,
    profileId,
    rowsAdded: committed.rowsAdded,
    rowsDuplicate: committed.rowsDuplicate,
    rowsError: committed.rowsError,
    needsReview,
    rulesApplied,
    attributionSummary: committed.attributionSummary,
    engine,
    engineFailed,
    loanLinksCreated,
    loanMatchFailed: loanMatchReport.failed,
  };
}
