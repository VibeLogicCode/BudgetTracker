// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ConnectionsClient } from '@/app/(app)/settings/connections/connections-client';
// Importing the real constant here is safe: this file runs under Vitest's Node test runner,
// never bundled for a browser, unlike connections-client.tsx itself (see the note there on
// why it takes autoSyncOptions as a plain-string prop instead of importing this constant).
import { AUTO_SYNC_INTERVALS } from '@/lib/simplefin/connection';

const AUTO_SYNC_OPTIONS = Object.entries(AUTO_SYNC_INTERVALS).map(([value, cfg]) => ({ value, label: cfg.label }));

vi.mock('@/app/(app)/settings/connections/actions', () => ({
  forgetConnectionAction: vi.fn(async () => ({ message: 'Connection removed. Bridge Chequing reverts to CSV import.' })),
  setSimplefinAutoSyncAction: vi.fn(async () => ({ message: 'Automatic sync is on: once a day.' })),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CONNECTION = { id: 1, claimedAt: '2026-08-15T00:00:00.000Z', lastSyncAt: null, requestsToday: 0, requestsDate: '2026-08-15', enabled: true };

describe('ConnectionsClient — forget connection warns about affected accounts (finding 1)', () => {
  it('lists every linked account name in the confirm dialog before forgetting', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const { getByText } = render(
      <ConnectionsClient
        connection={CONNECTION}
        links={[
          { simplefinAccountId: 'remote-1', accountId: 10, currency: 'CAD', lastBalanceCents: null, lastBalanceDate: null, syncFrom: null, firstSyncedAt: null },
          { simplefinAccountId: 'remote-2', accountId: 11, currency: 'CAD', lastBalanceCents: null, lastBalanceDate: null, syncFrom: null, firstSyncedAt: null },
        ]}
        accounts={[
          { id: 10, name: 'Bridge Chequing' },
          { id: 11, name: 'Bridge Savings' },
        ]}
        remainingRequests={20}
        dailyLimit={20}
      />,
    );

    fireEvent.click(getByText('Forget connection'));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = confirmSpy.mock.calls[0][0] as string;
    expect(message).toContain('Bridge Chequing');
    expect(message).toContain('Bridge Savings');
    expect(message).toMatch(/CSV import/i);
    confirmSpy.mockRestore();
  });

  it('surfaces the action error instead of reloading when the action is rejected', async () => {
    const forget = vi.mocked((await import('@/app/(app)/settings/connections/actions')).forgetConnectionAction);
    forget.mockResolvedValueOnce({ error: 'Cross-origin request rejected' });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { getByText, findByText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );
    fireEvent.click(getByText('Forget connection'));

    expect(await findByText('Cross-origin request rejected')).toBeTruthy();
    confirmSpy.mockRestore();
  });

  it('does not mention unlinking when nothing is linked', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const { getByText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );

    fireEvent.click(getByText('Forget connection'));

    const message = confirmSpy.mock.calls[0][0] as string;
    expect(message).not.toMatch(/CSV import/i);
    expect(message).toMatch(/fresh setup token/i);
    confirmSpy.mockRestore();
  });
});

describe('ConnectionsClient — a bridge error with zero accounts is a FAILED sync (m3, spec section 12)', () => {
  function stubSync(payload: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })),
    );
  }

  it('shows only the amber error box — no green "Nothing to import." next to it', async () => {
    stubSync({ accounts: [], errlist: ['Bank X needs re-authentication'], remainingRequests: 19, engineFailed: false });

    const { getByText, queryByText, findByText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );
    fireEvent.click(getByText('Sync now'));

    expect(await findByText('Bank X needs re-authentication')).toBeTruthy();
    await waitFor(() => expect(queryByText(/Nothing to import/)).toBeNull());
    // The green notice is the only thing suppressed; the bridge's own
    // request-budget line above it is static page content and stays.
    expect(queryByText(/of 20 requests left today\./)).toBeNull();
  });

  it('still reports the summary when at least one account did sync despite an errlist entry', async () => {
    stubSync({
      accounts: [{ accountName: 'Bridge Chequing', added: 2, duplicates: 0, skippedPending: 0, errors: 0, currencyWarning: null }],
      errlist: ['Bank Y is slow today'],
      remainingRequests: 19,
      engineFailed: false,
    });

    const { getByText, findByText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );
    fireEvent.click(getByText('Sync now'));

    expect(await findByText(/Bridge Chequing: 2 added/)).toBeTruthy();
    expect(getByText('Bank Y is slow today')).toBeTruthy();
  });

  it('says so when the rows landed but categorization failed (m2)', async () => {
    stubSync({
      accounts: [{ accountName: 'Bridge Chequing', added: 2, duplicates: 0, skippedPending: 0, errors: 0, currencyWarning: null }],
      errlist: [],
      remainingRequests: 19,
      engineFailed: true,
    });

    const { getByText, findByText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );
    fireEvent.click(getByText('Sync now'));

    expect(await findByText(/review queue/i)).toBeTruthy();
  });

  it('NEW-5 fix-round: says so when loan payment matching failed', async () => {
    stubSync({
      accounts: [{ accountName: 'Bridge Chequing', added: 2, duplicates: 0, skippedPending: 0, errors: 0, currencyWarning: null }],
      errlist: [],
      remainingRequests: 19,
      engineFailed: false,
      loanMatchFailed: true,
    });

    const { getByText, findByText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );
    fireEvent.click(getByText('Sync now'));

    expect(await findByText(/loan payment matching failed/i)).toBeTruthy();
  });
});

