// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { AskInWords } from '@/components/AskInWords';
import { askInWordsAction } from '@/app/(app)/transactions/ask-action';

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/app/(app)/transactions/ask-action', () => ({
  askInWordsAction: vi.fn(async () => ({})),
}));

afterEach(() => {
  cleanup();
  vi.mocked(askInWordsAction).mockClear();
  push.mockClear();
});

const HREF = '/transactions?range=custom&from=2026-03-01&to=2026-03-31&category=12&spending=1';

function ask(question: string): void {
  const field = screen.getByRole('textbox', { name: 'Ask in words' }) as HTMLInputElement;
  fireEvent.change(field, { target: { value: question } });
  fireEvent.submit(field.closest('form') as HTMLFormElement);
}

/** v1.64.0 (plan 2026-11-12, E4). The box only chooses filters; the page does every sum. */
describe('AskInWords', () => {
  it('renders a field with the server’s limit and an Ask button', () => {
    render(<AskInWords maxChars={200} />);
    const field = screen.getByRole('textbox', { name: 'Ask in words' }) as HTMLInputElement;
    expect(field.maxLength).toBe(200);
    expect(field.name).toBe('question');
    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('posts the question, shows how it was read and opens the link', async () => {
    vi.mocked(askInWordsAction).mockResolvedValueOnce({ href: HREF, reading: 'Food › Groceries, spending only, Mar 1 to Mar 31' });
    render(<AskInWords maxChars={200} />);
    ask('groceries this month');
    await waitFor(() => expect(askInWordsAction).toHaveBeenCalledTimes(1));
    const posted = vi.mocked(askInWordsAction).mock.calls[0][1] as FormData;
    expect(posted.get('question')).toBe('groceries this month');
    await waitFor(() => expect(push).toHaveBeenCalledWith(HREF));
    expect(push).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Read as: Food › Groceries, spending only, Mar 1 to Mar 31.'),
    );
    // The question stays in the box, so it can be reworded.
    expect((screen.getByRole('textbox', { name: 'Ask in words' }) as HTMLInputElement).value).toBe('groceries this month');
  });

  it('shows a refusal in one line and goes nowhere', async () => {
    vi.mocked(askInWordsAction).mockResolvedValueOnce({ error: 'Local AI is off or not answering. Use the filters instead.' });
    render(<AskInWords maxChars={200} />);
    ask('groceries this month');
    await waitFor(() => expect(screen.getByText('Local AI is off or not answering. Use the filters instead.')).toBeTruthy());
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('');
  });
});
