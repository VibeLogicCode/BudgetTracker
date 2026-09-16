'use client';

import { useMemo, useState } from 'react';
import { FileDrop } from '@/components/FileDrop';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { ImportHistoryCard } from '@/components/ImportHistoryCard';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill, type PillTone } from '@/components/ui/Pill';
import { buttonClass } from '@/components/ui/Button';
import type { ImportMapping } from '@/lib/import/mapping';
import { ImportClient, type AccountOption, type ProfileOption, type PersonOption } from './import-client';
import type { ImportHistoryRow } from '@/lib/import/commit';

/**
 * 2026-09-15. Ten statements dropped at once, detected together, shown as one list.
 *
 * The reported problem: ten statements downloaded in one sitting, then fed in one at a time,
 * with the occasional file imported twice because nothing said it had already been done. The
 * design and its rulings are docs/superpowers/specs/2026-09-15-batch-import-design.md.
 *
 * WHAT THIS COMPONENT IS NOT. It is not a second import screen. It decides nothing about a file --
 * every status on it comes from the SAME two detectors the one-file page uses (ruling B1), and
 * every commit goes through the SAME `commitStagedImport` (ruling B2). Opening any row mounts the
 * real ImportClient, seeded with the detection the list already has, so "look at this one properly"
 * and "look at one file" are the same screen rather than two that can drift.
 */

/** Mirrors BatchDetectRow in src/app/api/import/batch/detect/route.ts -- see DetectionResult in
 *  import-client.tsx for why a 'use client' module declares the shape rather than importing it. */
export interface BatchRow {
  status: 'ready' | 'already-imported' | 'needs-you' | 'unsupported';
  filename: string;
  reason: string | null;
  stagingId: string | null;
  rowCount: number;
  account: { id: number; name: string } | null;
  accountConfidence: 'certain' | 'likely' | 'none' | null;
  profile: { id: number; name: string } | null;
  profileConfidence: 'certain' | 'likely' | 'none' | null;
  source: 'csv' | 'ofx' | null;
  counts: { totalRows: number; duplicateCount: number; errorCount: number; willImport: number } | null;
}

interface CommitOutcome {
  filename: string;
  ok: boolean;
  rowsAdded?: number;
  rowsDuplicate?: number;
  error?: string;
}

const STATUS_LABEL: Record<BatchRow['status'], string> = {
  ready: 'Ready',
  'already-imported': 'Already imported',
  'needs-you': 'Needs you',
  unsupported: 'Skipped',
};

const STATUS_TONE: Record<BatchRow['status'], PillTone> = {
  ready: 'positive',
  'already-imported': 'neutral',
  'needs-you': 'warning',
  unsupported: 'neutral',
};

