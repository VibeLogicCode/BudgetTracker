import { detectImportAccount, type AccountDetection, type AccountCandidate } from './detect-account';
import { detectImportProfile, type ProfileDetection, type ProfileCandidate } from './detect-profile';
import { looksLikeOfx, parseOfx } from './ofx';
import { parseCsv } from './parse';
import { writeStagedFile } from './staging';

/**
 * 2026-09-15. Dropping ten statements at once instead of picking them one at a time.
 *
 * The reported problem: ten statements downloaded in one sitting, then fed in one at a time,
 * with the occasional file imported twice because nothing said it had already been done. The
 * full reasoning is docs/superpowers/specs/2026-09-15-batch-import-design.md; the
 * rulings referenced below (B1-B9) are that document's.
 *
 * RULING B1, AND THE POINT OF THIS FILE: the detection is NOT changing. This was stated twice,
 * once with an asterisk. detectImportAccount and detectImportProfile run per file exactly as they
 * run on the one-file page, and everything here only READS the `confidence` and `reason` they
 * already return. There is no second scorer in this file and there must never be one -- a gate
 * that formed its own opinion would let the batch screen and the wizard disagree about the same
 * file, which is the failure this whole design is meant to avoid.
 */

/** Exactly what one staged file's detection produced. The input to the gate, and nothing more. */
export interface FileDetection {
  stagingId: string;
  filename: string;
  /** How many rows were parsed out of the file, by whichever reader actually read it. */
  rowCount: number;
  account: AccountDetection;
  profile: ProfileDetection;
}

/**
 * `ready` is the only status that may be imported without somebody looking at the file first.
 * `unsupported` is decided before detection is even attempted, so it never reaches this gate --
 * it is in the union because the screen renders one list of all four.
 */
export type FileStatus = 'ready' | 'already-imported' | 'needs-you' | 'unsupported';

export interface FileClassification {
  status: FileStatus;
  /**
   * The detector's OWN sentence, passed through untouched, or null when nothing needed saying.
   * Never a rewrite: the wizard shows this same string when the row is opened, and two phrasings
   * of one decision read as two decisions.
   */
  reason: string | null;
}

/**
 * How many of this file's rows the DETECTED account already holds -- not the best score in the
 * list. The two differ exactly when detection picked one account while another overlapped more,
 * which is the case detect-account.ts refuses to take a side in, and reading the wrong one there
 * would mark a file "already imported" against an account it was never going to land in.
 */
function matchedRowsForDetectedAccount(detection: AccountDetection): number {
  const picked = detection.account;
  if (picked === null) return 0;
  return detection.scores.find((score) => score.accountId === picked.id)?.matchedRows ?? 0;
}

/**
 * Which of the four lists a detected file belongs in.
 *
 * RULING B5 -- the profile must be `certain`, never `likely`. This is not a threshold of mine:
 * detect-profile.ts writes the sentence "read 37 of 40 rows. Check the preview before you commit."
 * for its own `likely`, and has done since long before this file existed. Routing on it is
 * obeying an instruction the codebase already gives.
 *
 * RULING B6 -- the account may be `likely`. Decided on 2026-09-15. The
 * reason it is the right call rather than a concession: account `certain` requires row OVERLAP
 * (detect-account.ts branch 1), so a clean monthly statement that overlaps nothing can never be
 * `certain` however obvious its account is. A `certain`-only gate would leave the common case
 * permanently amber and the feature would not have helped.
 *
 * RULING B7 -- an OFX file is `certain` WITH A NULL PROFILE, because the format names its own
 * columns. Reading the confidence rather than the profile id is what lets that fall out with no
 * special case.
 */
