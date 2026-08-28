'use client';

import { useState } from 'react';
import { MappingEditor } from '@/components/MappingEditor';
import { SubmitButton } from '@/components/SubmitButton';
import { ImportIcon } from '@/components/icons';
import { AutoSaveSelect, type AutoSaveResult } from '@/components/ui/AutoSave';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, selectClass } from '@/components/ui/form';
import type { ImportMapping } from '@/lib/import/mapping';
import type { CardValueSummary, PreviewResult } from '@/lib/import/preview';
import type { ImportHistoryRow } from '@/lib/import/commit';
import { setCardPersonAction } from './actions';

interface AccountOption { id: number; name: string; importProfileId: number | null }
interface ProfileOption { id: number; name: string; isBuiltin: boolean; mapping: ImportMapping }
interface PersonOption { id: number; name: string }

/**
 * One card value's assignment row (spec 2026-08-22 v1.6.0, MUST-6.1/MUST-6.2). Each row's save
 * is still independent -- there can be several of these per preview -- because each row holds
 * its own auto-save state (AutoSaveSelect's internal useAutoSave), not a shared one.
 *
 * The person <select> is now controlled by AutoSaveSelect rather than uncontrolled with
 * `defaultValue`: it needs to be able to revert to the last saved value when the server
 * refuses an edit, which an uncontrolled select has no way to do.
 *
 * `options` is `people` (active users) PLUS the currently assigned person when they are not
 * already in that list -- an assignment can point at a since-deactivated user
 * (src/lib/import/card-people.ts, MUST-3.1: "remains valid and resolvable for display"), and
 * without this the <select>'s `defaultValue` would match no <option>, which the browser
 * resolves by silently selecting the FIRST option ("Account owner (default)") -- exactly the
 * native-fallback trap the Task 5 ledger entry warns about, here it would make a real
 * assignment look unassigned.
 */
function CardValueRow({
  accountId,
  cardValue,
  rowCount,
  assignedUserId,
  assignedUserName,
  people,
  onSaved,
}: {
  accountId: number;
  cardValue: string;
  rowCount: number;
  assignedUserId: number | null;
  assignedUserName: string | null;
  people: PersonOption[];
  /**
   * F1 fix (post-1.6.0 review follow-up): called with the row's new (userId, userName) the
   * instant a save succeeds, so the parent can patch its own `preview.cardValues` state.
   * Patching locally was chosen over re-running `rePreview(mapping)` -- the round trip would
   * re-read and re-parse the whole staged file just to refresh a value this component already
   * knows, and the person a save just wrote is never anything this row didn't already have on
   * screen (it came from one of `options`, below). Not called on error, so a failed save
   * leaves the row exactly as it was.
   */
  onSaved: (cardValue: string, userId: number | null, userName: string | null) => void;
}) {
  /**
   * F1 (post-1.6.0): the action's return value only ever carries a message or an error, never
   * the person that was submitted -- but that is exactly what is needed to patch local state
   * without a second request. Reading back the FormData the control just built keeps this
   * honest about what was really sent. Patching locally beats re-running `rePreview(mapping)`,
   * which would re-read and re-parse the whole staged file to refresh a value this row already
   * knows. Not called on error, so a failed save leaves the row exactly as it was.
   */
  async function savePerson(formData: FormData): Promise<AutoSaveResult> {
    const result = await setCardPersonAction({}, formData);
    if (!result.error) {
      const raw = formData.get('person');
      const newUserId = raw === null || raw === '' ? null : Number(raw);
      // A re-save of the SAME assignee keeps their existing name rather than re-deriving it:
      // `people` holds only ACTIVE users, so re-deriving would overwrite a since-deactivated
      // assignee's real name with undefined.
      const newUserName =
        newUserId === null
          ? null
          : newUserId === assignedUserId
            ? assignedUserName
            : people.find((p) => p.id === newUserId)?.name ?? null;
      onSaved(cardValue, newUserId, newUserName);
    }
    return result;
  }

  const options: PersonOption[] =
    assignedUserId !== null && !people.some((p) => p.id === assignedUserId)
      ? [...people, { id: assignedUserId, name: `${assignedUserName ?? 'Former user'} (inactive)` }]
      : people;

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface px-3 py-2">
      <span className="font-mono text-sm text-ink">{cardValue}</span>
      <span className="text-xs text-muted">
        {rowCount} row{rowCount === 1 ? '' : 's'}
      </span>
      {assignedUserId === null ? (
        <span className="text-xs text-muted">Unassigned — falls back to the account owner at import.</span>
      ) : null}
      {/* `options` is `people` PLUS the currently assigned person when they are not in that
          list: an assignment can point at a since-deactivated user (MUST-3.1), and without the
          extra option the select's value would match no <option>, which the browser resolves by
          selecting the FIRST one -- making a real assignment look unassigned. */}
      <span className="ml-auto flex items-center gap-2">
        <AutoSaveSelect
          name="person"
          defaultValue={assignedUserId === null ? '' : String(assignedUserId)}
          options={[
            { value: '', label: 'Account owner (default)' },
            ...options.map((person) => ({ value: String(person.id), label: person.name })),
          ]}
          fields={{ accountId: String(accountId), cardValue }}
          action={savePerson}
          ariaLabel={`Person for ${cardValue}`}
          className={selectClass}
        />
      </span>
    </li>
  );
}

