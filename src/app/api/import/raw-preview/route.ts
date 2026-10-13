import { z } from 'zod';
import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { ImportLimitError, MAX_FILE_BYTES, previewRawRows } from '@/lib/import/parse';
import { StagingError, readStagedFile, writeStagedFile } from '@/lib/import/staging';

const encodingSchema = z.enum(['auto', 'utf-8', 'windows-1252']).default('auto');

/**
 * v1.55.2. The second way in: a file the import screen ALREADY staged, named by its id, so "Add a
 * bank" from that screen opens on the file in hand instead of asking for it again. The id is
 * validated exactly as /api/import/preview's JSON body validates it (`z.string().uuid()`), and the
 * bytes come through the same readStagedFile, whose stagedFilePath guard is the only way a
 * staging id ever reaches path.join.
 */
const stagedBodySchema = z.object({
  stagingId: z.string().uuid(),
  encoding: encodingSchema,
});

function tooLarge(): Response {
  return Response.json({ error: `File is larger than ${MAX_FILE_BYTES} bytes`, code: 'file_too_large' }, { status: 413 });
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
  // Task 14 fix round 1 (controller ruling): the import UI already refuses a self viewer,
  // but these routes are reachable directly -- refuse here too, before any work.
  if (isSelfScoped(user)) return Response.json({ error: 'Import is not available on this account.' }, { status: 403 });

  // Reject on the declared size BEFORE formData()/json() buffers the whole body —
  // an authenticated user could otherwise force an arbitrarily large body
  // into memory before any per-file cap is ever consulted (review finding 1).
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) return tooLarge();

  const contentType = request.headers.get('content-type') ?? '';

  if (!contentType.includes('multipart/form-data')) {
    // A staged file, by id. Nothing new is staged: the wizard keeps working on the copy the import
    // screen already holds, and hands that same id back so its save and the import after it agree
    // on which file this is.
    const parsed = stagedBodySchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    try {
      // previewRawRows applies the same MAX_FILE_BYTES cap to these bytes as to an upload's.
      const { rows, encoding: detected } = previewRawRows(readStagedFile(parsed.data.stagingId), parsed.data.encoding, 10);
      return Response.json({ stagingId: parsed.data.stagingId, encoding: detected, rows });
    } catch (error) {
      if (error instanceof ImportLimitError) return Response.json({ error: error.message, code: error.code }, { status: 413 });
      if (error instanceof StagingError) return Response.json({ error: error.message, code: error.code }, { status: 410 });
      throw error;
    }
  }

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return Response.json({ error: 'No file uploaded' }, { status: 400 });
  // content-length can be absent/wrong (e.g. chunked transfer); the file's
  // own size is authoritative and is known without reading its bytes yet.
  if (file.size > MAX_FILE_BYTES) return tooLarge();

  const encoding = encodingSchema.parse(form.get('encoding') ?? 'auto');
  const buf = Buffer.from(await file.arrayBuffer());

  try {
    const { rows, encoding: detected } = previewRawRows(buf, encoding, 10);
    const stagingId = writeStagedFile(buf);
    return Response.json({ stagingId, filename: file.name, encoding: detected, rows });
  } catch (error) {
    if (error instanceof ImportLimitError) return Response.json({ error: error.message, code: error.code }, { status: 413 });
    throw error;
  }
}
