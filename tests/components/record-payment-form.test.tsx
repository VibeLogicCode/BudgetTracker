// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { RecordPaymentForm } from '@/components/RecordPaymentForm';

vi.mock('@/app/(app)/bills/actions', () => ({
  recordBillPaymentAction: vi.fn(async () => ({ message: 'Payment recorded and the installment marked paid.' })),
}));

afterEach(cleanup);

describe('RecordPaymentForm', () => {
  it('shows the action message after a submit', async () => {
    render(<RecordPaymentForm installmentId={7} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Payment recorded and the installment marked paid.');
    });
  });
});
