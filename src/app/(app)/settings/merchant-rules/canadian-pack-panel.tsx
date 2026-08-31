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

      {confirmingInstall && installPreview ? (
        <div className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3 text-xs text-muted">
          <p>
            Installing writes <strong className="font-semibold text-ink">{installPreview.wouldWrite}</strong> rule
            {ruleWord(installPreview.wouldWrite) === 'rules' ? 's' : ''} out of {installPreview.totalRules} in the
            pack ({installPreview.categoryRules} categorizations, {installPreview.renameRules} merchant-name
            cleanups).
            {installPreview.alreadyPresent > 0
              ? ` ${installPreview.alreadyPresent} pattern${installPreview.alreadyPresent === 1 ? '' : 's'} you already have will be left exactly as they are.`
              : ''}
          </p>
          <p>
            Renames apply to your existing transactions immediately. Category rules only affect future imports --
            use <strong className="font-semibold text-ink">Re-run rules</strong> above to catch up older transactions.
          </p>
          <p>
            <strong className="font-semibold text-ink">FORTIS</strong> and <strong className="font-semibold text-ink">ATCO</strong> are
            this pack&apos;s documented likely-miscategorisations (both are diversified holding companies, not
            pure utilities) -- worth checking their &quot;Affects&quot; figure on the rules table after installing.
          </p>
          <p>Every rule this installs is removable afterward with the Remove all button above.</p>
          <div className="flex gap-2">
            <form action={install} onSubmit={() => setConfirmingInstall(false)}>
              <SubmitButton size="sm">Install now</SubmitButton>
            </form>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmingInstall(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {confirmingRemove && removalPreview ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-negative-soft bg-surface p-3 text-sm">
          <span className="text-ink">
            Remove {removalPreview.ruleCount} preset rule{removalPreview.ruleCount === 1 ? '' : 's'}?
            {removalPreview.transactionsRevert > 0
              ? ` ${removalPreview.transactionsRevert} transaction${removalPreview.transactionsRevert === 1 ? '' : 's'} using a preset rename will revert to the bank's wording.`
              : ' This cannot be undone.'}
            {' '}A rule you edited since installing is not touched -- it is already yours.
          </span>
          <form action={remove} onSubmit={() => setConfirmingRemove(false)}>
            <SubmitButton variant="danger" size="sm">Remove permanently</SubmitButton>
          </form>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConfirmingRemove(false)}>
            Cancel
          </button>
        </div>
      ) : null}

      {reviewingUpdate && updateDiff ? (
        <div className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3 text-xs text-muted">
          <h4 className="eyebrow text-ink">
            What v{updateDiff.toVersion} changes (currently v{updateDiff.fromVersion ?? '?'})
          </h4>
          {updateDiff.added.length > 0 ? (
            <p>
              <strong className="font-semibold text-ink">{updateDiff.added.length} added:</strong>{' '}
              {updateDiff.added.map((e) => e.pattern).join(', ')}
            </p>
          ) : null}
          {updateDiff.changed.length > 0 ? (
            <div>
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
            <p>
              <strong className="font-semibold text-ink">{updateDiff.removed.length} no longer in the pack:</strong>{' '}
              {updateDiff.removed.map((e) => e.pattern).join(', ')}
            </p>
          ) : null}
          {updateDiff.skippedEdited.length > 0 ? (
            <p>
              {updateDiff.skippedEdited.length} rule{updateDiff.skippedEdited.length === 1 ? '' : 's'} left alone --
              you have edited {updateDiff.skippedEdited.length === 1 ? 'it' : 'them'} since installing:{' '}
              {updateDiff.skippedEdited.map((e) => e.pattern).join(', ')}
            </p>
          ) : null}
          <p>{updateDiff.unchangedCount} rule{updateDiff.unchangedCount === 1 ? '' : 's'} unchanged.</p>
          <p>A disabled rule stays disabled. Nothing here is applied until you press Apply update below.</p>
          {updateDiff.removed.length > 0 ? (
            <label className="flex items-start gap-2 text-muted">
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
        </div>
      ) : null}
    </section>
  );
}
