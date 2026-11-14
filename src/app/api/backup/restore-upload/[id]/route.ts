import { z } from '@/lib/zod';
import { CROSS_ORIGIN_ERROR, isSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest, type SessionUser } from '@/lib/auth/session';
import { mustChangePassword } from '@/lib/auth/users';
import { armRestart } from '@/lib/backup/restart';
import {
  RESTORE_UPLOAD_CHUNK_BYTES,
  RESTORE_UPLOAD_MAX_BYTES,
  appendRestoreUpload,
  cancelRestoreUpload,
  finishRestoreUpload,
  restoreUploadErrorResponse,
} from '@/lib/backup/restore-upload';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const idSchema = z.guid();
const offsetSchema = z
  .string()
  .regex(/^\d{1,16}$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(RESTORE_UPLOAD_MAX_BYTES));

const pieceTooLarge = () =>
  Response.json(
    { error: `Each piece of an upload is at most ${RESTORE_UPLOAD_CHUNK_BYTES / (1024 * 1024)} MB. Nothing was changed.` },
    { status: 413 },
  );

/** The same gate, in the same order, as /api/backup/restore-upload (start). */
function gate(request: Request): SessionUser | Response {
  if (!isSameOrigin(request.headers)) return Response.json({ error: CROSS_ORIGIN_ERROR }, { status: 403 });
  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ error: 'Only an admin can restore a backup.' }, { status: 403 });
  if (mustChangePassword(user.id)) return Response.json({ error: 'Finish setting your password first.' }, { status: 403 });
  return user;
}

/** The id from the path, checked before anything touches the disk. */
async function sessionId(context: Context): Promise<string | Response> {
  const parsed = idSchema.safeParse((await context.params).id);
  return parsed.success ? parsed.data : Response.json({ error: 'That upload id is not valid.' }, { status: 400 });
}

/** One piece: `PUT ?offset=<bytes so far>`, the bytes as application/octet-stream. */
export async function PUT(request: Request, context: Context): Promise<Response> {
  const user = gate(request);
  if (user instanceof Response) return user;
  const id = await sessionId(context);
  if (id instanceof Response) return id;

  const offset = offsetSchema.safeParse(new URL(request.url).searchParams.get('offset') ?? '');
  if (!offset.success) return Response.json({ error: 'The offset must be a whole number of bytes.' }, { status: 400 });
  if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
    return Response.json({ error: 'Send each piece as application/octet-stream.' }, { status: 415 });
  }
  // The declared size is refused before the body is read, and the bytes read are checked again.
  const declared = request.headers.get('content-length');
  if (declared === null || !/^\d{1,16}$/.test(declared)) {
    return Response.json({ error: 'Send each piece with its length.' }, { status: 411 });
  }
  if (Number(declared) > RESTORE_UPLOAD_CHUNK_BYTES) return pieceTooLarge();
  const chunk = new Uint8Array(await request.arrayBuffer());
  if (chunk.byteLength > RESTORE_UPLOAD_CHUNK_BYTES) return pieceTooLarge();

  try {
    return Response.json(appendRestoreUpload({ id, offset: offset.data, chunk, user, now: new Date() }));
  } catch (error) {
    return restoreUploadErrorResponse(error);
  }
}

/** Finish: stage the complete upload through the listed restore's checks, then restart. */
export async function POST(request: Request, context: Context): Promise<Response> {
  const user = gate(request);
  if (user instanceof Response) return user;
  const id = await sessionId(context);
  if (id instanceof Response) return id;

  let staged;
  try {
    // stageUploadedRestore() emits the one audit line ("[restore] staged uploaded: ...").
    staged = finishRestoreUpload({ id, user, now: new Date() });
  } catch (error) {
    return restoreUploadErrorResponse(error);
  }
  armRestart();
  return Response.json({
    restarting: true,
    message: `Restoring ${staged.sourceName}. The app will restart. Refresh this page in about 30 seconds.`,
  });
}

/** Cancel: remove the session and everything it received. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  const user = gate(request);
  if (user instanceof Response) return user;
  const id = await sessionId(context);
  if (id instanceof Response) return id;

  try {
    cancelRestoreUpload({ id, user });
    return Response.json({ cancelled: true });
  } catch (error) {
    return restoreUploadErrorResponse(error);
  }
}