describe('ConnectionsClient — Task 8: Automatic sync select', () => {
  it('renders Off plus every interval from AUTO_SYNC_INTERVALS, defaulting to the current value', () => {
    const { getByLabelText } = render(
      <ConnectionsClient
        connection={CONNECTION}
        links={[]}
        accounts={[]}
        remainingRequests={20}
        dailyLimit={20}
        autoSync="daily"
        autoSyncOptions={AUTO_SYNC_OPTIONS}
      />,
    );
    const select = getByLabelText('Automatic sync') as HTMLSelectElement;
    expect(select.value).toBe('daily');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['off', '6h', '12h', 'daily', 'weekly']);
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Off',
      'Every 6 hours',
      'Every 12 hours',
      'Once a day',
      'Once a week',
    ]);
  });

  it('defaults to Off when no auto-sync is configured', () => {
    const { getByLabelText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );
    expect((getByLabelText('Automatic sync') as HTMLSelectElement).value).toBe('off');
  });

  it('shows the required copy about running on the server and notifying on failure', () => {
    const { getByText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );
    expect(getByText('Runs on the server while the app is up. If a sync fails you will be notified.')).toBeTruthy();
  });

  it('calls setSimplefinAutoSyncAction with the newly chosen value and reloads on success', async () => {
    const action = vi.mocked((await import('@/app/(app)/settings/connections/actions')).setSimplefinAutoSyncAction);
    action.mockClear();
    const reloadSpy = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload: reloadSpy });

    const { getByLabelText } = render(
      <ConnectionsClient
        connection={CONNECTION}
        links={[]}
        accounts={[]}
        remainingRequests={20}
        dailyLimit={20}
        autoSyncOptions={AUTO_SYNC_OPTIONS}
      />,
    );
    fireEvent.change(getByLabelText('Automatic sync'), { target: { value: 'weekly' } });

    await waitFor(() => expect(action).toHaveBeenCalledWith('weekly'));
    await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
  });

  it('surfaces an error from the action instead of reloading', async () => {
    const action = vi.mocked((await import('@/app/(app)/settings/connections/actions')).setSimplefinAutoSyncAction);
    action.mockResolvedValueOnce({ error: 'That is not a valid automatic sync interval.' });

    const { getByLabelText, findByText } = render(
      <ConnectionsClient
        connection={CONNECTION}
        links={[]}
        accounts={[]}
        remainingRequests={20}
        dailyLimit={20}
        autoSyncOptions={AUTO_SYNC_OPTIONS}
      />,
    );
    fireEvent.change(getByLabelText('Automatic sync'), { target: { value: 'weekly' } });

    expect(await findByText('That is not a valid automatic sync interval.')).toBeTruthy();
  });
});

