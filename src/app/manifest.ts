import type { MetadataRoute } from 'next';

/**
 * Next's metadata-route convention: this file compiles to GET /manifest.webmanifest, and the
 * root layout's `metadata.manifest` link points at that exact path (see src/app/layout.tsx).
 *
 * Task 17 scope only (owner ruling 9): manifest + icons + installability. No service worker,
 * no offline caching, no install-prompt UI.
 *
 * Colors are copied verbatim from the LIGHT theme in src/app/globals.css (`:root`), matching
 * the same canvas tone the root layout's `viewport.themeColor` already uses as the browser
 * chrome color (that export tints the tab/status bar per color scheme; a manifest can only
 * hold one static value, so this uses the light value, the default theme). Do not invent a
 * new color here if a token ever changes — re-copy it from globals.css.
 */
const CANVAS = '#f5f5fa'; // --canvas (light)

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Budget Tracker',
    short_name: 'Budget',
    description: 'Self-hosted household budget tracker',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: CANVAS,
    theme_color: CANVAS,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
    ],
    /**
     * v1.13.0 ruling R7. A home-screen long-press lands on the quick-add form instead of the
     * dashboard. One entry, not a menu: the manifest's own docblock records ruling 9 (no service
     * worker, no offline caching), and a shortcut list is a navigation surface that has to be kept
     * in step with the nav for ever.
     */
    shortcuts: [{ name: 'Add a transaction', short_name: 'Add', url: '/transactions#quick-add' }],
  };
}
