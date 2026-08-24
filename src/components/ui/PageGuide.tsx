import { GuidePanel } from '@/components/ui/GuidePanel';

/**
 * The "What is this page for?" panel that sits under a nav section's `PageHeader`.
 *
 * The open state is derived, never stored: the panel is open while the page has nothing to
 * show and closed once it does. A screen with nothing on it is exactly when a reader needs
 * the explanation, and a screen full of data is exactly when the panel is in the way — so
 * `empty` is the same condition the page already uses to decide whether to render its
 * `EmptyState`, not a second, subtly different notion of empty.
 *
 * Deriving it also means there is nothing to persist, which is why this panel needs no
 * dismiss control, no per-user flag, and therefore no migration.
 */
export function PageGuide({ empty, children }: { empty: boolean; children: React.ReactNode }) {
  return (
    <GuidePanel summary="What is this page for?" open={empty}>
      {children}
    </GuidePanel>
  );
}
