// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { DisclosureSummary, DisclosureButton } from '@/components/ui/Disclosure';
import { BackLink, BackButton } from '@/components/ui/BackLink';
import { CardActionRow } from '@/components/ui/CardActionRow';

afterEach(cleanup);

const svgOf = (el: HTMLElement) => el.querySelector('svg') as SVGElement;

describe('DisclosureSummary', () => {
  it('is accent text with an aria-hidden chevron that follows the details state', () => {
    const { container } = render(
      <details className="group/disclosure">
        <DisclosureSummary>Show details</DisclosureSummary>
        <p>Body</p>
      </details>,
    );
    const summary = container.querySelector('summary') as HTMLElement;
    expect(summary.className).toContain('text-accent-text');
    expect(svgOf(summary).getAttribute('aria-hidden')).toBe('true');
    expect(svgOf(summary).getAttribute('class')).toContain('group-open/disclosure:rotate-90');
    expect(summary.textContent).toBe('Show details');
  });
});

describe('DisclosureButton', () => {
  it('tracks aria-expanded and rotation with open, and calls onToggle', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <DisclosureButton open={false} onToggle={onToggle} controls="panel">
        Show history
      </DisclosureButton>,
    );
    const btn = screen.getByRole('button', { name: 'Show history' });
    expect(btn.className).toContain('text-accent-text');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-controls')).toBe('panel');
    expect(svgOf(btn).getAttribute('aria-hidden')).toBe('true');
    expect(svgOf(btn).getAttribute('class')).not.toContain('rotate-90');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(
      <DisclosureButton open onToggle={onToggle} controls="panel">
        Show history
      </DisclosureButton>,
    );
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(svgOf(btn).getAttribute('class')).toContain('rotate-90');
  });

  it('uses label as the name when icon-only', () => {
    render(<DisclosureButton open={false} onToggle={() => {}} label="Show members" />);
    expect(screen.getByRole('button', { name: 'Show members' })).toBeTruthy();
  });
});

describe('BackLink and BackButton', () => {
  it('link: data-back, accent, hidden icon, name is the bare label', () => {
    render(<BackLink href="/groups">Back to groups</BackLink>);
    const a = screen.getByRole('link', { name: 'Back to groups' });
    expect(a.hasAttribute('data-back')).toBe(true);
    expect(a.getAttribute('href')).toBe('/groups');
    expect(a.className).toContain('text-accent-text');
    expect(a.className).toContain('self-start');
    expect(svgOf(a).getAttribute('aria-hidden')).toBe('true');
  });

  it('button: data-back, click and disabled work', () => {
    const onClick = vi.fn();
    const { rerender } = render(<BackButton onClick={onClick}>Back to the list</BackButton>);
    const b = screen.getByRole('button', { name: 'Back to the list' }) as HTMLButtonElement;
    expect(b.hasAttribute('data-back')).toBe(true);
    expect(b.className).toContain('text-accent-text');
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <BackButton onClick={onClick} disabled>
        Back to the list
      </BackButton>,
    );
    expect(b.disabled).toBe(true);
  });
});

describe('CardActionRow', () => {
  it('link: full width, accent, hidden trailing icon, no aria-expanded', () => {
    render(<CardActionRow href="/transactions">Categorize</CardActionRow>);
    const a = screen.getByRole('link', { name: 'Categorize' });
    expect(a.className).toContain('text-accent-text');
    expect(a.className).toContain('justify-between');
    expect(a.getAttribute('aria-expanded')).toBeNull();
    expect(svgOf(a).getAttribute('aria-hidden')).toBe('true');
  });

  it('button: aria-expanded and rotation track expanded, controls is set', () => {
    const { rerender } = render(
      <CardActionRow onClick={() => {}} expanded={false} controls="kids">
        Show sub-categories
      </CardActionRow>,
    );
    const b = screen.getByRole('button', { name: 'Show sub-categories' });
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.getAttribute('aria-controls')).toBe('kids');
    expect(svgOf(b).getAttribute('class')).not.toContain('rotate-90');
    rerender(
      <CardActionRow onClick={() => {}} expanded controls="kids">
        Show sub-categories
      </CardActionRow>,
    );
    expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(svgOf(b).getAttribute('class')).toContain('rotate-90');
  });

  it('opensDialog sets aria-haspopup; without expanded there is no aria-expanded', () => {
    render(
      <CardActionRow onClick={() => {}} opensDialog>
        Set limit
      </CardActionRow>,
    );
    const b = screen.getByRole('button', { name: 'Set limit' });
    expect(b.getAttribute('aria-haspopup')).toBe('dialog');
    expect(b.getAttribute('aria-expanded')).toBeNull();
  });
});
