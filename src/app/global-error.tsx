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
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f5f5fa',
          color: '#111827',
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
            <p style={{ margin: '0 0 1rem', fontSize: '0.8125rem', color: '#4b5563' }}>
              Reference: <code>{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              padding: '0.5rem 1rem',
              border: '1px solid #111827',
              borderRadius: '0.375rem',
              background: '#111827',
              color: '#ffffff',
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
