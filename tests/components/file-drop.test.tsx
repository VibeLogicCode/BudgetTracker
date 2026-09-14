// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { FileDrop, extensionsFromAccept, rejectionFor } from '@/components/FileDrop';

afterEach(cleanup);

function csv(name = 'statement.csv'): File {
  return new File(['2026-03-02,COFFEE,4.85'], name, { type: 'text/csv' });
}

/** jsdom implements neither DataTransfer nor FileList, so a drop carries a stand-in of both. */
function drop(target: Element, files: File[]): void {
  fireEvent.drop(target, { dataTransfer: { files, types: ['Files'] } });
}

function zone(): HTMLElement {
  return screen.getByTestId('file-drop');
}

describe('FileDrop: the click path is the real one', () => {
  it('renders a real file input carrying the name and accept it was given', () => {
    const { container } = render(<FileDrop name="file" accept=".csv,.ofx,.qfx" label="Choose a file" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.getAttribute('name')).toBe('file');
    expect(input.getAttribute('accept')).toBe('.csv,.ofx,.qfx');
  });

  /**
   * Drag-and-drop is an enhancement over a working control, never a replacement: a keyboard or
   * screen-reader user reaches the same input, and the label is its accessible name. The hint
   * sits OUTSIDE the label on purpose -- item J fixed hints being folded into accessible names
   * once already.
   */
  it('labels the input, and keeps the hint out of the label', () => {
    render(<FileDrop name="file" accept=".csv" label="Choose a file" hint="A CSV export from your bank." />);
    const input = screen.getByLabelText('Choose a file');
    expect(input.tagName).toBe('INPUT');
    expect(screen.getByText('A CSV export from your bank.').closest('label')).toBeNull();
  });
});

describe('FileDrop: dropping a file', () => {
  it('reports the dropped file by name', () => {
    render(<FileDrop name="file" accept=".csv" label="Choose a file" />);
    drop(zone(), [csv('td-march.csv')]);
    expect(screen.getByText('td-march.csv')).toBeTruthy();
  });

  it('calls back with the file it accepted', () => {
    const onFile = vi.fn();
    render(<FileDrop name="file" accept=".csv" label="Choose a file" onFile={onFile} />);
    drop(zone(), [csv('td-march.csv')]);
    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile.mock.calls[0]?.[0]?.name).toBe('td-march.csv');
  });

  /**
   * Without preventDefault on dragover the browser navigates to the file instead of dropping it
   * -- the page disappears and the import is lost. It is the one drag handler that is not
   * cosmetic.
   */
  it('prevents the browser from opening the file on dragover', () => {
    render(<FileDrop name="file" accept=".csv" label="Choose a file" />);
    const prevented = fireEvent.dragOver(zone(), { dataTransfer: { types: ['Files'] } });
    expect(prevented).toBe(false); // fireEvent returns false when preventDefault was called
  });

  it('refuses two files at once, and says so', () => {
    const onFile = vi.fn();
    render(<FileDrop name="file" accept=".csv" label="Choose a file" onFile={onFile} />);
    drop(zone(), [csv('one.csv'), csv('two.csv')]);
    expect(screen.getByText(/one file at a time/i)).toBeTruthy();
    expect(onFile).not.toHaveBeenCalled();
  });

  it('refuses a file whose extension is not on offer', () => {
    const onFile = vi.fn();
    render(<FileDrop name="file" accept=".csv,.ofx" label="Choose a file" onFile={onFile} />);
    drop(zone(), [new File(['x'], 'statement.pdf', { type: 'application/pdf' })]);
    expect(screen.getByText(/\.csv or \.ofx/i)).toBeTruthy();
    expect(onFile).not.toHaveBeenCalled();
  });

  it('clears a previous refusal once a good file arrives', () => {
    render(<FileDrop name="file" accept=".csv" label="Choose a file" />);
    drop(zone(), [new File(['x'], 'statement.pdf', { type: 'application/pdf' })]);
    drop(zone(), [csv('good.csv')]);
    expect(screen.queryByText(/\.csv/i)?.textContent).not.toContain('cannot read');
    expect(screen.getByText('good.csv')).toBeTruthy();
  });
});

describe('the two pure helpers', () => {
  it('reads the extension list out of an accept attribute, ignoring MIME types', () => {
    expect(extensionsFromAccept('.csv,.ofx,.qfx,text/csv')).toEqual(['.csv', '.ofx', '.qfx']);
  });

  it('names the reason a drop was refused, or null when it is fine', () => {
    expect(rejectionFor([csv()], ['.csv'])).toBeNull();
    expect(rejectionFor([csv(), csv()], ['.csv'])).toMatch(/one file at a time/i);
    expect(rejectionFor([], ['.csv'])).toMatch(/no file/i);
    expect(rejectionFor([new File(['x'], 'a.pdf')], ['.csv'])).toMatch(/\.csv/);
  });

  it('accepts any file when the accept list names no extensions at all', () => {
    expect(rejectionFor([new File(['x'], 'a.pdf')], [])).toBeNull();
  });
});