/**
 * The pin (`account.importProfileId`) only preselects when that profile is actually one of
 * the offered options (spec 2026-08-22 v1.6.0, MUST-5.2). `profiles` here is already filtered
 * to active + readable (page.tsx, Task 4's MUST-4.1) -- a profile an account is pinned to can
 * have since been deactivated or gone unreadable, in which case its id is real but absent from
 * `profiles`. Honoring it anyway would preselect a value with no matching <option>. When the
 * pin is not offered, this falls back to exactly what an unpinned account already does:
 * `profiles[0]?.id ?? 0`.
 */
function resolveOfferedProfileId(pinnedProfileId: number | null | undefined, profiles: ProfileOption[]): number {
  if (pinnedProfileId != null && profiles.some((p) => p.id === pinnedProfileId)) return pinnedProfileId;
  return profiles[0]?.id ?? 0;
}

/** Import really is a three-step sequence, so the numbers carry information here. */
function StepMark({ n, state = 'todo' }: { n: number; state?: 'todo' | 'active' }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
        state === 'active' ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-subtle'
      }`}
    >
      {n}
    </span>
  );
}

function StepTitle({ n, state, children }: { n: number; state?: 'todo' | 'active'; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2.5">
      <StepMark n={n} state={state} />
      {children}
    </span>
  );
}

const fileInputClass =
  'text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-accent-soft-fg';

export function ImportClient({
  accounts,
  profiles,
  history,
  simplefinManaged,
  people = [],
}: {
  accounts: AccountOption[];
  profiles: ProfileOption[];
  history: ImportHistoryRow[];
  simplefinManaged: string[];
  /**
   * Active users, offered on each card value's person select (MUST-6.1). Optional and
   * defaulted to `[]` so every test/caller that predates this feature (there is no cardCol on
   * their mapping, so the section never renders) does not need to pass it.
   */
  people?: PersonOption[];
}) {
  const [accountId, setAccountId] = useState<number>(accounts[0]?.id ?? 0);
  const [profileId, setProfileId] = useState<number>(resolveOfferedProfileId(accounts[0]?.importProfileId, profiles));
  const [mapping, setMapping] = useState<ImportMapping | null>(profiles[0]?.mapping ?? null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyRows, setHistoryRows] = useState<ImportHistoryRow[]>(history);

  // F1 fix: patches the ONE row that was just saved inside `preview.cardValues`, leaving
  // everything else (including the rest of `preview`, e.g. `rows`/`errors`) untouched. This is
  // the only place `cardValues` is written outside of a fresh preview response, so a sibling
  // row's own assignment can never be disturbed by this update.
  function applyCardAssignment(cardValue: string, userId: number | null, userName: string | null) {
    setPreview((prev) => {
      if (!prev || !prev.cardValues) return prev;
      return {
        ...prev,
        cardValues: prev.cardValues.map((cv) =>
          cv.value === cardValue ? { ...cv, assignedUserId: userId, assignedUserName: userName } : cv,
        ),
      };
    });
  }

  /**
   * The Preview button is guarded by SubmitButton's useFormStatus, not by `busy`.
   *
   * This is a form ACTION, and React 19 holds state updates made inside an async action
   * until that action settles — so the `setBusy(true)` that used to open this function
   * never rendered, and the button it was meant to disable stayed clickable for the whole
   * upload. useFormStatus reads the form's real pending state instead. `busy` is still the
   * right mechanism for commit(), rePreview() and undo(), which are plain onClick/onChange
   * handlers and therefore render their state updates immediately.
   */
  async function upload(formData: FormData) {
    setError(null);
    setSummary(null);
    formData.set('accountId', String(accountId));
    formData.set('profileId', String(profileId));
    const response = await fetch('/api/import/preview', { method: 'POST', body: formData });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Upload failed');
      return;
    }
    setPreview(body as PreviewResult);
    setMapping((body as PreviewResult).mapping);
  }

  // Optimistically applies `next` so the form reflects what the user just changed while the
  // request is in flight, but a failed re-preview MUST roll `mapping` back to whatever was
  // last actually previewed — otherwise commit() (which posts `mapping`, not whatever
  // preview.mapping says) can fire against a mapping that was never confirmed to parse this
  // file at all (release review finding C).
  async function rePreview(next: ImportMapping) {
    if (!preview) return;
    const previous = mapping;
    setMapping(next);
    setBusy(true);
    try {
      const response = await fetch('/api/import/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stagingId: preview.stagingId, filename: preview.filename, accountId, profileId, mapping: next }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Preview failed');
        setMapping(previous);
        return;
      }
      setPreview(body as PreviewResult);
    } finally {
      setBusy(false);
    }
  }

  // The Import button is a plain onClick, not a form action, so `busy` really does render
  // here — but it has to be released in a `finally`: a thrown fetch (a dropped connection
  // mid-import is the realistic case) would otherwise leave the button disabled forever,
  // with rows possibly already committed and no way to find out from this screen.
  async function commit() {
    if (!preview || !mapping) return;
    setBusy(true);
    try {
      const response = await fetch('/api/import/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stagingId: preview.stagingId, filename: preview.filename, accountId, profileId, mapping }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Import failed');
        return;
      }
      setPreview(null);
      // The rows are always committed by this point, even when categorization
      // itself failed (flow.ts catches runEngine and reports engineFailed
      // instead of throwing) — they're categoryless, so the review queue
      // picks them up regardless of whether the engine ran.
      const base = body.engineFailed
        ? `${body.rowsAdded} imported, categorization failed — rows are in the review queue.`
        : `${body.rowsAdded} added, ${body.rowsDuplicate} duplicates skipped, ${body.rowsError} errors, ${body.needsReview} need review.`;
      // Carry 2 (spec 2026-08-22 v1.6.0, Task 6): SHOULD-3.6's per-card attribution split,
      // already flowing through CommitFlowResult.attributionSummary (Task 3) -- null
      // whenever there is nothing card-specific to report, so nothing is appended then.
      const withAttribution = body.attributionSummary ? `${base} ${body.attributionSummary}.` : base;
      // NEW-5 fix-round: applyPaymentMatchers is internally guarded (MUST-13.5) the same way
      // runEngine is caught above, so a matcher failure never fails the import either — it
      // just needs the same honest note engineFailed already gets.
      setSummary(body.loanMatchFailed ? `${withAttribution} Loan payment matching failed for these rows.` : withAttribution);
    } finally {
      setBusy(false);
    }
  }

  // Undo is a two-request dance around a confirm() dialog, and the second request
  // deletes rows. Without a busy guard a double-click fires the whole sequence twice:
  // the second pass finds the import already gone and reports a confusing failure over
  // a successful undo. `busy` is released in a finally so an early return cannot strand
  // every other button on the page in a disabled state.
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
      const ok = window.confirm(`Undo this import?\n\nWill delete ${counts.willDelete} transactions.\nWill keep ${counts.willKeep} shared with other imports.`);
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
          (result.snapshotsDeleted > 0 ? `, and ${result.snapshotsDeleted} balance ${result.snapshotsDeleted === 1 ? 'figure' : 'figures'} removed.` : '.'),
      );
      setHistoryRows((rows) => rows.filter((row) => row.id !== importId));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Import"
        description="Upload a statement, check what it found, then add it. Nothing is written until you say so."
        actions={
          <a href="/import/wizard" className="btn btn--secondary">
            Add a bank
          </a>
        }
      />

      <PageGuide>
        <p>
          This is where a bank statement becomes transactions. Download a CSV file from your
          bank&rsquo;s website — most banks call it &ldquo;export&rdquo; or &ldquo;download
          transactions&rdquo; — pick the account it belongs to, and upload it. Nothing is written
          to the database until you press the import button on the preview.
        </p>
        <p>
          Several banks have a built-in profile, so their file is understood as soon as it is
          uploaded. Any other bank works through <strong className="font-semibold text-ink">Add
          a bank</strong>, which walks you through pointing out which column is the date, which
          is the amount and which is the description. That mapping is saved against the account,
          so the next statement from the same bank needs no setup.
        </p>
        <p>
          Re-uploading a file, or uploading one whose dates overlap a file you already brought
          in, is safe: matching rows are marked as duplicates in the preview and left out of the
          count you import. Every import is listed under History with an undo beside it.
        </p>
        <p>
          If a statement covers a card that more than one person uses, the preview lists each
          value found in the cardholder column so you can say who each one is. That is what puts
          a joint card&rsquo;s rows against the right person in Budgets and Reports.
        </p>
      </PageGuide>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {summary ? (
        <Notice tone="success">
          {summary}{' '}
          <a className="font-semibold underline underline-offset-2" href="/review">Go to the review queue</a>
        </Notice>
      ) : null}

      {simplefinManaged.length > 0 ? (
        <Notice tone="info">
          {simplefinManaged.join(', ')} {simplefinManaged.length === 1 ? 'is' : 'are'} synced from SimpleFIN, so CSV import is turned off for{' '}
          {simplefinManaged.length === 1 ? 'it' : 'them'}. Unlink under <a className="underline underline-offset-2" href="/settings/connections">Settings → Connections</a>{' '}
          to switch back to CSV.
        </Notice>
      ) : null}

      <div id="choose-file">
      {accounts.length === 0 ? (
        <Card>
          <CardHeader
            title={<StepTitle n={1} state="active">No accounts to import into yet</StepTitle>}
            description={
              <>
                {simplefinManaged.length > 0
                  ? 'Every account you have is synced from SimpleFIN, so there is nothing here to upload a CSV for. Add a CSV account to import one.'
                  : 'A CSV has to land somewhere, so add the bank account first — name, type, and whether it is joint or one person’s.'}{' '}
                <a className="font-medium text-accent-text underline underline-offset-2" href="/settings/accounts">
                  Add a bank account
                </a>
                {' '}(Settings → Bank accounts).
              </>
            }
          />
          <CardBody>
            <div className="flex flex-wrap items-center gap-3">
              <input type="file" accept=".csv,text/csv" disabled aria-label="Upload a CSV" className={fileInputClass} />
              <button type="button" disabled className="btn btn--primary">
                Preview
              </button>
            </div>
          </CardBody>
        </Card>
      ) : profiles.length === 0 ? (
        // F2 (post-1.6.0 review follow-up): every mapping deactivated, or a fresh DB where
        // the built-in presets never got seeded, leaves this empty even though accounts exist.
        // Same shape as the zero-accounts branch above: a disabled file input plus a plain,
        // non-submitting Preview button, so there is nothing here that can post profileId=0
        // and surface the raw zod validation string to an admin.
        <Card>
          <CardHeader
            title={<StepTitle n={1} state="active">No import mappings are turned on</StepTitle>}
            description={
              <>
                Every mapping has been deactivated, or none has been set up yet, so there is nothing here to preview a
                file against.{' '}
                <a className="font-medium text-accent-text underline underline-offset-2" href="/settings/managers">
                  Reactivate a mapping in Settings → Managers
                </a>
                , then come back here.
              </>
            }
          />
          <CardBody>
            <div className="flex flex-wrap items-center gap-3">
              <input type="file" accept=".csv,text/csv" disabled aria-label="Upload a CSV" className={fileInputClass} />
              <button type="button" disabled className="btn btn--primary">
                Preview
              </button>
            </div>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title={<StepTitle n={1} state="active">Choose a file</StepTitle>}
            description="Pick the account it belongs to and the profile that matches the bank's column layout."
          />
          <CardBody>
            <form action={upload} className="flex flex-wrap items-end gap-4">
              <Field label="Account">
                <select
                  value={accountId}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    setAccountId(id);
                    // Switching accounts switches banks: the previous account's
                    // remembered profile, its column mapping and any preview built
                    // from it all belong to the file that is no longer selected.
                    // Fall back to the first offered profile when this account has never
                    // been imported into (or its pin is no longer offered — MUST-5.2), rather
                    // than silently keeping the old one.
                    const remembered = resolveOfferedProfileId(accounts.find((a) => a.id === id)?.importProfileId, profiles);
                    setProfileId(remembered);
                    setMapping(profiles.find((p) => p.id === remembered)?.mapping ?? null);
                    setPreview(null);
                    setSummary(null);
                    setError(null);
                  }}
                  className={selectClass}
                >
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Import profile">
                <select
                  value={profileId}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    setProfileId(id);
                    setMapping(profiles.find((p) => p.id === id)?.mapping ?? null);
                  }}
                  className={selectClass}
                >
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                      {profile.isBuiltin ? ' (built-in)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <input type="file" name="file" accept=".csv,text/csv" required className={`${fileInputClass} py-2`} />
              <SubmitButton>Preview</SubmitButton>
            </form>
          </CardBody>
        </Card>
      )}
      </div>

      {preview && mapping ? (
        <Card>
          <CardHeader
            title={
              <StepTitle n={2} state="active">
                Preview — {preview.totalRows} rows, {preview.duplicateCount} duplicates, {preview.errorCount} errors,
                {/* Rows dropped by the profile's skipRules never appear in the table below and
                    were counted nowhere on screen, so a mis-typed skip rule that swallowed half
                    the file looked exactly like a short file. */}
                {preview.skipped > 0 ? ` ${preview.skipped} skipped by profile rules,` : ''} encoding {preview.encoding}
              </StepTitle>
            }
            description="Wrong columns? Fix the mapping and the preview re-reads the same file."
          />
          <CardBody className="flex flex-col gap-4">
            <MappingEditor
              mapping={mapping}
              onChange={(next) => void rePreview(next)}
              dateFormatDetection={preview.dateFormatDetection}
              busy={busy}
              cardColumnOptions={preview.columnOptions}
            />

            {mapping.cardCol !== null && preview.cardValues ? (
              <div className="rounded-lg border border-line bg-surface-2/50 p-4">
                <h3 className="text-sm font-semibold text-ink">Cardholder assignments</h3>
                <p className="mt-1 text-sm text-muted">
                  Assign each value found in the cardholder column to a person. Anything left as &ldquo;Account owner (default)&rdquo; —
                  including a row where that column is blank — is attributed to the account owner automatically; nothing here blocks the
                  import.
                </p>
                {preview.cardValues.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">No cardholder values were found in that column.</p>
                ) : (
                  <ul className="mt-3 flex flex-col gap-2">
                    {preview.cardValues.map((cv: CardValueSummary) => (
                      <CardValueRow
                        key={cv.value}
                        accountId={accountId}
                        cardValue={cv.value}
                        rowCount={cv.rowCount}
                        assignedUserId={cv.assignedUserId}
                        assignedUserName={cv.assignedUserName}
                        people={people}
                        onSaved={applyCardAssignment}
                      />
                    ))}
                  </ul>
                )}
              </div>
            ) : null}

            <TableWrap className="max-h-96 overflow-y-auto">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Description</th>
                  <th scope="col">Merchant</th>
                  <th scope="col" className="text-right">Amount</th>
                  <th scope="col">Category</th>
                  <th scope="col">Flags</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={`${row.rowIndex}-${row.dedupHash}`} className={row.isDuplicate ? 'opacity-50' : ''}>
                    <td className="tabnum whitespace-nowrap text-muted">{row.date}</td>
                    <td>{row.rawDescription}</td>
                    <td className="text-muted">{row.normalizedMerchant}</td>
                    <td className="text-right"><Money cents={row.amountCents} /></td>
                    <td className="text-muted">{row.predictedCategoryName ?? '—'}{row.predictedSource === 'bayes' ? ' (guess)' : ''}</td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        {row.isDuplicate ? <span className="badge badge--slate">duplicate</span> : null}
                        {row.isTransfer ? <span className="badge badge--blue">transfer</span> : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>

            {preview.errors.length > 0 ? (
              <details className="rounded-md border border-line bg-surface-2/50 px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium text-ink">{preview.errors.length} rows could not be parsed</summary>
                <ul className="mt-2 list-inside list-disc text-xs text-muted">
                  {preview.errors.map((rowError) => (
                    <li key={rowError.rowIndex}>
                      Row {rowError.rowIndex + 1}: {rowError.reason} — {rowError.cells.join(' | ')}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <div className="flex items-center gap-3 border-t border-line pt-4">
              <StepMark n={3} state="active" />
              <button type="button" onClick={() => void commit()} disabled={busy} className="btn btn--primary btn--lg">
                Import {preview.totalRows - preview.duplicateCount} transactions
              </button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="History" description="Every import, and the button that takes one back out." />
        {historyRows.length === 0 ? (
          <EmptyState
            icon={ImportIcon}
            title="Nothing imported yet"
            action={
              <a href="#choose-file" className="btn btn--primary btn--sm">
                Upload a statement
              </a>
            }
          >
            Once you upload a statement it lands here, with an undo next to it.
          </EmptyState>
        ) : (
          <TableWrap bare fixed minWidth="63rem">
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
              {historyRows.map((row) => (
                <tr key={row.id}>
                  <td className="tabnum whitespace-nowrap text-muted">{row.createdAt.slice(0, 16).replace('T', ' ')}</td>
                  {/* Truncate with a title, never a bare ellipsis: the full account name and
                      the full filename stay readable on hover and to a screen reader. */}
                  <td className="cell-truncate" title={row.accountName}>{row.accountName}</td>
                  <td className="cell-truncate font-mono text-xs" title={row.filename}>{row.filename}</td>
                  <td className="text-muted">{row.importedByName}</td>
                  <td className="tabnum text-right">{row.rowsAdded}</td>
                  <td className="tabnum text-right text-muted">{row.rowsDuplicate}</td>
                  <td className="tabnum text-right text-muted">{row.rowsError}</td>
                  <td className="text-right">
                    <button
                      type="button"
                      onClick={() => void undo(row.id)}
                      disabled={busy}
                      className="btn btn--secondary btn--sm"
                    >
                      Undo
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <p className="text-sm text-muted">
        Importing from a bank that is not listed? Either adjust the columns in the preview editor above (editing a built-in profile automatically saves a
        copy for this account and leaves the shared preset untouched), or <a className="font-medium text-accent-text underline underline-offset-2" href="/import/wizard">set up a new bank profile from a
        sample file</a>.
      </p>
    </div>
  );
}
