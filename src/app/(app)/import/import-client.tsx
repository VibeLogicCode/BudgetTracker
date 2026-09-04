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
import { SectionHeader } from '@/components/ui/SectionHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, hintClass, inputClass, selectClass } from '@/components/ui/form';
import type { ImportMapping } from '@/lib/import/mapping';
import type { CardValueSummary, PreviewResult } from '@/lib/import/preview';
import type { ImportHistoryRow } from '@/lib/import/commit';
// F-03 (v1.31.0): the sentence half of the post-commit balance check. Pure module (formatCents
// plus a TYPE import of Discrepancy) so this 'use client' file never drags balance-reconcile.ts
// -- and its @/db/client import -- into the browser bundle. See discrepancy-message.ts's own
// docblock for the full reasoning.
import { discrepancyMessage } from '@/lib/discrepancy-message';
import type { Discrepancy } from '@/lib/balance-reconcile';
// F-03: the History row's "View rows" link goes through this, never a hand-built
// `?import=<id>` -- see this module's own docblock for why (two copies of the same
// querystring had already drifted apart once).
import { transactionsHref } from '@/lib/transaction-links';
import { saveMappingAction, setCardPersonAction } from './actions';
import type { SaveMappingState } from './actions';

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
  // v1.26.0 Lane 3b. The post-commit offer to inspect what rules did (the owner: "i still need
  // to confirm or deny no? i dont just want to auto apply rules and never see what happened on
  // my import."). Its own state rather than folded into `summary` -- the offer carries an
  // importId a plain string cannot, and it must be cleared by a fresh preview the same way
  // `summary` already is, but never touched by anything else. null renders nothing: this is an
  // offer, not a gate, and the result screen below reads exactly as it always has when there is
  // nothing to offer (rulesApplied === 0, the common and unremarkable case).
  const [ruleOffer, setRuleOffer] = useState<{ importId: number; count: number } | null>(null);

  // Lane 5 (2026-08-30 savings-targets plan): the "Save as a new profile" / "Update <name>"
  // button's own state. `forkAccountName` fills the one editable slot in presets.ts's
  // copy-on-write naming template (`<profile> (<account>)`) -- seeded from the real account name
  // the moment a preview lands (see `upload`), and left alone on every re-preview after that so
  // an edit here survives a person tweaking an unrelated mapping field. `mappingSaveState` is
  // deliberately its own state rather than reusing the top-of-page `error`/`summary` Notices:
  // those already carry the Preview/Import/Undo story, and interleaving a fourth, unrelated
  // outcome into them would make it unclear which action a message was actually reporting on.
  const [forkAccountName, setForkAccountName] = useState('');
  const [mappingSaveState, setMappingSaveState] = useState<SaveMappingState | null>(null);

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
    setRuleOffer(null);
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
    // A fresh preview is a fresh save-mapping session: reseed the fork name from the real
    // account name (rather than whatever an earlier account/file's edit left behind) and drop
    // any leftover message from a previous file's save.
    setForkAccountName(accounts.find((a) => a.id === accountId)?.name ?? '');
    setMappingSaveState(null);
  }

  // A plain onClick (not a form action, and not gated by useFormStatus) because this button has
  // to stay reachable exactly when the Preview/Import ones might not be worth pressing yet --
  // ruling T8's whole point is a mapping fix must be saveable from a preview that reported 0
  // rows and 117 errors, so it cannot depend on `preview` having anything to import. `busy` is
  // still the right guard (same reasoning commit()/undo() give): released in a finally so a
  // dropped connection cannot strand the button disabled forever.
  async function saveMapping() {
    if (!mapping) return;
    setBusy(true);
    try {
      const formData = new FormData();
      formData.set('profileId', String(profileId));
      formData.set('accountId', String(accountId));
      formData.set('accountName', forkAccountName);
      formData.set('mapping', JSON.stringify(mapping));
      const result = await saveMappingAction({}, formData);
      setMappingSaveState(result);
    } finally {
      setBusy(false);
    }
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
      const withLoanNote = body.loanMatchFailed ? `${withAttribution} Loan payment matching failed for these rows.` : withAttribution;
      // F-03 (v1.31.0): CommitFlowResult.discrepancy is null for every account that cannot
      // reconcile at all (no balance column on the mapping, or an OFX file, which has none
      // either -- flow.ts's own doc comment on this field has the full list), AND for a clean
      // statement that agreed. Both read exactly the same here on purpose -- silence, never
      // "checked" or "balance agreed" -- because nothing on this screen can tell the two apart,
      // and guessing wrong in the reassuring direction is the mistake v1.30.0 had to fix once
      // already (a notification claiming "$0.00 over" when the real gap was $113.40).
      const discrepancy = (body.discrepancy ?? null) as Discrepancy | null;
      setSummary(discrepancy ? `${withLoanNote} ${discrepancyMessage(discrepancy)}` : withLoanNote);
      // v1.26.0 Lane 3b: an OFFER, not a gate -- only when a rule actually claimed a row.
      // Zero is the common case and means there is nothing to audit, so it renders nothing
      // rather than a link to a screen that would just say so.
      setRuleOffer(body.rulesApplied > 0 ? { importId: body.importId, count: body.rulesApplied } : null);
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

  // Which profile the save-mapping button/field below describe. Looked up rather than trusted
  // to always exist: `profileId` only ever comes from one of `profiles`' own <option> values or
  // a just-loaded preview's mapping, but a defensive `undefined` here (never rendering the
  // panel) is cheaper than a crash if that ever stops being true.
  const currentProfile = profiles.find((profile) => profile.id === profileId);

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
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
          {/* Review round (fold /review in): the review queue is `?review=1` on Transactions now
              (ruling R1), not a second page -- repointed the same way the nav item and the
              dashboard callout were. */}
          <a className="font-semibold underline underline-offset-2" href="/transactions?review=1">Go to the review queue</a>
        </Notice>
      ) : null}

      {/* v1.26.0 Lane 3b. An OFFER, never a gate: its own Notice, separate from the row-count
          summary above, so ignoring it leaves that summary exactly as it always read. Only
          rendered when a rule actually claimed a row of THIS import (ruleOffer is null
          otherwise) -- a rule-assigned row never reaches the review queue above (REVIEW_WHERE
          treats `source = 'rule'` as settled), which is exactly why it needs its own way to be
          found. Links to the fixed audit contract verbatim: /transactions?import=<id>&source=
          rule&group=category (a sibling lane owns that screen). */}
      {ruleOffer ? (
        <Notice tone="info">
          {ruleOffer.count} transaction{ruleOffer.count === 1 ? '' : 's'} {ruleOffer.count === 1 ? 'was' : 'were'} categorized
          by rules.{' '}
          <a
            className="font-semibold underline underline-offset-2"
            href={`/transactions?import=${ruleOffer.importId}&source=rule&group=category`}
          >
            Check {ruleOffer.count === 1 ? 'it' : 'them'}
          </a>
          .
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
              <div className="flex flex-col gap-1">
                {/* Ruling R9/T9: an OFX/QFX file skips the CSV mapping step entirely -- flow.ts
                    detects it by content, not by this accept attribute, which only shortens the
                    file picker's own filter. */}
                <input
                  type="file"
                  name="file"
                  accept=".csv,.ofx,.qfx,text/csv"
                  required
                  className={`${fileInputClass} py-2`}
                />
                <span className={hintClass}>
                  A CSV export, or an OFX/QFX file from your bank&rsquo;s &ldquo;download for Quicken&rdquo; option.
                </span>
              </div>
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
            // v1.13.1 fix round (item 5): an OFX preview has no mapping editor at all -- see
            // the ternary just below -- so telling that viewer to "fix the mapping" pointed at
            // a control that was never there.
            description={
              preview.source === 'csv'
                ? 'Wrong columns? Fix the mapping and the preview re-reads the same file.'
                : 'Check the rows below and commit.'
            }
          />
          <CardBody className="flex flex-col gap-4">
            {preview.source === 'csv' ? (
              <MappingEditor
                mapping={mapping}
                onChange={(next) => void rePreview(next)}
                dateFormatDetection={preview.dateFormatDetection}
                busy={busy}
                cardColumnOptions={preview.columnOptions}
              />
            ) : (
              // Item BP: an OFX file carries its own columns (DTPOSTED / NAME / TRNAMT / FITID),
              // so there is nothing to map and every control in the editor was inert.
              <p className="text-sm text-muted">
                This file carries its own columns, so there is nothing to map — check the rows
                below and commit.
              </p>
            )}

            {/* Lane 5 (2026-08-30 savings-targets plan, ruling T8). Deliberately reachable
                regardless of preview.errorCount/totalRows -- an OFX file skips this entirely (no
                CSV mapping to save, same reasoning flow.ts's own fork/repoint skip gives for
                OFX), but a CSV preview that found 0 rows and every row an error is exactly the
                case this button exists for: without it, the one mapping fix a person most needs
                to keep could never be saved, because the only other path into
                forkProfileIfBuiltin is a SUCCESSFUL commit. Never a bare "Save" -- the label
                names which of the two outcomes (fork vs. update-in-place) this press produces,
                because they are different enough that a person must be told which one they are
                getting. */}
            {preview.source === 'csv' && currentProfile ? (
              <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface-2/50 p-4">
                {currentProfile.isBuiltin ? (
                  <Field
                    label="New profile name"
                    hint={`"${currentProfile.name}" is a shared, built-in profile and is never changed in place — saving forks it into a new profile named "${currentProfile.name} (${forkAccountName || '…'})".`}
                  >
                    <input
                      value={forkAccountName}
                      onChange={(e) => setForkAccountName(e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                ) : null}
                <button type="button" onClick={() => void saveMapping()} disabled={busy} className="btn btn--secondary">
                  {currentProfile.isBuiltin ? 'Save as a new profile' : `Update ${currentProfile.name}`}
                </button>
                {mappingSaveState?.error ? <Notice tone="error">{mappingSaveState.error}</Notice> : null}
                {mappingSaveState?.message ? <Notice tone="success">{mappingSaveState.message}</Notice> : null}
              </div>
            ) : null}

            {mapping.cardCol !== null && preview.cardValues ? (
              <div className="rounded-lg border border-line bg-surface-2/50 p-4">
                {/* Lane 4 (2026-08-30 one-design-language plan): the shared small-caps
                    SectionHeader, in place of a hand-rolled <h3> -- this stays a table page
                    (ruling D7), so SectionHeader is the one piece of the new system it adopts. */}
                <SectionHeader title="Cardholder assignments" />
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

            {/* Ruling S4: this is a spreadsheet preview -- raw CSV columns side by side, exactly
                what a person is here to compare -- so it stays a plain table with sideways
                scroll, and gets no `responsive` and no cell-stack-* classes. The data-label
                attributes below do nothing without the stacking class on an ancestor (see
                .data-table--stack in globals.css), so this table's behaviour is unchanged; they
                exist only so this file's OTHER table (History, below) can go responsive without
                failing the cross-file "every responsive file labels at least as many cells as it
                has column headers" floor in tests/ops/table-layout.test.ts, which counts both
                tables in this file together. */}
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
                    <td className="tabnum whitespace-nowrap text-muted" data-label="Date">{row.date}</td>
                    <td data-label="Description">{row.rawDescription}</td>
                    <td className="text-muted" data-label="Merchant">{row.normalizedMerchant}</td>
                    <td className="text-right" data-label="Amount"><Money cents={row.amountCents} /></td>
                    <td className="text-muted" data-label="Category">{row.predictedCategoryName ?? '—'}{row.predictedSource === 'bayes' ? ' (guess)' : ''}</td>
                    <td data-label="Flags">
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
              {historyRows.map((row) => (
                <tr key={row.id}>
                  {/* v1.16.0 Lane C item 3: When and Account are context for the row, not the
                      fact it is about -- File (below) already carries `cell-stack-headline`, so
                      `cell-stack-meta` puts these on a small muted line under it instead of two
                      more labelled rows of their own. */}
                  <td className="tabnum whitespace-nowrap text-muted cell-stack-meta" data-label="When">{row.createdAt.slice(0, 16).replace('T', ' ')}</td>
                  {/* Truncate with a title, never a bare ellipsis: the full account name and
                      the full filename stay readable on hover and to a screen reader. */}
                  <td className="cell-truncate cell-stack-meta" title={row.accountName} data-label="Account">{row.accountName}</td>
                  {/* v1.15.0 (responsive rows): the filename is what tells one import from
                      another -- Account repeats across every re-import of the same statement --
                      so it is the phone card's headline. No cell-stack-amount: Added/Dupes/Errors
                      are row counts, not money. */}
                  <td className="cell-truncate font-mono text-xs cell-stack-headline" title={row.filename} data-label="File">{row.filename}</td>
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
                        className="btn btn--secondary btn--sm min-h-11 sm:min-h-0"
                      >
                        View rows
                      </a>
                      <button
                        type="button"
                        onClick={() => void undo(row.id)}
                        disabled={busy}
                        className="btn btn--secondary btn--sm"
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

      <p className="text-sm text-muted">
        Importing from a bank that is not listed? Either adjust the columns in the preview editor above (editing a built-in profile automatically saves a
        copy for this account and leaves the shared preset untouched), or <a className="font-medium text-accent-text underline underline-offset-2" href="/import/wizard">set up a new bank profile from a
        sample file</a>.
      </p>
    </div>
  );
}
