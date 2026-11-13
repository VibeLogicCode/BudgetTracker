// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { SetupSuggestionsCard } from '@/components/SetupSuggestionsCard';
import type { SetupSuggestion } from '@/lib/setup-suggestions';

const action = vi.hoisted(() => vi.fn());
vi.mock('@/app/(app)/transactions/actions', () => ({ setRecurringMarkAction: action }));

afterEach(() => {
  cleanup();
  action.mockReset();
});

function suggestion(over: Partial<SetupSuggestion> = {}): SetupSuggestion {
  return {
    kind: 'recurring',
    merchant: 'MAPLE MORTGAGE',
    transactionId: 501,
    typicalCents: 240000,
    monthlyCents: 240000,
    dayOfMonth: 2,
    reason: 'Mark it so the month check-in counts it as still due.',
    sentence: 'MAPLE MORTGAGE looks recurring: about $2,400 around the 2nd of each month. Mark it so the month check-in counts it as still due.',
    ...over,
  };
}

const streambox = () => suggestion({ merchant: 'STREAMBOX', transactionId: 502, sentence: 'STREAMBOX looks recurring.' });
const LIST = '/insights/recurring';

describe('SetupSuggestionsCard', () => {
  it('shows the title, one row per merchant, and the link to the full list', () => {
    const { container } = render(<SetupSuggestionsCard suggestions={[suggestion(), streambox()]} recurringHref={LIST} />);
    expect(screen.getByRole('heading', { name: 'Make your numbers sharper' })).toBeTruthy();
    expect(container.querySelector('#sharper')).not.toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText(/MAPLE MORTGAGE looks recurring: about \$2,400 around the 2nd/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Full Recurring list' }).getAttribute('href')).toBe(LIST);
  });

  it('is hidden when there is nothing to suggest', () => {
    const { container } = render(<SetupSuggestionsCard suggestions={[]} recurringHref={LIST} />);
    expect(screen.queryByRole('heading', { name: 'Make your numbers sharper' })).toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });

  it('names the merchant in every button', () => {
    render(<SetupSuggestionsCard suggestions={[suggestion()]} recurringHref={LIST} />);
    expect(screen.getByRole('button', { name: 'Mark recurring: MAPLE MORTGAGE' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Not recurring: MAPLE MORTGAGE' })).toBeTruthy();
  });

  it('posts the newest charge with the mark, announces the result and drops the row', async () => {
    action.mockResolvedValue({ message: 'MAPLE MORTGAGE is marked recurring.' });
    render(<SetupSuggestionsCard suggestions={[suggestion(), streambox()]} recurringHref={LIST} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark recurring: MAPLE MORTGAGE' }));
    await waitFor(() => expect(screen.queryByText(/MAPLE MORTGAGE looks recurring/)).toBeNull());
    const form = action.mock.calls[0][1] as FormData;
    expect(form.get('transactionId')).toBe('501');
    expect(form.get('mark')).toBe('recurring');
    expect(screen.getByRole('status').textContent).toBe('MAPLE MORTGAGE is marked recurring.');
    expect(screen.getByText('STREAMBOX looks recurring.')).toBeTruthy();
  });

  it('Not recurring posts that mark', async () => {
    action.mockResolvedValue({ message: 'MAPLE MORTGAGE will not be listed as recurring.' });
    render(<SetupSuggestionsCard suggestions={[suggestion()]} recurringHref={LIST} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not recurring: MAPLE MORTGAGE' }));
    await waitFor(() => expect(screen.queryByText(/MAPLE MORTGAGE looks recurring/)).toBeNull());
    expect((action.mock.calls[0][1] as FormData).get('mark')).toBe('not_recurring');
    expect(screen.getByRole('status').textContent).toContain('will not be listed as recurring');
  });

  it('keeps the row and shows the error when the action refuses', async () => {
    action.mockResolvedValue({ error: 'That rule belongs to Alex.' });
    render(<SetupSuggestionsCard suggestions={[suggestion()]} recurringHref={LIST} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark recurring: MAPLE MORTGAGE' }));
    await waitFor(() => expect(screen.getByText('That rule belongs to Alex.')).toBeTruthy());
    expect(screen.getByText(/MAPLE MORTGAGE looks recurring/)).toBeTruthy();
  });
});
