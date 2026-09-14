import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { imports } from '@/db/schema';
import { computeRowHashes, findExistingByExternalIds, findExistingByHashes } from './dedup';
import type { CandidateRow } from './parse';

/** One account the import page is willing to land rows in: active, and of a type that takes them. */
export interface AccountCandidate {
  id: number;
  name: string;
  importProfileId: number | null;
}

export interface AccountScore {
  accountId: number;
  name: string;
  /** How many of this file's rows this account already holds. The whole of the strong signal. */
  matchedRows: number;
}

export interface AccountDetection {
  /** The account to pre-select, or null when the evidence does not separate them. */
  account: { id: number; name: string } | null;
  /**
   * `certain` -- rows from this file are already in that account, which no other account has.
   * `likely` -- no overlap, but a weaker signal (this filename's history, or a profile only one
   * account uses) points one way. `none` -- nothing to go on, or two accounts equally likely.
   */
  confidence: 'certain' | 'likely' | 'none';
  /** A sentence for the screen, naming the evidence. Always populated, pick or no pick. */
  reason: string;
  scores: AccountScore[];
}

/**
 * WHY A WRONG ANSWER IS WORSE THAN NO ANSWER, and why every branch below would rather say
 * nothing: dedup is scoped per account (dedupHash takes accountId), so importing a statement
 * into the wrong account does not merge with anything -- it writes a SECOND copy of every row,
 * under an account that never had them. That is a mess to unpick by hand, so this returns null
 * wherever the evidence is thin, and the caller leaves the picker for the household to set.
 *
 * It also never commits anything: this only decides what the account select is SET TO when the
 * preview appears, and the household can change it before pressing the button that writes.
 */
function decide(input: {
  rows: CandidateRow[];
  filename: string;
  profileId: number | null;
  accounts: AccountCandidate[];
}): AccountDetection {
  const scores: AccountScore[] = input.accounts.map((account) => ({
    accountId: account.id,
    name: account.name,
    matchedRows: overlapCount(account.id, input.rows),
  }));
  const ranked = [...scores].sort((a, b) => b.matchedRows - a.matchedRows);

  // 1. The rows themselves. Two statements from one bank can be shaped identically and still
  //    contain different transactions, which is exactly the case a layout-based guess cannot
  //    answer -- see the owner's two-TD-accounts question.
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (best !== undefined && best.matchedRows > 0 && (runnerUp === undefined || runnerUp.matchedRows === 0)) {
    return {
      account: { id: best.accountId, name: best.name },
      confidence: 'certain',
      reason: `${best.matchedRows} of ${input.rows.length} rows in this file are already in ${best.name}.`,
      scores,
    };
  }
  // Rows found in TWO accounts means the same statement has been imported into both already --
  // a mess this must not take a side in.
  if (best !== undefined && runnerUp !== undefined && best.matchedRows > 0 && runnerUp.matchedRows > 0) {
    return {
      account: null,
      confidence: 'none',
      reason: `Rows from this file are already in more than one account (${best.name}, ${runnerUp.name}), so nothing was pre-selected.`,
      scores,
    };
  }

  // 2. Where a file of this name went last time. Weak on its own -- a bank that names every
  //    export accountactivity.csv defeats it, which is why it never outranks the rows above.
  const previous = lastAccountForFilename(input.filename, input.accounts);
  if (previous !== undefined) {
    return {
      account: { id: previous.id, name: previous.name },
      confidence: 'likely',
      reason: `The last file called ${input.filename} was imported into ${previous.name}.`,
      scores,
    };
  }

  // 3. The profile pin. Narrows rather than decides: two accounts at one bank share a profile,
  //    and then this says nothing at all rather than tossing a coin between them.
  if (input.profileId !== null) {
    const pinned = input.accounts.filter((account) => account.importProfileId === input.profileId);
    if (pinned.length === 1) {
      const only = pinned[0]!;
      return {
        account: { id: only.id, name: only.name },
        confidence: 'likely',
        reason: `${only.name} is the only account that uses this import profile.`,
        scores,
      };
    }
    if (pinned.length > 1) {
      return {
        account: null,
        confidence: 'none',
        reason: `${pinned.length} accounts use this import profile (${pinned.map((a) => a.name).join(', ')}) — more than one could be right, so pick the account yourself.`,
        scores,
      };
    }
  }

  return {
    account: null,
    confidence: 'none',
    reason: 'Nothing in this file says which account it belongs to. Pick the account before you commit.',
    scores,
  };
}

/**
 * How many of this file's rows the account already holds. Hashes are recomputed per account
 * because dedupHash includes the account id by design (src/lib/import/dedup.ts) -- the same row
 * hashes differently for a different account, which is what makes this a per-account question
 * rather than a global one.
 *
 * Provider ids are checked alongside, for the same reason buildPreview checks both: an OFX row
 * commits with dedup_hash NULL and its FITID in external_id, so a hash lookup alone would report
 * an already-imported OFX statement as matching nothing anywhere.
 */
function overlapCount(accountId: number, rows: CandidateRow[]): number {
  if (rows.length === 0) return 0;
  const hashed = computeRowHashes(accountId, rows);
  const byHash = findExistingByHashes(
    accountId,
    hashed.map((row) => row.dedupHash),
  );
  const externalIds = hashed
    .map((row) => row.externalId ?? null)
    .filter((value): value is string => value !== null && value.length > 0);
  const byExternalId = findExistingByExternalIds(accountId, externalIds);
  return hashed.filter(
    (row) =>
      byHash.has(row.dedupHash) || (row.externalId !== null && row.externalId !== undefined && byExternalId.has(row.externalId)),
  ).length;
}

/** The newest import of a file with exactly this name, if it landed in an account still on offer. */
function lastAccountForFilename(filename: string, accounts: AccountCandidate[]): AccountCandidate | undefined {
  if (filename.length === 0) return undefined;
  const row = getDb()
    .select({ accountId: imports.accountId })
    .from(imports)
    .where(eq(imports.filename, filename))
    .orderBy(desc(imports.id))
    .limit(1)
    .get();
  if (row === undefined) return undefined;
  return accounts.find((account) => account.id === row.accountId);
}

/**
 * Which account this file most likely belongs to, from three signals in descending order of
 * strength: rows the account already holds, then where a file of this name went last time, then
 * an import profile only one account uses. See decide() for why each of them would rather say
 * nothing than guess.
 */
export function detectImportAccount(input: {
  rows: CandidateRow[];
  filename: string;
  profileId: number | null;
  accounts: AccountCandidate[];
}): AccountDetection {
  if (input.accounts.length === 0) {
    return { account: null, confidence: 'none', reason: 'There are no accounts to import into yet.', scores: [] };
  }
  return decide(input);
}
