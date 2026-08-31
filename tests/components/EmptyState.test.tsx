// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { EmptyState } from '@/components/ui/EmptyState';
import { GoalsIcon } from '@/components/icons';

afterEach(() => cleanup());

// Item 2 (2026-08-30 one-design-language plan). Seven pages had hand-rolled the identical
// `rounded-md border border-dashed border-line-strong px-4 py-{6,8} text-center text-sm
// text-muted` box instead of reaching for this shared component -- one test here covering the
// `compact` size this refactor added stands in for what would otherwise have been seven
// near-identical assertions, one per converted call site.
describe('EmptyState', () => {
  it('renders the icon circle and a bold title by default', () => {
    const { container } = render(<EmptyState icon={GoalsIcon} title="No goals yet" />);
    expect(screen.getByText('No goals yet').className).toContain('font-semibold');
    // aria-hidden icon wrapper -- decorative, same convention every icon in this app follows.
    expect(container.querySelector('[aria-hidden="true"] svg')).toBeTruthy();
    expect(container.querySelector('.border-dashed')).toBeNull();
  });

  it('omits the icon entirely when none is given, without leaving an empty glyph slot', () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('size="compact" drops the bold title and draws the dashed card-scoped box, with no icon when none is given', () => {
    const { container } = render(<EmptyState size="compact" title="No receipts attached yet." />);
    // None of the seven call sites this variant replaced ever carried an icon -- omitting it is
    // the caller's own choice (icon stays independent of size, see this component's docblock),
    // not something `compact` forces.
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    const title = screen.getByText('No receipts attached yet.');
    expect(title.className).not.toContain('font-semibold');
    expect(container.querySelector('.border-dashed.border-line-strong')).toBeTruthy();
  });

  it('still renders the icon in compact mode when a caller does pass one -- the two props stay independent', () => {
    const { container } = render(<EmptyState size="compact" title="Nothing here" icon={GoalsIcon} />);
    expect(container.querySelector('[aria-hidden="true"] svg')).toBeTruthy();
  });

  it('still supports an action button in compact mode', () => {
    render(
      <EmptyState size="compact" title="Nothing linked yet." action={<button type="button">Link now</button>} />,
    );
    expect(screen.getByRole('button', { name: 'Link now' })).toBeTruthy();
  });
});
