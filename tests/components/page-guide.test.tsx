// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { GuidePanel } from '@/components/ui/GuidePanel';
import { PageGuide } from '@/components/ui/PageGuide';

afterEach(cleanup);

/**
 * Ruling A6 / A4-style derivation: the panel's open state is a function of whether the page
 * has anything on it, so there is nothing to persist and no per-user flag to migrate. These
 * tests pin the derivation in both directions, because "open when empty" is the whole reason
 * the panel is allowed to exist without a dismiss control.
 */
describe('PageGuide: the per-page "what is this for?" panel', () => {
  it('is open when the page has no data to show', () => {
    const { container } = render(
      <PageGuide empty>
        <p>body</p>
      </PageGuide>,
    );
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(true);
    expect(details?.hasAttribute('open')).toBe(true);
  });

  it('is closed once the page has data, so it is not in the way', () => {
    const { container } = render(
      <PageGuide empty={false}>
        <p>body</p>
      </PageGuide>,
    );
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('asks exactly one question, on every page that carries it', () => {
    const { container } = render(
      <PageGuide empty>
        <p>body</p>
      </PageGuide>,
    );
    expect(container.querySelector('summary')?.textContent).toBe('What is this page for?');
  });

  it('renders its children as the panel body', () => {
    const { container } = render(
      <PageGuide empty={false}>
        <p>what this screen summarises</p>
      </PageGuide>,
    );
    expect(container.textContent).toContain('what this screen summarises');
  });
});

/**
 * The shell itself. Its only variable is the summary text — that is what makes one primitive
 * serve both the notification setup guides and the per-page guides instead of two divergent
 * info-panel styles drifting apart in one app (ruling A6).
 */
describe('GuidePanel: the shared shell', () => {
  it('takes the summary as a prop, so both callers share one shape', () => {
    const { container } = render(
      <GuidePanel summary="How do I set this up?" open={false}>
        <p>body</p>
      </GuidePanel>,
    );
    expect(container.querySelector('summary')?.textContent).toBe('How do I set this up?');
    expect(container.querySelector('details')?.open).toBe(false);
  });

  it('keeps the info-panel styling in one place', () => {
    const { container } = render(
      <GuidePanel summary="What is this page for?" open>
        <p>body</p>
      </GuidePanel>,
    );
    const details = container.querySelector('details');
    expect(details?.className).toContain('bg-info-soft');
    expect(details?.className).toContain('text-info-soft-fg');
    expect(container.querySelector('summary')?.className).toContain('cursor-pointer');
  });

  it('renders no clickable address, so the zero-egress claim stays auditable', () => {
    const { container } = render(
      <GuidePanel summary="What is this page for?" open>
        <p>body</p>
      </GuidePanel>,
    );
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });
});
