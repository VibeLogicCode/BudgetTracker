// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

/**
 * v1.13.0 whole-branch review, item I1. src/app/(app)/layout.tsx used to call
 * reviewQueueCount() -- a household-wide count with no owner scoping of its own
 * (src/lib/categorize/engine.ts) -- for EVERY viewer, unconditionally, and serialize the result
 * into AppShell's props. AppShell's own nav (src/components/app-shell/nav.ts,
 * SELF_HIDDEN_HREFS) already hides the /review link entirely for a self viewer, so the number
 * never rendered anywhere -- but the RSC payload still carried it, the same "computed and
 * discarded rather than never computed" leak C1/I2 fix in this same review. AppShell itself is
 * replaced with a stub here so this test can read the exact `reviewCount` prop the layout
 * computed, rather than relying on whether the real chrome happens to render it.
 */

const currentUser = vi.hoisted(() => ({
  value: {
    id: 1,
    name: 'Adult',
    role: 'admin' as 'admin' | 'member',
    visibility: 'household' as 'household' | 'self',
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireUser: async () => currentUser.value,
}));

vi.mock('@/lib/auth/users', () => ({
  mustChangePassword: () => false,
}));

const reviewQueueCountMock = vi.hoisted(() => vi.fn(() => 7));
vi.mock('@/lib/categorize/engine', () => ({
  reviewQueueCount: reviewQueueCountMock,
}));

vi.mock('@/components/app-shell/AppShell', () => ({
  AppShell: ({ reviewCount, children }: { reviewCount: number; children: React.ReactNode }) => (
    <div data-testid="review-count">
      {reviewCount}
      {children}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  reviewQueueCountMock.mockClear();
});

describe('AppLayout (item I1)', () => {
  it('never calls reviewQueueCount, and passes 0, for a self viewer', async () => {
    currentUser.value = { id: 2, name: 'Kid', role: 'member', visibility: 'self' };
    const { default: AppLayout } = await import('@/app/(app)/layout');
    const { getByTestId } = render(await AppLayout({ children: <span>hi</span> }));

    expect(getByTestId('review-count').textContent).toMatch(/^0/);
    expect(reviewQueueCountMock).not.toHaveBeenCalled();
  });

  it('computes the real reviewQueueCount for a household viewer', async () => {
    currentUser.value = { id: 1, name: 'Adult', role: 'admin', visibility: 'household' };
    const { default: AppLayout } = await import('@/app/(app)/layout');
    const { getByTestId } = render(await AppLayout({ children: <span>hi</span> }));

    expect(getByTestId('review-count').textContent).toMatch(/^7/);
    expect(reviewQueueCountMock).toHaveBeenCalledTimes(1);
  });
});
