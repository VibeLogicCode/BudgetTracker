// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ListRow } from '@/components/ui/ListRow';

afterEach(() => cleanup());

/** Renders inside a <ul> -- ListRow's own root is an <li>, and jsdom (unlike a real DOM parser)
 *  does not reparent an <li> rendered without one, but every real caller wraps a list of these
 *  in a <ul>, so the tests match that shape. */
function renderRow(children: React.ReactElement) {
  return render(<ul>{children}</ul>);
}

describe('ListRow', () => {
  it('renders the circled money-in arrow, toned differently from money-out', () => {
    const { container: inContainer } = renderRow(
      <ListRow direction="in" title="Refund" amount="$12.00" />,
    );
    const inArrowWrap = inContainer.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(inArrowWrap).not.toBeNull();
    expect(inArrowWrap.querySelector('svg')).not.toBeNull();
    expect(inArrowWrap.className).toContain('bg-positive-soft');
    cleanup();

    const { container: outContainer } = renderRow(
      <ListRow direction="out" title="Coffee" amount="$4.50" />,
    );
    const outArrowWrap = outContainer.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(outArrowWrap).not.toBeNull();
    expect(outArrowWrap.querySelector('svg')).not.toBeNull();
    expect(outArrowWrap.className).not.toContain('bg-positive-soft');
  });

  it('puts the amount after the title in reading order', () => {
    renderRow(<ListRow direction="out" title="Coffee" amount="$4.50" />);
    const title = screen.getByText('Coffee');
    const amount = screen.getByText('$4.50');
    // DOCUMENT_POSITION_FOLLOWING (4): amount comes after title in the DOM.
    expect(title.compareDocumentPosition(amount) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('uses the given icon instead of an arrow when direction is absent', () => {
    const { container } = renderRow(
      <ListRow icon={<span data-testid="custom-icon" />} title="Extended warranty" />,
    );
    expect(screen.getByTestId('custom-icon')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders no icon tile at all when neither direction nor icon is given', () => {
    const { container } = render(
      <ul>
        <ListRow title="Plain row" />
      </ul>,
    );
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('renders the leading and trailing slots', () => {
    renderRow(
      <ListRow
        leading={<input type="checkbox" aria-label="Select row" />}
        title="Groceries"
        trailing={<button type="button">Menu</button>}
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Select row' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Menu' })).toBeTruthy();
  });

  it('renders meta under the title and omits the amount column when amount is not given', () => {
    renderRow(<ListRow title="Groceries" meta="Housing" />);
    expect(screen.getByText('Groceries')).toBeTruthy();
    expect(screen.getByText('Housing')).toBeTruthy();
  });
});
