// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DaysRemainingPill } from '@/components/ui/DaysRemainingPill';

afterEach(() => cleanup());

// Item 3 (2026-08-30 one-design-language plan). ComingUpCard.tsx, ExpiringSoonCard.tsx and
// warranties-client.tsx each hand-rolled this exact "92d, 22d, a warning-toned 7d inside a week"
// rule on their own; one shared component now covers all three, so one test file covers the rule
// instead of three near-identical suites.
describe('DaysRemainingPill', () => {
  it('renders a plain day count with no warning glyph when more than a week remains', () => {
    const { container } = render(<DaysRemainingPill days={92} />);
    expect(screen.getByText('92d')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('goes warning-toned with the glyph at exactly seven days', () => {
    const { container } = render(<DaysRemainingPill days={7} />);
    expect(screen.getByText(/7d/)).toBeTruthy();
    expect(container.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
  });

  it('stays neutral with no glyph at eight days -- one past the warning boundary', () => {
    const { container } = render(<DaysRemainingPill days={8} />);
    expect(screen.getByText('8d')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders nothing at all for a negative day count', () => {
    const { container } = render(<DaysRemainingPill days={-3} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders a pill (not nothing) at zero days -- due today is still a day count, not "overdue"', () => {
    render(<DaysRemainingPill days={0} />);
    expect(screen.getByText('0d')).toBeTruthy();
  });
});