export function classifyDetection(detection: FileDetection): FileClassification {
  if (detection.account.account === null) {
    return { status: 'needs-you', reason: detection.account.reason };
  }
  if (detection.profile.confidence !== 'certain') {
    return { status: 'needs-you', reason: detection.profile.reason };
  }

  /*
    RULING B3, and the reported problem. The first draft of this design added an
    `imports.content_hash` column so a re-import could be spotted before any work was done. It is
    not needed: matchedRows is ALREADY how many of this file's rows that account holds, computed
    on every detect call, so all-of-them is already sayable from numbers in hand.

    Better than a hash, and never worse: it catches a re-download whose BYTES differ -- a fresh
    export timestamp, a reordered column -- but whose contents are already held. And a genuinely
    new statement that fully overlaps contains no new rows, so pausing on it costs nothing.

    The zero case is excluded deliberately. An empty file, or one no profile could parse, has
    matchedRows === rowCount === 0, and "every row is already in" is not a claim worth making
    about no rows at all.
  */
  const matched = matchedRowsForDetectedAccount(detection.account);
  if (detection.rowCount > 0 && matched >= detection.rowCount) {
    return {
      status: 'already-imported',
      reason: `Every one of these ${detection.rowCount} rows is already in ${detection.account.account.name}.`,
    };
  }

  return { status: 'ready', reason: detection.account.reason };
}

/** What a file will actually do, in the same words the preview screen uses. */
export interface FileCounts {
  totalRows: number;
  duplicateCount: number;
  errorCount: number;
  /** Rows that will actually arrive. The number the household is really asking for. */
  willImport: number;
}

/**
 * 2026-09-15, reported after v1.44.1: "on first page it should show summary like
 * last screenshot showing how many duplicates and what it will import."
 *
 * The list said "7 rows", which reads as a promise to add seven. It was going to add ONE -- six of
 * the seven were already in the account -- and the only number that mattered was the one number
 * not on the screen.
 *
 * `willImport` is deliberately the SAME arithmetic the commit button already does
 * (import-client.tsx: `preview.totalRows - preview.duplicateCount`), with errored rows taken off
 * as well since those never arrive either. The inputs come from `buildPreview`, the very call the
 * preview screen makes -- a count derived any other way could disagree with the screen two clicks
 * later, and a household with no way to tell which was right would be correct to trust neither.
 */
export function fileCounts(preview: { totalRows: number; duplicateCount: number; errorCount: number }): FileCounts {
  return {
    totalRows: preview.totalRows,
    duplicateCount: preview.duplicateCount,
    errorCount: preview.errorCount,
    willImport: Math.max(0, preview.totalRows - preview.duplicateCount - preview.errorCount),
  };
}

/**
 * RULING B9: ONE DETECTION PATH. This is the body that used to sit inline in
 * src/app/api/import/detect/route.ts between writeStagedFile and its Response.json, moved here so
 * the single-file route and the batch route call the same code. A second copy would drift from
 * the first, and the drift would stay invisible until the two screens disagreed about one file.
 *
 * It stages, reads and detects. It decides nothing and writes no transaction -- both detections
 * are pre-selections for two <select>s the household can still change, exactly as before.
 */
export function detectStagedFile(input: {
  buf: Buffer;
  filename: string;
  profiles: ProfileCandidate[];
  accounts: AccountCandidate[];
}): FileDetection {
  const stagingId = writeStagedFile(input.buf);
  const profile = detectImportProfile({ buf: input.buf, filename: input.filename, candidates: input.profiles });

  // The rows the account scorer needs, read the way this file is actually going to be read: an
  // OFX file by its own parser (it names its own fields and has no mapping), a CSV by whichever
  // mapping just won. With no profile detected there is nothing to parse the file WITH, so the
  // account scorer falls back to its filename and profile-pin signals over an empty row list.
  const mapping = input.profiles.find((candidate) => candidate.id === profile.profile?.id)?.mapping ?? null;
  const rows = looksLikeOfx(input.filename, input.buf)
    ? parseOfx(input.buf).rows
    : mapping === null
      ? []
      : parseCsv(input.buf, mapping).rows;

  const account = detectImportAccount({
    rows,
    filename: input.filename,
    profileId: profile.profile?.id ?? null,
    accounts: input.accounts,
  });

  return { stagingId, filename: input.filename, rowCount: rows.length, account, profile };
}