/** v1.60.0 item 3a: while automatic sync is backing off after failures, the page says so, once. */
describe('ConnectionsClient — automatic sync backoff line', () => {
  it('says how many tries failed and roughly when the next one is', () => {
    const { getByText } = render(
      <ConnectionsClient
        connection={CONNECTION}
        links={[]}
        accounts={[]}
        remainingRequests={17}
        dailyLimit={20}
        autoSync="daily"
        autoSyncOptions={AUTO_SYNC_OPTIONS}
        autoSyncWaiting={{ failures: 3, nextTry: '14:30' }}
      />,
    );
    expect(getByText('Automatic sync is waiting after 3 failed tries. Next try about 14:30.')).toBeTruthy();
  });

  it('says try, not tries, after one failure', () => {
    const { getByText } = render(
      <ConnectionsClient
        connection={CONNECTION}
        links={[]}
        accounts={[]}
        remainingRequests={19}
        dailyLimit={20}
        autoSync="daily"
        autoSyncOptions={AUTO_SYNC_OPTIONS}
        autoSyncWaiting={{ failures: 1, nextTry: '09:05' }}
      />,
    );
    expect(getByText('Automatic sync is waiting after 1 failed try. Next try about 09:05.')).toBeTruthy();
  });

  it('shows nothing when automatic sync is not waiting', () => {
    const { queryByText } = render(
      <ConnectionsClient
        connection={CONNECTION}
        links={[]}
        accounts={[]}
        remainingRequests={20}
        dailyLimit={20}
        autoSync="daily"
        autoSyncOptions={AUTO_SYNC_OPTIONS}
      />,
    );
    expect(queryByText(/Automatic sync is waiting/)).toBeNull();
  });
});

/**
 * v1.61.0 item 3b. Link no longer posts straight away: it fetches the overlap and opens a confirm
 * panel in that remote account's row, with the counts, a start date and the warnings, before
 * anything is linked.
 */
describe('ConnectionsClient — choose the start date, then link', () => {
  const OVERLAP = {
    today: '2026-06-05',
    windowStart: '2026-03-08',
    rowsInWindow: 212,
    byOrigin: { manual: 14, csv: 198, ofx: 0, simplefin: 0 },
    newestImported: '2026-05-28',
    suggestedStart: '2026-05-29',
  };

  function stubBridge(currency = 'CAD') {
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (url === '/api/simplefin/accounts') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ accounts: [{ id: 'remote-1', name: 'Bridge Visa', currency, balance: '-120.00' }], errlist: [] }),
          };
        }
        const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
        posts.push(body);
        if (body.action === 'preview') return { ok: true, status: 200, json: async () => OVERLAP };
        return { ok: true, status: 200, json: async () => ({ links: [], csvDisabled: true, syncFrom: body.syncFrom, currencyWarning: null }) };
      }),
    );
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    return { posts, reload };
  }

  async function openPanel(currency = 'CAD') {
    const bridge = stubBridge(currency);
    const view = render(
      <ConnectionsClient
        connection={CONNECTION}
        links={[]}
        accounts={[{ id: 10, name: "Sam's Visa" }]}
        remainingRequests={20}
        dailyLimit={20}
      />,
    );
    fireEvent.click(view.getAllByText('List remote accounts')[0]!);
    fireEvent.click(await view.findByRole('button', { name: 'Link' }));
    await view.findByLabelText('First day to take from the bank');
    return { ...view, ...bridge };
  }

  it('shows the counts, the start date and both warnings before any link is posted', async () => {
    const view = await openPanel('USD');

    expect(view.posts).toEqual([{ action: 'preview', accountId: 10 }]);
    expect(
      view.getByText("Sam's Visa already holds 212 rows from the last 90 days (198 from a CSV statement, 14 added by hand)."),
    ).toBeTruthy();
    const date = view.getByLabelText('First day to take from the bank') as HTMLInputElement;
    expect(date.value).toBe('2026-05-29');
    expect(date.min).toBe('2026-03-08');
    expect(date.max).toBe('2026-06-05');
    expect(
      view.getByText(
        'Rows before this date stay with your statements. Rows added by hand after it are checked for duplicates. CSV import turns off for this account.',
      ),
    ).toBeTruthy();
    expect(view.getByText('This account reports USD; this app stores CAD cents with no conversion.')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Link from May 29' })).toBeTruthy();
  });

  it('shows no currency warning for a CAD account', async () => {
    const view = await openPanel('CAD');
    expect(view.queryByText(/stores CAD cents with no conversion/)).toBeNull();
  });

  it('Cancel closes the panel and posts nothing', async () => {
    const view = await openPanel();
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(view.queryByLabelText('First day to take from the bank')).toBeNull();
    expect(view.posts.filter((body) => body.action === 'link')).toEqual([]);
    expect(view.reload).not.toHaveBeenCalled();
  });

  it('confirming posts the chosen start date', async () => {
    const view = await openPanel();
    fireEvent.change(view.getByLabelText('First day to take from the bank'), { target: { value: '2026-05-20' } });
    fireEvent.click(view.getByRole('button', { name: 'Link from May 20' }));

    await waitFor(() => expect(view.reload).toHaveBeenCalled());
    expect(view.posts.filter((body) => body.action === 'link')).toEqual([
      { action: 'link', simplefinAccountId: 'remote-1', accountId: 10, currency: 'CAD', syncFrom: '2026-05-20' },
    ]);
  });

  it('an emptied date cannot be linked', async () => {
    const view = await openPanel();
    fireEvent.change(view.getByLabelText('First day to take from the bank'), { target: { value: '' } });
    const button = view.getByRole('button', { name: /^Link from/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('says so when the account holds nothing yet', async () => {
    stubBridge();
    const fetchMock = vi.mocked(globalThis.fetch);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? '{}'));
      if (body.action === 'preview') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...OVERLAP, rowsInWindow: 0, byOrigin: { manual: 0, csv: 0, ofx: 0, simplefin: 0 }, newestImported: null, suggestedStart: '2026-03-08' }),
        } as unknown as Response;
      }
      return base(url, init);
    });
    const view = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[{ id: 10, name: "Sam's Visa" }]} remainingRequests={20} dailyLimit={20} />,
    );
    fireEvent.click(view.getAllByText('List remote accounts')[0]!);
    fireEvent.click(await view.findByRole('button', { name: 'Link' }));
    expect(await view.findByText("Sam's Visa holds no rows from the last 90 days.")).toBeTruthy();
    expect(view.getByRole('button', { name: 'Link from Mar 8' })).toBeTruthy();
  });

  it('the linked list shows the start date of a link that has one', () => {
    const { getByText, queryAllByText } = render(
      <ConnectionsClient
        connection={CONNECTION}
        links={[
          { simplefinAccountId: 'remote-1', accountId: 10, currency: 'CAD', lastBalanceCents: null, lastBalanceDate: null, syncFrom: '2026-05-29', firstSyncedAt: null },
          { simplefinAccountId: 'remote-2', accountId: 11, currency: 'CAD', lastBalanceCents: null, lastBalanceDate: null, syncFrom: null, firstSyncedAt: null },
        ]}
        accounts={[
          { id: 10, name: "Sam's Visa" },
          { id: 11, name: 'Joint Chequing' },
        ]}
        remainingRequests={20}
        dailyLimit={20}
        today="2026-06-05"
      />,
    );
    expect(getByText(/from May 29/)).toBeTruthy();
    expect(queryAllByText(/· from /)).toHaveLength(1);
  });
});

