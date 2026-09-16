// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ProgressBar } from '@/components/ui/ProgressBar';

afterEach(cleanup);

const bar = () => screen.getByRole('progressbar');
const fill = () => bar().querySelector('[data-bar-fill]') as HTMLElement;
const limit = () => bar().querySelector('[data-bar-limit]') as HTMLElement | null;

/**
 * 2026-09-15, from a real budgets card: Housing at 117% of its limit and Health at 370%
 * rendered as IDENTICAL full red bars. The fill is clamped to 100%, which is right — a bar cannot
 * overflow its track — but clamping threw away the one thing a reader needs at that moment, which
 * is how far over.
 *
 * Those two numbers call for very different reactions, and the bar was flattening them into the
 * same picture.
 */
describe('ProgressBar: under the limit', () => {
  it('fills to the percentage, and shows no limit marker', () => {
    render(<ProgressBar pct={40} label="Groceries budget used" />);
    expect(fill().style.width).toBe('40%');
    expect(limit()).toBeNull();
  });

  it('reports the true value to assistive tech', () => {
    render(<ProgressBar pct={40} label="Groceries budget used" />);
    expect(bar().getAttribute('aria-valuenow')).toBe('40');
  });

  it('warns before it is over, not after', () => {
    render(<ProgressBar pct={85} label="Groceries budget used" />);
    expect(fill().className).toContain('bg-warning-solid');
  });
});

describe('ProgressBar: over the limit, the overshoot is visible', () => {
  it('still fills the track, because a bar cannot overflow itself', () => {
    render(<ProgressBar pct={117} label="Housing budget used" />);
    expect(fill().style.width).toBe('100%');
    expect(fill().className).toContain('bg-negative-solid');
  });

  /**
   * The marker sits where the LIMIT falls on a track that now represents the whole spend. Slightly
   * over puts it near the right-hand end; far over drags it left, and the gap after it is the
   * overshoot. One glance separates 117% from 370%.
   */
  it('marks where the limit was, proportionally', () => {
    render(<ProgressBar pct={117} label="Housing budget used" />);
    // 100/117 -> ~85%.
    expect(Math.round(parseFloat(limit()!.style.left))).toBe(85);
  });

  it('drags the marker far left when the overshoot is large', () => {
    render(<ProgressBar pct={370} label="Health budget used" />);
    // 100/370 -> ~27%.
    expect(Math.round(parseFloat(limit()!.style.left))).toBe(27);
  });

  it('tells the two apart, which is the whole point', () => {
    const { unmount } = render(<ProgressBar pct={117} label="Housing budget used" />);
    const slightly = limit()!.style.left;
    unmount();
    render(<ProgressBar pct={370} label="Health budget used" />);
    expect(limit()!.style.left).not.toBe(slightly);
  });

  it('keeps the real percentage for a screen reader, which never needed the clamp', () => {
    render(<ProgressBar pct={370} label="Health budget used" />);
    expect(bar().getAttribute('aria-valuenow')).toBe('370');
  });

  /** The marker is decoration over a bar that already has an accessible name and value. */
  it('hides the marker from assistive tech', () => {
    render(<ProgressBar pct={117} label="Housing budget used" />);
    expect(limit()!.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows no marker exactly at the limit, where there is nothing to show', () => {
    render(<ProgressBar pct={100} label="Housing budget used" />);
    expect(limit()).toBeNull();
  });
});
