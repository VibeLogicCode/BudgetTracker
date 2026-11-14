/**
 * The largest request body an upload route reads: the proxy's body clone limit. A body past it
 * reaches the route cut short, so every upload route refuses a declared length over it before
 * reading anything, and answers a body that cannot be read as a form the same way.
 */
export const UPLOAD_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

export const UPLOAD_TOO_LARGE_MESSAGE = 'That upload is too large. Send at most 10 MB at once.';

/** True when the request declares a body longer than `limit`. An absent or unreadable length is not over. */
export function declaredLengthOver(request: Request, limit: number = UPLOAD_BODY_LIMIT_BYTES): boolean {
  const declared = Number(request.headers.get('content-length') ?? '');
  return Number.isFinite(declared) && declared > limit;
}

/** The 413 every upload route answers for a body over the limit or one that arrived incomplete. */
export function uploadTooLargeResponse(message: string = UPLOAD_TOO_LARGE_MESSAGE): Response {
  return Response.json({ error: message, code: 'file_too_large' }, { status: 413 });
}

/** The request's form, or null when the body cannot be read as one (a body cut short reads this way). */
export async function readFormOrNull(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}
