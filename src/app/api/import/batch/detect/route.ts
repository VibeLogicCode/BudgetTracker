import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { acceptsTransactions, listAccounts } from '@/lib/accounts';
import { isSimplefinManaged } from '@/lib/simplefin/connection';
import {
  MAX_DROP_STAGED_BYTES,
  classifyDetection,
  detectStagedFile,
  fileCounts,
  type FileCounts,
  type FileStatus,
} from '@/lib/import/batch';
import { buildPreview } from '@/lib/import/preview';
import type { ImportMapping } from '@/lib/import/mapping';
import { ImportLimitError, MAX_FILE_BYTES } from '@/lib/import/parse';
import { hasReadableMapping, listProfiles } from '@/lib/import/presets';
import { StagingError } from '@/lib/import/staging';
import { ZipError, looksLikeZip, readZipEntries } from '@/lib/import/zip';
import { declaredLengthOver, readFormOrNull, uploadTooLargeResponse } from '@/lib/upload-limits';

/**
 * 2026-09-15. The batch counterpart of /api/import/detect: N files in, one classified row each
 * back. Design: docs/superpowers/specs/2026-09-15-batch-import-design.md.
 *
 * It stages and reads, and it commits NOTHING. Every row it returns is a pre-selection the
 * household can change, exactly as the single-file route's two answers are -- the difference is
 * only that ten files are answered in one round trip instead of ten.
 *
 * Same three refusals as that route, in the same order (MUST-10.2: origin first, then auth, then
 * the self-viewer rule), because this route stages files exactly as that one does.
 */

/** How many files one drop may carry. A folder-select can hand over hundreds by accident. */
export const MAX_BATCH_FILES = 25;

export interface BatchDetectRow {
  status: FileStatus;
  filename: string;
  reason: string | null;
  /** Null for an `unsupported` row -- nothing was staged, so there is nothing to open later. */
  stagingId: string | null;
  rowCount: number;
  account: { id: number; name: string } | null;
  accountConfidence: string | null;
  profile: { id: number; name: string } | null;
  profileConfidence: string | null;
  source: string | null;
  /**
   * 2026-09-15. What this file will actually DO -- rows, duplicates, errors and the number that
   * matters, how many will arrive. Null whenever no account or no mapping was resolved, because
   * there is then nothing to count the file against, which is precisely why such a row needs a
   * person. See fileCounts() in src/lib/import/batch.ts for why these come from buildPreview.
   */
  counts: FileCounts | null;
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof CsrfError) return Response.json({ error: 'Forbidden' }, { status: 403 });
    throw error;
  }
  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (isSelfScoped(user)) return Response.json({ error: 'Import is not available on this account.' }, { status: 403 });

  if (declaredLengthOver(request)) return uploadTooLargeResponse();
  const form = await readFormOrNull(request);
  if (form === null) return uploadTooLargeResponse();
  const files = form.getAll('files').filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) return Response.json({ error: 'No files uploaded' }, { status: 400 });
  if (files.length > MAX_BATCH_FILES) {
    return Response.json({ error: `Drop at most ${MAX_BATCH_FILES} files at once.`, code: 'too_many_files' }, { status: 413 });
  }

  // Exactly the lists the import page's own pickers offer (MUST-4.1), read ONCE for the whole
  // batch rather than per file: they cannot change mid-request, and re-reading them ten times
  // would be ten identical queries.
  const profiles = listProfiles()
    .filter(hasReadableMapping)
    .filter((profile) => profile.isActive)
    .map((profile) => ({ id: profile.id, name: profile.name, mapping: profile.mapping }));

  const accounts = listAccounts({}, user)
    .filter((account) => acceptsTransactions(account.type))
    .filter((account) => !isSimplefinManaged(account.id))
    .map((account) => ({ id: account.id, name: account.name, importProfileId: account.importProfileId }));

  /*
    TWO PASSES. The first reads every file and opens every zip without staging anything, so the
    drop's total -- each zip entry at its inflated size -- is known before a byte is written. Past
    MAX_DROP_STAGED_BYTES the whole drop is refused and nothing is staged. The second pass stages
    and detects, in the order the files came.
  */
  const slots: ({ kind: 'row'; row: BatchDetectRow } | { kind: 'file'; buf: Buffer; filename: string })[] = [];
  let dropBytes = 0;
  const dropTooLarge = (): Response =>
    Response.json(
      {
        error: `The files in this drop are larger than ${Math.floor(MAX_DROP_STAGED_BYTES / (1024 * 1024))} MB in total. Drop fewer at once.`,
        code: 'drop_too_large',
      },
      { status: 413 },
    );

  /**
   * One readable file, queued for detection. Called for a dropped file and, once a zip has been
   * opened, for each thing inside it -- an entry out of an archive is not a special kind of file
   * once it has been read, and giving it its own path would be a second place for the four
   * statuses to be decided. False once the drop is past its byte budget.
   */
  const take = (buf: Buffer, filename: string): boolean => {
    if (buf.length > MAX_FILE_BYTES) {
      slots.push({ kind: 'row', row: unsupported(filename, `This file is larger than ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB.`) });
      return true;
    }
    // Ruling B11: a zip inside a zip is listed, never opened. Recursion is how a bounded reader
    // becomes an unbounded one, and no bank has ever nested a statement inside a statement.
    if (looksLikeZip(filename, buf)) {
      slots.push({ kind: 'row', row: unsupported(filename, 'A zip inside a zip is not opened. Unzip it first.') });
      return true;
    }
    dropBytes += buf.length;
    if (dropBytes > MAX_DROP_STAGED_BYTES) return false;
    slots.push({ kind: 'file', buf, filename });
    return true;
  };

  const rows: BatchDetectRow[] = [];
  const detect = (buf: Buffer, filename: string): void => {
    try {
      const detection = detectStagedFile({ buf, filename, profiles, accounts, userId: user.id });
      const { status, reason } = classifyDetection(detection);
      rows.push({
        status,
        filename: detection.filename,
        reason,
        stagingId: detection.stagingId,
        rowCount: detection.rowCount,
        account: detection.account.account,
        accountConfidence: detection.account.confidence,
        profile: detection.profile.profile,
        profileConfidence: detection.profile.confidence,
        source: detection.profile.source,
        counts: countsFor(detection, profiles, user.id),
      });
    } catch (error) {
      if (error instanceof ImportLimitError || error instanceof StagingError) {
        rows.push(unsupported(filename, error.message));
        return;
      }
      // A parser that threw something unforeseen is still one file's problem, not the batch's.
      rows.push(unsupported(filename, 'This file could not be read.'));
    }
  };

  for (const file of files) {
    /*
      ONE BAD FILE MUST NOT COST THE OTHERS. Every failure here becomes an `unsupported` ROW rather
      than a non-200 for the whole request -- the drop that motivated this feature is a bank folder
      with a PDF in it, and answering that drop with a single error would be worse than the
      one-at-a-time flow it replaces. This handling was asked for explicitly.
    */
    if (file.size > MAX_FILE_BYTES) {
      slots.push({ kind: 'row', row: unsupported(file.name, `This file is larger than ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB.`) });
      continue;
    }

    let buf: Buffer;
    try {
      buf = Buffer.from(await file.arrayBuffer());
    } catch {
      slots.push({ kind: 'row', row: unsupported(file.name, 'This file could not be read.') });
      continue;
    }

    // Ruling B11. A zip is opened here and its contents join the list as ordinary files -- the
    // owner's first sentence: a zip should be opened and its contents imported. zip.ts owns every guard
    // (traversal, entry count, and the decompressed total, which is the one an upload-size check
    // cannot see); a refusal from it is this one file's problem, exactly like any other.
    if (looksLikeZip(file.name, buf)) {
      let entries: ReturnType<typeof readZipEntries>;
      try {
        entries = readZipEntries(buf);
      } catch (error) {
        slots.push({ kind: 'row', row: unsupported(file.name, error instanceof ZipError ? error.message : 'That zip could not be opened.') });
        continue;
      }
      if (entries.length === 0) slots.push({ kind: 'row', row: unsupported(file.name, 'That zip holds no files this page can read.') });
      // The whole-drop bound counts EXPANDED files, or a single small archive would walk past
      // the limit the drop itself is held to.
      else if (slots.length + entries.length > MAX_BATCH_FILES) {
        slots.push({ kind: 'row', row: unsupported(file.name, `That zip would make more than ${MAX_BATCH_FILES} files. Unzip it and drop fewer.`) });
      } else {
        for (const entry of entries) if (!take(entry.buf, entry.filename)) return dropTooLarge();
      }
      continue;
    }

    if (!take(buf, file.name)) return dropTooLarge();
  }

  for (const slot of slots) {
    if (slot.kind === 'row') rows.push(slot.row);
    else detect(slot.buf, slot.filename);
  }

  return Response.json({ rows });
}

