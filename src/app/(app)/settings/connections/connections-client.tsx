'use client';

import { useState } from 'react';
import { FormError } from '@/components/FormError';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Field, inputClass, selectClass, textareaClass } from '@/components/ui/form';
import { dayLabel, isIsoDate } from '@/lib/dates';
import { originLabel, type RowOrigin } from '@/lib/import/origin';
import type { AccountLink, ConnectionRecord, LinkOverlap } from '@/lib/simplefin/connection';
import { forgetConnectionAction, setSimplefinAutoSyncAction } from './actions';
import { buttonClass } from '@/components/ui/Button';

interface RemoteAccount {
  id: string;
  name: string;
  currency: string;
  balance: string;
}

/** v1.61.0 item 3b: a link waiting for the admin to confirm its first day. */
interface PendingLink {
  remote: RemoteAccount;
  accountId: number;
  accountName: string;
  overlap: LinkOverlap;
  syncFrom: string;
}

/** Imported roads first, hand-typed last: `198 from a CSV statement, 14 added by hand`. */
const ORIGIN_ORDER: RowOrigin[] = ['csv', 'ofx', 'simplefin', 'manual'];

function overlapSentence(accountName: string, overlap: LinkOverlap): string {
  if (overlap.rowsInWindow === 0) return `${accountName} holds no rows from the last 90 days.`;
  const parts = ORIGIN_ORDER.filter((origin) => overlap.byOrigin[origin] > 0).map(
    (origin) => `${overlap.byOrigin[origin]} ${originLabel(origin)}`,
  );
  const rows = `${overlap.rowsInWindow} ${overlap.rowsInWindow === 1 ? 'row' : 'rows'}`;
  return `${accountName} already holds ${rows} from the last 90 days (${parts.join(', ')}).`;
}

function currencyWarning(currency: string): string | null {
  const code = currency.toUpperCase();
  return code === 'CAD' ? null : `This account reports ${code}; this app stores CAD cents with no conversion.`;
}

