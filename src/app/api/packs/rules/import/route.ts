import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { MAX_FILE_BYTES } from '@/lib/import/parse';
import { PackFormatError, importRulesPack, previewRulesPackImport } from '@/lib/packs';

export const dynamic = 'force-dynamic';

function tooLarge(): Response {
  return Response.json({ error: `File is larger than ${MAX_FILE_BYTES} bytes`, code: 'file_too_large' }, { status: 413 });
}

/**
 * v1.31.0 (review finding R-15, P3). Thrown from readPack so POST's single `catch` can answer
 * with the very same 413 body the header pre-check answers with, rather than this route growing
 * two spellings of "too large". Not a PackFormatError: that class carries status 413's opposite
 * (400) and means "this file is not a pack", which is a different sentence to a different reader.
 */
class PackTooLargeError extends Error {
  constructor() {
    super('pack file too large');
    this.name = 'PackTooLargeError';
  }
}

async function readPack(request: Request): Promise<{ pack: unknown; mode: string; onConflict: 'keep' | 'overwrite' }> {
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new PackFormatError('No file was uploaded.');
  // R-15: the FILE's own size, which is authoritative and known without reading a byte -- exactly
  // what the CSV upload routes this route's header pre-check cites as precedent already do
  // (import/raw-preview/route.ts, import/preview/route.ts). The header check above is a
  // client-supplied number and is skipped entirely when the header is absent or unparseable
  // (chunked transfer sends no Content-Length, and `Number('')` is NaN, so `Number.isFinite`
  // declined to check anything at all) -- so it is a courtesy that avoids buffering, never the
  // limit. This is the limit.
  if (file.size > MAX_FILE_BYTES) throw new PackTooLargeError();
  const text = await file.text();
  // Belt and braces, and cheap: `file.size` is bytes on the wire and `text.length` is UTF-16 code
  // units, so neither bounds the other in general. Both are compared against the same ceiling
  // because what the parser below has to survive is the decoded string, not the upload.
  if (text.length > MAX_FILE_BYTES) throw new PackTooLargeError();
  let pack: unknown;
  try {
    pack = JSON.parse(text);
  } catch {
    throw new PackFormatError('That file is not valid JSON.');
  }
  return {
    pack,
    mode: String(form.get('mode') ?? 'preview'),
    onConflict: form.get('onConflict') === 'overwrite' ? 'overwrite' : 'keep',
  };
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
  if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

  // Reject on the declared size BEFORE formData() buffers the whole body — same
  // authenticated-memory-DoS defence as the CSV upload routes (review finding 1
  // precedent, e.g. import/raw-preview/route.ts). Reuses the CSV importer's
  // MAX_FILE_BYTES rather than a pack-specific constant: a JSON rules/profiles
  // pack has no reason to ever be larger than a bank statement CSV.
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) return tooLarge();

  try {
    const { pack, mode, onConflict } = await readPack(request);
    if (mode === 'apply') {
      return Response.json({ applied: true, ...importRulesPack(pack, { onConflict }) });
    }
    return Response.json({ applied: false, ...previewRulesPackImport(pack) });
  } catch (error) {
    if (error instanceof PackTooLargeError) return tooLarge();
    if (error instanceof PackFormatError) return Response.json({ error: error.message }, { status: error.status });
    // v1.31.0 R-04. Anything else used to be rethrown, which Next turns into a 500 with an HTML
    // body -- and the panel's `await response.json()` then threw on that HTML from inside a
    // floating `void send('apply')`, so the person who chose the file saw nothing at all happen.
    // The import is atomic now (importRulesPack wraps itself in one transaction), so reaching
    // here means nothing was written and saying so is true. The message stays deliberately dull:
    // an unexpected error's own text on a route fed user-supplied JSON is not something to hand
    // back verbatim, so the detail goes to the server log and the person gets a sentence.
    console.error('[packs] rules import failed', error);
    return Response.json({ error: 'Import failed. Nothing was changed.' }, { status: 500 });
  }
}
