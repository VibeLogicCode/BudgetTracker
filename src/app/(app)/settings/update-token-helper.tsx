'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { buttonClass } from '@/components/ui/Button';
import { CardActionRow } from '@/components/ui/CardActionRow';
import { DisclosureSummary } from '@/components/ui/Disclosure';
import { WarningIcon } from '@/components/ui/icons';
import { Sheet } from '@/components/ui/Sheet';

/**
 * v1.59.1: the helper for an install that still runs on the shared default update token. The app
 * cannot change the token itself (it has no Docker access, on purpose), so this makes the manual
 * change a copy-paste job: a quiet line in the Updates card, and a Sheet with a fresh value and the
 * steps. MUST-7.3 holds: the card is told only THAT the default is in use (a boolean), and the new
 * value is made here, in the browser, never sent to the server and never stored by the app.
 */

/** How long a Copy button shows its outcome before its label returns. */
const COPY_OUTCOME_MS = 2000;

/** 32 random bytes from this browser's crypto.getRandomValues, as 64 lowercase hex characters. */
function newUpdateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The page's one new update token, and how to make it. */
export interface UpdateToken {
  value: string | null;
  /** Makes the value when there is none yet; does nothing once there is one. */
  ensure: () => void;
}

/**
 * Held by UpdatesClient, above both of its branches, so turning update checks on or off (which
 * moves the line from one branch to the other and remounts it) keeps the same value. It is made on
 * the first Fix and kept while the page stays open, so closing and reopening the Sheet, or toggling
 * checks, never hands out a second value after the first went into one of the places that must match.
 */
export function useUpdateToken(): UpdateToken {
  const [value, setValue] = useState<string | null>(null);
  return {
    value,
    ensure: () => {
      if (value === null) setValue(newUpdateToken());
    },
  };
}

