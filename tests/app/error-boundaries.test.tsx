// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AppError from '@/app/(app)/error';
import NotFound from '@/app/(app)/not-found';

afterEach(() => cleanup());

describe('the app error boundary (item W / UX-1, ruling R7)', () => {
  it('says what happened in plain language and never shows the raw message', () => {
    render(<AppError error={Object.assign(new Error('SQLITE_BUSY: database is locked'), { digest: 'abc123' })} reset={() => {}} />);

    expect(screen.getByRole('heading').textContent).toContain('Something went wrong');
    expect(screen.queryByText(/SQLITE_BUSY/)).toBeNull();
    // The digest IS shown: it is the string that makes a support conversation possible, and it
    // carries none of the message.
    expect(screen.getByText(/Reference/)).toBeTruthy();
    expect(document.body.textContent).toContain('abc123');
  });

  it('offers Try again, wired to reset()', () => {
    const reset = vi.fn();
    render(<AppError error={new Error('x')} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('offers a way back to the Dashboard', () => {
    render(<AppError error={new Error('x')} reset={() => {}} />);
    expect(screen.getByRole('link', { name: /Dashboard/ }).getAttribute('href')).toBe('/dashboard');
  });

  it('renders with no digest at all', () => {
    render(<AppError error={new Error('x')} reset={() => {}} />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The digest block is conditional on error.digest; with none supplied it must not render at
    // all, not just render an empty value.
    expect(screen.queryByText(/Reference/)).toBeNull();
  });
});

describe('the app not-found boundary (item W / UX-1)', () => {
  it('says the thing is gone and links back', () => {
    render(<NotFound />);
    expect(document.body.textContent).toContain('gone');
    expect(screen.getByRole('link', { name: /Dashboard/ }).getAttribute('href')).toBe('/dashboard');
  });
});
