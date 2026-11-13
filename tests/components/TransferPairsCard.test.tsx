// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { TransferPairsCard } from '@/components/review/TransferPairsCard';
import { confirmTransferPairAction, dismissTransferPairAction } from '@/app/(app)/transactions/transfer-pair-actions';
import type { TransferPair } from '@/lib/transfer-pairs';

vi.mock('@/app/(app)/transactions/transfer-pair-actions', () => ({
  confirmTransferPairAction: vi.fn(async () => ({ message: 'Marked 2 transactions as a transfer pair.' })),
  dismissTransferPairAction: vi.fn(async () => ({})),
}));

afterEach(() => {
  cleanup();
  vi.mocked(confirmTransferPairAction).mockClear();
  vi.mocked(dismissTransferPairAction).mockClear();
});

function pair(over: Partial<TransferPair> = {}): TransferPair {
  return {
    out: {
      id: 7,
      date: '2026-03-09',
      accountName: 'Everyday Chequing',
      description: 'E-TRANSFER 4417',
      amountCents: -50000,
      isTransfer: false,
      personName: 'Alex',
    },
    in: {
      id: 8,
      date: '2026-03-11',
      accountName: 'Rainy Day Savings',
      description: 'E-TRANSFER 4417',
      amountCents: 50000,
      isTransfer: true,
      personName: null,
    },
    ...over,
  };
}

describe('TransferPairsCard', () => {
  it('shows nothing but the quiet live region when there are no pairs', () => {
    const { container } = render(<TransferPairsCard pairs={[]} total={0} today="2026-03-12" />);
    expect(screen.queryByText(/Possible transfers/)).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('renders both lines, the badge, the note and the more-after line', () => {
    render(<TransferPairsCard pairs={[pair()]} total={23} today="2026-03-12" />);
    expect(screen.getByText('Possible transfers (23)')).toBeTruthy();
    expect(screen.getByText('Everyday Chequing')).toBeTruthy();
    expect(screen.getByText('Rainy Day Savings')).toBeTruthy();
    expect(screen.getByText('already a transfer')).toBeTruthy();
    expect(screen.getByText(/-\$500\.00/)).toBeTruthy();
    expect(screen.getByText(/\+\$500\.00/)).toBeTruthy();
    expect(screen.getByText(/No rule is saved, so the next pair like this is suggested again\./)).toBeTruthy();
    expect(screen.getByText(/22 more after these are done\./)).toBeTruthy();
  });

  it('gives each button an accessible name with both accounts and the amount', () => {
    render(<TransferPairsCard pairs={[pair()]} total={1} today="2026-03-12" />);
    expect(
      screen.getByRole('button', { name: 'Mark both as a transfer: $500.00 from Everyday Chequing to Rainy Day Savings' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Not a transfer: $500.00 from Everyday Chequing to Rainy Day Savings' })).toBeTruthy();
    expect(screen.queryByText(/more after these are done/)).toBeNull();
  });

  it('posts the two ids from each button', async () => {
    render(<TransferPairsCard pairs={[pair()]} total={1} today="2026-03-12" />);
    fireEvent.click(screen.getByRole('button', { name: /^Mark both as a transfer/ }));
    await waitFor(() => expect(confirmTransferPairAction).toHaveBeenCalledTimes(1));
    const confirmData = vi.mocked(confirmTransferPairAction).mock.calls[0][1] as FormData;
    expect([confirmData.get('outId'), confirmData.get('inId')]).toEqual(['7', '8']);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Marked 2 transactions as a transfer pair.'));

    fireEvent.click(screen.getByRole('button', { name: /^Not a transfer/ }));
    await waitFor(() => expect(dismissTransferPairAction).toHaveBeenCalledTimes(1));
    const dismissData = vi.mocked(dismissTransferPairAction).mock.calls[0][1] as FormData;
    expect([dismissData.get('outId'), dismissData.get('inId')]).toEqual(['7', '8']);
  });
});
