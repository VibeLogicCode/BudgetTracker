'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';
import { FormError } from '@/components/FormError';
import { renderEmphasis } from '@/components/render-emphasis';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import type { UpdateSeverity } from '@/lib/update/semver';
import {
  applyUpdateAction,
  checkForUpdateNowAction,
  disableUpdateChecksAction,
  dismissUpdateAction,
  enableUpdateChecksAction,
  reviewUpdateAction,
  setAutoApplyAction,
  type ReviewUpdateState,
  type UpdateActionState,
} from './actions';
import { pendingApplyMessage } from './pending-apply-message';

export interface UpdatesViewProps {
  currentVersion: string;
  enabled: boolean;
  autoApply: boolean;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  latestVersion: string | null;
  latestPublishedAt: string | null;
  dismissedVersion: string | null;
  lastAppliedAt: string | null;
  lastApplyError: string | null;
  /** Task 3d (symptom B): committed BEFORE the Watchtower fetch (MUST-7.4) — non-null here
   *  means the database already knows an apply is in flight, whether or not this render is
   *  the one that triggered it. See resolveView() and the pending block below. */
  applyRequestedVersion: string | null;
  applyRequestedAt: string | null;
  severity: UpdateSeverity;
  /** MUST-7.3: the card receives this boolean and NOTHING else about Watchtower. */
  canApplyInApp: boolean;
  watchtowerError: string | null;
  /** Backlog item 17 / Part 4: null when up to date or nothing installed -- see UpdatesCard for
   *  how this is derived (a plain version comparison, never a network call). */
  canadianPackUpdate: { installedVersion: number | null; bundledVersion: number } | null;
}

const initial: UpdateActionState = {};

const SEVERITY_BADGE: Record<Exclude<UpdateSeverity, 'none'>, string> = {
  patch: 'Patch update',
  minor: 'Minor update',
  major: 'Major update',
};

/** notify §11.4's amendment, and the app's ONE timestamp convention. No relative strings. */
function stamp(iso: string | null): string {
  return iso === null ? 'Never' : iso.slice(0, 16).replace('T', ' ');
}

/**
 * Mirrors state.ts's export of the same name (MUST-7.6's 30-minute apply-confirm window).
 * That module reads and writes the settings table through @/lib/settings -> @/db/client, which
 * pulls better-sqlite3 — a native module — into anything that imports it. That is exactly the
 * MUST-2.1 client-bundle hazard semver.ts's own docblock names for this very file: importing
 * state.ts here to reuse one integer would pull the database client into the browser build.
 * Duplicating the constant is the smaller, and the only safe, cost. Keep it in lockstep with
 * state.ts if that value ever changes.
 */
const APPLY_CONFIRM_MAX_AGE_MS = 30 * 60_000;

/** Every field the card renders that comes from update state rather than from the build. */
type ResolvedAvailability = Pick<
  UpdatesViewProps,
  | 'latestVersion'
  | 'latestPublishedAt'
  | 'lastCheckedAt'
  | 'severity'
  | 'applyRequestedVersion'
  | 'applyRequestedAt'
  | 'enabled'
  | 'autoApply'
  | 'dismissedVersion'
>;

/** The fields resolveView picks over, named once so the loop below and the type agree. */
const RESOLVED_KEYS = [
  'latestVersion',
  'latestPublishedAt',
  'lastCheckedAt',
  'severity',
  'applyRequestedVersion',
  'applyRequestedAt',
  'enabled',
  'autoApply',
  'dismissedVersion',
] as const;

