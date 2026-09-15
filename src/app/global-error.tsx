'use client';

/**
 * v1.12.1 (item W / UX-1, ruling R7). The last-resort boundary: this one catches a throw from the
 * ROOT layout, which means it REPLACES that layout -- so it has to render its own <html> and
 * <body>, and it cannot use anything from the app shell, the theme script or globals.css, none of
 * which have run. Everything here is therefore inline and deliberately plain.
 *
 * Same rule as (app)/error.tsx: the message is never shown, the digest is.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      {/*
        2026-09-15, `$impeccable critique` minor finding. This file renders OUTSIDE the React tree
        and outside globals.css -- it replaces the root layout when the layout itself failed -- so
        it cannot reach a single design token and every colour here has to be a literal. That part
        is correct and stays.
        What was wrong is that the literals were LIGHT-ONLY, so a household running the app in dark
        mode got a full-white page at the exact moment something had already gone wrong. A bare
        `prefers-color-scheme` block is the one theming mechanism available without a stylesheet or
        a class on <html>; it follows the device rather than the in-app toggle, which is the best
        obtainable here and far better than always being wrong for half the day.
      */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
            :root { color-scheme: light dark; }
            .bt-crash { background: #f5f5fa; color: #16162b; }
            .bt-crash .bt-ref { color: #5a5a72; }
            .bt-crash .bt-retry { background: #16162b; color: #ffffff; border-color: #16162b; }
            @media (prefers-color-scheme: dark) {
              .bt-crash { background: #0e0f17; color: #ededf5; }
              .bt-crash .bt-ref { color: #a9adc4; }
              .bt-crash .bt-retry { background: #ededf5; color: #0e0f17; border-color: #ededf5; }
            }
          `,
        }}
      />
      <body
        className="bt-crash"
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
        }}
      >
        <main style={{ maxWidth: '32rem', padding: '2rem' }}>
          <h1 style={{ fontSize: '1.125rem', margin: '0 0 0.75rem' }}>Budget Tracker could not start this page</h1>
          <p style={{ margin: '0 0 1rem', lineHeight: 1.5 }}>
            Something failed before the app could draw anything. Your data is not affected. Try
            again, and if it keeps happening, check the container log.
          </p>
          {error.digest ? (
            <p className="bt-ref" style={{ margin: '0 0 1rem', fontSize: '0.8125rem' }}>
              Reference: <code>{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            className="bt-retry"
            style={{
              padding: '0.5rem 1rem',
              borderWidth: '1px',
              borderStyle: 'solid',
              borderRadius: '0.375rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
