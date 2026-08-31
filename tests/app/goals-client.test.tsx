// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { GoalsClient } from '@/app/(app)/goals/goals-client';
import { computePace, type GoalWithProgress } from '@/lib/goals';

vi.mock('@/app/(app)/goals/actions', () => ({
  addContributionAction: vi.fn(async () => ({})),
  archiveGoalAction: vi.fn(async () => ({})),
  deleteContributionAction: vi.fn(async () => ({})),
}));

afterEach(() => cleanup());

function goal(over: Partial<GoalWithProgress> = {}): GoalWithProgress {
  const pace = computePace({ targetCents: 100000, targetDate: null, contributions: [], today: '2026-08-16' });
  return {
    id: 1,
    name: 'Trip to Japan',
    ownerUserId: null,
    ownerName: null,
    targetCents: 100000,
    targetDate: null,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    savedCents: pace.savedCents,
    pace,
    ...over,
  } as GoalWithProgress;
}

function renderClient(over: { archived?: boolean; showArchived?: boolean } = {}) {
  return render(
    <GoalsClient
      today="2026-08-16"
      showArchived={over.showArchived ?? false}
      goals={[{ goal: goal({ archived: over.archived ?? false }), contributions: [] }]}
    />,
  );
}

describe('GoalsClient — polish item 6: archived goals are reachable again', () => {
  it('offers a "Show archived" link when archived goals are hidden', () => {
    const { getByText } = renderClient();
    const link = getByText('Show archived') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/goals?archived=1');
  });

  it('flips to "Hide archived" once they are shown', () => {
    const { getByText } = renderClient({ showArchived: true });
    const link = getByText('Hide archived') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/goals');
  });

  it('an active goal offers Archive, submitting archived=1', () => {
    const { container, getByText } = renderClient();
    expect(getByText('Archive')).toBeTruthy();
    const field = container.querySelector('input[name="archived"]') as HTMLInputElement;
    expect(field.value).toBe('1');
  });

  it('an archived goal offers Restore instead, submitting archived=0', () => {
    const { container, getByText } = renderClient({ archived: true, showArchived: true });
    // archiveGoal(id, false) existed all along; nothing in the UI could reach it.
    expect(getByText('Restore')).toBeTruthy();
    expect(getByText('Archived')).toBeTruthy();
    const field = container.querySelector('input[name="archived"]') as HTMLInputElement;
    expect(field.value).toBe('0');
  });
});

describe('v1.12.1: the number pad opens for both goal money fields (item Y / UX-9)', () => {
  it('the contribution amount carries inputMode="decimal"', () => {
    renderClient();
    const field = screen.getAllByLabelText(/Contribution amount for /)[0] as HTMLInputElement;
    expect(field.getAttribute('inputmode')).toBe('decimal');
  });

  // v1.20.0: the New goal target field's own half of this test moved with the field itself --
  // "New goal" is no longer part of GoalsClient (see the describe block below), so it is now
  // covered by tests/app/new-goal-client.test.tsx instead of being deleted outright.
});

/**
 * v1.20.0: replaces the old "item 1 (2026-08-30 plan)" describe block, which asserted a
 * disclosure toggling open/closed on this same page -- that disclosure (and every field it
 * held) moved to its own route, /goals/new (see new-goal-client.tsx), mirroring how
 * /warranties/new already works. The risk those tests guarded -- that "Add goal" reaches the
 * create form at all -- still exists, just one hop further away now: it is a plain navigation
 * link rather than a client-side toggle, so what is worth asserting here is its href, not an
 * aria-expanded/hidden dance that no longer happens on this page. The fields themselves (name,
 * target, targetDate, owner) are covered by tests/app/new-goal-client.test.tsx, which renders
 * the form they actually live in now.
 */
describe('GoalsClient — v1.20.0: "Add goal" navigates to its own route', () => {
  it('the header "Add goal" link points at /goals/new', () => {
    const { getByRole } = renderClient();
    const link = getByRole('link', { name: 'Add goal' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/goals/new');
  });

  it('the empty-state "Add a goal" link also points at /goals/new (no goals yet)', () => {
    const { getByRole } = render(<GoalsClient today="2026-08-16" goals={[]} />);
    const link = getByRole('link', { name: 'Add a goal' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/goals/new');
  });
});
