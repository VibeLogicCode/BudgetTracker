// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GoalsClient } from '@/app/(app)/goals/goals-client';
import { computePace, type GoalWithProgress } from '@/lib/goals';

vi.mock('@/app/(app)/goals/actions', () => ({
  createGoalAction: vi.fn(async () => ({})),
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
      people={[{ id: 1, name: 'Alice' }]}
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

  it('the new goal target carries inputMode="decimal"', () => {
    renderClient();
    const target = document.querySelector('input[name="target"]') as HTMLInputElement | null;
    expect(target?.getAttribute('inputmode')).toBe('decimal');
  });
});

describe('GoalsClient — item 1 (2026-08-30 plan): "New goal" sits behind an Add goal button', () => {
  it('the New goal card starts hidden, and the header button says "Add goal"', () => {
    const { container, getByRole } = renderClient();
    const toggle = getByRole('button', { name: 'Add goal' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('new-goal');
    // Mounted, not omitted -- so a person tabbing or scanning raw text still finds every field;
    // only the real `hidden` attribute keeps it off-screen while closed.
    const card = container.querySelector('#new-goal') as HTMLElement;
    expect(card.hidden).toBe(true);
    expect(container.querySelector('input[name="target"]')).toBeTruthy();
  });

  it('clicking the header button opens the form and flips its own label to "Close"', () => {
    const { container, getByRole } = renderClient();
    fireEvent.click(getByRole('button', { name: 'Add goal' }));
    const toggle = getByRole('button', { name: 'Close' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect((container.querySelector('#new-goal') as HTMLElement).hidden).toBe(false);
  });

  it('clicking Close collapses it again', () => {
    const { container, getByRole } = renderClient();
    fireEvent.click(getByRole('button', { name: 'Add goal' }));
    fireEvent.click(getByRole('button', { name: 'Close' }));
    expect(getByRole('button', { name: 'Add goal' })).toBeTruthy();
    expect((container.querySelector('#new-goal') as HTMLElement).hidden).toBe(true);
  });

  it('every existing field in the form survives the move behind the disclosure', () => {
    const { container } = renderClient();
    expect(container.querySelector('input[name="name"]')).toBeTruthy();
    expect(container.querySelector('input[name="target"]')).toBeTruthy();
    expect(container.querySelector('input[name="targetDate"]')).toBeTruthy();
    expect(container.querySelector('select[name="owner"]')).toBeTruthy();
  });

  it('the empty-state "Add a goal" button opens the same disclosure (no goals yet)', () => {
    const { container, getByRole } = render(
      <GoalsClient today="2026-08-16" goals={[]} people={[{ id: 1, name: 'Alice' }]} />,
    );
    expect((container.querySelector('#new-goal') as HTMLElement).hidden).toBe(true);
    fireEvent.click(getByRole('button', { name: 'Add a goal' }));
    expect((container.querySelector('#new-goal') as HTMLElement).hidden).toBe(false);
  });
});
