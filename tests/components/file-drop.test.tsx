// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { FileDrop, extensionsFromAccept, partitionDrop, rejectionFor } from '@/components/FileDrop';

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

/**
 * The owner, twice -- 2026-09-13 and again on v1.38.0, 2026-09-14: "ui is still an issue here in
 * 38 for drag and drop component", with a screenshot of the browser's own grey "Choose File / No
 * file chosen" widget sitting in the middle of the drop zone, directly under our own heading that
 * already said "Choose a file".
 *
 * The native control cannot be styled -- its button is drawn by the OS, so on a dark page it is a
 * pale rectangle that matches nothing, and it prints its own filename, which is why the import
 * page had to pass showChosenName={false} to stop the name appearing twice. So the input is
 * visually hidden and its LABEL is the button, which is the standard way this is done and costs
 * nothing in accessibility: the input is still in the tab order, still the thing a screen reader
 * announces, and clicking the label still opens the picker.
 */
describe('FileDrop: the zone is ours, not the browser grey widget', () => {
  it('hides the native input visually while leaving it reachable', () => {
    const { container } = render(<FileDrop name="file" accept=".csv" label="Choose a file" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.className).toContain('sr-only');
    // Not `hidden`, not display:none, not disabled -- any of those would take it out of the tab
    // order and break the keyboard path this component exists to preserve.
    expect(input.hasAttribute('hidden')).toBe(false);
    expect(input.disabled).toBe(false);
  });

  it('offers one visible control, which is the input own label', () => {
    const { container } = render(<FileDrop name="file" accept=".csv" label="Choose a file" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const label = container.querySelector(`label[for="${input.id}"]`) as HTMLLabelElement;
    expect(label).toBeTruthy();
    expect(label.textContent).toContain('Choose a file');
    // One heading, not two: the zone used to print our label AND the widget's own button text.
    expect(screen.getAllByText('Choose a file')).toHaveLength(1);
  });

  it('prints the chosen filename itself, once', () => {
    render(<FileDrop name="file" accept=".csv" label="Choose a file" />);
    const input = screen.getByLabelText('Choose a file') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['a,b'], 'march.csv', { type: 'text/csv' })] } });
    expect(screen.getAllByText('march.csv')).toHaveLength(1);
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

/**
 * 2026-09-15. The report downloads ten statements and feeds them in one at a time: "throughwing all
 * together lets app handle the process". `rejectionFor` refused a multi-file drop outright, in one
 * line, and that line is the whole of what stood in the way.
 *
 * THE RULE THAT SHAPES ALL OF THIS: a mixed drop must not be refused wholesale. Nine statements and
 * one PDF is the realistic drop -- a bank folder has a PDF in it -- and throwing the nine away
 * because of the one would be worse than what it replaces. So multi mode PARTITIONS rather than
 * refuses, which is also a real ask ("icase onf the files is not supported it should
 * handle it accodingy").
 */
describe('partitionDrop: a bad file does not condemn the good ones', () => {
  it('splits a mixed drop, keeping the good and naming each reject', () => {
    const good = csv('jan.csv');
    const bad = new File(['x'], 'scan.pdf');
    const result = partitionDrop([good, bad], ['.csv']);
    expect(result.accepted).toEqual([good]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.file).toBe(bad);
    expect(result.rejected[0]!.reason).toMatch(/\.csv/);
  });

  it('keeps every file when the accept list names no extensions', () => {
    const files = [new File(['x'], 'a.pdf'), new File(['x'], 'b.xls')];
    expect(partitionDrop(files, []).accepted).toEqual(files);
  });

  it('reports an all-bad drop as all rejected, with nothing accepted', () => {
    const result = partitionDrop([new File(['x'], 'a.pdf'), new File(['x'], 'b.docx')], ['.csv']);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(2);
  });

  it('handles an empty drop without inventing a file', () => {
    expect(partitionDrop([], ['.csv'])).toEqual({ accepted: [], rejected: [] });
  });
});

describe('FileDrop in multiple mode', () => {
  it('tells the browser picker it may take more than one', () => {
    const { container } = render(<FileDrop name="file" accept=".csv" label="Choose files" multiple />);
    expect((container.querySelector('input[type="file"]') as HTMLInputElement).multiple).toBe(true);
  });

  it('hands every dropped file to onFiles', () => {
    const onFiles = vi.fn();
    render(<FileDrop name="file" accept=".csv" label="Choose files" multiple onFiles={onFiles} />);
    drop(zone(), [csv('jan.csv'), csv('feb.csv'), csv('mar.csv')]);
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0]![0].map((file: File) => file.name)).toEqual(['jan.csv', 'feb.csv', 'mar.csv']);
  });

  /** The realistic drop: a folder of statements with a PDF in it. */
  it('imports the good ones and says which it could not take', () => {
    const onFiles = vi.fn();
    render(<FileDrop name="file" accept=".csv" label="Choose files" multiple onFiles={onFiles} />);
    drop(zone(), [csv('jan.csv'), new File(['x'], 'scan.pdf'), csv('feb.csv')]);
    expect(onFiles.mock.calls[0]![0].map((file: File) => file.name)).toEqual(['jan.csv', 'feb.csv']);
    expect(screen.getByRole('status').textContent).toContain('scan.pdf');
  });

  it('calls nothing when every file was refused', () => {
    const onFiles = vi.fn();
    render(<FileDrop name="file" accept=".csv" label="Choose files" multiple onFiles={onFiles} />);
    drop(zone(), [new File(['x'], 'a.pdf'), new File(['x'], 'b.docx')]);
    expect(onFiles).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toMatch(/a\.pdf/);
  });

  it('takes a multi selection from the picker too, not only from a drop', () => {
    const onFiles = vi.fn();
    const { container } = render(<FileDrop name="file" accept=".csv" label="Choose files" multiple onFiles={onFiles} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [csv('jan.csv'), csv('feb.csv')] } });
    expect(onFiles.mock.calls[0]![0]).toHaveLength(2);
  });

  /** Regression: every other caller in the app is single, and must stay refused. */
  it('still refuses two files when multiple is not set', () => {
    const onFile = vi.fn();
    render(<FileDrop name="file" accept=".csv" label="Choose a file" onFile={onFile} />);
    drop(zone(), [csv('jan.csv'), csv('feb.csv')]);
    expect(onFile).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toMatch(/one file at a time/i);
  });
});
