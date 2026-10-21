// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/app/(app)/transactions/actions', () => ({
  previewAlwaysAskAction: vi.fn(async () => ({ message: 'Matches 3 transactions.' })),
  setAlwaysAskAction: vi.fn(async () => ({
    message: 'Rows matching "PHONEMART" will always be asked about.',
    ruleId: 41,
    sendBackCount: 2,
  })),
  sendBackToReviewAction: vi.fn(async () => ({ message: 'Sent 2 transactions back to review.' })),
}));

import { AlwaysAskDialog } from '@/components/transactions/AlwaysAskDialog';

afterEach(cleanup);

describe('AlwaysAskDialog', () => {
  it('starts from the merchant minus its code, saves, offers Send back, then reports the send and closes', async () => {
    const onSent = vi.fn();
    const onClose = vi.fn();
    render(<AlwaysAskDialog merchant="PHONEMART ***884" onClose={onClose} onSent={onSent} />);
    expect((screen.getByLabelText('Text to match') as HTMLInputElement).value).toBe('PHONEMART');
    expect(await screen.findByTestId('always-ask-count')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Always ask' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send 2 back to review' }));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });
});