export function BatchClient(props: {
  accounts: AccountOption[];
  profiles: ProfileOption[];
  history: ImportHistoryRow[];
  simplefinManaged: string[];
  people?: PersonOption[];
}) {
  const { history } = props;
  const [rows, setRows] = useState<BatchRow[] | null>(null);
  const [open, setOpen] = useState<BatchRow | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [outcomes, setOutcomes] = useState<CommitOutcome[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const ready = useMemo(() => (rows ?? []).filter((row) => row.status === 'ready'), [rows]);

  /** What the whole go-group will actually do, summed from each file's own preview. */
  const readyTotals = useMemo(
    () =>
      ready.reduce(
        (total, row) => ({
          totalRows: total.totalRows + (row.counts?.totalRows ?? row.rowCount),
          duplicateCount: total.duplicateCount + (row.counts?.duplicateCount ?? 0),
          willImport: total.willImport + (row.counts?.willImport ?? row.rowCount),
        }),
        { totalRows: 0, duplicateCount: 0, willImport: 0 },
      ),
    [ready],
  );

  /**
   * Which mapping a ready row commits with. The profile the DETECTOR chose, never the account's
   * pin: the pin is what the account usually uses and the detection is what this file actually
   * reads as, and when they disagree the file in hand is the better evidence.
   *
   * An OFX row has no profile at all (ruling B7) and needs none -- flow.ts dispatches on the
   * file's CONTENT and ignores the mapping entirely for one. It still has to send SOMETHING,
   * because `imports.profile_id` records what was used; the account's pin, else the first
   * offered profile, is the same answer the one-file page's picker would have been showing.
   */
  function mappingFor(row: BatchRow): { profileId: number; mapping: ImportMapping } | null {
    const detected = props.profiles.find((profile) => profile.id === row.profile?.id);
    if (detected !== undefined) return { profileId: detected.id, mapping: detected.mapping };
    const pinned = props.accounts.find((account) => account.id === row.account?.id)?.importProfileId;
    const fallback = props.profiles.find((profile) => profile.id === pinned) ?? props.profiles[0];
    return fallback === undefined ? null : { profileId: fallback.id, mapping: fallback.mapping };
  }

  async function detectAll(files: File[]) {
    setError(null);
    setOutcomes(null);
    setConfirming(false);
    setBusy(true);
    try {
      const form = new FormData();
      for (const file of files) form.append('files', file);
      const response = await fetch('/api/import/batch/detect', { method: 'POST', body: form });
      const body = (await response.json()) as { rows?: BatchRow[]; error?: string };
      if (!response.ok) {
        setError(body.error ?? 'Those files could not be read.');
        return;
      }
      setRows(body.rows ?? []);
    } catch {
      setError('Those files could not be read.');
    } finally {
      setBusy(false);
    }
  }

  async function commitReady() {
    setError(null);
    setBusy(true);
    try {
      const files = ready.flatMap((row) => {
        const resolved = mappingFor(row);
        if (resolved === null || row.stagingId === null || row.account === null) return [];
        return [
          {
            stagingId: row.stagingId,
            filename: row.filename,
            accountId: row.account.id,
            profileId: resolved.profileId,
            mapping: resolved.mapping,
          },
        ];
      });
      const response = await fetch('/api/import/batch/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files }),
      });
      const body = (await response.json()) as { results?: CommitOutcome[]; error?: string };
      if (!response.ok) {
        setError(body.error ?? 'Those files could not be imported.');
        return;
      }
      setOutcomes(body.results ?? []);
      setConfirming(false);
      // The imported rows leave the list; whatever still needs a person stays on it, which is the
      // list's whole job once the easy ones are gone.
      setRows((previous) => (previous ?? []).filter((row) => row.status !== 'ready'));
    } catch {
      setError('Those files could not be imported.');
    } finally {
      setBusy(false);
    }
  }

  if (open !== null) {
    return (
      <ImportClient
        // A row is a different file: remounting is what stops the previous row's mapping and
        // pickers leaking into this one, which is the defect v1.37.0's detect-on-choose fixed for
        // the single-file page and would otherwise reappear here.
        key={open.stagingId ?? open.filename}
        {...props}
        initialDetection={
          open.stagingId === null
            ? null
            : {
                stagingId: open.stagingId,
                filename: open.filename,
                profile: open.profile,
                profileReason: open.reason ?? '',
                profileConfidence: open.profileConfidence ?? 'none',
                source: open.source ?? 'csv',
                account: open.account,
                accountReason: open.reason ?? '',
                accountConfidence: open.accountConfidence ?? 'none',
              }
        }
        onBackToList={() => setOpen(null)}
        onDiscard={() => {
          // Off the list and back to it. The staged bytes are left to the ordinary sweep that
          // clears DATA_DIR/tmp (src/lib/import/staging.ts) rather than deleted through a route
          // of their own -- discarding is a change of mind about importing, not a demand that
          // something be erased, and the sweep already owns that file's lifetime.
          setRows((previous) => (previous ?? []).filter((entry) => entry.stagingId !== open.stagingId));
          setOpen(null);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        title="Import"
        description="Drop everything you downloaded. Each file is read and sorted before anything is written."
        actions={
          <a href="/import/wizard" className={buttonClass('secondary')}>
            Add a bank
          </a>
        }
      />

      {/*
        The page's own explanation, moved UP here with the landing screen. It used to live in
        ImportClient, which is now one click in -- and a guide nobody reaches until they have
        already worked out what to do is not a guide. Guard 3 (tests/ops/onboarding-coverage.ts)
        caught exactly this the moment the page started rendering this component instead.
      */}
      <PageGuide>
        <p>
          This is where bank statements become transactions. Download whatever your bank gives you
          — most call it &ldquo;export&rdquo; or &ldquo;download transactions&rdquo; — and drop the
          whole lot here at once, a zip included. Each file is read and sorted before anything is
          written, and nothing is written until you say so.
        </p>
        <p>
          Files marked <strong className="font-semibold text-ink">Ready</strong> were recognised:
          the app knows which account and which column layout they use. One button imports all of
          them, after showing you what it is about to do. Anything it could not place says so in
          its own words and waits for you.
        </p>
        <p>
          A file whose rows are all already here is marked{' '}
          <strong className="font-semibold text-ink">Already imported</strong> rather than run
          again. Re-importing was always safe — matching rows are counted as duplicates and left
          out — but now you can see it before spending the time.
        </p>
        <p>
          A bank the app has never seen has no column layout yet. Open that row, or use{' '}
          <strong className="font-semibold text-ink">Add a bank</strong>, and point out which
          column is the date, the amount and the description. That mapping is saved against the
          account, so the next statement from the same bank needs no setup.
        </p>
      </PageGuide>

      {error === null ? null : <Notice tone="warning">{error}</Notice>}

      {outcomes === null ? null : (
        <Card>
          <CardHeader
            title={`Imported ${outcomes.filter((outcome) => outcome.ok).length} of ${outcomes.length}`}
            description="Each file is its own import, with its own undo under History."
          />
          <ul className="border-t border-line text-sm">
            {outcomes.map((outcome) => (
              <li key={outcome.filename} className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 last:border-b-0 sm:px-5">
                <span className="font-medium text-ink">{outcome.filename}</span>
                <span className="text-muted">
                  {outcome.ok
                    ? `${outcome.rowsAdded ?? 0} added, ${outcome.rowsDuplicate ?? 0} already there`
                    : (outcome.error ?? 'Could not be imported')}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Drop your statements"
          description="As many as you like, or a zip of them. Files that cannot be read are listed and skipped rather than stopping the rest."
        />
        <CardBody>
          <FileDrop
            name="files"
            multiple
            // .zip is here and NOT on the single-file page's own input: only this screen can do
            // anything with an archive, because opening one produces several files and that is a
            // list, which is the thing this screen is.
            accept=".csv,.ofx,.qfx,.zip,text/csv"
            label={busy ? 'Reading…' : 'Choose files'}
            disabled={busy}
            onFiles={detectAll}
            hint="CSV, OFX/QFX, or a zip of them. Nothing is written until you confirm."
          />
        </CardBody>
      </Card>

      {rows === null || rows.length === 0 ? null : (
        <Card>
          <CardHeader
            title={`${rows.length} ${rows.length === 1 ? 'file' : 'files'}`}
            description="Click any row to open it properly — preview, pickers and column mapping, exactly as a single file."
            action={
              ready.length === 0 ? null : (
                <button type="button" disabled={busy} onClick={() => setConfirming(true)} className={buttonClass('primary', 'sm')}>
                  {`Import the ${ready.length} ready ${ready.length === 1 ? 'one' : 'ones'}`}
                </button>
              )
            }
          />

          {/* "Likely is enough, but show me first" -- chosen deliberately on
              2026-09-15. The group button opens this rather than committing, so the one screen
              nobody previewed is still a screen somebody accepted. */}
          {!confirming ? null : (
            <CardBody>
              <Notice tone="info">
                {/* The honest headline: what will ARRIVE, not how many rows were read. */}
                <p className="font-medium text-ink">
                  {`About to import ${readyTotals.willImport} ${readyTotals.willImport === 1 ? 'transaction' : 'transactions'} from ${ready.length} ${ready.length === 1 ? 'file' : 'files'}.`}
                </p>
                {readyTotals.duplicateCount === 0 ? null : (
                  <p className="text-muted">{`${readyTotals.duplicateCount} of the ${readyTotals.totalRows} rows read are already here and will be left out.`}</p>
                )}
                <ul className="mt-2 flex flex-col gap-1">
                  {ready.map((row) => (
                    <li key={row.stagingId ?? row.filename}>
                      {row.filename} → {row.account?.name ?? 'no account'} ·{' '}
                      {row.counts === null ? `${row.rowCount} rows` : `${row.counts.willImport} of ${row.counts.totalRows} rows`}
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" disabled={busy} onClick={commitReady} className={buttonClass('primary', 'sm')}>
                    Yes, import them
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className={buttonClass('secondary', 'sm')}>
                    Back
                  </button>
                </div>
              </Notice>
            </CardBody>
          )}

          {/*
            "View rows" also appears in History below, where it means "the transactions this import
            already created". Here it means "what is in this file before anything is imported".
            Both are the right words for their own card, and the two cards are far apart with their
            own headings -- but the duplication is deliberate rather than accidental, and this is
            where it is written down.
          */}
          <ul data-testid="batch-list" className="border-t border-line text-sm">
            {rows.map((row) => {
              const openable = row.stagingId !== null;
              return (
                <li key={`${row.filename}-${row.stagingId ?? 'none'}`} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    disabled={!openable}
                    onClick={() => setOpen(row)}
                    className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent sm:px-5"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium text-ink">{row.filename}</span>
                      <span className="text-xs text-muted">
                        {row.account === null ? 'No account decided' : row.account.name}
                        {row.profile === null ? '' : ` · ${row.profile.name}`}
                      </span>
                      {/*
                        2026-09-15. "7 rows" used to be the whole of this line, and it reads as a
                        promise to add seven when the file is about to add one. These are the
                        preview's OWN numbers (see countsFor in the batch detect route), so the
                        figure here is the figure on the screen the row opens.
                      */}
                      {row.counts === null ? (
                        row.rowCount > 0 ? <span className="text-xs text-muted">{`${row.rowCount} rows`}</span> : null
                      ) : (
                        <span className="text-xs text-muted">
                          {`${row.counts.totalRows} rows`}
                          {row.counts.duplicateCount > 0 ? ` · ${row.counts.duplicateCount} already here` : ''}
                          {row.counts.errorCount > 0 ? ` · ${row.counts.errorCount} unreadable` : ''}
                          {' · '}
                          <span className={row.counts.willImport > 0 ? 'font-medium text-ink' : ''}>
                            {row.counts.willImport === 0 ? 'nothing to import' : `${row.counts.willImport} to import`}
                          </span>
                        </span>
                      )}
                      {row.reason === null ? null : <span className="text-xs text-subtle">{row.reason}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      {/*
                        The click target says what it does. A whole row that is silently a button
                        is a guess, and the two things a row can lead to are genuinely different:
                        a file we could read opens on its rows, one we could not opens on the
                        pickers that fix it (reported 2026-09-15).
                      */}
                      {!openable ? null : (
                        <span className="text-sm font-medium text-accent-text underline underline-offset-2">
                          {row.status === 'needs-you' ? 'Set it up' : 'View rows'}
                        </span>
                      )}
                      <Pill tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Pill>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/*
        Behind a toggle, and only on this screen. History is a reference -- "what did I bring in,
        and can I take it back" -- not part of importing, and a long table under the thing you are
        working on is noise most of the time. It is gone entirely from the single-file view, where
        it answered a question nobody was asking at that moment.
      */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowHistory((shown) => !shown)}
          aria-expanded={showHistory}
          className={buttonClass('secondary', 'sm')}
        >
          {showHistory ? 'Hide history' : 'Show history'}
        </button>
      </div>
      {showHistory ? <ImportHistoryCard history={history} /> : null}
    </div>
  );
}