/**
 * The real preview for a file whose account and mapping are both settled, so the list can say what
 * it will import rather than only how many rows it holds. THE SAME CALL the preview screen makes
 * -- see fileCounts() for why anything else would be a number the screen could contradict.
 *
 * Null rather than zeros when there is nothing to count against: an unresolved account means the
 * duplicate check has no account to run in, and reporting "0 duplicates" there would be a claim
 * this route cannot support. An OFX file has a null profile and still counts fine, because
 * buildPreview dispatches on the file's content exactly as flow.ts does (ruling R9).
 *
 * A throw is swallowed to null on purpose: a count is a convenience on a row that already has its
 * status and its reason, and losing the convenience must not cost the row.
 */
function countsFor(
  detection: ReturnType<typeof detectStagedFile>,
  profiles: { id: number; name: string; mapping: ImportMapping }[],
  userId: number,
): FileCounts | null {
  const account = detection.account.account;
  if (account === null) return null;

  const profileId = detection.profile.profile?.id ?? null;
  const detected = profiles.find((profile) => profile.id === profileId);
  // An OFX file has no profile and needs none -- buildPreview dispatches on the file's content
  // (ruling R9) and never looks at the mapping for one. It still has to be HANDED a mapping, so
  // any offered one does; with no profiles at all there is nothing to hand it and nothing to count.
  const mapping = detected?.mapping ?? (detection.profile.source === 'ofx' ? profiles[0]?.mapping : undefined);
  if (mapping === undefined) return null;

  try {
    return fileCounts(
      buildPreview({
        stagingId: detection.stagingId,
        filename: detection.filename,
        accountId: account.id,
        profileId,
        mapping,
        userId,
      }),
    );
  } catch {
    return null;
  }
}

function unsupported(filename: string, reason: string): BatchDetectRow {
  return {
    status: 'unsupported',
    filename,
    reason,
    stagingId: null,
    rowCount: 0,
    account: null,
    accountConfidence: null,
    profile: null,
    profileConfidence: null,
    source: null,
    counts: null,
  };
}
