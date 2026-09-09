'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card, CardBody } from '@/components/ui/Card';
import { readRestartExpected } from '@/lib/update/restart-notice';
import { APP_VERSION } from '@/lib/version';

/**
 * v1.12.1 (item W / UX-1, ruling R7). Until now there was no error.tsx, not-found.tsx or
 * global-error.tsx anywhere under src/app, so any server-side failure -- SQLite locked while the
 * 02:00 backup runs, a full volume, one bad row -- put a family member in front of Next's built-in
 * screen: unstyled black text reading "Application error: a server-side exception has occurred", a
 * digest hash, no navigation, no theme and no way back.
 *
 * `error.message` is deliberately NOT rendered. Next redacts real messages in production anyway, so
 * showing it would mean a driver string in development and nothing in production -- the worst of
 * both. `error.digest` IS rendered: it is the only string that lets somebody match this screen to a
 * line in `docker logs`, and it carries none of the message.
 *
 * This file sits inside the (app) route group, so the AppShell around it is still there: the rail,
 * the header and the footer all render, which is the entire point.
 *
 * ---
 *
 * v1.32.0 (UP-2). One of the two screens a household sees during a PLANNED restart is this one,
 * and until now it told them the wrong thing. Press Update now, Watchtower kills the container,
 * and the tab -- still open on the app -- lands here and reads "The app could not finish loading
 * this screen… this usually clears on its own", which is the copy for a crash, thirty seconds
 * after somebody deliberately asked for a restart. The other screen is the browser's own
 * ERR_CONNECTION_RESET page once the socket closes; that one belongs to Chrome and nothing here
 * changes it or claims to.
 *
 * The signal comes from localStorage, written by updates-client.tsx when an apply is accepted and
 * read once, HERE, in an effect. Two properties are load-bearing:
 *
 *  - The read is in an effect, not in render. Next server-renders client components for the
 *    initial HTML, where there is no localStorage at all, and reading a clock or a browser store
 *    during render is what produced this codebase's last hydration mismatch (item M-6, the
 *    Updates card's pending notice). The honest cost is the same one that fix accepted: one
 *    frame of the ordinary crash copy before the effect swaps in the restart copy.
 *  - Every rule about WHEN the entry counts lives in @/lib/update/restart-notice, not here, so
 *    the expiry window and the "already on the new version" check have one definition rather
 *    than a copy in each reader.
 *
 * APP_VERSION is the version of the BUNDLE this tab is running, which is exactly the comparison
 * that matters: a tab still holding the old bundle is a tab that has not come back yet, whatever
 * the container is doing. Once the household reloads onto the new version the entry stops
 * matching and this screen goes back to saying what it says today.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [restartingTo, setRestartingTo] = useState<string | null>(null);
  useEffect(() => {
    setRestartingTo(readRestartExpected({ nowMs: Date.now(), runningVersion: APP_VERSION }));
  }, []);

  const digest = error.digest ? (
    <p className="text-xs text-subtle">
      Reference: <code className="rounded bg-surface-2 px-1 font-mono">{error.digest}</code>
    </p>
  ) : null;

  if (restartingTo !== null) {
    return (
      <Card>
        <CardBody className="flex flex-col items-start gap-4 py-10">
          <h1 className="text-lg font-semibold text-ink">Installing v{restartingTo} — the app is restarting</h1>
          <p className="max-w-prose text-sm text-muted">
            You asked for this update a moment ago. The container is being replaced, so the app is
            unreachable for a minute — this screen is that gap, not a fault. Nothing you have saved is affected, and
            the database stays exactly where it is. Wait about a minute, then reload. If the page still will not load
            after that, check the container&apos;s logs.
          </p>
          {digest}
          <button type="button" onClick={() => window.location.reload()} className="btn btn--primary">
            Reload the page
          </button>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="flex flex-col items-start gap-4 py-10">
        <h1 className="text-lg font-semibold text-ink">Something went wrong on this page</h1>
        <p className="max-w-prose text-sm text-muted">
          The app could not finish loading this screen. Nothing you have saved is affected. This
          usually clears on its own — try again, and if it keeps happening, check that the app has
          somewhere to write and that the nightly backup is not still running.
        </p>
        {digest}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={reset} className="btn btn--primary">
            Try again
          </button>
          <Link href="/dashboard" className="btn btn--secondary">
            Back to the Dashboard
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}