export function ConnectionsClient({
  connection,
  links,
  accounts,
  remainingRequests,
  dailyLimit,
  autoSync = null,
  autoSyncOptions = [],
  autoSyncWaiting = null,
  today = null,
}: {
  connection: ConnectionRecord | null;
  links: AccountLink[];
  accounts: { id: number; name: string }[];
  remainingRequests: number;
  dailyLimit: number;
  /**
   * The raw stored key ('6h' | '12h' | 'daily' | 'weekly'), or null for off. Deliberately a
   * plain string rather than the branded AutoSyncInterval type: this component never imports
   * @/lib/simplefin/connection as a VALUE (see autoSyncOptions below), so it has no reason to
   * import that module's type either -- the server action re-validates whatever string this
   * component sends back.
   */
  autoSync?: string | null;
  /**
   * Computed server-side FROM AUTO_SYNC_INTERVALS (see page.tsx) and handed down as plain
   * data. This component must NOT import AUTO_SYNC_INTERVALS itself: connection.ts pulls in
   * @/db/client (better-sqlite3), and a 'use client' file importing a VALUE from it would
   * drag that whole server-only module graph into the browser bundle and break the build --
   * the same Ruling P4 constraint documented in src/lib/notify/events.ts. The existing
   * `import type { AccountLink, ConnectionRecord }` above is safe because type-only imports
   * are erased entirely; AUTO_SYNC_INTERVALS is a runtime value, so it cannot travel the same
   * way.
   */
  autoSyncOptions?: { value: string; label: string }[];
  /**
   * v1.60.0: set while automatic sync is waiting out its failure backoff. `nextTry` is already
   * formatted server-side (HH:mm, household clock).
   */
  autoSyncWaiting?: { failures: number; nextTry: string } | null;
  /** The household's today (YYYY-MM-DD), so a start date in this year reads without its year. */
  today?: string | null;
}) {
  const [setupToken, setSetupToken] = useState('');
  const [remote, setRemote] = useState<RemoteAccount[] | null>(null);
  const [errlist, setErrlist] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);

  async function post(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(payload.error ?? 'That did not work.');
      return null;
    }
    return payload;
  }

  async function claim() {
    const result = await post('/api/simplefin/claim', { setupToken });
    if (!result) return;
    setSetupToken('');
    setNotice('Connected. The access URL is stored encrypted and never shown again.');
    window.location.reload();
  }

  async function loadRemote() {
    setBusy(true);
    setError(null);
    const response = await fetch('/api/simplefin/accounts');
    const payload = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(payload.error ?? 'Could not list the remote accounts.');
      return;
    }
    setRemote(payload.accounts as RemoteAccount[]);
    setErrlist(payload.errlist ?? []);
  }

  /**
   * v1.61.0 item 3b. Nothing is linked yet: this asks what the account already holds and opens the
   * confirm panel, seeded with the suggested first day.
   */
  async function previewLink(account: RemoteAccount, accountId: number) {
    const overlap = (await post('/api/simplefin/link', { action: 'preview', accountId })) as LinkOverlap | null;
    if (!overlap) return;
    const accountName = accounts.find((local) => local.id === accountId)?.name ?? `account ${accountId}`;
    setPendingLink({ remote: account, accountId, accountName, overlap, syncFrom: overlap.suggestedStart });
  }

  async function confirmLink(pending: PendingLink) {
    const result = await post('/api/simplefin/link', {
      action: 'link',
      simplefinAccountId: pending.remote.id,
      accountId: pending.accountId,
      currency: pending.remote.currency,
      syncFrom: pending.syncFrom,
    });
    if (!result) return;
    setPendingLink(null);
    setNotice(
      [`Linked. The first sync takes rows from ${dayLabel(pending.syncFrom, pending.overlap.today)}.`, result.currencyWarning]
        .filter(Boolean)
        .join(' '),
    );
    window.location.reload();
  }

  async function unlink(simplefinAccountId: string) {
    const result = await post('/api/simplefin/link', { action: 'unlink', simplefinAccountId });
    if (!result) return;
    setNotice('Unlinked. CSV import is available for that account again.');
    window.location.reload();
  }

  async function sync() {
    const result = await post('/api/simplefin/sync', {});
    if (!result) return;
    const errors: string[] = result.errlist ?? [];
    setErrlist(errors);
    const synced = result.accounts as { accountName: string; added: number; duplicates: number; skippedPending: number; errors: number; currencyWarning: string | null }[];
    // v1.61.0 item 3d: possible duplicates the sync held instead of counting twice.
    const held = typeof result.totalHeld === 'number' ? result.totalHeld : 0;
    const heldNote =
      held > 0 ? ` ${held} possible ${held === 1 ? 'duplicate waits' : 'duplicates wait'} in Needs review.` : '';
    if (errors.length > 0 && synced.length === 0) {
      // Spec section 12: a non-empty errlist with zero accounts IS a failed
      // sync. Reporting "Nothing to import." in green next to the bridge's
      // complaint reads as success and is exactly wrong.
      setNotice(null);
      return;
    }
    const perAccount = synced
      .map((a) => `${a.accountName}: ${a.added} added, ${a.duplicates} already had, ${a.skippedPending} still pending, ${a.errors} errors`)
      .join(' · ');
    const engineNote = result.engineFailed ? ' Categorization failed, so the new rows are waiting in the review queue.' : '';
    // NEW-5 fix-round: same honest-note treatment as engineFailed — applyPaymentMatchers is
    // internally guarded (MUST-13.5) so a matcher failure never fails the sync either.
    const loanNote = result.loanMatchFailed ? ' Loan payment matching failed for these rows.' : '';
    setNotice(`${perAccount || 'Nothing to import.'} — ${result.remainingRequests} of ${dailyLimit} requests left today.${heldNote}${engineNote}${loanNote}`);
  }

  async function setAutoSync(value: string) {
    setBusy(true);
    setError(null);
    const result = await setSimplefinAutoSyncAction(value);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setNotice(result.message ?? null);
    window.location.reload();
  }

  const autoSyncLabel = autoSyncOptions.find((option) => option.value === autoSync)?.label ?? autoSync ?? '';

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        eyebrow="Settings"
        title="Connections"
        description="SimpleFIN fetches transactions from your bank through a bridge you control. It is entirely optional — leave this page alone and the app never makes a single network request."
      />

      <FormError message={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {errlist.length > 0 ? (
        <Notice tone="warning" title="The bridge reported problems:">
          <ul className="flex flex-col gap-0.5">
            {errlist.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {connection === null ? (
        <Card className="max-w-xl">
          <CardHeader
            title="Connect a SimpleFIN bridge"
            description={
              <>
                Paste the setup token from your bridge. It can only be claimed <strong className="font-semibold text-ink">once</strong> — if this
                fails, generate a fresh token. The access URL it returns is a read-only credential for your bank data; it is encrypted before it is
                stored and is never displayed again.
              </>
            }
          />
          <CardBody className="flex flex-col gap-3">
            <Field label="Setup token">
              <textarea
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                rows={4}
                placeholder="Paste the setup token"
                className={`${textareaClass} font-mono text-xs`}
              />
            </Field>
            <button
              type="button"
              onClick={() => void claim()}
              disabled={busy || setupToken.trim().length === 0}
              className={buttonClass('primary', 'md', 'w-fit')}
            >
              {busy ? 'Claiming…' : 'Claim token'}
            </button>
          </CardBody>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader
              title="Bridge"
              description={
                <>
                  Connected {connection.claimedAt.slice(0, 10)} · last sync{' '}
                  {connection.lastSyncAt ? connection.lastSyncAt.slice(0, 16).replace('T', ' ') : 'never'} ·{' '}
                  <strong className="font-semibold text-ink">{remainingRequests}</strong> of {dailyLimit} requests left today
                </>
              }
            />
            <CardBody className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void sync()} disabled={busy} className={buttonClass('primary')}>
                  {busy ? 'Working…' : 'Sync now'}
                </button>
                <button type="button" onClick={() => void loadRemote()} disabled={busy} className={buttonClass('secondary')}>
                  List remote accounts
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const affectedNames = links.map((l) => accounts.find((a) => a.id === l.accountId)?.name ?? `account ${l.accountId}`);
                    const impact =
                      affectedNames.length > 0
                        ? ` This will also unlink ${affectedNames.join(', ')} — ${affectedNames.length === 1 ? 'it reverts' : 'they revert'} to CSV import.`
                        : '';
                    if (!window.confirm(`Remove the stored connection?${impact} You will need a fresh setup token to reconnect.`)) return;
                    const result = await forgetConnectionAction();
                    if (result.error) {
                      // A rejected action (cross-origin) must not look like a
                      // successful removal followed by a page reload.
                      setError(result.error);
                      return;
                    }
                    setNotice(result.message ?? null);
                    window.location.reload();
                  }}
                  className={buttonClass('ghost')}
                >
                  Forget connection
                </button>
              </div>
              <Field
                label="Automatic sync"
                htmlFor="auto-sync-select"
                hint="Runs on the server while the app is up. If a sync fails you will be notified."
              >
                <select
                  id="auto-sync-select"
                  defaultValue={autoSync ?? 'off'}
                  disabled={busy}
                  onChange={(e) => void setAutoSync(e.target.value)}
                  className={`${selectClass} w-auto`}
                >
                  <option value="off">Off</option>
                  {autoSyncOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="text-xs text-subtle">
                {autoSync
                  ? `Automatic sync is on: ${autoSyncLabel.toLowerCase()}. Each sync asks for everything since the last one plus five days of overlap, so a late-posting transaction is never missed.`
                  : 'Syncing is manual unless you turn on automatic sync above. Each sync asks for everything since the last one plus five days of overlap, so a late-posting transaction is never missed.'}
              </p>
              {autoSync && autoSyncWaiting ? (
                <p className="text-xs text-subtle">
                  {`Automatic sync is waiting after ${autoSyncWaiting.failures} failed ${autoSyncWaiting.failures === 1 ? 'try' : 'tries'}. Next try about ${autoSyncWaiting.nextTry}.`}
                </p>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Linked accounts" description="Each remote account maps to exactly one account here." />
            <CardBody className="flex flex-col gap-3">
              {links.length === 0 ? (
                // Guard 1 (tests/ops/onboarding-coverage.test.ts): the action calls the same
                // loadRemote() the "List remote accounts" button above already does -- the
                // sentence names it, so the button does it.
                <EmptyState
                  size="compact"
                  title="Nothing linked yet. List the remote accounts to map them."
                  action={
                    <button type="button" onClick={() => void loadRemote()} disabled={busy} className={buttonClass('secondary', 'sm')}>
                      List remote accounts
                    </button>
                  }
                />
              ) : (
                <ul className="flex flex-col">
                  {links.map((link) => (
                    <li
                      key={link.simplefinAccountId}
                      className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-2 text-sm last:border-b-0"
                    >
                      <span>
                        <code className="rounded bg-surface-2 px-1 font-mono text-xs">{link.simplefinAccountId}</code> →{' '}
                        {accounts.find((a) => a.id === link.accountId)?.name ?? `account ${link.accountId}`}{' '}
                        <span className="text-xs text-subtle">
                          {link.currency}
                          {link.lastBalanceCents !== null ? <> · balance <Money cents={link.lastBalanceCents} plain /></> : null}
                          {link.syncFrom ? ` · from ${dayLabel(link.syncFrom, today ?? link.syncFrom)}` : null}
                        </span>
                      </span>
                      <button type="button" onClick={() => void unlink(link.simplefinAccountId)} className={buttonClass('ghost', 'sm')}>
                        unlink
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {links.length > 0 ? (
                <p className="text-xs text-warning">
                  Linked accounts are synced from SimpleFIN, so CSV import is turned off for them. Unlink to switch an account back to CSV.
                </p>
              ) : null}
            </CardBody>
          </Card>

          {remote ? (
            <Card>
              <CardHeader title="Remote accounts" description="What the bridge can see. Map each one to an account here." />
              <CardBody>
                <ul className="flex flex-col">
                  {remote.map((account) => (
                    <li
                      key={account.id}
                      className="flex flex-wrap items-center gap-2 border-b border-line py-2.5 text-sm last:border-b-0"
                    >
                      <span className="flex-1">
                        {account.name} <span className="text-xs text-subtle">{account.currency} · {account.balance}</span>
                      </span>
                      {links.some((l) => l.simplefinAccountId === account.id) ? (
                        <span className="badge badge--green">already linked</span>
                      ) : (
                        <>
                          <select
                            id={`map-${account.id}`}
                            aria-label={`Local account for ${account.name}`}
                            disabled={pendingLink?.remote.id === account.id}
                            className={`${selectClass} w-auto px-2 py-1 text-xs`}
                          >
                            {accounts.map((local) => (
                              <option key={local.id} value={local.id}>
                                {local.name}
                              </option>
                            ))}
                          </select>
                          {pendingLink?.remote.id === account.id ? null : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                const select = document.getElementById(`map-${account.id}`) as HTMLSelectElement | null;
                                if (select) void previewLink(account, Number(select.value));
                              }}
                              className={buttonClass('secondary', 'sm')}
                            >
                              Link
                            </button>
                          )}
                        </>
                      )}
                      {pendingLink?.remote.id === account.id ? (
                        <LinkConfirmPanel
                          pending={pendingLink}
                          busy={busy}
                          onDateChange={(syncFrom) => setPendingLink({ ...pendingLink, syncFrom })}
                          onConfirm={() => void confirmLink(pendingLink)}
                          onCancel={() => setPendingLink(null)}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}
        </>
      )}

      <p className="text-xs text-subtle">
        The access URL is stored encrypted in the database, which means it is also inside your unencrypted nightly backups. If you keep offsite
        copies, turn on your backup tool&apos;s client-side encryption. Rotating <code className="font-mono">SECRET_KEY</code> makes the stored URL
        undecryptable and you will need a fresh setup token.
      </p>
    </div>
  );
}

/**
 * v1.61.0 item 3b. What linking will do, said before it happens: what the account already holds
 * from the bank's 90 days, the first day to take from the bank (seeded with the day after the
 * newest imported row), and what happens either side of it.
 */
function LinkConfirmPanel({
  pending,
  busy,
  onDateChange,
  onConfirm,
  onCancel,
}: {
  pending: PendingLink;
  busy: boolean;
  onDateChange: (syncFrom: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { overlap, syncFrom } = pending;
  const inputId = `sync-from-${pending.remote.id}`;
  const valid = isIsoDate(syncFrom) && syncFrom >= overlap.windowStart && syncFrom <= overlap.today;
  const warning = currencyWarning(pending.remote.currency);
  return (
    <div className="flex basis-full flex-col gap-3 rounded-md border border-line bg-surface-2 p-3">
      <p>{overlapSentence(pending.accountName, overlap)}</p>
      <Field label="First day to take from the bank" htmlFor={inputId}>
        <input
          id={inputId}
          type="date"
          min={overlap.windowStart}
          max={overlap.today}
          value={syncFrom}
          onChange={(e) => onDateChange(e.target.value)}
          className={`${inputClass} w-auto`}
        />
      </Field>
      <p className="text-xs text-subtle">
        Rows before this date stay with your statements. Rows added by hand after it are checked for duplicates. CSV import turns off
        for this account.
      </p>
      {warning ? <p className="text-xs text-warning">{warning}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onConfirm} disabled={busy || !valid} className={buttonClass('primary', 'sm')}>
          {valid ? `Link from ${dayLabel(syncFrom, overlap.today)}` : 'Link from this date'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
      </div>
    </div>
  );
}
