// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { NewGoalClient } from '@/app/(app)/goals/new/new-goal-client';

vi.mock('@/app/(app)/goals/actions', () => ({
  createGoalAction: vi.fn(async () => ({})),
}));

afterEach(() => cleanup());

const people = [{ id: 1, name: 'Alice' }];

/**
 * v1.20.0: this suite exists because the "New goal" form moved off /goals onto its own route
 * (goals-client.tsx no longer renders it at all -- see that file's own docblock). Two of its
 * assertions are relocations, not new coverage:
 *  - "every field survives the move" replaces goals-client.test.tsx's identically-named test,
 *    which used to render the disclosure open; there is no disclosure left to open.
 *  - the target field's inputMode="decimal" replaces the second half of goals-client.test.tsx's
 *    "v1.12.1" test, for the same reason.
 */
describe('NewGoalClient', () => {
  it('renders every field the old on-page disclosure carried', () => {
    const { container } = render(<NewGoalClient people={people} />);
    expect(container.querySelector('input[name="name"]')).toBeTruthy();
    expect(container.querySelector('input[name="target"]')).toBeTruthy();
    expect(container.querySelector('input[name="targetDate"]')).toBeTruthy();
    expect(container.querySelector('select[name="owner"]')).toBeTruthy();
  });

  it('the target amount carries inputMode="decimal" (item Y / UX-9)', () => {
    const { container } = render(<NewGoalClient people={people} />);
    const target = container.querySelector('input[name="target"]') as HTMLInputElement;
    expect(target.getAttribute('inputmode')).toBe('decimal');
  });

  it('lists every person passed in, alongside the Shared option', () => {
    const { container } = render(
      <NewGoalClient people={[{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]} />,
    );
    const select = container.querySelector('select[name="owner"]') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['shared', '1', '2']);
  });

  it('offers a Cancel link back to /goals, mirroring new-warranty-client\'s own back link', () => {
    const { getByRole } = render(<NewGoalClient people={people} />);
    const link = getByRole('link', { name: 'Cancel' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/goals');
  });
});
