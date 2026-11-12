// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PossibleDuplicatesCard } from '@/components/PossibleDuplicatesCard';
import { dismissPossibleDuplicateAction, keepPossibleDuplicateAction } from '@/app/(app)/transactions/actions';
import type { WaitingSetAsideRow } from '@/lib/import/set-aside';

vi.mock('@/app/(app)/transactions/actions', () => ({
  keepPossibleDuplicateAction: vi.fn(async () => ({})),
  dismissPossibleDuplicateAction: vi.fn(async () => ({})),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(keepPossibleDuplicateAction).mockClear();
  vi.mocked(dismissPossibleDuplicateAction).mockClear();
});

const ALEX = 11;
const SAM = 12;

function held(over: Partial<WaitingSetAsideRow> = {}): WaitingSetAsideRow {
  return {
    id: 5,
    accountId: 1,
    accountName: 'Joint chequing',
    origin: 'simplefin',
    importId: 3,
    importFilename: 'simplefin 2026-03-10 09:15',
    date: '2026-03-10',
    amountCents: -4217,
    rawDescription: 'MAPLE GROCER #12',
    attributedUserId: ALEX,
    personName: 'Alex',
    reason: 'possible_duplicate',
    createdAt: '2026-03-10T13:15:00.000Z',
    candidate: {
      id: 40,
      date: '2026-03-09',
      description: 'MAPLE GROCER',
      amountCents: -4217,
      origin: 'manual',
      personName: 'Alex',
    },
    ...over,
  };
}

describe('PossibleDuplicatesCard', () => {
  it('shows the held copy beside the row it may duplicate, with both choices', () => {
    render(<PossibleDuplicatesCard rows={[held()]} today="2026-03-12" viewerId={ALEX} isAdmin />);
    const item = screen.getByRole('listitem');
    expect(item.textContent).toContain('MAPLE GROCER #12');
    expect(item.textContent).toContain('Mar 10');
    expect(item.textContent).toContain('Joint chequing');
    expect(item.textContent).toContain('from SimpleFIN');
    expect(item.textContent).toContain('simplefin 2026-03-10 09:15');
    expect(within(item).getByText('Possible duplicate')).toBeTruthy();
    expect(item.textContent).toContain('Looks like: MAPLE GROCER -42.17 on Mar 9, added by hand, Alex');
    expect(within(item).getByRole('button', { name: /^Keep both/ })).toBeTruthy();
    expect(within(item).getByRole('button', { name: /^Delete this one/ })).toBeTruthy();
    expect(item.textContent).toContain("To keep the bank's copy instead, choose Keep both, then delete the hand-typed row.");
  });

  it('says so when the row it matched has since been deleted', () => {
    render(<PossibleDuplicatesCard rows={[held({ candidate: null })]} today="2026-03-12" viewerId={ALEX} isAdmin />);
    const item = screen.getByRole('listitem');
    expect(item.textContent).toContain('The matching row was deleted');
    expect(item.textContent).not.toContain('Looks like');
    expect(item.textContent).not.toContain('hand-typed row');
  });

  it('names an imported match by its road, and offers no hand-typed advice for it', () => {
    render(
      <PossibleDuplicatesCard
        rows={[held({ candidate: { id: 41, date: '2026-03-09', description: 'MAPLE GROCER', amountCents: -4217, origin: 'csv', personName: null } })]}
        today="2026-03-12"
        viewerId={ALEX}
        isAdmin
      />,
    );
    const item = screen.getByRole('listitem');
    expect(item.textContent).toContain('Looks like: MAPLE GROCER -42.17 on Mar 9, from a CSV statement');
    expect(item.textContent).not.toContain('hand-typed row');
  });

  it('Keep both posts the held row id', async () => {
    render(<PossibleDuplicatesCard rows={[held()]} today="2026-03-12" viewerId={ALEX} isAdmin />);
    fireEvent.click(screen.getByRole('button', { name: /^Keep both/ }));
    await waitFor(() => expect(keepPossibleDuplicateAction).toHaveBeenCalled());
    const formData = vi.mocked(keepPossibleDuplicateAction).mock.calls[0]?.[1] as FormData;
    expect(formData.get('setAsideId')).toBe('5');
  });

  it('Delete this one asks first, and a refusal posts nothing', () => {
    const asked = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<PossibleDuplicatesCard rows={[held()]} today="2026-03-12" viewerId={ALEX} isAdmin />);
    fireEvent.click(screen.getByRole('button', { name: /^Delete this one/ }));
    expect(asked).toHaveBeenCalledWith(expect.stringMatching(/leave it out/i));
    expect(dismissPossibleDuplicateAction).not.toHaveBeenCalled();
  });

  it('Delete this one posts the held row id once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PossibleDuplicatesCard rows={[held()]} today="2026-03-12" viewerId={ALEX} isAdmin />);
    fireEvent.click(screen.getByRole('button', { name: /^Delete this one/ }));
    await waitFor(() => expect(dismissPossibleDuplicateAction).toHaveBeenCalled());
    const formData = vi.mocked(dismissPossibleDuplicateAction).mock.calls[0]?.[1] as FormData;
    expect(formData.get('setAsideId')).toBe('5');
  });

  it("offers Delete this one to the row's person and on a shared row, but not to another member", () => {
    render(<PossibleDuplicatesCard rows={[held()]} today="2026-03-12" viewerId={SAM} isAdmin={false} />);
    expect(screen.getByRole('button', { name: /^Keep both/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Delete this one/ })).toBeNull();
    cleanup();

    render(<PossibleDuplicatesCard rows={[held()]} today="2026-03-12" viewerId={ALEX} isAdmin={false} />);
    expect(screen.getByRole('button', { name: /^Delete this one/ })).toBeTruthy();
    cleanup();

    render(<PossibleDuplicatesCard rows={[held({ attributedUserId: null, personName: null })]} today="2026-03-12" viewerId={SAM} isAdmin={false} />);
    expect(screen.getByRole('button', { name: /^Delete this one/ })).toBeTruthy();
  });

  /** Fix round: every row has the same two buttons, so each names the row it acts on. */
  it('names the row in each button, so the buttons make sense read on their own', () => {
    render(
      <PossibleDuplicatesCard
        rows={[held(), held({ id: 6, rawDescription: 'CORNER COFFEE', amountCents: -450, date: '2026-03-11' })]}
        today="2026-03-12"
        viewerId={ALEX}
        isAdmin
      />,
    );
    expect(screen.getByRole('button', { name: 'Keep both: MAPLE GROCER #12 on Mar 10' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete this one: MAPLE GROCER #12 on Mar 10' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep both: CORNER COFFEE on Mar 11' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete this one: CORNER COFFEE on Mar 11' })).toBeTruthy();
  });

  it('shows and announces what Keep both did, in a live region already on the page', async () => {
    vi.mocked(keepPossibleDuplicateAction).mockResolvedValueOnce({ message: 'Kept both rows.' });
    render(<PossibleDuplicatesCard rows={[held()]} today="2026-03-12" viewerId={ALEX} isAdmin />);
    const live = screen.getByRole('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /^Keep both/ }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Kept both rows.'));
  });

  it('keeps the message once the row has left the list', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(dismissPossibleDuplicateAction).mockResolvedValueOnce({ message: 'Deleted the possible duplicate.' });
    const { rerender } = render(<PossibleDuplicatesCard rows={[held()]} today="2026-03-12" viewerId={ALEX} isAdmin />);
    fireEvent.click(screen.getByRole('button', { name: /^Delete this one/ }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Deleted the possible duplicate.'));
    // The page revalidates and the row is gone; the card's region and its message stay.
    rerender(<PossibleDuplicatesCard rows={[]} today="2026-03-12" viewerId={ALEX} isAdmin />);
    expect(screen.getByRole('status').textContent).toBe('Deleted the possible duplicate.');
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('renders nothing when nothing waits, and an empty state on its own view', () => {
    const { container } = render(<PossibleDuplicatesCard rows={[]} today="2026-03-12" viewerId={ALEX} isAdmin />);
    expect(container.textContent).toBe('');
    cleanup();

    render(<PossibleDuplicatesCard rows={[]} today="2026-03-12" viewerId={ALEX} isAdmin standalone />);
    expect(screen.getByText('No possible duplicates are waiting.')).toBeTruthy();
  });
});
