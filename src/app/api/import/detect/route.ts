import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { acceptsTransactions, listAccounts } from '@/lib/accounts';
import { isSimplefinManaged } from '@/lib/simplefin/connection';
import { detectImportAccount } from '@/lib/import/detect-account';
import { detectImportProfile } from '@/lib/import/detect-profile';
import { looksLikeOfx, parseOfx } from '@/lib/import/ofx';
import { ImportLimitError, MAX_FILE_BYTES, parseCsv } from '@/lib/import/parse';
import { hasReadableMapping, listProfiles } from '@/lib/import/presets';
import { StagingError, writeStagedFile } from '@/lib/import/staging';

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
    const stagingId = writeStagedFile(buf);
    const profileDetection = detectImportProfile({ buf, filename: file.name, candidates: profiles });

    // The rows the account scorer needs, read the way this file is actually going to be read: an
    // OFX file by its own parser (it names its own fields and has no mapping), a CSV by whichever
    // mapping just won. With no profile detected there is nothing to parse the file WITH, so the
    // account scorer falls back to its filename and profile-pin signals over an empty row list.
    const mapping = profiles.find((profile) => profile.id === profileDetection.profile?.id)?.mapping ?? null;
    const rows = looksLikeOfx(file.name, buf)
      ? parseOfx(buf).rows
      : mapping === null
        ? []
        : parseCsv(buf, mapping).rows;

    const accountDetection = detectImportAccount({
      rows,
      filename: file.name,
      profileId: profileDetection.profile?.id ?? null,
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
