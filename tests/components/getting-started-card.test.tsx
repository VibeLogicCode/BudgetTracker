// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { GettingStartedCard } from '@/components/GettingStartedCard';
import type { OnboardingStep } from '@/lib/onboarding';

afterEach(cleanup);

const ACCOUNT: OnboardingStep = {
  key: 'account',
  title: 'Add a bank account',
  body: 'Every import lands in an account, so this comes first.',
  href: '/settings/accounts',
  cta: 'Add an account',
};
const IMPORT: OnboardingStep = {
  key: 'import',
  title: 'Import your first statement',
  body: 'Download a CSV from your bank and drop it in.',
  href: '/import',
  cta: 'Start an import',
};

/**
 * Ruling A9. Two properties are being pinned together here, and they are in tension: the card
 * must vanish for good once setup is done (no dismiss button, no per-user flag, no migration),
 * AND it must hand the reader on to budgets, goals and coverage before it goes. A card that
 * renders nothing cannot say anything, so the handoff has to live in every render that happens
 * at all -- which is what the third block asserts.
 */
describe('GettingStartedCard', () => {
  it('renders nothing at all once every step is done, so it disappears without a dismiss control', () => {
    const { container } = render(<GettingStartedCard steps={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders only the steps still undone, each with its own copy and call to action', () => {
    const { container } = render(<GettingStartedCard steps={[IMPORT]} />);

    expect(container.textContent).toContain('Import your first statement');
    expect(container.textContent).toContain('Download a CSV from your bank and drop it in.');

    // The account step was filtered out upstream by onboardingSteps(), so nothing about it
    // may leak into the card -- a dumb props-only component cannot re-derive it.
    expect(container.textContent).not.toContain('Add a bank account');

    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/import');
    expect(hrefs).not.toContain('/settings/accounts');

    const ctas = [...container.querySelectorAll('a')].map((a) => a.textContent?.trim());
    expect(ctas).toContain('Start an import');
  });

  it('carries the handoff to budgets, goals and coverage in every render it makes', () => {
    // Shown alongside whatever remains -- during setup, and again on the last render before
    // the card is gone for good. The empty-array case above proves there is no later render
    // for it to live in, which is precisely why it cannot be a "finished" state.
    for (const steps of [[ACCOUNT, IMPORT], [IMPORT]]) {
      const { container } = render(<GettingStartedCard steps={steps} />);
      const text = container.textContent ?? '';
      expect(text).toMatch(/budgets/i);
      expect(text).toMatch(/goals/i);
      expect(text).toMatch(/coverage/i);
      const help = [...container.querySelectorAll('a')].filter((a) => a.getAttribute('href') === '/help');
      expect(help).toHaveLength(1);
      cleanup();
    }
  });

  it('offers no way to dismiss it, because progress is derived rather than stored', () => {
    const { container } = render(<GettingStartedCard steps={[ACCOUNT]} />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/dismiss|hide this|skip/i);
  });
});
