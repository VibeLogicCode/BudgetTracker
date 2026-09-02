/**
 * The notification page's tab vocabulary, deliberately NOT in notifications-client.tsx.
 *
 * v1.29.1 defect fix. v1.29.0 declared these three exports inside notifications-client.tsx and
 * had page.tsx -- a Server Component -- import `isNotificationTab` from there to validate
 * `?tab=`. That crashed the page in production while every test passed. Next replaces EVERY
 * export of a `'use client'` module with a client reference for server-side importers, so the
 * name page.tsx received was a reference proxy rather than the function, and calling it threw
 * before the page could render. Vitest imports the module directly, with no client/server
 * boundary in between, so no unit test could ever have caught it: the boundary only exists in
 * a real Next build.
 *
 * Every other server page in this app imports exactly one thing from its `*-client` module --
 * the component -- plus `import type`, which tsconfig's isolatedModules erases at compile time
 * and which therefore crosses the boundary safely. v1.29.0 was the only value import across it
 * in the whole repo, and tests/ops/client-bundle.test.ts now guards that (see its
 * "a Server Component never value-imports a runtime helper" block) so this cannot recur
 * silently.
 *
 * Same remedy as the client-bundle splits already in this codebase -- src/lib/savings-rate.ts,
 * src/lib/networth-constants.ts, src/lib/notify/events.ts, src/lib/env-tz.ts -- for the mirror
 * image of the problem: those exist so a client module can reach a value without dragging the
 * server's module graph into the browser bundle, this one so a server module can reach a value
 * without going through the client boundary. A plain module with no directive belongs to
 * neither side and can be imported by both.
 *
 * `isNotificationTab` exists at all because `?tab=` arrives as arbitrary user-suppliable text,
 * not a typed value: page.tsx's searchParams read follows the exact fallback-on-malformed-input
 * idiom dashboard/page.tsx already uses for `?month=` -- a missing or garbage tab name is a
 * reason to show the default tab, never a reason to throw.
 */
export type NotificationTab = 'email' | 'telegram' | 'events' | 'deliveries';

export const NOTIFICATION_TABS: readonly NotificationTab[] = ['email', 'telegram', 'events', 'deliveries'];

/** The tab shown when `?tab=` is absent or does not name one of the four. */
export const DEFAULT_NOTIFICATION_TAB: NotificationTab = 'email';

export function isNotificationTab(value: unknown): value is NotificationTab {
  return typeof value === 'string' && (NOTIFICATION_TABS as readonly string[]).includes(value);
}

export const TAB_LABEL: Record<NotificationTab, string> = {
  email: 'Email',
  telegram: 'Telegram',
  events: 'Events',
  deliveries: 'Deliveries',
};
