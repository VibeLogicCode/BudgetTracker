import { GuidePanel } from '@/components/ui/GuidePanel';

/**
 * The "What is this page for?" panel that sits under a nav section's `PageHeader`.
 *
 * It starts CLOSED, always. The v1.10.0 onboarding spec derived the open state from the page
 * having nothing on it -- "a screen with nothing on it is exactly when a reader needs the
 * explanation" -- and the owner reversed that on 2026-08-24 after living with it: a panel that
 * opens itself is a panel in the way, and an empty page is already explained by its `EmptyState`
 * and the action button on it. There is no `empty` prop, deliberately: a prop nothing reads is
 * the stale claim this repo's docblocks keep warning about (ruling B1).
 *
 * Nothing is persisted, so this panel needs no dismiss control, no per-user flag, and therefore
 * no migration -- the two sentences of the old docblock that still hold.
 *
 * `GuidePanel` keeps its `open` prop: the notification setup guides pass one for their own
 * reasons (ruling B2). Only this component's derivation is gone.
 */
export function PageGuide({ children }: { children: React.ReactNode }) {
  return (
    <GuidePanel summary="What is this page for?" open={false}>
      {children}
    </GuidePanel>
  );
}
