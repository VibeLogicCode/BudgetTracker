'use client';

import { useActionState, useEffect, useMemo, useState } from 'react';
import { MappingEditor } from '@/components/MappingEditor';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { buttonClass } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, inputClass } from '@/components/ui/form';
import type { ImportMapping } from '@/lib/import/mapping';
import { detectDateFormat } from '@/lib/import/detect-date-format';
import { STAGED_FILE_GONE_SENTENCE, STAGED_FILE_MISSING, importHeldFileHref, type HeldFile } from '@/lib/import/held-file';
import { saveWizardProfileAction, type WizardState } from '../actions';

const initial: WizardState = {};

const fileInputClass =
  'text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-accent-soft-fg';

/** Where the file the wizard was opened on stands. 'none' is the wizard opened on no file at all. */
type HeldState = 'none' | 'reading' | 'read' | 'gone' | 'failed';

export function WizardClient({
  starterMapping,
  heldFile = null,
}: {
  starterMapping: ImportMapping;
  /**
   * v1.55.2. A file the import screen already staged ("Add a bank" from a file no profile could
   * read). The wizard reads its columns by id instead of asking for the same file again, keeps it
   * when the profile is saved, and leads straight back to importing it.
   */
  heldFile?: HeldFile | null;
}) {
  const [mapping, setMapping] = useState<ImportMapping>(starterMapping);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [stagingId, setStagingId] = useState<string>('');
  const [filename, setFilename] = useState<string>(heldFile?.filename ?? '');
  const [encoding, setEncoding] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState<HeldState>(heldFile === null ? 'none' : 'reading');
  const [state, save] = useActionState(saveWizardProfileAction, initial);

  // Opened from the import screen: the file here is the one being imported, not a throwaway sample.
  const fromImport = heldFile !== null;
  const heldStagingId = heldFile?.stagingId ?? null;

  useEffect(() => {
    if (heldStagingId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/import/raw-preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stagingId: heldStagingId }),
        });
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          // A swept file is asked for again in a sentence; anything else is its own error. Either
          // way the file input comes back, so the page is never left with nothing to do.
          if (body.code === STAGED_FILE_MISSING) setHeld('gone');
          else {
            setHeld('failed');
            setError(body.error ?? 'That file could not be read.');
          }
          return;
        }
        setRows(body.rows as string[][]);
        setStagingId(body.stagingId as string);
        setEncoding(body.encoding as string);
        setHeld('read');
      } catch {
        if (cancelled) return;
        setHeld('failed');
        setError('That file could not be read.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [heldStagingId]);

  // This posts a file and stages it server-side, so a double-submit stages the same
  // sample twice and orphans the second staging id. The guard is SubmitButton's
  // useFormStatus rather than a local `busy` flag on purpose: React 19 holds state
  // updates made inside an async form action until that action settles, so a
  // setBusy(true) at the top of this function would not render until it is already
  // too late to matter. useFormStatus reads the form's real pending state.
  async function upload(formData: FormData) {
    setError(null);
    // Only reachable with the file input on screen, which a held file in 'reading'/'read' hides.
    const response = await fetch('/api/import/raw-preview', { method: 'POST', body: formData });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Upload failed');
      return;
    }
    setRows(body.rows as string[][]);
    setStagingId(body.stagingId as string);
    setEncoding(body.encoding as string);
    setFilename((body.filename as string | undefined) ?? '');
    // A file chosen here replaces a held one that was gone or unreadable, so the warning about it
    // goes. The input stays, in case a different file is wanted.
    setHeld('none');
  }

  // /api/import/raw-preview hands back every line of the sample untouched — it does not
  // know yet which rows are headers, since that is exactly what this screen is for
  // deciding. Skip the same rows parseCsv (src/lib/import/parse.ts) would skip before
  // sampling the date column, or a literal "Date" header row poisons detection into
  // reporting 'none' for a perfectly normal file.
  const dateFormatDetection = useMemo(() => {
    if (!rows) return null;
    const skip = mapping.hasHeader ? Math.max(mapping.headerRows, 1) : mapping.headerRows;
    return detectDateFormat(rows.slice(skip).map((row) => row[mapping.dateCol] ?? ''));
  }, [rows, mapping.hasHeader, mapping.headerRows, mapping.dateCol]);

  const showFileInput = held === 'none' || held === 'gone' || held === 'failed';

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        eyebrow="Import"
        title="Add a bank"
        description={
          fromImport
            ? 'The first rows of the file you were importing are shown with their column numbers so you can say which column holds the date, the description and the amount. Saving keeps the file, so you can import it straight after.'
            : 'Upload a sample export from the bank. The first rows are shown with their column numbers so you can say which column holds the date, the description and the amount. Nothing is imported here — this only saves a reusable profile.'
        }
      />

      <FormError message={error ?? state.error} />
      {state.message ? <Notice tone="success">{state.message}</Notice> : null}
      {/* v1.55.2. The way back to the file this wizard was opened on. The import page reads it
          again with the new profile among the candidates, so it lands on that file's pickers or
          straight on its rows -- never on an empty drop zone asking for the same file. */}
      {state.message && fromImport && stagingId !== '' ? (
        <a href={importHeldFileHref({ stagingId, filename })} className={`${buttonClass('primary')} self-start`}>
          Import {filename} now
        </a>
      ) : null}

      <Card>
        {showFileInput ? (
          <>
            <CardHeader title="Sample file" description="A short export is plenty — the first handful of rows is all this needs." />
            <CardBody className="flex flex-col gap-3">
              {held === 'gone' ? <Notice tone="warning">{STAGED_FILE_GONE_SENTENCE}</Notice> : null}
              <form action={upload} className="flex flex-wrap items-center gap-3">
                <input type="file" name="file" accept=".csv,text/csv" required className={fileInputClass} />
                <SubmitButton>Show the first rows</SubmitButton>
              </form>
            </CardBody>
          </>
        ) : (
          <>
            <CardHeader title="The file you were importing" description="Its first rows are below, read from the copy the import screen already holds." />
            <CardBody>
              <p className="text-sm text-ink">
                <span className="font-medium">{heldFile?.filename}</span>
                {held === 'reading' ? <span className="text-muted"> — reading…</span> : null}
              </p>
            </CardBody>
          </>
        )}
      </Card>

      {rows ? (
        <>
          <Card>
            <CardHeader title="What the file looks like" description={`Detected encoding: ${encoding}`} />
            <TableWrap bare className="max-h-96 overflow-y-auto">
              <thead>
                <tr>
                  {(rows[0] ?? []).map((_, index) => (
                    <th scope="col" key={index}>col {index}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      // A capped, ellipsised cell needs the full value on hover, or a wide
                      // column in someone's file is silently unreadable in the one place they
                      // are being asked to identify it.
                      <td key={cellIndex} className="max-w-40 truncate text-xs" title={cell}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </Card>

          <Card>
            <CardHeader title="Which column is which" description="Column numbers start at 0, matching the headings above." />
            <CardBody>
              <MappingEditor mapping={mapping} onChange={setMapping} dateFormatDetection={dateFormatDetection} />
            </CardBody>
          </Card>

          <Card className="max-w-md">
            <CardHeader title="Save this profile" description="Reusable for every future import from this bank." />
            <CardBody>
              <form action={save} className="flex flex-col gap-4">
                <input type="hidden" name="mapping" value={JSON.stringify(mapping)} />
                <input type="hidden" name="stagingId" value={stagingId} />
                {/* v1.55.2: the file is about to be imported, so saving must not delete it. */}
                {fromImport ? <input type="hidden" name="keepStaged" value="1" /> : null}
                <Field label="Profile name">
                  <input name="name" placeholder="Tangerine Chequing" required className={inputClass} />
                </Field>
                <Field label="Institution">
                  <input name="institution" placeholder="Tangerine" required className={inputClass} />
                </Field>
                <SubmitButton className="w-fit">Save profile</SubmitButton>
              </form>
            </CardBody>
          </Card>
        </>
      ) : null}
    </div>
  );
}
