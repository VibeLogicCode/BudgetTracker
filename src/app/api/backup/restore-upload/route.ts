import { z } from '@/lib/zod';
import { CROSS_ORIGIN_ERROR, isSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest, type SessionUser } from '@/lib/auth/session';
import { mustChangePassword } from '@/lib/auth/users';
import { RESTORE_UPLOAD_CHUNK_BYTES, restoreUploadErrorResponse, startRestoreUpload } from '@/lib/backup/restore-upload';

export const dynamic = 'force-dynamic';

/** The start request is a few dozen bytes of JSON; nothing bigger is read. */
const START_BODY_MAX_BYTES = 4096;

const tooLarge = () => Response.json({ error: 'That request is too large.' }, { status: 413 });

/**
 * v1.63.0 fix round. The body as text, read up to `max` bytes and no further: null when it is
 * longer. The declared length alone is not enough -- a chunked request declares none -- so the
 * read itself stops at the cap, whatever the headers say.
 */
async function readCapped(request: Request, max: number): Promise<string | null> {
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const startSchema = z.object({
  name: z.string().trim().min(1).max(255),
  bytes: z.number().int().nonnegative(),
  confirm: z.literal(true, { error: 'Tick the confirmation box first.' }),
});

/**
 * v1.63.0: the strict origin check first (a mutating request), then the session, then admin, then
 * the password flag -- the same gate, in the same order, as /api/backup/restore-upload/[id].
 */
function gate(request: Request): SessionUser | Response {
  if (!isSameOrigin(request.headers)) return Response.json({ error: CROSS_ORIGIN_ERROR }, { status: 403 });
  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ error: 'Only an admin can restore a backup.' }, { status: 403 });
  if (mustChangePassword(user.id)) return Response.json({ error: 'Finish setting your password first.' }, { status: 403 });
  return user;
}

/** Starts a restore upload: `{ name, bytes, confirm: true }` in, `{ id, chunkBytes }` out. */
export async function POST(request: Request): Promise<Response> {
  const user = gate(request);
  if (user instanceof Response) return user;

  // A declared length over the cap is refused before anything is read; the read is capped anyway.
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > START_BODY_MAX_BYTES) return tooLarge();
  let text: string | null;
  try {
    text = await readCapped(request, START_BODY_MAX_BYTES);
  } catch {
    return Response.json({ error: 'That request was not valid JSON.' }, { status: 400 });
  }
  if (text === null) return tooLarge();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: 'That request was not valid JSON.' }, { status: 400 });
  }
  const parsed = startSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0].message }, { status: 400 });

  try {
    const { id } = startRestoreUpload({ name: parsed.data.name, bytes: parsed.data.bytes, user, now: new Date() });
    return Response.json({ id, chunkBytes: RESTORE_UPLOAD_CHUNK_BYTES });
  } catch (error) {
    return restoreUploadErrorResponse(error);
  }
}
