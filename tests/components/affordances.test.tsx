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

  it('keeps wrapped text left and merges a caller className onto the button', () => {
    const { rerender } = render(
      <DisclosureButton open={false} onToggle={() => {}}>
        Payment on account
      </DisclosureButton>,
    );
    const btn = screen.getByRole('button', { name: 'Payment on account' });
    const classes = () => btn.className.split(/\s+/);
    expect(classes()).toContain('text-left');
    expect(classes()).not.toContain('min-w-0');
    rerender(
      <DisclosureButton open={false} onToggle={() => {}} className="min-w-0">
        Payment on account
      </DisclosureButton>,
    );
    expect(classes()).toEqual(expect.arrayContaining(['text-left', 'text-accent-text', 'min-w-0']));
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

  it('inline: the same accent look at the width of its label, chevron after it, touch floor kept', () => {
    render(
      <CardActionRow onClick={() => {}} opensDialog inline>
        Fix
      </CardActionRow>,
    );
    const b = screen.getByRole('button', { name: 'Fix' });
    const classes = b.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['inline-flex', 'text-accent-text', 'min-h-11', 'sm:min-h-0']));
    expect(classes).not.toContain('w-full');
    expect(classes).not.toContain('justify-between');
    expect(b.lastElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(svgOf(b).getAttribute('aria-hidden')).toBe('true');
  });

  it('inline: at least 44px wide below sm, like the theme toggle; the full-width row is unchanged', () => {
    render(
      <CardActionRow onClick={() => {}} opensDialog inline>
        Fix
      </CardActionRow>,
    );
    const inline = screen.getByRole('button', { name: 'Fix' }).className.split(/\s+/);
    expect(inline).toEqual(expect.arrayContaining(['min-w-11', 'sm:min-w-0']));
    cleanup();
    render(<CardActionRow onClick={() => {}}>Set limit</CardActionRow>);
    const row = screen.getByRole('button', { name: 'Set limit' }).className.split(/\s+/);
    expect(row).not.toContain('min-w-11');
    expect(row).not.toContain('sm:min-w-0');
    expect(row).toEqual(expect.arrayContaining(['w-full', 'justify-between', 'min-h-11', 'sm:min-h-0']));
  });
});
