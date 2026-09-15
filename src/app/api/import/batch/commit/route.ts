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
import { MAX_BATCH_FILES } from '../detect/route';

/**
 * 2026-09-15. The confirmed files from the batch screen, committed one after another.
 *
 * RULING B2: THERE IS NO NEW COMMIT PATH HERE. Every file goes through `commitStagedImport`
 * (src/lib/import/flow.ts) -- the same call the single-file route makes, with the same arguments,
 * in the same order. This route is a loop and three refusals; the moment it grows a second way to
 * write a transaction it has become a place for the two paths to disagree about dedup, rules,
 * loan matching or balance reconciliation, all of which that one function owns.
 *
 * ONE FILE'S FAILURE DOES NOT ROLL BACK THE OTHERS, and that is not a compromise: each file is
 * already its own `imports` row with its own undo (`/api/import/undo`), so partial success is the
 * shape the data model has always had. A batch that rolled back everything on the eighth file
 * would be inventing a transaction boundary the rest of the app does not have, and would throw
 * away seven good imports to do it.
 */
const entrySchema = z.object({
  stagingId: z.string().uuid(),
  filename: z.string().min(1).max(255),
  accountId: z.number().int().positive(),
  profileId: z.number().int().positive(),
  mapping: importMappingSchema,
});

const bodySchema = z.object({ files: z.array(entrySchema).min(1).max(MAX_BATCH_FILES) });

export interface BatchCommitResult {
  filename: string;
  stagingId: string;
  ok: boolean;
  /** Present when ok -- the same numbers the single-file screen reports for one import. */
  rowsAdded?: number;
  rowsDuplicate?: number;
  rowsError?: number;
  needsReview?: number;
  importId?: number;
  /** Present when it failed, in the household's words rather than the exception's. */
  error?: string;
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

  // Same defence as the single-file commit route: this carries no file bytes (they are staged
  // already) but request.json() still buffers the whole body, so an implausible declared size is
  // refused before that happens.
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) {
    return Response.json({ error: `Request body is larger than ${MAX_FILE_BYTES} bytes`, code: 'file_too_large' }, { status: 413 });
  }

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });

  const results: BatchCommitResult[] = [];
  for (const entry of parsed.data.files) {
    const base = { filename: entry.filename, stagingId: entry.stagingId };
    const account = getAccount(entry.accountId);
    if (!account) {
      results.push({ ...base, ok: false, error: 'That account no longer exists.' });
      continue;
    }
    if (!acceptsTransactions(account.type)) {
      results.push({ ...base, ok: false, error: 'That account only holds a balance you type in.' });
      continue;
    }
    if (!getProfile(entry.profileId)) {
      results.push({ ...base, ok: false, error: 'That import mapping no longer exists.' });
      continue;
    }
    try {
      const result = commitStagedImport({ ...entry, userId: user.id });
      results.push({
        ...base,
        ok: true,
        importId: result.importId,
        rowsAdded: result.rowsAdded,
        rowsDuplicate: result.rowsDuplicate,
        rowsError: result.rowsError,
        needsReview: result.needsReview,
      });
    } catch (error) {
      if (error instanceof ImportLimitError || error instanceof StagingError) {
        results.push({ ...base, ok: false, error: error.message });
        continue;
      }
      // Unforeseen, and still one file's problem: the others have either already landed or are
      // still to come, and neither is helped by a 500 for the whole batch.
      results.push({ ...base, ok: false, error: 'This file could not be imported.' });
    }
  }

  return Response.json({ results });
}
