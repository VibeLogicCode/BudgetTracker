// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ReportsLoading from '@/app/(app)/reports/loading';
import TransactionsLoading from '@/app/(app)/transactions/loading';

afterEach(() => cleanup());

describe('loading skeletons (item AX / UX-10)', () => {
  it('Reports announces itself and draws placeholder bars', () => {
    const { container } = render(<ReportsLoading />);
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('Transactions announces itself and draws placeholder bars', () => {
    const { container } = render(<TransactionsLoading />);
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
});
