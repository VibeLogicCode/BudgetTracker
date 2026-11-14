// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReconcileLoanForm } from '@/app/(app)/warranties/[id]/reconcile-loan-form';

vi.mock('@/app/(app)/warranties/actions', () => ({
  reconcileLoanAction: vi.fn(async () => ({})),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReconcileLoanForm statement file', () => {
  it('states the size limit for a statement kept with the loan once a file is chosen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'That statement could not be read. Type the figures instead.' }), { status: 422 })),
    );
    const { container } = render(<ReconcileLoanForm itemId={42} direction="owed" interest={null} today="2026-09-01" />);
    expect(screen.queryByText(/1 MB or smaller/)).toBeNull();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['%PDF-1.7'], 'statement.pdf', { type: 'application/pdf' })] } });

    await waitFor(() => expect(screen.getByText('A statement kept with the loan must be a PDF of 1 MB or smaller.')).toBeTruthy());
  });
});