/**
 * Task 3d (symptom A). Every update action now hands back exactly what it just wrote
 * (actions.ts's UpdateActionState fields); this is the ONE place that decides which source wins
 * when props and several action results might all disagree. An action result beats props,
 * because props may be from a render Next never refreshed (the owner's report); among action
 * results the freshest wins.
 *
 * `!== undefined` is deliberate, not a truthiness or `||` test: an action that ran and found
 * nothing (severity 'none', latestVersion null, dismissedVersion null) still WINS, because those
 * are defined values, not absent ones — a stale "version available" from props must not survive
 * a check that just proved there is nothing to offer.
 *
 * v1.31.0 item M-3: SIX action states, not two, and ranked by each result's own `resolvedAt`
 * stamp rather than by the order they are listed in. With two the hardcoded order was arguable;
 * with six it is not — press Enable then Check and the enable result's correctly-wiped
 * `latestVersion: null` is a defined value that would beat the check result's real answer under
 * any fixed ordering, while reversing the order breaks the opposite sequence. Sorting is stable,
 * so a result with no stamp (an action that refused before writing, or a test that hands back a
 * partial payload) keeps its listed position behind the stamped ones and still beats props.
 */
function resolveView(props: UpdatesViewProps, states: readonly UpdateActionState[]): ResolvedAvailability {
  const ranked = [...states].sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));
  const resolved = {} as Record<(typeof RESOLVED_KEYS)[number], unknown>;
  for (const key of RESOLVED_KEYS) {
    const winner = ranked.find((state) => state[key] !== undefined);
    resolved[key] = winner === undefined ? props[key] : winner[key];
  }
  return resolved as ResolvedAvailability;
}

