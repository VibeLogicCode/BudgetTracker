'use client';

import { useState } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { TableWrap } from '@/components/ui/Table';
import { buttonClass } from '@/components/ui/Button';
import { ImportIcon } from '@/components/icons';
import { transactionsHref } from '@/lib/transaction-links';
import type { ImportHistoryRow } from '@/lib/import/commit';

/**
 * Every import, and the button that takes one back out.
 *
 * 2026-09-15: EXTRACTED, unchanged, from import-client.tsx. It had lived inside that component
 * since the page was written, which was fine while that component WAS the import page -- and
 * stopped being fine the moment the batch screen became the landing surface, because History then
 * only existed once a household had clicked into a single file. Reported directly:
 * "i should also have a history button on new page to take me to page that shows me history of
 * what was imported like in older screenshot."
 *
 * It owns its own rows and its own undo. The alternative -- lifting both into two parents -- would
 * have put the same fetch, the same confirm dialog and the same list-splicing in two places, and
 * the undo path is the one path on this page that deletes transactions.
 *
 * `history` seeds state and is not watched afterwards. Both parents render this beneath a server
 * component that fetches the list fresh on every navigation, so a stale prop cannot outlive the
 * page; within a page, an undo edits the list here and a fresh import is added by the parent
 * through `onUndone`'s twin, `extraRows`.
 */
export function ImportHistoryCard({
  history,
  /** Rows imported during THIS visit, which the server list (fetched before them) cannot know. */
  extraRows = [],
}: {
  history: ImportHistoryRow[];
  extraRows?: ImportHistoryRow[];
}) {
  const [historyRows, setHistoryRows] = useState<ImportHistoryRow[]>(history);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const rows = [...extraRows, ...historyRows.filter((row) => !extraRows.some((extra) => extra.id === row.id))];

  async function undo(importId: number) {
    setError(null);
    setBusy(true);
    try {
      const dialogResponse = await fetch('/api/import/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ importId }),
      });
      const counts = await dialogResponse.json();
      if (!dialogResponse.ok) {
        setError(counts.error ?? 'Could not look up this import.');
        return;
      }
      const ok = window.confirm(
        `Undo this import?\n\nWill delete ${counts.willDelete} transactions.\nWill keep ${counts.willKeep} shared with other imports.`,
      );
      if (!ok) return;

      const undoResponse = await fetch('/api/import/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ importId, confirm: true }),
      });
      const result = await undoResponse.json();
      if (!undoResponse.ok) {
        setError(result.error ?? 'Undo failed.');
        return;
      }
      // v1.12.1 (item AE / MON-5 follow-up): snapshotsDeleted was computed and returned but never
      // rendered anywhere -- the docblock in src/lib/import/commit.ts claimed it was "reported"
      // when only deleted/kept ever reached the screen. This clause is the fix; 0 says nothing
      // extra, the same convention loanLinksReversed and the skipped-rows count elsewhere follow.
      setSummary(
        `Undo complete: ${result.deleted} deleted, ${result.kept} kept` +
          (result.snapshotsDeleted > 0
            ? `, and ${result.snapshotsDeleted} balance ${result.snapshotsDeleted === 1 ? 'figure' : 'figures'} removed.`
            : '.'),
      );
      setHistoryRows((current) => current.filter((row) => row.id !== importId));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error === null ? null : <Notice tone="warning">{error}</Notice>}
      {summary === null ? null : <Notice tone="info">{summary}</Notice>}
      <Card>
        <CardHeader title="History" description="Every import, and the button that takes one back out." />
        {rows.length === 0 ? (
          <EmptyState
            icon={ImportIcon}
            title="Nothing imported yet"
            action={
              <a href="#choose-file" className={buttonClass('primary', 'sm')}>
                Upload a statement
              </a>
            }
          >
            Once you upload a statement it lands here, with an undo next to it.
          </EmptyState>
        ) : (
          <TableWrap bare fixed minWidth="63rem" responsive>
            {/* The undo button is the last column, and under auto sizing a bank's filename --
                one long unbreakable token in a monospace cell -- could push the row past the
                shell's width and take that button off the edge with it. Fixed widths keep undo
                where the eye expects it and make the filename the thing that gives way. */}
            <colgroup>
              {/* Stamp and account name are nowrap/truncated, so each needs its full run. */}
              <col style={{ width: '10rem' }} />
              <col style={{ width: '10rem' }} />
              {/* The filename gets the biggest share, and still truncates with a title. */}
              <col style={{ width: '15rem' }} />
              <col style={{ width: '7rem' }} />
              {/* Three counts, each floored by its own heading rather than its digits. */}
              <col style={{ width: '5rem' }} />
              <col style={{ width: '5rem' }} />
              <col style={{ width: '5.5rem' }} />
              <col style={{ width: '5.5rem' }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Account</th>
                <th scope="col">File</th>
                <th scope="col">By</th>
                <th scope="col" className="text-right">Added</th>
                <th scope="col" className="text-right">Dupes</th>
                <th scope="col" className="text-right">Errors</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  {/* v1.16.0 Lane C item 3: When and Account are context for the row, not the
                      fact it is about -- File (below) already carries `cell-stack-headline`, so
                      `cell-stack-meta` puts these on a small muted line under it instead of two
                      more labelled rows of their own. */}
                  <td className="tabnum whitespace-nowrap text-muted cell-stack-meta" data-label="When">
                    {row.createdAt.slice(0, 16).replace('T', ' ')}
                  </td>
                  {/* Truncate with a title, never a bare ellipsis: the full account name and
                      the full filename stay readable on hover and to a screen reader. */}
                  <td className="cell-truncate cell-stack-meta" title={row.accountName} data-label="Account">
                    {row.accountName}
                  </td>
                  {/* v1.15.0 (responsive rows): the filename is what tells one import from
                      another -- Account repeats across every re-import of the same statement --
                      so it is the phone card's headline. No cell-stack-amount: Added/Dupes/Errors
                      are row counts, not money. */}
                  <td className="cell-truncate font-mono text-xs cell-stack-headline" title={row.filename} data-label="File">
                    {row.filename}
                  </td>
                  <td className="text-muted" data-label="By">{row.importedByName}</td>
                  <td className="tabnum text-right" data-label="Added">{row.rowsAdded}</td>
                  <td className="tabnum text-right text-muted" data-label="Dupes">{row.rowsDuplicate}</td>
                  <td className="tabnum text-right text-muted" data-label="Errors">{row.rowsError}</td>
                  <td className="text-right cell-stack-actions" data-label="">
                    {/* F-03 (v1.31.0): "the rows THIS import added" -- the arrival path
                        transactions-client.tsx's own mobile-fold comment already calls out
                        (`activeImportId`, rendered as a dismissible chip regardless of the
                        filter disclosure's own open/closed state). transactionsHref, never a
                        hand-built `?import=<id>` -- see that module's docblock. Stacked above
                        Undo, not beside it: the fixed-width actions column (colgroup above) is
                        too narrow for two side-by-side buttons, and stacking needs no widening
                        of every other row's column. */}
                    <div className="flex flex-col items-end gap-1.5">
                      <a
                        href={transactionsHref({ range: null, person: null }, { kind: 'import', importId: row.id })}
                        className={buttonClass('secondary', 'sm', 'min-h-11 sm:min-h-0')}
                      >
                        View rows
                      </a>
                      <button
                        type="button"
                        onClick={() => void undo(row.id)}
                        disabled={busy}
                        className={buttonClass('secondary', 'sm')}
                      >
                        Undo
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
