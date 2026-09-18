import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { extractPdfText, ScannedPdfError } from '@/lib/warranty/ocr/pdf';
import { findStatementCandidates, prefill } from '@/lib/loans/statement-extract';

/**
 * Read the figures off a statement so the reconcile form can be filled in.
 *
 * RULING S1: THIS WRITES NOTHING. It returns candidates; a person confirms them; the reconcile
 * action writes the anchor. That separation is what keeps the statement history trustworthy -- a
 * mis-parsed figure saved unconfirmed would corrupt the one number the app states as fact.
 *
 * TEXT LAYER ONLY (MUST-7.14/7.15). extractPdfText reads the document's own text with every remote
 * fetch disabled -- no font URL, no CMap URL, no worker fetch -- so a mortgage statement never
 * leaves the machine. A scanned PDF has no text layer and is refused rather than guessed at;
 * running Tesseract over a page of small digits is exactly where a wrong digit in a balance would
 * come from, and typing two numbers is faster than checking twelve.
 */
export const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof CsrfError) return Response.json({ error: 'Forbidden' }, { status: 403 });
    throw error;
  }
  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (isSelfScoped(user)) return Response.json({ error: 'Not available on this account.' }, { status: 403 });

  const form = await request.formData();
  const file = form.get('statement');
  if (!(file instanceof File)) return Response.json({ error: 'No statement uploaded' }, { status: 400 });
  if (file.size > MAX_STATEMENT_BYTES) {
    return Response.json({ error: 'That file is too large to read.' }, { status: 413 });
  }

  // Written to a temp file because extractPdfText takes a path, and removed in the finally below
  // whatever happens: this route only ever READS a statement. Keeping the document is a separate,
  // opt-in decision made on the reconcile form itself.
  const scratch = path.join(os.tmpdir(), `statement-${randomUUID()}.pdf`);
  try {
    fs.writeFileSync(scratch, Buffer.from(await file.arrayBuffer()));
    const text = await extractPdfText(scratch);
    const candidates = findStatementCandidates(text);
    return Response.json({
      balance: prefill(candidates.balance),
      statementDate: prefill(candidates.statementDate),
      interest: prefill(candidates.interest),
      // Every other candidate, so the form can show them as chips with the words around them --
      // seeing "Minimum payment due $312.00" is how a person knows why not to pick it.
      others: {
        balance: candidates.balance.slice(0, 6),
        statementDate: candidates.statementDate.slice(0, 6),
        interest: candidates.interest.slice(0, 6),
      },
    });
  } catch (error) {
    if (error instanceof ScannedPdfError) {
      return Response.json(
        { error: 'This PDF has no text layer — it looks like a scan. Type the figures from the statement instead.' },
        { status: 422 },
      );
    }
    return Response.json({ error: 'That statement could not be read. Type the figures instead.' }, { status: 422 });
  } finally {
    fs.rmSync(scratch, { force: true });
  }
}
