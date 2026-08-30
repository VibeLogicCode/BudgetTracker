// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MetricCard } from '@/components/ui/MetricCard';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Pill } from '@/components/ui/Pill';

afterEach(() => cleanup());

describe('MetricCard', () => {
  it('renders every slot when provided', () => {
    render(
      <MetricCard
        icon={<span data-testid="metric-card-icon">🏠</span>}
        title="Groceries"
        subtitle="6 categories · 2 over"
        pill={<Pill tone="warning">92%</Pill>}
        value="$430.00"
        compare="of $500.00"
        bar={<ProgressBar pct={86} label="Groceries budget used" />}
        status="$70.00 remaining"
        action={<button type="button">View breakdown</button>}
      >
        <p>Expanded child content</p>
      </MetricCard>,
    );

    expect(screen.getByTestId('metric-card-icon')).toBeTruthy();
    expect(screen.getByText('Groceries')).toBeTruthy();
    expect(screen.getByText('6 categories · 2 over')).toBeTruthy();
    expect(screen.getByText('92%')).toBeTruthy();
    expect(screen.getByText('$430.00')).toBeTruthy();
    expect(screen.getByText('of $500.00')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Groceries budget used' })).toBeTruthy();
    expect(screen.getByText('$70.00 remaining')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View breakdown' })).toBeTruthy();
    expect(screen.getByText('Expanded child content')).toBeTruthy();
  });

  it('renders only the required slots when every optional prop is omitted', () => {
    render(<MetricCard title="Groceries" value="$430.00" />);
    expect(screen.getByText('Groceries')).toBeTruthy();
    expect(screen.getByText('$430.00')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('omits the footer strip entirely when action is absent', () => {
    render(<MetricCard title="Groceries" value="$430.00" />);
    expect(screen.queryByTestId('metric-card-footer')).toBeNull();
  });

  it('renders the footer strip only when action is present', () => {
    render(
      <MetricCard title="Groceries" value="$430.00" action={<button type="button">View breakdown</button>} />,
    );
    expect(screen.getByTestId('metric-card-footer')).toBeTruthy();
  });
});

describe('ProgressBar', () => {
  it('exposes the true percentage to assistive tech, even past 100', () => {
    render(<ProgressBar pct={138} label="Coffee budget used" />);
    const bar = screen.getByRole('progressbar', { name: 'Coffee budget used' });
    expect(bar.getAttribute('aria-valuenow')).toBe('138');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('clamps the visual fill at 100% while the reported percentage stays true (ruling D4)', () => {
    render(<ProgressBar pct={138} label="Coffee budget used" />);
    const bar = screen.getByRole('progressbar', { name: 'Coffee budget used' });
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('never shrinks the fill below 0% for a negative percentage', () => {
    render(<ProgressBar pct={-10} label="Weird budget" />);
    const bar = screen.getByRole('progressbar', { name: 'Weird budget' });
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('0%');
  });

  it.each([
    [79, 'bg-positive-solid'],
    [80, 'bg-warning-solid'],
    [100, 'bg-warning-solid'],
    [138, 'bg-negative-solid'],
  ])('derives the D5 tone at %s%%', (pct, expectedClass) => {
    render(<ProgressBar pct={pct} label={`test-${pct}`} />);
    const bar = screen.getByRole('progressbar', { name: `test-${pct}` });
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.className).toContain(expectedClass);
  });

  it('an explicit tone wins over the derived one', () => {
    render(<ProgressBar pct={10} tone="over" label="explicit tone" />);
    const bar = screen.getByRole('progressbar', { name: 'explicit tone' });
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.className).toContain('bg-negative-solid');
  });
});
