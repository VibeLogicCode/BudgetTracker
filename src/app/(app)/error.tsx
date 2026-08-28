'use client';

import Link from 'next/link';
import { Card, CardBody } from '@/components/ui/Card';

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
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Card>
      <CardBody className="flex flex-col items-start gap-4 py-10">
        <h1 className="text-lg font-semibold text-ink">Something went wrong on this page</h1>
        <p className="max-w-prose text-sm text-muted">
          The app could not finish loading this screen. Nothing you have saved is affected. This
          usually clears on its own — try again, and if it keeps happening, check that the app has
          somewhere to write and that the nightly backup is not still running.
        </p>
        {error.digest ? (
          <p className="text-xs text-subtle">
            Reference: <code className="rounded bg-surface-2 px-1 font-mono">{error.digest}</code>
          </p>
        ) : null}
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
