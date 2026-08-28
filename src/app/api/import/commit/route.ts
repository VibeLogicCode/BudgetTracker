import { z } from 'zod';
import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { acceptsTransactions, getAccount } from '@/lib/accounts';
import { importMappingSchema } from '@/lib/import/mapping';
import { getProfile } from '@/lib/import/presets';
import { commitStagedImport } from '@/lib/import/flow';
import { StagingError } from '@/lib/import/staging';
import { ImportLimitError, MAX_FILE_BYTES } from '@/lib/import/parse';

const bodySchema = z.object({
  stagingId: z.string().uuid(),
  filename: z.string().min(1).max(255),
  accountId: z.number().int().positive(),
  profileId: z.number().int().positive(),
  mapping: importMappingSchema,
});

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof CsrfError) return Response.json({ error: 'Forbidden' }, { status: 403 });
    throw error;
  }
  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  // Task 14 fix round 1 (controller ruling): the import UI already refuses a self viewer,
  // but these routes are reachable directly -- refuse here too, before any work.
  if (isSelfScoped(user)) return Response.json({ error: 'Import is not available on this account.' }, { status: 403 });

  // This route never carries file bytes itself (the file is already staged),
  // but the JSON body is still fully buffered by request.json() — reject an
  // implausibly large body on its declared size before that happens, the
  // same defence applied to the upload routes (review finding 1).
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) {
    return Response.json({ error: `Request body is larger than ${MAX_FILE_BYTES} bytes`, code: 'file_too_large' }, { status: 413 });
  }

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
  const account = getAccount(parsed.data.accountId);
  if (!account) return Response.json({ error: 'Unknown account' }, { status: 404 });
  // v1.13.0 ruling R10 (item I6): commitStagedImport itself now refuses this too (defense in
  // depth for any other caller), but checking here first means a direct hit on this route gets
  // a clean 400 instead of the generic 500 an uncaught thrown Error would otherwise produce.
  if (!acceptsTransactions(account.type)) {
    return Response.json({ error: 'That account only holds a balance you type in.' }, { status: 400 });
  }
  if (!getProfile(parsed.data.profileId)) return Response.json({ error: 'Unknown import profile' }, { status: 404 });

  try {
    const result = commitStagedImport({ ...parsed.data, userId: user.id });
    return Response.json(result);
  } catch (error) {
    if (error instanceof ImportLimitError) return Response.json({ error: error.message, code: error.code }, { status: 413 });
    if (error instanceof StagingError) return Response.json({ error: error.message }, { status: 410 });
    throw error;
  }
}
