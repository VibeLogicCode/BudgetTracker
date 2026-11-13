// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { UndoBar } from '@/components/review/UndoBar';
import { undoBulkAction } from '@/app/(app)/transactions/actions';

vi.mock('@/app/(app)/transactions/actions', () => ({
  undoBulkAction: vi.fn(async () => ({})),
}));

afterEach(() => {
  cleanup();
  vi.mocked(undoBulkAction).mockClear();
});

const OFFER = { label: 'Categorized 12 transactions as Groceries.', until: '14:32' };

/** v1.62.0 (plan item 3, B5). Undo for the signed-in person's own last bulk change. */
describe('UndoBar (v1.62.0)', () => {
  it('shows the change and the time it can be undone until', () => {
    const { container } = render(<UndoBar undo={OFFER} />);
    const bar = container.querySelector('[data-undo-bar]') as HTMLElement;
    expect(bar.textContent).toContain('Categorized 12 transactions as Groceries.');
    expect(bar.textContent).toContain('Until 14:32.');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('posts to the undo action and announces what it put back', async () => {
    vi.mocked(undoBulkAction).mockResolvedValueOnce({ message: 'Undone. 12 transactions are back as they were; 1 rule removed.' });
    render(<UndoBar undo={OFFER} />);
    fireEvent.submit(screen.getByRole('button', { name: 'Undo' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(undoBulkAction).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Undone. 12 transactions are back as they were; 1 rule removed.'),
    );
  });

  it('shows a refusal', async () => {
    vi.mocked(undoBulkAction).mockResolvedValueOnce({ error: 'That change is more than 15 minutes old, so it can no longer be undone.' });
    render(<UndoBar undo={OFFER} />);
    fireEvent.submit(screen.getByRole('button', { name: 'Undo' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByText('That change is more than 15 minutes old, so it can no longer be undone.')).toBeTruthy());
  });

  it('is absent when there is nothing to undo, leaving only its empty live region', () => {
    const { container } = render(<UndoBar undo={null} />);
    expect(container.querySelector('[data-undo-bar]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('keeps the announcement once the offer is gone, as it is after a successful undo revalidates', async () => {
    vi.mocked(undoBulkAction).mockResolvedValueOnce({ message: 'Undone. 1 rule removed.' });
    const view = render(<UndoBar undo={OFFER} />);
    fireEvent.submit(screen.getByRole('button', { name: 'Undo' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Undone. 1 rule removed.'));
    view.rerender(<UndoBar undo={null} />);
    expect(screen.getByRole('status').textContent).toBe('Undone. 1 rule removed.');
  });
});
