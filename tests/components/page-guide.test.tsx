// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { GuidePanel } from '@/components/ui/GuidePanel';
import { PageGuide } from '@/components/ui/PageGuide';

afterEach(cleanup);

/**
 * v1.12.0 REVERSAL (spec docs/superpowers/specs/2026-08-24-bills-with-due-dates-design.md,
 * item N / ruling B1). This panel used to derive its open state from the page being empty, and
 * two tests here pinned that derivation in both directions. The owner lived with it and
 * disagreed: a panel that opens itself is a panel in the way, and an empty page is already
 * explained by its EmptyState and its action button. The derivation is gone, the `empty` prop
 * is gone with it, and the single test below replaces both -- kept as a test rather than a
 * deletion so the record shows the behaviour was once the opposite.
 */
describe('PageGuide: the per-page "what is this for?" panel', () => {
  it('is collapsed on every page, whether or not the page has data', () => {
    const { container } = render(
      <PageGuide>
        <p>body</p>
      </PageGuide>,
    );
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('asks exactly one question, on every page that carries it', () => {
    const { container } = render(
      <PageGuide>
        <p>body</p>
      </PageGuide>,
    );
    expect(container.querySelector('summary')?.textContent).toBe('What is this page for?');
  });

  it('renders its children as the panel body', () => {
    const { container } = render(
      <PageGuide>
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
