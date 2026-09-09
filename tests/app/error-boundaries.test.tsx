// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AppError from '@/app/(app)/error';
import NotFound from '@/app/(app)/not-found';
import { RESTART_NOTICE_KEY, RESTART_NOTICE_MAX_AGE_MS } from '@/lib/update/restart-notice';
import { APP_VERSION } from '@/lib/version';

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
/**
 * v1.32.0 (UP-2). The screen the owner's recording caught: Update now, Watchtower kills the
 * container, and this boundary tells a household that just authorised a restart that "the app
 * could not finish loading this screen... this usually clears on its own". The other screen in
 * that recording is the browser's own ERR_CONNECTION_RESET page, which belongs to Chrome and is
 * not touched here or claimed to be.
 *
 * The read half. tests/app/updates-card.test.tsx covers which apply outcomes arm the entry, and
 * tests/lib/update/restart-notice.test.ts covers the rules in between. What these pin is the
 * one property that matters most: a stale entry must NEVER swallow a real crash message.
 */
describe('UP-2: a planned restart is not reported as a crash', () => {
  const CRASH = 'The app could not finish loading this screen';

  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  /** Written directly rather than through markRestartExpected, so the age is exact. */
  function arm(version: string, ageMs: number): void {
    window.localStorage.setItem(
      RESTART_NOTICE_KEY,
      JSON.stringify({ version, at: Date.now() - ageMs }),
    );
  }

  it('names the version being installed and offers the reload the copy asks for', () => {
    arm('99.0.0', 30_000);
    render(<AppError error={new Error('Failed to fetch')} reset={() => {}} />);

    expect(screen.getByRole('heading').textContent).toBe('Installing v99.0.0 — the app is restarting');
    expect(document.body.textContent).not.toContain(CRASH);
    expect(document.body.textContent).toContain('this screen is that gap, not a fault');
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
    // The crash screen's controls are gone: "Try again" re-runs a render against a container
    // that is not there, and a link to the Dashboard is a second dead end during a restart.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('still shows the digest when there is one -- it carries none of the message and is the only support string', () => {
    arm('99.0.0', 30_000);
    render(<AppError error={Object.assign(new Error('x'), { digest: 'abc123' })} reset={() => {}} />);
    expect(document.body.textContent).toContain('abc123');
  });

  it('an entry older than the window shows the REAL error -- yesterday’s update does not explain today’s fault', () => {
    arm('99.0.0', RESTART_NOTICE_MAX_AGE_MS + 60_000);
    render(<AppError error={new Error('SQLITE_BUSY: database is locked')} reset={() => {}} />);

    expect(screen.getByRole('heading').textContent).toContain('Something went wrong');
    expect(document.body.textContent).toContain(CRASH);
    expect(document.body.textContent).not.toContain('is restarting');
    // Spent, so it cannot be reconsidered on the next error.
    expect(window.localStorage.getItem(RESTART_NOTICE_KEY)).toBeNull();
  });

  it('an entry naming the version this bundle already IS means the restart landed', () => {
    arm(APP_VERSION, 30_000);
    render(<AppError error={new Error('x')} reset={() => {}} />);

    expect(screen.getByRole('heading').textContent).toContain('Something went wrong');
    expect(window.localStorage.getItem(RESTART_NOTICE_KEY)).toBeNull();
  });

  it('junk in localStorage is refused, not rendered', () => {
    window.localStorage.setItem(RESTART_NOTICE_KEY, '{"version":"<img src=x>","at":0}');
    render(<AppError error={new Error('x')} reset={() => {}} />);

    expect(screen.getByRole('heading').textContent).toContain('Something went wrong');
    expect(document.body.textContent).not.toContain('<img');
  });

  it('storage that throws leaves the ordinary crash screen intact', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('The operation is insecure.');
    });
    render(<AppError error={new Error('x')} reset={() => {}} />);

    expect(document.body.textContent).toContain(CRASH);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('MUST-9.9: the restart screen sets no timer and polls nothing', () => {
    arm('99.0.0', 30_000);
    const interval = vi.spyOn(globalThis, 'setInterval');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''));

    render(<AppError error={new Error('x')} reset={() => {}} />);

    // The container this page would have to ask is the one being replaced. It waits for a
    // person to reload, and that is the whole mechanism.
    expect(screen.getByRole('heading').textContent).toContain('is restarting');
    expect(interval).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // setTimeout is deliberately NOT asserted: React's own scheduler takes one during render
    // (verified -- `setTimeout(fn, 1)`), so a spy on it would fail for a reason that has nothing
    // to do with this component and would have to be neutered into a guard that cannot fail.
    // setInterval and fetch are the two a poll actually needs.
  });
});
