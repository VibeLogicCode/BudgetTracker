import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { extractPdfText, ScannedPdfError } from '@/lib/warranty/ocr/pdf';
import { findStatementCandidates, prefill } from '@/lib/loans/statement-extract';
import { detectStatementColumns, readStatementCsv, type StatementColumns } from '@/lib/loans/statement-csv';
import { statementCsvColumnsFor } from '@/lib/loans';

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

/** A CSV by type or by name. A statement is one or the other; nothing else is accepted. */
function looksLikeCsv(file: File): boolean {
  return file.type === 'text/csv' || /\.csv$/i.test(file.name);
}

/** The three columns a person picked on the form, when they picked any (S2). */
function readMapping(form: FormData): StatementColumns | null {
  const date = String(form.get('columnDate') ?? '').trim();
  const balance = String(form.get('columnBalance') ?? '').trim();
  if (date.length === 0 || balance.length === 0) return null;
  const interest = String(form.get('columnInterest') ?? '').trim();
  return { date, balance, interest: interest.length === 0 ? null : interest };
}

/** The mapping confirmed for this loan last time, if the form said which loan it is (S3). */
function remembered(form: FormData): StatementColumns | null {
  const itemId = Number(form.get('itemId'));
  if (!Number.isInteger(itemId) || itemId <= 0) return null;
  const stored = statementCsvColumnsFor(itemId);
  if (stored === null) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<StatementColumns>;
    if (typeof parsed.date !== 'string' || typeof parsed.balance !== 'string') return null;
    return { date: parsed.date, balance: parsed.balance, interest: typeof parsed.interest === 'string' ? parsed.interest : null };
  } catch {
    return null;
  }
}

function previewOf(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .slice(1, 6)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(','));
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
  if (isSelfScoped(user)) return Response.json({ error: 'Not available on this account.' }, { status: 403 });

  const form = await request.formData();
  const file = form.get('statement');
  if (!(file instanceof File)) return Response.json({ error: 'No statement uploaded' }, { status: 400 });
  if (file.size > MAX_STATEMENT_BYTES) {
    return Response.json({ error: 'That file is too large to read.' }, { status: 413 });
  }

  /*
    v1.48.0, ruling S1. A CSV never reaches the disk at all: it is text, so it is decoded in memory,
    read, and dropped. Only the PDF path needs a file, because extractPdfText takes a path.

    The mapping a person confirmed for THIS loan is tried first (S3). A lender's export keeps its
    shape month to month, so remembering it turns a monthly chore back into an upload.
  */
  if (looksLikeCsv(file)) {
    const text = Buffer.from(await file.arrayBuffer()).toString('utf8');
    const detected = detectStatementColumns(text);
    const asked = readMapping(form);
    const mapping = asked ?? remembered(form) ?? detected.mapping;
    const figures = readStatementCsv(text, mapping);
    if (figures === null) {
      return Response.json(
        {
          prefilledFrom: 'csv',
          csv: { headers: detected.headers, mapping, confident: false, preview: previewOf(text) },
          error: 'Could not find a date and a balance in that file — say which columns they are in.',
        },
        { status: 200 },
      );
    }
    return Response.json({
      prefilledFrom: 'csv',
      balance: { valueCents: figures.balanceCents },
      statementDate: { date: figures.statementDate },
      interest: figures.interestCents === null ? null : { valueCents: figures.interestCents },
      csv: {
        headers: detected.headers,
        mapping,
        // Asked-for mappings are confident by definition: a person just chose them.
        confident: asked !== null || detected.confident,
        preview: figures.preview,
      },
    });
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
