import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { acceptsTransactions, listAccounts } from '@/lib/accounts';
import { isSimplefinManaged } from '@/lib/simplefin/connection';
import { detectStagedFile } from '@/lib/import/batch';
import { ImportLimitError, MAX_FILE_BYTES } from '@/lib/import/parse';
import { hasReadableMapping, listProfiles } from '@/lib/import/presets';
import { StagingError } from '@/lib/import/staging';

/**
 * The first hop of an import: the browser posts the file, this stages it ONCE and answers which
 * import profile can read it and which account it most likely belongs to. The client then calls
 * /api/import/preview with the same stagingId and whichever ids the household actually wants, so
 * the file is uploaded once however many times the pickers are changed afterwards.
 *
 * It decides nothing. Both answers are pre-selections for two <select>s the household can change,
 * and the preview built from them is the real check -- a wrong mapping shows up there as dates in
 * the wrong century or amounts in the wrong column, before a single row is committed.
 *
 * Same three refusals as the preview route, in the same order (MUST-10.2: origin first, then
 * auth, then the self-viewer rule), because this route stages a file exactly as that one does.
 */
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

  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) {
    return Response.json({ error: `File is larger than ${MAX_FILE_BYTES} bytes`, code: 'file_too_large' }, { status: 413 });
  }

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return Response.json({ error: 'No file uploaded' }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) {
    return Response.json({ error: `File is larger than ${MAX_FILE_BYTES} bytes`, code: 'file_too_large' }, { status: 413 });
  }

  const buf = Buffer.from(await file.arrayBuffer());

  // Exactly the list the import page's own picker offers (MUST-4.1): active, with a readable
  // mapping. Detecting a profile the household cannot then select would be a suggestion the
  // screen has no way to honour.
  const profiles = listProfiles()
    .filter(hasReadableMapping)
    .filter((profile) => profile.isActive)
    .map((profile) => ({ id: profile.id, name: profile.name, mapping: profile.mapping }));

  // Same account list as the page: no asset accounts (they take no transactions, ruling R10) and
  // no SimpleFIN-managed ones (those sync rather than import).
  const accounts = listAccounts({}, user)
    .filter((account) => acceptsTransactions(account.type))
    .filter((account) => !isSimplefinManaged(account.id))
    .map((account) => ({ id: account.id, name: account.name, importProfileId: account.importProfileId }));

  try {
    /*
      2026-09-15, ruling B9. This block used to hold the staging, parsing and both detections
      inline. It moved WHOLE into detectStagedFile (src/lib/import/batch.ts) when the batch screen
      needed the identical work for N files -- not copied there, moved, so there is exactly one
      detection path. Two copies would drift, and the drift would stay invisible until this page
      and the batch list disagreed about the same file.
    */
    const { stagingId, account: accountDetection, profile: profileDetection } = detectStagedFile({
      buf,
      filename: file.name,
      profiles,
      accounts,
    });

    return Response.json({
      stagingId,
      filename: file.name,
      profile: profileDetection.profile,
      profileReason: profileDetection.reason,
      profileConfidence: profileDetection.confidence,
      source: profileDetection.source,
      account: accountDetection.account,
      accountReason: accountDetection.reason,
      accountConfidence: accountDetection.confidence,
    });
  } catch (error) {
    if (error instanceof ImportLimitError) return Response.json({ error: error.message, code: error.code }, { status: 413 });
    if (error instanceof StagingError) return Response.json({ error: error.message }, { status: 410 });
    throw error;
  }
}
