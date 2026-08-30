// @vitest-environment jsdom
/**
 * jsdom does not evaluate media queries, so `.data-table--stack`'s actual reflow -- the header
 * hiding, the grid placement of `cell-stack-lead`/`cell-stack-headline`/`cell-stack-amount` --
 * cannot be exercised here. These are class assertions, not layout assertions: they check that
 * `TableWrap` and `AmountCell` put the right hooks (`data-table--stack`, `data-label`) onto the
 * right nodes, and leave verifying that the CSS in globals.css actually reflows those nodes on a
 * phone-width viewport to a browser, by eye.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TableWrap, AmountCell } from '@/components/ui/Table';

afterEach(() => cleanup());

describe('TableWrap responsive', () => {
  it('adds data-table--stack to the table when responsive is set', () => {
    render(
      <TableWrap responsive>
        <tbody>
          <tr>
            <td>row</td>
          </tr>
        </tbody>
      </TableWrap>,
    );
    expect(screen.getByRole('table').className).toContain('data-table--stack');
  });

  it('leaves data-table--stack off the table when responsive is not set', () => {
    render(
      <TableWrap>
        <tbody>
          <tr>
            <td>row</td>
          </tr>
        </tbody>
      </TableWrap>,
    );
    expect(screen.getByRole('table').className).not.toContain('data-table--stack');
  });

  it('composes with fixed and minWidth -- both are desktop concerns the stacked layout must still carry', () => {
    render(
      <TableWrap responsive fixed minWidth="68rem">
        <tbody>
          <tr>
            <td>row</td>
          </tr>
        </tbody>
      </TableWrap>,
    );
    const table = screen.getByRole('table');
    expect(table.className).toContain('data-table--stack');
    expect(table.className).toContain('data-table--fixed');
    // The stacked-layout media query only overrides this inline style with `!important` at
    // widths below `sm`; jsdom never applies that query, so the inline style set by `minWidth`
    // must still be present here for the override to have anything to win against.
    expect(table.style.minWidth).toBe('68rem');
  });
});

describe('AmountCell data-label', () => {
  it('renders the data-label prop onto the td', () => {
    render(
      <table>
        <tbody>
          <tr>
            <AmountCell data-label="Amount">$12.00</AmountCell>
          </tr>
        </tbody>
      </table>,
    );
    const cell = screen.getByText('$12.00');
    expect(cell.tagName).toBe('TD');
    expect(cell.getAttribute('data-label')).toBe('Amount');
  });
});
