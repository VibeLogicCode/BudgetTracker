import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { ThemeScript } from '@/components/theme/theme-script';
import './globals.css';

export const metadata: Metadata = {
  title: 'Budget Tracker',
  description: 'Self-hosted household budget tracker',
  // src/app/manifest.ts compiles to this exact route (Next's metadata-route convention).
  manifest: '/manifest.webmanifest',
  // Installability only (owner ruling 9) — no service worker, no offline mode, no
  // install-prompt UI. iOS reads `icons.apple` for its home-screen icon rather than the
  // manifest's icons array, so it is pointed at the same generated file separately here.
  appleWebApp: {
    title: 'Budget Tracker',
    statusBarStyle: 'default',
  },
  icons: {
    apple: '/icons/apple-touch-icon.png',
  },
};

/** Both themes are real, so the browser chrome should track whichever is on. */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f5fa' },
    { media: '(prefers-color-scheme: dark)', color: '#0e0f17' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the per-request nonce (set by src/middleware.ts) opts this route into
  // dynamic rendering, which the nonce-based CSP requires: a statically pre-rendered
  // page would ship scripts nonced at build time that could never match a fresh
  // per-request nonce in the response's Content-Security-Policy header.
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    // suppressHydrationWarning: ThemeScript deliberately mutates <html>'s class and
    // color-scheme before React hydrates, so the attributes it finds will not match
    // the ones the server sent. That mismatch is the whole point — it is what stops
    // the wrong theme flashing — and it is confined to this one element.
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript nonce={nonce} />
      </head>
      <body>{children}</body>
    </html>
  );
}