/** Sits directly under the card's "Last checked" line (or at the top of the card with checks off). */
export function UpdateTokenLine({ token }: { token: UpdateToken }) {
  const [open, setOpen] = useState(false);

  function openSheet() {
    token.ensure();
    setOpen(true);
  }

  return (
    <>
      <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
        <WarningIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
        <span>Update token: shared default</span>
        <CardActionRow inline opensDialog onClick={openSheet}>
          Fix
        </CardActionRow>
      </p>
      {open && token.value !== null ? <UpdateTokenSheet token={token.value} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

type CopyTarget = 'token' | 'app' | 'watchtower' | 'env';
type CopyResult = 'Copied' | 'Selected';

/** What the live region names, so a second copy within the outcome window is still announced. */
const TARGET_NAME: Record<CopyTarget, string> = {
  token: 'New token',
  app: 'budget-tracker line',
  watchtower: 'watchtower line',
  env: '.env line',
};

/** A fallback selection says how to finish, since nothing was copied. */
function announcement(target: CopyTarget, result: CopyResult): string {
  return result === 'Copied'
    ? `${TARGET_NAME[target]} copied`
    : `${TARGET_NAME[target]} selected. Use your device’s Copy to finish.`;
}

const BOX = 'block select-all break-all rounded-md bg-surface-2 px-3 py-2 font-mono text-xs text-ink';

/**
 * One value to copy: an optional label above it, the value in a selectable box, and its Copy
 * button. The visible label shows the outcome for a moment; the accessible name stays the same.
 */
function CopyBox({
  label,
  text,
  testId,
  name,
  outcome,
  onCopy,
}: {
  label?: ReactNode;
  text: string;
  testId: string;
  name: string;
  outcome: CopyResult | null;
  onCopy: (box: HTMLElement | null) => void;
}) {
  const boxRef = useRef<HTMLElement | null>(null);
  return (
    <div className="flex flex-col gap-2">
      {label === undefined ? null : <p className="text-xs text-subtle">{label}</p>}
      <code ref={boxRef} data-testid={testId} className={BOX}>
        {text}
      </code>
      <button
        type="button"
        aria-label={name}
        className={buttonClass('secondary', 'sm', 'min-h-11 self-start sm:min-h-0')}
        onClick={() => onCopy(boxRef.current)}
      >
        {outcome ?? 'Copy'}
      </button>
    </div>
  );
}

function UpdateTokenSheet({ token, onClose }: { token: string; onClose: () => void }) {
  // `n` counts copies, so the live region gets a new node even when the same text repeats.
  const [outcome, setOutcome] = useState<{ target: CopyTarget; result: CopyResult; n: number } | null>(null);
  const copies = useRef(0);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const appLine = `WATCHTOWER_TOKEN: "${token}"`;
  const watchtowerLine = `WATCHTOWER_HTTP_API_TOKEN: "${token}"`;
  const envLine = `WATCHTOWER_TOKEN=${token}`;

  /**
   * The clipboard is withheld outside a secure context (a NAS reached over plain http is the usual
   * case) and a browser may refuse it anyway. Either way the box is selected instead, so the
   * device's own Copy finishes the job, and the announcement says so rather than claiming a copy.
   */
  async function copy(target: CopyTarget, text: string, box: HTMLElement | null) {
    let result: CopyResult = 'Copied';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      result = 'Selected';
      if (box !== null) window.getSelection()?.selectAllChildren(box);
    }
    copies.current += 1;
    setOutcome({ target, result, n: copies.current });
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setOutcome(null), COPY_OUTCOME_MS);
  }

  const outcomeOf = (target: CopyTarget) => (outcome?.target === target ? outcome.result : null);

  return (
    <Sheet sheetId="update-token" title="Change the update token" onClose={onClose}>
      <div className="flex flex-col gap-5 px-4 py-4 text-sm text-muted sm:px-5">
        <p>
          Older compose files all shipped the same update token. Changing it makes sure only this install can ask
          Watchtower for an update. Updates keep working until it is changed.
        </p>

        <section aria-labelledby="update-token-new" className="flex flex-col gap-2">
          <h3 id="update-token-new" className="text-sm font-semibold text-ink">
            New token
          </h3>
          <CopyBox
            text={token}
            testId="update-token-value"
            name="Copy new token"
            outcome={outcomeOf('token')}
            onCopy={(box) => void copy('token', token, box)}
          />
          <p className="text-xs text-subtle">Made on this device, and not saved or sent anywhere by the app.</p>
        </section>

        <section aria-labelledby="update-token-synology" className="flex flex-col gap-2">
          <h3 id="update-token-synology" className="text-sm font-semibold text-ink">
            Synology Container Manager
          </h3>
          <ol className="flex list-decimal flex-col gap-3 pl-5">
            <li className="flex flex-col gap-3">
              <span>
                Copy the new token first, or each line below. It goes in two lines of the compose file, one under each
                service:
              </span>
              <CopyBox
                label={
                  <>
                    Under <code>budget-tracker</code>
                  </>
                }
                text={appLine}
                testId="update-token-app-line"
                name="Copy budget-tracker line"
                outcome={outcomeOf('app')}
                onCopy={(box) => void copy('app', appLine, box)}
              />
              <CopyBox
                label={
                  <>
                    Under <code>watchtower</code>
                  </>
                }
                text={watchtowerLine}
                testId="update-token-watchtower-line"
                name="Copy watchtower line"
                outcome={outcomeOf('watchtower')}
                onCopy={(box) => void copy('watchtower', watchtowerLine, box)}
              />
              <p>Both lines must carry the same value, or updates stop working.</p>
            </li>
            <li>Open Project, select the project, then Stop.</li>
            <li>Action, Edit. Replace the value of both lines with the new token.</li>
            <li>
              Save, then Build, then start the project again. Come back here afterwards: the update token line goes away
              once the app sees the new token.
            </li>
          </ol>
        </section>

        <details className="group/disclosure">
          <DisclosureSummary className="min-h-11 sm:min-h-0">Docker compose on a computer</DisclosureSummary>
          <ol className="mt-2 flex list-decimal flex-col gap-3 pl-5">
            <li className="flex flex-col gap-2">
              <span>Open the compose file and replace the value of the same two lines with the new token.</span>
              <span>
                If those two lines read <code>{'${WATCHTOWER_TOKEN…}'}</code>, leave them as they are and put this line
                in the .env file next to the compose file instead, in place of any old one:
              </span>
              <CopyBox
                text={envLine}
                testId="update-token-env"
                name="Copy the .env line"
                outcome={outcomeOf('env')}
                onCopy={(box) => void copy('env', envLine, box)}
              />
            </li>
            <li>
              Run <code>docker compose up -d</code> in that folder, then come back here.
            </li>
          </ol>
        </details>

        <p role="status" aria-live="polite" className="sr-only">
          {outcome === null ? null : <span key={outcome.n}>{announcement(outcome.target, outcome.result)}</span>}
        </p>
      </div>
    </Sheet>
  );
}