export function UpdatesClient(props: UpdatesViewProps) {
  const [enableState, enable] = useActionState(enableUpdateChecksAction, initial);
  const [disableState, disable] = useActionState(disableUpdateChecksAction, initial);
  const [autoState, saveAuto] = useActionState(setAutoApplyAction, initial);
  const [checkState, checkNow] = useActionState(checkForUpdateNowAction, initial);
  const [applyState, apply] = useActionState(applyUpdateAction, initial);
  const [dismissState, dismiss] = useActionState(dismissUpdateAction, initial);
  const [review, runReview, reviewPending] = useActionState(
    async (_prev: ReviewUpdateState, formData: FormData) => reviewUpdateAction(formData),
    {} as ReviewUpdateState,
  );
  const [panelOpen, setPanelOpen] = useState(false);

  const messages = [enableState, disableState, autoState, checkState, applyState, dismissState];
  const message = messages.map((s) => s.message).find((m) => m !== undefined);
  const error = messages.map((s) => s.error).find((e) => e !== undefined) ?? review.error;

  // Task 3d (symptom A) / item M-3: resolved, not props, from here down — see resolveView above.
  // Hoisted ABOVE the "checks are off" branch because `enabled` is now resolved too: pressing
  // Enable used to leave that branch rendered until the page was reloaded by hand.
  const resolved = resolveView(props, messages);

  /**
   * Item M-6. `pending` compares a wall-clock reading against a server-written timestamp, and
   * UpdatesClient is rendered on the SERVER for the initial HTML and again on hydration. Reading
   * Date.now() during render therefore produced two different answers for a request landing
   * within a few hundred milliseconds of MUST-7.6's 30-minute boundary — pending notice in the
   * HTML, `Update now` button after hydration, which is a hydration mismatch React resolves by
   * discarding and re-rendering the tree.
   *
   * Fixed by not reading the clock during the first render at all: `null` until an effect has
   * run, which is a value the server and the hydrating client agree on by construction. The
   * effect re-reads on every change to the pending stamp, so a fresh apply result computes
   * against a fresh clock rather than against mount time.
   *
   * The docblock below is unchanged and still right: this sets no timer, no interval and no
   * poll. An effect that runs once per state change is not a poll, and MUST-9.9's concern is
   * repeatedly asking a container that is about to be replaced, not reading the browser's clock.
   *
   * The honest cost: on a hard page load while an apply IS in flight, the first paint shows
   * `Update now` for one frame before the effect swaps in the pending notice. Rejected
   * alternative: having UpdatesCard (the Server Component) compute the boolean and pass it as a
   * prop, which removes even that flash. It also puts the 30-minute rule in a second place — the
   * server would own the props path and this component would still need the clock for the
   * post-action path, where `applyRequestedAt` comes from an action result the server never saw.
   * One rule in one place, with a one-frame flash, beat two rules that must agree.
   */
  const [clockMs, setClockMs] = useState<number | null>(null);
  const applyStamp = resolved.applyRequestedAt;
  useEffect(() => {
    setClockMs(Date.now());
  }, [applyStamp]);

  /**
   * Backlog item 17 / Part 4: independent of whether APP update checks are on/off (this is a
   * plain, local version comparison -- no GitHub request, nothing to enable) so it renders in
   * both the "checks are off" branch below and the normal one. Never an apply control here -- see
   * applyCanadianPackUpdate's own docblock for why the diff-and-confirm step only ever lives on
   * the merchant-rules page, which is what this links to.
   */
  const canadianPackNotice =
    props.canadianPackUpdate === null ? null : (
      <Notice tone="info" title="Preset rules: an update is available">
        <p>
          The Canadian merchant pack you installed is v{props.canadianPackUpdate.installedVersion}; this build ships
          v{props.canadianPackUpdate.bundledVersion}.{' '}
          <Link href="/settings/merchant-rules" className="underline">
            Review the change and apply it on Settings → Merchant rules
          </Link>
          .
        </p>
      </Notice>
    );

  // MUST-9.3: the off state. One button, no other control.
  if (!resolved.enabled) {
    return (
      <Card>
        <CardHeader title="Updates" description={`Budget Tracker v${props.currentVersion} · update checks are off.`} />
        <CardBody className="flex flex-col gap-4">
          {canadianPackNotice}
          <p className="text-sm text-muted">
            This app does not check for updates unless you ask it to. Switch this on and once a day it will ask GitHub
            whether a newer version of Budget Tracker has been published. That request carries the version you are
            running and nothing else — not your data, not your address, not how many people use this install.
          </p>
          <p className="text-sm text-muted">
            Small updates (bug fixes and new features) install themselves. A major version never does: you will be
            told, shown exactly what changed, and asked.
          </p>
          <FormError message={error} />
          <form action={enable}>
            <SubmitButton className="btn btn--primary">Enable update checks</SubmitButton>
          </form>
        </CardBody>
      </Card>
    );
  }

  const severity = resolved.severity;
  const offered = severity !== 'none' && resolved.latestVersion !== null ? resolved.latestVersion : null;
  // Item M-3: resolved, not props. dismissUpdateAction hands back the dismissedVersion it just
  // wrote, so "Not now" takes effect without a manual reload.
  const dismissed = offered !== null && resolved.dismissedVersion === offered;

  /**
   * Task 3d (symptom B). MUST-9.9 forbids polling a container that is about to be replaced —
   * it does NOT forbid rendering the pending state the database already holds. This reads
   * Date.now() exactly once, at render, the same way any other derived value in this component
   * is computed; it sets no timer, no interval, no auto-reload. The rejected alternative was a
   * client poll re-checking apply status every few seconds specifically to grey out this
   * button — precisely the thing MUST-9.9 exists to prevent, since the container that would
   * have to answer that poll is the one about to die. The block below retires itself the next
   * time ANY server action runs (a fresh check, a fresh apply) or the page is reloaded by hand,
   * because reconcilePendingApply (state.ts) clears the flag on the next boot or check tick —
   * never because this component watched for it.
   */
  const pending =
    offered !== null &&
    resolved.applyRequestedVersion === offered &&
    resolved.applyRequestedAt !== null &&
    clockMs !== null &&
    clockMs - Date.parse(resolved.applyRequestedAt) < APPLY_CONFIRM_MAX_AGE_MS;

  // Item M-2: ONE definition of this sentence (./pending-apply-message), the same function
  // actions.ts returns when applyUpdate's single-flight guard fires for this same condition. It
  // used to be this JSX and a template literal over there, kept in step by a comment.
  const pendingNotice =
    offered === null ? null : (
      <Notice tone="info" title={`Update requested ${stamp(resolved.applyRequestedAt)}`}>
        <p>{pendingApplyMessage(offered, props.currentVersion)}</p>
      </Notice>
    );

  return (
    <Card>
      <CardHeader
        title="Updates"
        description={
          offered === null
            ? `Up to date (v${props.currentVersion})`
            : `Version ${offered} is available`
        }
        action={
          offered === null || severity === 'none' ? null : (
            <span className="badge badge--amber">{SEVERITY_BADGE[severity]}</span>
          )
        }
      />
      <CardBody className="flex flex-col gap-4">
        {canadianPackNotice}
        <p className="text-sm text-subtle">
          Last checked {stamp(resolved.lastCheckedAt)}
          {resolved.latestPublishedAt === null ? null : ` · published ${stamp(resolved.latestPublishedAt)}`}
          {props.lastAppliedAt === null ? null : ` · last updated ${stamp(props.lastAppliedAt)}`}
        </p>

        {props.lastCheckError === null ? null : <Notice tone="error">{props.lastCheckError}</Notice>}
        {props.lastApplyError === null ? null : <Notice tone="error">{props.lastApplyError}</Notice>}
        {props.watchtowerError === null ? null : <Notice tone="error">{props.watchtowerError}</Notice>}
        <FormError message={error} />
        {message === undefined ? null : <Notice tone="success">{message}</Notice>}

        <div className="flex flex-wrap items-center gap-3">
          <form action={checkNow}>
            <SubmitButton className="btn btn--secondary">Check now</SubmitButton>
          </form>
          <form action={saveAuto} className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" name="autoApply" defaultChecked={resolved.autoApply} />
              Install small updates automatically
            </label>
            <SubmitButton className="btn btn--ghost btn--sm">Save</SubmitButton>
          </form>
          <form action={disable} className="ml-auto">
            <SubmitButton className="btn btn--ghost">Disable update checks</SubmitButton>
          </form>
        </div>

        {offered === null ? null : dismissed ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted">Version {offered} is available — you chose to skip it for now.</p>
            <form action={dismiss}>
              <input type="hidden" name="version" value="" />
              <SubmitButton className="btn btn--ghost btn--sm">Show again</SubmitButton>
            </form>
          </div>
        ) : !props.canApplyInApp ? (
          // MUST-7.8: the apply button is ABSENT, not disabled. A disabled button invites a
          // click and then explains itself, and there is nothing to explain away.
          // MUST-7.9: shipped verbatim. Every path and filename is plain text, never an
          // <a href>. It keeps the zero-egress claim trivially auditable and it survives a
          // screenshot.
          <Notice tone="info" title="This install updates by hand.">
            {/* Fix wave item 3: the old copy claimed "no Watchtower companion... cannot
                replace itself" for EVERY !canApplyInApp install, which is false for a
                pre-1.3.1 compose file — that install still has Watchtower, and it may still
                be auto-pulling on its old daily timer, just without an HTTP endpoint this
                app can ask on demand. The wording below covers both realities honestly
                instead of asserting the wrong one for whichever install actually has no
                trigger at all (build from source, a bare `npm start`). */}
            <p>
              This app has no way to trigger an update for itself here. That is expected if you built from source or
              run it with a bare <code>npm start</code>. If your compose file predates 1.3.1 instead, it does not
              have this trigger either — but it may still have Watchtower&apos;s old daily auto-pull running in the
              background regardless, quietly updating this container without asking. Check that container&apos;s
              logs if you want to be sure either way.
            </p>
            <p>
              To move to the new version by hand, run <code>./install/update.sh</code> on Linux, macOS, a Raspberry
              Pi, or Synology over SSH, or <code>.\install\update.ps1</code> on Windows. Both scripts tag a rollback
              point first and put it back automatically if the new version does not come up healthy.
            </p>
            <p>
              If you installed with the prebuilt image, you can switch to in-app updates instead by replacing your
              compose file with the current <code>install/synology-compose-pull.yml</code> — see INSTALL.md, "Moving
              to in-app updates".
            </p>
          </Notice>
        ) : severity === 'major' ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <form action={runReview}>
                <input type="hidden" name="version" value={offered} />
                {/* Review fix (MED): panelOpen is set from onClick, an ordinary, urgent
                    event handler, rather than from inside the form's action. React does
                    not commit a state update made INSIDE a pending action/transition until
                    that action settles, so setting it there left the panel (and therefore
                    reviewPending's "Fetching release notes…" line) invisible for the whole
                    length of the fetch; onClick fires before the transition starts. */}
                <SubmitButton className="btn btn--primary" onClick={() => setPanelOpen(true)}>
                  Review and update
                </SubmitButton>
              </form>
              <form action={dismiss}>
                <input type="hidden" name="version" value={offered} />
                <SubmitButton className="btn btn--ghost">Not now</SubmitButton>
              </form>
            </div>
            {!panelOpen ? null : (
              <div className="flex flex-col gap-3 rounded-md border border-line px-4 py-4">
                <h3 className="text-sm font-semibold text-ink">What changed in {offered}</h3>
                {reviewPending ? (
                  // Review fix (MED): this used to be indistinguishable from a genuinely
                  // failed fetch, because panelOpen flips true and review.release is still
                  // undefined for the entire duration of the request. Every review would
                  // flash the "could not be fetched" sentence before the real notes arrived.
                  <p className="text-sm text-muted">Fetching release notes…</p>
                ) : review.release === undefined ? (
                  // MUST-9.6: a failed changelog read must not become a wall that stops an
                  // admin updating. The confirm button below is still offered.
                  <p className="text-sm text-muted">
                    The release notes for {offered} could not be fetched. You can read them on the project&apos;s
                    releases page before deciding.
                  </p>
                ) : (
                  review.release.groups.map((group, index) => (
                    // M-7 (2026-09-02 review): same fix as about-panel.tsx -- `group.title`
                    // alone collides when a release has two same-named `###` groups.
                    <div key={`${index}-${group.title}`} className="flex flex-col gap-1.5">
                      <h4 className="eyebrow">{group.title}</h4>
                      <ul className="flex flex-col gap-1 text-sm text-muted">
                        {group.items.map((item, index) => (
                          <li key={index} className="flex gap-2">
                            <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                            <span>{renderEmphasis(item)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
                <Notice tone="warning">
                  This is a major version. Read the notes above before continuing. Your data is not touched by an
                  update — the database stays where it is and migrations run automatically when the new version
                  starts.
                </Notice>
                <div className="flex flex-wrap items-center gap-3">
                  {pending ? (
                    // Task 3d (symptom B): in place of the "Install X" button ONLY — the rest
                    // of this panel (notes, warning, Cancel) is untouched, because a request
                    // already fired from here and the reader may still want to re-read what
                    // they confirmed.
                    pendingNotice
                  ) : (
                    <form action={apply}>
                      <input type="hidden" name="version" value={offered} />
                      {/* MUST-9.5: the version is in the LABEL, so a stale panel cannot install
                          something the reader did not read about. */}
                      <SubmitButton className="btn btn--primary">Install {offered}</SubmitButton>
                    </form>
                  )}
                  <button type="button" className="btn btn--ghost" onClick={() => setPanelOpen(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : pending ? (
          // Task 3d (symptom B): in place of the Update now / Not now row entirely — no
          // button lives here while the database says a request for THIS version is already
          // in flight, so a stale tab cannot fire a second one.
          pendingNotice
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <form action={apply}>
              <input type="hidden" name="version" value={offered} />
              <SubmitButton className="btn btn--primary">Update now</SubmitButton>
            </form>
            <form action={dismiss}>
              <input type="hidden" name="version" value={offered} />
              <SubmitButton className="btn btn--ghost">Not now</SubmitButton>
            </form>
          </div>
        )}

        {/* MUST-9.9: no spinner, no polling, no auto-reload. The container is going away; a
            page trying to poll it is a page showing a network error. */}
      </CardBody>
    </Card>
  );
}