/** v1.61.0 item 3d. The sync notice says how many possible duplicates it held for Needs review. */
describe('ConnectionsClient — held possible duplicates in the sync notice', () => {
  function stubSync(payload: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })),
    );
  }
  const account = { accountName: "Sam's Visa", added: 3, duplicates: 1, held: 2, setAside: 0, beforeStart: 0, skippedPending: 0, errors: 0, currencyWarning: null };

  it('names the count when the sync held some', async () => {
    stubSync({ accounts: [account], errlist: [], remainingRequests: 19, engineFailed: false, totalHeld: 2 });
    const { getByText, findByText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );
    fireEvent.click(getByText('Sync now'));
    expect(await findByText(/2 possible duplicates wait in Needs review\./)).toBeTruthy();
  });

  it('says waits for one', async () => {
    stubSync({ accounts: [{ ...account, held: 1 }], errlist: [], remainingRequests: 19, engineFailed: false, totalHeld: 1 });
    const { getByText, findByText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );
    fireEvent.click(getByText('Sync now'));
    expect(await findByText(/1 possible duplicate waits in Needs review\./)).toBeTruthy();
  });

  it('says nothing about duplicates when none were held', async () => {
    stubSync({ accounts: [{ ...account, held: 0 }], errlist: [], remainingRequests: 19, engineFailed: false, totalHeld: 0 });
    const { getByText, findByText, queryByText } = render(
      <ConnectionsClient connection={CONNECTION} links={[]} accounts={[]} remainingRequests={20} dailyLimit={20} />,
    );
    fireEvent.click(getByText('Sync now'));
    await findByText(/Sam's Visa: 3 added/);
    expect(queryByText(/possible duplicate/)).toBeNull();
  });
});
