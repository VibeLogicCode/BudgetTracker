'use client';

// Backlog item 17 ("an imported pack cannot be un-imported") plus the owner's follow-up ask to
// make the Canadian merchant pack installable/removable/version-aware from inside the app,
// instead of the download-and-import-a-file path RulesPackPanel still offers (kept, on purpose --
// see this feature's spec, Part 1: that panel is for sharing a pack with ANOTHER install, this one
// is for the ONE bundled preset this build ships).

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
import { RowDialog } from '@/components/ui/RowDialog';
import type {
  CanadianPackInstallPreview,
  CanadianPackRemovalPreview,
  CanadianPackState,
  CanadianPackUpdateDiff,
} from '@/lib/canadian-pack';
import { applyCanadianPackUpdateAction, installCanadianPackAction, removeCanadianPackAction, type RuleActionState } from './actions';

const initial: RuleActionState = {};

function ruleWord(n: number): string {
  return n === 1 ? 'rule' : 'rules';
}

export function CanadianPackPanel({
  state,
  installPreview,
  removalPreview,
  updateDiff,
}: {
  state: CanadianPackState;
  installPreview: CanadianPackInstallPreview | null;
  removalPreview: CanadianPackRemovalPreview | null;
  updateDiff: CanadianPackUpdateDiff | null;
}) {
  const [installState, install] = useActionState(installCanadianPackAction, initial);
  const [removeState, remove] = useActionState(removeCanadianPackAction, initial);
  const [updateState, applyUpdate] = useActionState(applyCanadianPackUpdateAction, initial);

  const [confirmingInstall, setConfirmingInstall] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [reviewingUpdate, setReviewingUpdate] = useState(false);
  const [deleteRemoved, setDeleteRemoved] = useState(false);

  const message = installState.message ?? removeState.message ?? updateState.message;
  const error = installState.error ?? removeState.error ?? updateState.error;

  const statusLine = !state.installed
    ? 'not installed'
    : `installed, v${state.installedVersion} · ${state.presentCount} of ${state.totalCount} present`;

  /**
   * Owner ask (2026-08-31): these three confirmations shipped in v1.23.0 as inline disclosures
   * (a plain bordered div toggled by useState), because the brief that produced this file spelled
   * out what each one had to SAY and DO and never named an idiom, so it fell back to copying the
   * nearest pattern in this same file rather than the dialog every OTHER page-level confirm with
   * a consequence to read uses. See RowDialog's own docblock for the rule this now follows: a
   * confirm belongs to a dialog once there is no single row left for it to anchor to (install and
   * remove act on the whole pack; update reviews a diff across many rules) and it carries wording
   * that must be read before agreeing -- exactly the case here. Each function below is called
   * once, at the bottom of this component's return, mirroring merchant-rules-client.tsx's own
   * `ruleDialog()` -- not rendered inline where the state lived, so the mount-once contract
   * (`{state ? <RowDialog .../> : null}`) RowDialog's docblock asks for is visibly satisfied.
   *
   * Every word of the disclaimer, the remove-consequence count and the update diff below is
   * unchanged from the v1.23.0 inline version -- only the shell around it and each dialog's own
   * title (RowDialog requires one; none of the three had a heading before except the update
   * review's own "What vX changes" line, which stays exactly where it was, inside the body) are
   * new.
   */
  function installDialog() {
    if (!confirmingInstall || !installPreview) return null;
    return (
      <RowDialog
        dialogId="install-pack-dialog"
        title="Install the Canadian merchant pack"
        onClose={() => setConfirmingInstall(false)}
      >
        <p className="text-xs text-muted">
          Installing writes <strong className="font-semibold text-ink">{installPreview.wouldWrite}</strong> rule
          {ruleWord(installPreview.wouldWrite) === 'rules' ? 's' : ''} out of {installPreview.totalRules} in the
          pack ({installPreview.categoryRules} categorizations, {installPreview.renameRules} merchant-name
          cleanups).
          {installPreview.alreadyPresent > 0
            ? ` ${installPreview.alreadyPresent} pattern${installPreview.alreadyPresent === 1 ? '' : 's'} you already have will be left exactly as they are.`
            : ''}
        </p>
        <p className="text-xs text-muted">
          Renames apply to your existing transactions immediately. Category rules only affect future imports --
          use <strong className="font-semibold text-ink">Re-run rules</strong> above to catch up older transactions.
        </p>
        <p className="text-xs text-muted">
          <strong className="font-semibold text-ink">FORTIS</strong> and{' '}
          <strong className="font-semibold text-ink">ATCO</strong> are this pack&apos;s documented
          likely-miscategorisations (both are diversified holding companies, not pure utilities) -- worth checking
          their &quot;Affects&quot; figure on the rules table after installing.
        </p>
        <p className="text-xs text-muted">Every rule this installs is removable afterward with the Remove all button above.</p>
        <div className="flex gap-2">
          <form action={install} onSubmit={() => setConfirmingInstall(false)}>
            <SubmitButton size="sm">Install now</SubmitButton>
          </form>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmingInstall(false)}>
            Cancel
          </button>
        </div>
      </RowDialog>
    );
  }

  function removeDialog() {
    if (!confirmingRemove || !removalPreview) return null;
    return (
      <RowDialog
        dialogId="remove-pack-dialog"
        title="Remove the Canadian merchant pack"
        onClose={() => setConfirmingRemove(false)}
      >
        <p className="text-sm text-ink">
          Remove {removalPreview.ruleCount} preset rule{removalPreview.ruleCount === 1 ? '' : 's'}?
          {removalPreview.transactionsRevert > 0
            ? ` ${removalPreview.transactionsRevert} transaction${removalPreview.transactionsRevert === 1 ? '' : 's'} using a preset rename will revert to the bank's wording.`
            : ' This cannot be undone.'}
          {' '}A rule you edited since installing is not touched -- it is already yours.
        </p>
        <div className="flex gap-2">
          <form action={remove} onSubmit={() => setConfirmingRemove(false)}>
            <SubmitButton variant="danger" size="sm">Remove permanently</SubmitButton>
          </form>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConfirmingRemove(false)}>
            Cancel
          </button>
        </div>
      </RowDialog>
    );
  }

  function updateDialog() {
    if (!reviewingUpdate || !updateDiff) return null;
    return (
      <RowDialog
        dialogId="update-pack-dialog"
        title={`Update the Canadian merchant pack to v${updateDiff.toVersion}`}
        onClose={() => setReviewingUpdate(false)}
      >
        <h4 className="eyebrow text-ink">
          What v{updateDiff.toVersion} changes (currently v{updateDiff.fromVersion ?? '?'})
        </h4>
        {updateDiff.added.length > 0 ? (
          <p className="text-xs text-muted">
            <strong className="font-semibold text-ink">{updateDiff.added.length} added:</strong>{' '}
            {updateDiff.added.map((e) => e.pattern).join(', ')}
          </p>
        ) : null}
        {updateDiff.changed.length > 0 ? (
          <div className="text-xs text-muted">
            <strong className="font-semibold text-ink">{updateDiff.changed.length} changed:</strong>
            <ul className="mt-1 list-inside list-disc">
              {updateDiff.changed.map((e) => (
                <li key={`${e.pattern}-${e.matchType}-${e.ruleKind}`}>
                  <code className="font-mono">{e.pattern}</code>: {e.before} → {e.after}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {updateDiff.removed.length > 0 ? (
          <p className="text-xs text-muted">
            <strong className="font-semibold text-ink">{updateDiff.removed.length} no longer in the pack:</strong>{' '}
            {updateDiff.removed.map((e) => e.pattern).join(', ')}
          </p>
        ) : null}
        {updateDiff.skippedEdited.length > 0 ? (
          <p className="text-xs text-muted">
            {updateDiff.skippedEdited.length} rule{updateDiff.skippedEdited.length === 1 ? '' : 's'} left alone --
            you have edited {updateDiff.skippedEdited.length === 1 ? 'it' : 'them'} since installing:{' '}
            {updateDiff.skippedEdited.map((e) => e.pattern).join(', ')}
          </p>
        ) : null}
        <p className="text-xs text-muted">{updateDiff.unchangedCount} rule{updateDiff.unchangedCount === 1 ? '' : 's'} unchanged.</p>
        <p className="text-xs text-muted">A disabled rule stays disabled. Nothing here is applied until you press Apply update below.</p>
        {updateDiff.removed.length > 0 ? (
          <label className="flex items-start gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={deleteRemoved}
              onChange={(e) => setDeleteRemoved(e.target.checked)}
              className="mt-0.5 accent-accent"
            />
            Also delete the {updateDiff.removed.length} rule{updateDiff.removed.length === 1 ? '' : 's'} no longer in
            the pack (otherwise kept, just no longer tracked as a preset)
          </label>
        ) : null}
        <div className="flex gap-2">
          <form action={applyUpdate} onSubmit={() => setReviewingUpdate(false)}>
            <input type="hidden" name="deleteRemoved" value={deleteRemoved ? '1' : '0'} />
            <SubmitButton size="sm">{`Apply update to v${updateDiff.toVersion}`}</SubmitButton>
          </form>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setReviewingUpdate(false)}>
            Cancel
          </button>
        </div>
      </RowDialog>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2/50 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-ink">
            Preset rules <span className="font-normal text-muted">— {statusLine}</span>
          </h3>
          <p className="text-xs text-muted">
            The Canadian merchant pack this build ships (gas, coffee, groceries, telecom, utilities and more) --
            bundled in, not a file to find and upload.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!state.installed ? (
            <button type="button" className="btn btn--primary btn--sm" onClick={() => setConfirmingInstall(true)}>
              Install
            </button>
          ) : (
            <>
              {state.updateAvailable ? (
                <span className="flex items-center gap-2">
                  <Pill tone="accent">{`Update available (v${state.installedVersion} → v${state.bundledVersion})`}</Pill>
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => setReviewingUpdate(true)}>
                    Update
                  </button>
                </span>
              ) : null}
              <button type="button" className="btn btn--danger btn--sm" onClick={() => setConfirmingRemove(true)}>
                Remove all
              </button>
            </>
          )}
        </div>
      </div>

      <FormError message={error} />
      {message === undefined ? null : <Notice tone="success">{message}</Notice>}

      {installDialog()}
      {removeDialog()}
      {updateDialog()}
    </section>
  );
}
