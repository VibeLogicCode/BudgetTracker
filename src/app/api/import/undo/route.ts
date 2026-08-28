import { z } from 'zod';
import { appendAudit } from '@/lib/audit';
import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { canActOnOwner } from '@/lib/auth/viewer';
import { getImport, previewUndoImport, undoImport } from '@/lib/import/commit';

const bodySchema = z.object({
  importId: z.number().int().positive(),
  confirm: z.boolean().default(false),
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

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });

  const record = getImport(parsed.data.importId);
  if (!record) return Response.json({ error: 'Unknown import' }, { status: 404 });

  // v1.13.0 ruling R3. An undo deletes every transaction the import solely introduced, plus its Bayes
  // training and its loan and bill links -- a one-request operation against a plain integer id. The
  // person who ran the import, or an admin. 403 rather than 404 here: unlike a receipt, the import id
  // came from a list this member can already see, so hiding existence buys nothing.
  if (!canActOnOwner(record.importedBy, user)) {
    return Response.json(
      { error: 'Only the person who ran this import, or an admin, can undo it.' },
      { status: 403 },
    );
  }

  // Without confirm the caller gets the counts for the confirmation dialog.
  if (!parsed.data.confirm) {
    return Response.json(previewUndoImport(parsed.data.importId));
  }

  // BEFORE the undo: the delete cascades, so the count is only knowable while the rows are still
  // there. An audit row that says "an import was undone" without saying how much it took is not
  // worth writing.
  const preview = previewUndoImport(parsed.data.importId);
  appendAudit({
    userId: user.id,
    action: 'undo_import',
    entity: 'imports',
    entityId: parsed.data.importId,
    detail: `${preview.willDelete} transactions from ${record.filename}`,
  });
  return Response.json(undoImport(parsed.data.importId));
}
