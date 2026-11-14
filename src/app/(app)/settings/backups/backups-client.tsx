'use client';

import { useActionState, useRef, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { ImportIcon } from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Field } from '@/components/ui/form';
import type { BackupHealth } from '@/lib/backup';
import type { RestoreOutcome, RestoreRequest } from '@/lib/backup/restore';
import { runBackupNowAction, setRetentionAction, stageRestoreAction, type BackupActionState } from './actions';
import { buttonClass } from '@/components/ui/Button';

const initial: BackupActionState = {};

function formatStamp(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

/**
 * v1.63.0: what a restore does, said once. The row panel and the Restore from a file card both
 * render this, so the two can never drift apart. Every phrase is worded distinctly enough that it
 * cannot also match a submit button's own label (which itself contains the word "restart").
 */
function RestoreWarnings({ name }: { name: string }) {
  return (
    <div data-testid="restore-warnings" className="flex flex-col gap-3">
      <p className="text-ink">
        Restore <strong className="font-semibold">{name}</strong>? This replaces all data currently in the app with the contents of
        that backup. The current database is kept as <code className="rounded bg-surface px-1 font-mono text-xs">data/budget.pre-restore-&lt;timestamp&gt;.db</code>.
      </p>
      <p className="text-ink">
        Users, passwords, two-factor settings and deactivations return to the backup&apos;s state, and everyone signs in again.
        Two-factor sign-in and saved connection secrets need this install&apos;s <code className="font-mono">secret.key</code> to
        match the one the backup was made with.
      </p>
      <p className="text-xs text-muted">
        The app restarts to apply this. If your container has no restart policy (this install&apos;s{' '}
        <code className="font-mono">docker-compose.yml</code> ships <code className="font-mono">restart: unless-stopped</code>), the restore still takes effect
        the next time the app starts — nothing is lost, only the automatic part.
      </p>
    </div>
  );
}

/**
 * MUST-20.35 / MUST-20.30: an inline confirm panel, not `window.confirm` — the latter is
 * untestable in jsdom and cannot carry this much wording.
 *
 * It REPLACES the row rather than expanding under it: this is a destructive step, and the
 * row's own Restore button has no business staying clickable behind the confirmation.
 */
function RestorePanel({
  backup,
  confirmed,
  onConfirmedChange,
  onCancel,
  action,
  disabled,
  error,
}: {
  backup: { name: string };
  confirmed: boolean;
  onConfirmedChange: (value: boolean) => void;
  onCancel: () => void;
  action: (formData: FormData) => void;
  disabled: boolean;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-3 border-l-2 border-warning bg-warning-soft/40 px-4 py-4 text-sm sm:px-5">
      <RestoreWarnings name={backup.name} />
      {/* IMPORTANT (review): a restore refusal (F5/F6/F7) must surface right where the admin is
          looking, not only in a top-level banner a stale retention/backup-now message could be
          masking. */}
      <FormError message={error} />
      <label className="flex items-center gap-2 text-ink">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => onConfirmedChange(event.target.checked)}
          disabled={disabled}
          className="accent-accent"
        />
        I understand this replaces the current data.
      </label>
      <form action={action} className="flex items-center gap-2">
        <input type="hidden" name="name" value={backup.name} />
        <input type="hidden" name="confirm" value={confirmed ? 'on' : ''} />
        <SubmitButton variant="danger" disabled={disabled || !confirmed}>Restore and restart</SubmitButton>
        <button type="button" onClick={onCancel} disabled={disabled} className={buttonClass('secondary')}>
          Cancel
        </button>
      </form>
    </div>
  );
}

const UPLOAD_URL = '/api/backup/restore-upload';
const MIB = 1024 * 1024;
/**
 * v1.63.0 fix round. From this size the card says, before the upload starts, that checking the file
 * takes a while and the app pauses meanwhile: the server checks it in one synchronous pass (an
 * accepted trade-off), so every other page waits for it.
 */
const LARGE_UPLOAD_BYTES = 512 * MIB;

const fileInputClass =
  'text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-accent-soft-fg';

