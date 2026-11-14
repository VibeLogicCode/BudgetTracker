// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { AiSuggestionLine } from '@/components/review/AiSuggestionLine';
import { acceptAiSuggestionAction, ignoreAiSuggestionAction } from '@/app/(app)/transactions/ai-actions';
import type { AiSuggestionView } from '@/lib/ai/types';

vi.mock('@/app/(app)/transactions/ai-actions', () => ({
  acceptAiSuggestionAction: vi.fn(async () => ({ message: 'Category updated.' })),
  ignoreAiSuggestionAction: vi.fn(async () => ({ message: 'Ignored. No more AI suggestions for MAPLE GROCER.' })),
}));

afterEach(() => {
  cleanup();
  vi.mocked(acceptAiSuggestionAction).mockClear();
  vi.mocked(ignoreAiSuggestionAction).mockClear();
});

/** v1.64.0 (plan lane C3). Invented merchant. */
const BOTH: AiSuggestionView = { categoryId: 42, categoryLabel: 'Groceries', cleanName: 'Maple Grocer' };

function renderLine(over: { suggestion?: AiSuggestionView; canRemember?: boolean; alwaysAsk?: boolean; onResult?: (state: unknown) => void } = {}) {
  return render(
    <AiSuggestionLine
      transactionId={903}
      merchant="MAPLE GROCER"
      suggestion={over.suggestion ?? BOTH}
      canRemember={over.canRemember ?? true}
      alwaysAsk={over.alwaysAsk ?? false}
      onResult={over.onResult}
    />,
  );
}

const lastPosted = (action: typeof acceptAiSuggestionAction) => vi.mocked(action).mock.calls.at(-1)![1] as FormData;

describe('AiSuggestionLine (v1.64.0)', () => {
  it('shows one quiet line with both parts, Remember ticked, and Ignore, each named for the merchant', () => {
    const { container } = renderLine();
    expect(container.textContent).toContain('AI suggests:');
    expect(container.textContent).toContain('Groceries');
    expect(container.textContent).toContain('Name: Maple Grocer');
    expect(screen.getByRole('button', { name: 'Use Groceries for MAPLE GROCER' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use the name Maple Grocer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ignore the AI suggestion for MAPLE GROCER' })).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Remember for future MAPLE GROCER rows' }) as HTMLInputElement).checked).toBe(true);
    // Words on the page, never a title-only hint.
    expect(container.querySelector('[title]')).toBeNull();
  });

  it('Use posts the row, the part and remember, and hands the result up', async () => {
    const onResult = vi.fn();
    renderLine({ onResult });
    fireEvent.submit(screen.getByRole('button', { name: 'Use Groceries for MAPLE GROCER' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(acceptAiSuggestionAction).toHaveBeenCalledTimes(1));
    let posted = lastPosted(acceptAiSuggestionAction);
    expect([posted.get('transactionId'), posted.get('part'), posted.get('remember')]).toEqual(['903', 'category', '1']);
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ message: 'Category updated.' }));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember for future MAPLE GROCER rows' }));
    fireEvent.submit(screen.getByRole('button', { name: 'Use the name Maple Grocer' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(acceptAiSuggestionAction).toHaveBeenCalledTimes(2));
    posted = lastPosted(acceptAiSuggestionAction);
    expect([posted.get('part'), posted.get('remember')]).toEqual(['name', null]);
  });

  it('Ignore posts the merchant', async () => {
    renderLine();
    fireEvent.submit(screen.getByRole('button', { name: 'Ignore the AI suggestion for MAPLE GROCER' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(ignoreAiSuggestionAction).toHaveBeenCalledTimes(1));
    expect(lastPosted(ignoreAiSuggestionAction).get('merchant')).toBe('MAPLE GROCER');
  });

  it('does not render a part the suggestion lacks, and renders nothing when neither is there', () => {
    renderLine({ suggestion: { categoryId: 42, categoryLabel: 'Groceries', cleanName: null } });
    expect(screen.queryByRole('button', { name: /Use the name/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Use Groceries for MAPLE GROCER' })).toBeTruthy();
    cleanup();
    renderLine({ suggestion: { categoryId: null, categoryLabel: null, cleanName: 'Maple Grocer' } });
    expect(screen.queryByRole('button', { name: /^Use Groceries/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Use the name Maple Grocer' })).toBeTruthy();
    cleanup();
    const { container } = renderLine({ suggestion: { categoryId: null, categoryLabel: null, cleanName: null } });
    expect(container.textContent).toBe('');
  });

  it('hides the Remember checkbox for an Always ask merchant and posts no remember', async () => {
    renderLine({ alwaysAsk: true });
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.submit(screen.getByRole('button', { name: 'Use Groceries for MAPLE GROCER' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(acceptAiSuggestionAction).toHaveBeenCalledTimes(1));
    expect(lastPosted(acceptAiSuggestionAction).get('remember')).toBeNull();
  });
});
