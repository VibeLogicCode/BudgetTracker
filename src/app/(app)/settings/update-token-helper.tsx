'use client';

import { useEffect, useRef, useState } from 'react';
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

/**
 * Sits directly under the card's "Last checked" line. The token is made on the first Fix and kept
 * for the life of the page, so closing and reopening the Sheet never hands out a second value after
 * the first was already pasted into one of the two places that must match.
 */
export function UpdateTokenLine() {
  const [token, setToken] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  function openSheet() {
    if (token === null) setToken(newUpdateToken());
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
      {open && token !== null ? <UpdateTokenSheet token={token} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

type CopyTarget = 'token' | 'compose' | 'env';
type CopyOutcome = 'Copied' | 'Selected';

/** What the live region says. A fallback selection says how to finish, since nothing was copied. */
const ANNOUNCEMENT: Record<CopyOutcome, string> = {
  Copied: 'Copied',
  Selected: 'Selected. Use your device’s Copy to finish.',
};

const BOX = 'block select-all break-all rounded-md bg-surface-2 px-3 py-2 font-mono text-xs text-ink';

/** The visible label shows the outcome for a moment; the accessible name stays the same. */
function CopyButton({ name, outcome, onCopy }: { name: string; outcome: CopyOutcome | null; onCopy: () => void }) {
  return (
    <button
      type="button"
      aria-label={name}
      className={buttonClass('secondary', 'sm', 'min-h-11 self-start sm:min-h-0')}
      onClick={onCopy}
    >
      {outcome ?? 'Copy'}
    </button>
  );
}

function UpdateTokenSheet({ token, onClose }: { token: string; onClose: () => void }) {
  const tokenRef = useRef<HTMLElement | null>(null);
  const composeRef = useRef<HTMLPreElement | null>(null);
  const envRef = useRef<HTMLElement | null>(null);
  const [outcome, setOutcome] = useState<{ target: CopyTarget; result: CopyOutcome } | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const composeLines = `WATCHTOWER_TOKEN: "${token}"\nWATCHTOWER_HTTP_API_TOKEN: "${token}"`;
  const envLine = `WATCHTOWER_TOKEN=${token}`;

  /**
   * The clipboard is withheld outside a secure context (a NAS reached over plain http is the usual
   * case) and a browser may refuse it anyway. Either way the box is selected instead, so the
   * device's own Copy finishes the job, and the announcement says so rather than claiming a copy.
   */
  async function copy(target: CopyTarget, text: string, box: HTMLElement | null) {
    let result: CopyOutcome = 'Copied';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      result = 'Selected';
      if (box !== null) window.getSelection()?.selectAllChildren(box);
    }
    setOutcome({ target, result });
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
          <code ref={tokenRef} data-testid="update-token-value" className={BOX}>
            {token}
          </code>
          <CopyButton
            name="Copy new token"
            outcome={outcomeOf('token')}
            onCopy={() => void copy('token', token, tokenRef.current)}
          />
          <p className="text-xs text-subtle">Made on this device, and not saved or sent anywhere by the app.</p>
        </section>

        <section aria-labelledby="update-token-synology" className="flex flex-col gap-2">
          <h3 id="update-token-synology" className="text-sm font-semibold text-ink">
            Synology Container Manager
          </h3>
          <ol className="flex list-decimal flex-col gap-3 pl-5">
            <li>Open Project, select the project, then Stop.</li>
            <li className="flex flex-col gap-2">
              <span>
                Action, Edit. Replace the value of both lines with the new token: <code>WATCHTOWER_TOKEN</code> sits
                under budget-tracker, <code>WATCHTOWER_HTTP_API_TOKEN</code> under watchtower.
              </span>
              <pre ref={composeRef} data-testid="update-token-compose" className={`${BOX} whitespace-pre-wrap`}>
                {composeLines}
              </pre>
              <CopyButton
                name="Copy both lines"
                outcome={outcomeOf('compose')}
                onCopy={() => void copy('compose', composeLines, composeRef.current)}
              />
            </li>
            <li>
              Save, then Build. Then come back here: the update token line goes away once the app sees the new
              token.
            </li>
          </ol>
        </section>

        <details className="group/disclosure">
          <DisclosureSummary className="min-h-11 sm:min-h-0">Docker compose with a .env file</DisclosureSummary>
          <div className="mt-2 flex flex-col gap-2">
            <p>Put this line in the .env file next to the compose file, in place of the old one:</p>
            <code ref={envRef} data-testid="update-token-env" className={BOX}>
              {envLine}
            </code>
            <CopyButton
              name="Copy the .env line"
              outcome={outcomeOf('env')}
              onCopy={() => void copy('env', envLine, envRef.current)}
            />
            <p>
              Then run <code>docker compose up -d</code> in that folder.
            </p>
          </div>
        </details>

        <p role="status" aria-live="polite" className="sr-only">
          {outcome === null ? '' : ANNOUNCEMENT[outcome.result]}
        </p>
      </div>
    </Sheet>
  );
}