function formatSize(bytes: number): string {
  if (bytes >= 1024 * MIB) return `${(bytes / (1024 * MIB)).toFixed(1).replace(/\.0$/, '')} GB`;
  if (bytes >= MIB) return `${Math.round(bytes / MIB)} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

interface UploadReply {
  id?: unknown;
  received?: unknown;
  error?: unknown;
  restarting?: unknown;
  message?: unknown;
}

/**
 * One request of the upload. XMLHttpRequest rather than fetch, for upload progress. Never rejects:
 * a network failure comes back as status 0 so the caller decides what to do with it.
 */
function send(
  method: string,
  url: string,
  body: Blob | string | null,
  contentType: string | null,
  onProgress?: (loaded: number) => void,
): Promise<{ status: number; reply: UploadReply }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    if (contentType) xhr.setRequestHeader('content-type', contentType);
    if (onProgress) xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      let reply: UploadReply = {};
      try {
        const parsed: unknown = JSON.parse(xhr.responseText);
        if (parsed && typeof parsed === 'object') reply = parsed as UploadReply;
      } catch {
        reply = {};
      }
      resolve({ status: xhr.status, reply });
    };
    xhr.onerror = () => resolve({ status: 0, reply: {} });
    xhr.onabort = () => resolve({ status: 0, reply: {} });
    xhr.send(body);
  });
}

/**
 * v1.63.0: restore a backup from a file on this computer, for moving to a new machine. The file
 * goes up in pieces (src/lib/backup/restore-upload.ts explains why), then the server stages it
 * through exactly the checks a listed backup passes and the app restarts.
 */
function RestoreFromFileCard({
  maxBytes,
  chunkBytes,
  disabled,
  onRestarting,
}: {
  maxBytes: number;
  chunkBytes: number;
  disabled: boolean;
  onRestarting: (message: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'checking'>('idle');
  const [sent, setSent] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  /**
   * v1.63.0 fix round. What the live region says. Coarse on purpose: the start, every tenth of the
   * file, then the check -- never each progress event, which would talk over everything else.
   */
  const [announcement, setAnnouncement] = useState('');
  const tenthsAnnounced = useRef(0);

  const tooLarge = file !== null && file.size > maxBytes;
  const busy = phase !== 'idle';

  function choose(next: File | null) {
    setFile(next);
    setConfirmed(false);
    setError(undefined);
  }

  /** A refusal at any step: say why here, and drop whatever the server holds (best effort). */
  function stop(message: unknown, id: string | null) {
    if (id !== null) void send('DELETE', `${UPLOAD_URL}/${encodeURIComponent(id)}`, null, null);
    setError(typeof message === 'string' && message.length > 0 ? message : 'The upload stopped. Nothing was changed.');
    // The error itself is an alert; the live region goes quiet rather than say it twice.
    setAnnouncement('');
    setPhase('idle');
  }

  /** The bytes sent so far, for the bar, and a word for the live region at each new tenth. */
  function progress(bytes: number, total: number) {
    setSent(bytes);
    const tenths = total > 0 ? Math.floor((bytes * 10) / total) : 10;
    if (tenths > tenthsAnnounced.current && tenths < 10) {
      tenthsAnnounced.current = tenths;
      setAnnouncement(`Uploaded ${tenths * 10}%.`);
    }
  }

  async function upload(chosen: File) {
    const total = chosen.size;
    setError(undefined);
    setSent(0);
    tenthsAnnounced.current = 0;
    setAnnouncement('Upload started.');
    setPhase('uploading');

    const start = await send('POST', UPLOAD_URL, JSON.stringify({ name: chosen.name, bytes: total, confirm: true }), 'application/json');
    if (start.status !== 200 || typeof start.reply.id !== 'string') return stop(start.reply.error, null);
    const id = start.reply.id;
    const base = `${UPLOAD_URL}/${encodeURIComponent(id)}`;

    let offset = 0;
    let retried = false;
    while (offset < total) {
      const from = offset;
      const piece = await send(
        'PUT',
        `${base}?offset=${from}`,
        chosen.slice(from, Math.min(from + chunkBytes, total)),
        'application/octet-stream',
        (loaded) => progress(from + loaded, total),
      );
      const received = piece.reply.received;
      const reported = typeof received === 'number' && received >= 0 && received <= total ? received : null;
      if (piece.status === 200 && reported !== null && reported > from) {
        offset = reported;
        progress(offset, total);
        retried = false;
        continue;
      }
      // The server already holds more than this piece started from: carry on from there.
      if (piece.status === 409 && reported !== null && reported > from) {
        offset = reported;
        progress(offset, total);
        continue;
      }
      // One automatic retry, from wherever the server says the upload stands.
      if (retried) return stop(piece.reply.error, id);
      retried = true;
      if (piece.status === 409 && reported !== null) offset = reported;
    }

    setPhase('checking');
    setAnnouncement('Upload finished. Checking the backup. A large archive can take a few minutes.');
    const finish = await send('POST', base, null, null);
    if (finish.status === 200 && finish.reply.restarting === true) {
      onRestarting(
        typeof finish.reply.message === 'string'
          ? finish.reply.message
          : 'Restoring. The app will restart. Refresh this page in about 30 seconds.',
      );
      return;
    }
    stop(finish.reply.error, id);
  }

  return (
    <Card>
      <CardHeader
        title="Restore from a file"
        description="For moving to a new machine: an archive downloaded from another install (.tar.gz), or an older .db backup."
      />
      <CardBody className="flex flex-col gap-3 text-sm">
        <input
          type="file"
          accept=".gz,.tgz,.db"
          aria-label="Backup file to restore"
          disabled={disabled || busy}
          onChange={(event) => choose(event.target.files?.[0] ?? null)}
          className={fileInputClass}
        />
        {file ? (
          <p className="text-ink">
            <span className="font-mono text-xs">{file.name}</span>{' '}
            <span className="tabnum text-xs text-subtle">· {formatSize(file.size)}</span>
          </p>
        ) : null}
        {file && tooLarge ? (
          <FormError
            message={`That file is ${formatSize(file.size)}; a restore from a file takes at most ${formatSize(maxBytes)}. Use the restore-backup command for a larger archive.`}
          />
        ) : null}
        {file && !tooLarge ? (
          <div className="flex flex-col gap-3 border-l-2 border-warning bg-warning-soft/40 px-4 py-4">
            <RestoreWarnings name={file.name} />
            {file.size >= LARGE_UPLOAD_BYTES ? (
              <p className="text-ink">Checking a file this size can take a few minutes, and the app pauses for everyone until it is done.</p>
            ) : null}
            <FormError message={error} />
            <label className="flex items-center gap-2 text-ink">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                disabled={disabled || busy}
                className="accent-accent"
              />
              I understand this replaces the current data.
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void upload(file)}
                disabled={disabled || busy || !confirmed}
                className={buttonClass('danger')}
              >
                Upload, restore and restart
              </button>
              {phase === 'uploading' ? (
                <span className="flex items-center gap-2">
                  <progress
                    max={file.size}
                    value={Math.min(sent, file.size)}
                    aria-label="Upload progress"
                    className="h-2 w-32 accent-accent"
                  />
                  <span className="tabnum text-xs text-muted">
                    Uploading {Math.floor(sent / MIB)} of {Math.ceil(file.size / MIB)} MB
                  </span>
                </span>
              ) : null}
              {phase === 'checking' ? (
                <span className="text-xs text-muted">Checking the backup. A large archive can take a few minutes.</span>
              ) : null}
            </div>
          </div>
        ) : null}
        {/* Present from the first render, so the first announcement is heard: a live region added
            at the same moment as its text is often not read at all. */}
        <p role="status" aria-live="polite" className="sr-only" data-testid="upload-announcer">
          {announcement}
        </p>
      </CardBody>
    </Card>
  );
}

function ResultBanner({ result }: { result: RestoreOutcome }) {
  if (result.status === 'failed') {
    return <FormError message={result.error ?? 'The last restore failed.'} />;
  }
  return (
    <Notice tone="success">
      <p>
        Restored {result.sourceName} on {formatStamp(result.finishedAt)} — {result.receiptsRestored} receipt files
        restored.
        {/* M4 (review): a success outcome should never say "no safety copy" — that phrase implied
            nothing was replaced, contradicting the banner it sits in. Omit the clause instead. */}
        {result.safetyCopy ? <> The previous database was kept as {result.safetyCopy}.</> : null}
      </p>
      <p>Users, passwords, two-factor settings and deactivations are as they were in that backup, and everyone signs in again.</p>
    </Notice>
  );
}

export function BackupsClient({
  backups,
  retention,
  restore,
  health = null,
  upload,
}: {
  backups: { name: string; bytes: number; modifiedAt: string }[];
  retention: number;
  restore: { staged: RestoreRequest | null; result: RestoreOutcome | null };
  /** v1.60.0: backupHealth(); its failure reason is shown while the last backup has failed. */
  health?: BackupHealth | null;
  /** v1.63.0: the restore upload's limits (src/lib/backup/restore-upload.ts), passed by the page. */
  upload: { maxBytes: number; chunkBytes: number };
}) {
  const [retentionState, retentionAction] = useActionState(setRetentionAction, initial);
  const [restoreState, restoreAction] = useActionState(stageRestoreAction, initial);
  const [notice, setNotice] = useState<BackupActionState | null>(null);
  const [running, setRunning] = useState(false);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [uploadRestarting, setUploadRestarting] = useState<string | null>(null);

  // MUST-20.30/20.35: once the stage succeeds the process is about to exit — nothing else on
  // the page is worth rendering, let alone clicking. A restore from a file ends the same way.
  const restartingMessage = restoreState.restarting ? restoreState.message : uploadRestarting;
  if (restartingMessage) {
    return (
      <div className="flex flex-col gap-4 sm:gap-5">
        <PageHeader eyebrow="Settings" title="Backups" />
        <Notice tone="info" role="status">
          {restartingMessage}
        </Notice>
      </div>
    );
  }

  function openRow(name: string) {
    setOpenFor(name);
    setConfirmed(false);
  }
  function closeRow() {
    setOpenFor(null);
    setConfirmed(false);
  }

  const stagedElsewhere = restore.staged !== null;

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        eyebrow="Settings"
        title="Backups"
        description="A nightly archive of the database and every receipt, kept on this machine."
        actions={
          <a href="/api/backup/download" className={buttonClass('primary')}>
            Download backup now
          </a>
        }
      />

      {/* IMPORTANT (review): restoreState.error is deliberately NOT included here — a stale
          retention/backup-now error would otherwise permanently mask a restore refusal. It is
          rendered inside RestorePanel instead, where the admin is actually looking. */}
      <FormError message={retentionState.error ?? notice?.error} />
      {retentionState.message ?? notice?.message ? (
        <Notice tone="success">{retentionState.message ?? notice?.message}</Notice>
      ) : null}
      {health?.state === 'failed' ? (
        <Notice tone="warning" title="The last backup failed">
          <p>{health.failureReason}</p>
        </Notice>
      ) : null}
      {restore.result ? <ResultBanner result={restore.result} /> : null}
      {stagedElsewhere ? (
        <Notice tone="warning">A restore is staged and will be applied the next time the app starts.</Notice>
      ) : null}

      <Card>
        <CardHeader title="Schedule" description="The job runs at 02:00 local time." />
        <CardBody className="flex flex-wrap items-end gap-6">
          <form action={retentionAction} className="flex items-end gap-2">
            <Field label="Keep this many nightly backups">
              <input
                type="number"
                name="retention"
                min={1}
                max={365}
                defaultValue={retention}
                className="field-control w-24"
              />
            </Field>
            <SubmitButton>Save</SubmitButton>
          </form>
          <button
            type="button"
            disabled={running}
            onClick={async () => {
              setRunning(true);
              try {
                const result = await runBackupNowAction();
                setNotice(result);
              } finally {
                setRunning(false);
              }
            }}
            className={buttonClass('secondary')}
          >
            {running ? 'Running…' : 'Run the nightly job now'}
          </button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Nightly history" description={`${backups.length} archive${backups.length === 1 ? '' : 's'} on disk.`} />
        {backups.length === 0 ? (
          <EmptyState
            icon={ImportIcon}
            title="No backups yet. The job runs at 02:00 local time."
            action={
              <a href="/api/backup/download" className={buttonClass('primary', 'sm')}>
                Download backup now
              </a>
            }
          >
            You can also make one right now with Download backup now.
          </EmptyState>
        ) : (
          <ul className="border-t border-line text-sm">
            {backups.map((backup) => (
              <li key={backup.name} className="border-b border-line last:border-b-0">
                {openFor === backup.name ? (
                  <RestorePanel
                    backup={backup}
                    confirmed={confirmed}
                    onConfirmedChange={setConfirmed}
                    onCancel={closeRow}
                    action={restoreAction}
                    disabled={stagedElsewhere}
                    error={restoreState.error}
                  />
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 sm:px-6">
                    <span className="font-mono text-xs text-ink">{backup.name}</span>
                    <span className="tabnum text-xs text-subtle">
                      {(backup.bytes / 1024 / 1024).toFixed(2)} MB · {backup.modifiedAt.slice(0, 16).replace('T', ' ')}
                    </span>
                    <button
                      type="button"
                      onClick={() => openRow(backup.name)}
                      disabled={stagedElsewhere}
                      className={buttonClass('secondary', 'sm')}
                    >
                      Restore
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <RestoreFromFileCard
        maxBytes={upload.maxBytes}
        chunkBytes={upload.chunkBytes}
        disabled={stagedElsewhere}
        onRestarting={setUploadRestarting}
      />

      <p className="text-xs text-subtle">
        Each backup is a <code className="font-mono">.tar.gz</code> archive containing the database and every receipt file, stored unencrypted
        under <code className="font-mono">/data/backups</code>. Older <code className="font-mono">.db</code> backups from v1.0.0 are still listed and still restore.
        Offsite copies now carry receipt photographs too — these can show names, addresses and partial card numbers, so
        for offsite copies, point Hyper Backup (or your NAS equivalent) at the <code className="font-mono">/data</code> share and enable its
        client-side encryption there. Restoring under a live SQLite connection is how you corrupt a database, which is
        why Restore above stages the request and restarts the app instead of restoring in place; the{' '}
        <code className="font-mono">restore-backup</code> command-line tool remains available as a fallback for when the app will not start
        at all.
      </p>
    </div>
  );
}
