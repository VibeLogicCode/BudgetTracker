// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ImportClient } from '@/app/(app)/import/import-client';
import { getBuiltinPreset } from '@/lib/import/presets';
import type { ImportHistoryRow } from '@/lib/import/commit';

// Card assignments (spec 2026-08-22 v1.6.0, MUST-6.1/6.2) save through a real Next.js server
// action, not a fetch call -- mock it the same way tests/app/accounts-manager.test.tsx mocks
// its own actions module, since a real 'use server' function touches next/headers and the DB.
vi.mock('@/app/(app)/import/actions', () => ({
  setCardPersonAction: vi.fn(async () => ({ message: 'Saved.' })),
  // Lane 5 (2026-08-30 savings-targets plan): mocked the same way setCardPersonAction is above,
  // since the real action touches next/headers and the DB. Default resolves like a successful
  // save; individual tests below override with mockResolvedValueOnce for the message/error cases.
  saveMappingAction: vi.fn(async () => ({ message: 'Saved.' })),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TD_CHEQUING = getBuiltinPreset('TD Chequing/Debit');
const TD_VISA = getBuiltinPreset('TD Visa');

const PROFILES = [
  { id: 1, name: 'TD Chequing/Debit', isBuiltin: true, mapping: TD_CHEQUING },
  { id: 2, name: 'TD Visa', isBuiltin: true, mapping: TD_VISA },
];

describe('ImportClient — the profile follows the account (I4)', () => {
  it('switches to the account\'s remembered profile when the account changes', () => {
    const { getByLabelText } = render(
      <ImportClient
        accounts={[
          { id: 10, name: 'Joint Chequing', importProfileId: 1 },
          { id: 11, name: 'Joint Visa', importProfileId: 2 },
        ]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );

    const accountSelect = getByLabelText(/Account/) as HTMLSelectElement;
    const profileSelect = getByLabelText(/Import profile/) as HTMLSelectElement;
    expect(profileSelect.value).toBe('1');

    fireEvent.change(accountSelect, { target: { value: '11' } });

    expect(accountSelect.value).toBe('11');
    expect(profileSelect.value).toBe('2');
  });

  it('falls back to the first profile for an account that has never been imported into, instead of keeping the previous account\'s', () => {
    const { getByLabelText } = render(
      <ImportClient
        accounts={[
          { id: 10, name: 'Joint Visa', importProfileId: 2 },
          { id: 11, name: 'Brand New Account', importProfileId: null },
        ]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );

    const accountSelect = getByLabelText(/Account/) as HTMLSelectElement;
    const profileSelect = getByLabelText(/Import profile/) as HTMLSelectElement;
    expect(profileSelect.value).toBe('2');

    fireEvent.change(accountSelect, { target: { value: '11' } });

    expect(profileSelect.value).toBe('1');
  });
});

describe('ImportClient — a pin that is not among the offered profiles behaves like unpinned (MUST-5.2)', () => {
  // page.tsx only ever offers active+readable profiles (Task 4). An account can still be
  // pinned (accounts.importProfileId) to a profile that has since been deactivated or gone
  // unreadable -- that id is real, but it has no matching <option> in `profiles` here.
  //
  // A plain assertion on the <select>'s DOM .value is not a faithful test of this bug: an
  // HTML <select> whose controlled `value` prop matches no <option> falls back, natively, to
  // showing the FIRST option selected -- which happens to equal what MUST-5.2 wants anyway,
  // so that assertion would pass even completely unfixed. What actually goes wrong is the
  // REACT STATE backing the control: `upload()` posts `String(profileId)` in the request body
  // regardless of what the <select> visually shows, so these tests submit the preview form and
  // inspect the real FormData sent to /api/import/preview.
  function profileIdSubmittedTo(fetchMock: ReturnType<typeof vi.fn>): string | null {
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    return body.get('profileId') as string | null;
  }

  it('posts the first offered profile on initial mount, not the stale pin, when the account is pinned to a profile not in the offered list', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => previewBody({ profileId: PROFILES[0].id }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 99 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );

    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(profileIdSubmittedTo(fetchMock)).toBe(String(PROFILES[0].id));
  });

  it('posts the first offered profile when switching TO an account pinned to a profile not in the offered list', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => previewBody({ profileId: PROFILES[0].id }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { container, getByLabelText } = render(
      <ImportClient
        accounts={[
          { id: 10, name: 'Joint Chequing', importProfileId: 1 },
          { id: 11, name: 'Deactivated Pin', importProfileId: 99 },
        ]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );

    fireEvent.change(getByLabelText(/Account/) as HTMLSelectElement, { target: { value: '11' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(profileIdSubmittedTo(fetchMock)).toBe(String(PROFILES[0].id));
  });

  it('still honors the pin when it IS among the offered profiles, even when it is not profiles[0]', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => previewBody({ profileId: PROFILES[1].id }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Visa', importProfileId: PROFILES[1].id }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );

    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(profileIdSubmittedTo(fetchMock)).toBe(String(PROFILES[1].id));
  });
});

describe('ImportClient — zero CSV accounts (C1c / I5)', () => {
  it('explains what to do and disables the upload instead of offering a broken form', () => {
    const { getByText, queryByLabelText, getByLabelText } = render(
      <ImportClient accounts={[]} profiles={PROFILES} history={[]} simplefinManaged={[]} />,
    );

    expect(getByText(/No accounts to import into yet/i)).toBeTruthy();
    const link = getByText('Add a bank account') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/settings/accounts');
    // No account picker to submit a zero id from — that raw zod 400 is gone.
    expect(queryByLabelText(/Import profile/)).toBeNull();
    expect((getByLabelText('Upload a CSV') as HTMLInputElement).disabled).toBe(true);
    expect((getByText('Preview') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says why when every account is SimpleFIN-managed rather than repeating the generic message', () => {
    const { getByText } = render(
      <ImportClient accounts={[]} profiles={PROFILES} history={[]} simplefinManaged={['Bridge Chequing']} />,
    );
    expect(getByText(/Every account you have is synced from SimpleFIN/i)).toBeTruthy();
  });

  it('renders the normal upload form as soon as one account exists', () => {
    const { getByLabelText, queryByText } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    expect(queryByText(/No accounts to import into yet/i)).toBeNull();
    expect(getByLabelText(/Account/)).toBeTruthy();
  });
});

// F2 (post-1.6.0 review follow-up): every mapping deactivated (or a fresh DB where the
// built-in presets never got seeded) leaves `profiles` empty even though `accounts` is not.
// Unlike the zero-accounts case above, this had NO empty state at all — an empty <select>
// plus a live Preview button that posted profileId=0 and surfaced the raw zod string "Number
// must be greater than 0". These assertions follow the exact shape of the zero-accounts
// block: rendered text (not a submitted-value guess) and the actual `disabled` property on
// the real button element, which a bad fix (e.g. a disabled-looking style with no `disabled`
// attribute) would not satisfy.
describe('ImportClient — F2: zero active/readable mappings is a dead end without this', () => {
  it('explains what to do and disables the upload instead of offering a submittable empty form', () => {
    const { getByText, queryByLabelText, getByLabelText } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: null }]}
        profiles={[]}
        history={[]}
        simplefinManaged={[]}
      />,
    );

    expect(queryByLabelText(/Import profile/)).toBeNull();
    const link = getByText(/Settings → Managers/i) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/settings/managers');
    expect((getByLabelText('Upload a CSV') as HTMLInputElement).disabled).toBe(true);
    expect((getByText('Preview') as HTMLButtonElement).disabled).toBe(true);
  });

  it('still renders the normal upload form when at least one mapping is offered', () => {
    const { getByLabelText, container } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    expect(getByLabelText(/Import profile/)).toBeTruthy();
    expect((container.querySelector('input[name="file"]') as HTMLInputElement).disabled).toBe(false);
  });
});

const HISTORY: ImportHistoryRow[] = [
  {
    id: 77,
    accountId: 10,
    accountName: 'Joint Chequing',
    profileId: 1,
    filename: 'march.csv',
    importedBy: 1,
    importedByName: 'Alice',
    rowsAdded: 12,
    rowsDuplicate: 0,
    rowsError: 0,
    createdAt: '2026-03-10T09:00:00.000Z',
  },
];

function previewBody(over: Record<string, unknown> = {}) {
  return {
    stagingId: 'stg-1',
    filename: 'march.csv',
    accountId: 10,
    profileId: 1,
    encoding: 'utf-8',
    mapping: TD_CHEQUING,
    rows: [],
    errors: [],
    totalRows: 5,
    duplicateCount: 0,
    errorCount: 0,
    skipped: 0,
    truncated: false,
    // Item BP: every real preview carries this now, and import-client.tsx uses it to decide
    // whether to render the CSV mapping editor -- so a fixture that omits it would silently
    // hide the editor from every test in this file that doesn't pass its own override.
    source: 'csv',
    ...over,
  };
}

describe('ImportClient — polish item 9: rows the profile silently skipped', () => {
  async function renderPreview(skipped: number) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => previewBody({ skipped }) })),
    );
    const view = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(view.container.querySelector('form')!);
    await waitFor(() => expect(view.container.textContent).toContain('Preview —'));
    return view;
  }

  it('reports the skipped count when the profile dropped rows', async () => {
    const { container } = await renderPreview(3);
    // Without this, a mis-typed skip rule that swallowed half the file looked
    // exactly like a short file.
    expect(container.textContent).toContain('3 skipped by profile rules');
  });

  it('says nothing at all when nothing was skipped', async () => {
    const { container } = await renderPreview(0);
    expect(container.textContent).not.toContain('skipped by profile rules');
  });
});

describe('ImportClient — polish item 8: the undo button is busy-guarded', () => {
  it('disables Undo while the lookup request is in flight', async () => {
    const pending: { release?: (value: unknown) => void } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            pending.release = resolve;
          }),
      ),
    );

    const { getByText } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={HISTORY}
        simplefinManaged={[]}
      />,
    );

    const undo = getByText('Undo') as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    // A second click here used to fire the whole delete sequence again.
    await waitFor(() => expect(undo.disabled).toBe(true));

    pending.release?.({ ok: false, json: async () => ({ error: 'nope' }) });
    await waitFor(() => expect(undo.disabled).toBe(false));
  });
});

describe('ImportClient — undo reports every table it touched (item AE / MON-5 follow-up)', () => {
  it('appends the balance-figure count to the undo summary when snapshots were removed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        // lookup call
        .mockImplementationOnce(async () => ({ ok: true, json: async () => ({ importId: 77, willDelete: 3, willKeep: 1 }) }))
        // confirmed undo call
        .mockImplementationOnce(async () => ({
          ok: true,
          json: async () => ({ deleted: 3, kept: 1, loanLinksReversed: 0, snapshotsDeleted: 2 }),
        })),
    );

    const { getByText } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={HISTORY}
        simplefinManaged={[]}
      />,
    );

    fireEvent.click(getByText('Undo'));

    await waitFor(() => expect(getByText(/Undo complete/)).toBeTruthy());
    expect(getByText(/3 deleted, 1 kept, and 2 balance figures removed\./)).toBeTruthy();
  });

  it('says nothing extra when no snapshot was removed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(async () => ({ ok: true, json: async () => ({ importId: 77, willDelete: 3, willKeep: 1 }) }))
        .mockImplementationOnce(async () => ({
          ok: true,
          json: async () => ({ deleted: 3, kept: 1, loanLinksReversed: 0, snapshotsDeleted: 0 }),
        })),
    );

    const { getByText, queryByText } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={HISTORY}
        simplefinManaged={[]}
      />,
    );

    fireEvent.click(getByText('Undo'));

    await waitFor(() => expect(getByText(/Undo complete: 3 deleted, 1 kept\./)).toBeTruthy());
    expect(queryByText(/balance figure/)).toBeNull();
  });
});

describe('ImportClient — the Preview and Import buttons are busy-guarded', () => {
  it('disables Preview for as long as the upload is in flight (useFormStatus, not a local flag)', async () => {
    const pending: { release?: (value: unknown) => void } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            pending.release = resolve;
          }),
      ),
    );

    const { container, getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    const preview = () => getByRole('button', { name: /preview|working/i }) as HTMLButtonElement;
    expect(preview().disabled).toBe(false);

    fireEvent.submit(container.querySelector('form')!);
    // This is a form action: a local `busy` flag set inside it does not render until the
    // action settles, so the old guard left the button clickable for the whole upload.
    await waitFor(() => expect(preview().disabled).toBe(true));

    pending.release?.({ ok: false, json: async () => ({ error: 'nope' }) });
    await waitFor(() => expect(preview().disabled).toBe(false));
  });

  it('disables Import while the commit is in flight, and releases it when the commit fails', async () => {
    const calls: { release?: (value: unknown) => void } = {};
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        // first call: the preview upload, which resolves immediately
        .mockImplementationOnce(async () => ({ ok: true, json: async () => previewBody({ totalRows: 4 }) }))
        // second call: the commit, held open
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              calls.release = resolve;
            }),
        ),
    );

    const { container, getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));

    const importButton = () => getByRole('button', { name: /^Import \d+ transactions$/ }) as HTMLButtonElement;
    expect(importButton().disabled).toBe(false);

    fireEvent.click(importButton());
    await waitFor(() => expect(importButton().disabled).toBe(true));

    // Released in a finally, so a failed commit does not strand the button forever.
    calls.release?.({ ok: false, json: async () => ({ error: 'commit exploded' }) });
    await waitFor(() => expect(importButton().disabled).toBe(false));
    expect(container.textContent).toContain('commit exploded');
  });
});

describe('ImportClient — release review finding C: a failed re-preview must not leave commit() pointed at an unproven mapping', () => {
  it('rolls the mapping back to the last successfully previewed one when re-preview fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        // first call: the initial upload/preview, succeeds with TD_CHEQUING (hasHeader: false)
        .mockImplementationOnce(async () => ({ ok: true, json: async () => previewBody({ totalRows: 4 }) }))
        // second call: the re-preview fired by toggling "Has header" below, fails
        .mockImplementationOnce(async () => ({ ok: false, json: async () => ({ error: 'preview exploded' }) })),
    );

    const { container, getByLabelText, getByText } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));

    const hasHeader = getByLabelText(/Has header/i) as HTMLInputElement;
    expect(hasHeader.checked).toBe(false); // TD Chequing/Debit's mapping.hasHeader is false

    fireEvent.click(hasHeader); // flips to true and fires the failing re-preview
    await waitFor(() => expect(getByText(/preview exploded/i)).toBeTruthy());

    // Rolled back: the checkbox reflects the mapping that last actually previewed
    // successfully, not the one the failed request was for — so a subsequent commit()
    // (which posts this same `mapping` state) cannot use a mapping this file was never
    // shown to parse against.
    expect(hasHeader.checked).toBe(false);
  });

  it('disables the date-format one-click button while an unrelated field\'s re-preview is in flight, so it cannot fire a second overlapping request', async () => {
    // The button itself always vanishes the instant it is clicked (the optimistic mapping
    // update makes mapping.dateFormat one of the detector's candidates, which is exactly
    // the "nothing left to suggest" state) — so the double-fire this guards against is not
    // a second click on itself, it's a click on this button while busy is already true for
    // some OTHER field's in-flight re-preview.
    const pending: { release?: (value: unknown) => void } = {};
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(async () => ({
          ok: true,
          json: async () => previewBody({
            totalRows: 4,
            dateFormatDetection: { status: 'unique', detected: 'MM/DD/YYYY', candidates: ['MM/DD/YYYY'] },
          }),
        }))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              pending.release = resolve;
            }),
        ),
    );

    const { container, getByRole, getByLabelText } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));

    const useButton = () => getByRole('button', { name: /use mm\/dd\/yyyy/i }) as HTMLButtonElement;
    expect(useButton().disabled).toBe(false);

    fireEvent.click(getByLabelText(/Has header/i)); // an unrelated field, fires its own re-preview
    await waitFor(() => expect(useButton().disabled).toBe(true));

    pending.release?.({ ok: false, json: async () => ({ error: 'nope' }) });
    await waitFor(() => expect(useButton().disabled).toBe(false));
  });
});

describe('ImportClient — NEW-5 fix-round: loanMatchFailed gets the same honest note as engineFailed', () => {
  it('appends a loan-matching note to the summary without hiding the row counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(async () => ({ ok: true, json: async () => previewBody({ totalRows: 4 }) }))
        .mockImplementationOnce(async () => ({
          ok: true,
          json: async () => ({ rowsAdded: 4, rowsDuplicate: 0, rowsError: 0, needsReview: 1, engineFailed: false, loanMatchFailed: true }),
        })),
    );

    const { container, getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));
    fireEvent.click(getByRole('button', { name: /^Import \d+ transactions$/ }));

    await waitFor(() => expect(container.textContent).toMatch(/loan payment matching failed/i));
    expect(container.textContent).toContain('4 added');
  });
});

// Carry 2 of Task 6 (spec 2026-08-22 v1.6.0): CommitFlowResult.attributionSummary already
// reaches the /api/import/commit JSON body (Task 3) -- this is the display half.
describe('ImportClient — Carry 2: the post-commit message shows the attribution split', () => {
  it('appends attributionSummary to the success message, following the loanMatchFailed append pattern', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(async () => ({ ok: true, json: async () => previewBody({ totalRows: 7 }) }))
        .mockImplementationOnce(async () => ({
          ok: true,
          json: async () => ({
            rowsAdded: 7,
            rowsDuplicate: 0,
            rowsError: 0,
            needsReview: 7,
            engineFailed: false,
            loanMatchFailed: false,
            attributionSummary: '3 rows to Alex, 2 rows to Sam, 2 rows to the account owner (no card match)',
          }),
        })),
    );

    const { container, getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));
    fireEvent.click(getByRole('button', { name: /^Import \d+ transactions$/ }));

    await waitFor(() => expect(container.textContent).toContain('3 rows to Alex, 2 rows to Sam'));
    expect(container.textContent).toContain('7 added');
  });

  it('says nothing extra when attributionSummary is null (no cardCol on this mapping)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(async () => ({ ok: true, json: async () => previewBody({ totalRows: 4 }) }))
        .mockImplementationOnce(async () => ({
          ok: true,
          json: async () => ({ rowsAdded: 4, rowsDuplicate: 0, rowsError: 0, needsReview: 1, engineFailed: false, loanMatchFailed: false, attributionSummary: null }),
        })),
    );

    const { container, getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));
    fireEvent.click(getByRole('button', { name: /^Import \d+ transactions$/ }));

    await waitFor(() => expect(container.textContent).toContain('4 added'));
    expect(container.textContent).not.toContain('rows to');
  });
});

// v1.26.0 Lane 3b. The post-commit OFFER to inspect what rules did on THIS import -- the
// owner's own objection was "i still need to confirm or deny no? i dont just want to auto
// apply rules and never see what happened on my import." rulesApplied and importId already
// reach the /api/import/commit JSON body (CommitFlowResult, src/lib/import/flow.ts); this is
// the display half.
describe('ImportClient — Lane 3b: the post-commit offer to check what rules did', () => {
  it('offers the audit link, to the exact contract URL, only when rulesApplied > 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(async () => ({ ok: true, json: async () => previewBody({ totalRows: 4 }) }))
        .mockImplementationOnce(async () => ({
          ok: true,
          json: async () => ({
            importId: 77,
            rowsAdded: 4,
            rowsDuplicate: 0,
            rowsError: 0,
            needsReview: 1,
            engineFailed: false,
            loanMatchFailed: false,
            rulesApplied: 3,
          }),
        })),
    );

    const { container, getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));
    fireEvent.click(getByRole('button', { name: /^Import \d+ transactions$/ }));

    await waitFor(() => expect(container.textContent).toContain('3 transactions were categorized by rules.'));
    const link = getByRole('link', { name: /check them/i });
    // The fixed contract URL (v1.26.0 Lane 3a/3b) -- never a param this lane invents.
    expect(link.getAttribute('href')).toBe('/transactions?import=77&source=rule&group=category');
  });

  it('says nothing about rules when rulesApplied is 0 -- nothing to audit, no dead-end offer', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(async () => ({ ok: true, json: async () => previewBody({ totalRows: 4 }) }))
        .mockImplementationOnce(async () => ({
          ok: true,
          json: async () => ({
            importId: 78,
            rowsAdded: 4,
            rowsDuplicate: 0,
            rowsError: 0,
            needsReview: 1,
            engineFailed: false,
            loanMatchFailed: false,
            rulesApplied: 0,
          }),
        })),
    );

    const { container, getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));
    fireEvent.click(getByRole('button', { name: /^Import \d+ transactions$/ }));

    await waitFor(() => expect(container.textContent).toContain('4 added'));
    expect(container.textContent).not.toContain('categorized by rules');
  });

  it('is an offer, not a gate: the row-count summary and its review-queue link render exactly as before, offer or not', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(async () => ({ ok: true, json: async () => previewBody({ totalRows: 4 }) }))
        .mockImplementationOnce(async () => ({
          ok: true,
          json: async () => ({
            importId: 79,
            rowsAdded: 4,
            rowsDuplicate: 0,
            rowsError: 0,
            needsReview: 1,
            engineFailed: false,
            loanMatchFailed: false,
            rulesApplied: 2,
          }),
        })),
    );

    const { container, getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));
    fireEvent.click(getByRole('button', { name: /^Import \d+ transactions$/ }));

    await waitFor(() => expect(container.textContent).toContain('4 added, 0 duplicates skipped, 0 errors, 1 need review.'));
    expect(getByRole('link', { name: /go to the review queue/i })).toBeTruthy();
  });
});

// F-03 (v1.31.0): "did I miss a statement?" -- CommitFlowResult.discrepancy (src/lib/import/
// flow.ts) reaches this screen's post-commit summary, following the same append pattern
// loanMatchFailed/attributionSummary already use above. The controlling rule under test is
// silence, not reassurance: discrepancy null must never render anything, for either of the two
// different reasons it can be null (see flow.ts's own doc comment on the field).
describe('ImportClient — F-03: the post-commit balance check', () => {
  it('appends the reconciliation sentence to the summary when the newest statement disagreed', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(async () => ({ ok: true, json: async () => previewBody({ totalRows: 4 }) }))
        .mockImplementationOnce(async () => ({
          ok: true,
          json: async () => ({
            rowsAdded: 4,
            rowsDuplicate: 0,
            rowsError: 0,
            needsReview: 1,
            engineFailed: false,
            loanMatchFailed: false,
            discrepancy: {
              accountId: 10,
              fromDate: '2026-07-01',
              toDate: '2026-07-20',
              expectedCents: 80000,
              impliedCents: 85000,
              deltaCents: 5000,
            },
          }),
        })),
    );

    const { container, getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));
    fireEvent.click(getByRole('button', { name: /^Import \d+ transactions$/ }));

    await waitFor(() => expect(container.textContent).toContain('4 added'));
    expect(container.textContent).toContain('Your statement balance for 2026-07-20 is $50.00 lower');
    expect(container.textContent).toContain('between 2026-07-01 and 2026-07-20');
  });

  it('says nothing extra when discrepancy is null -- never "checked", never "balance agreed"', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(async () => ({ ok: true, json: async () => previewBody({ totalRows: 4 }) }))
        .mockImplementationOnce(async () => ({
          ok: true,
          json: async () => ({
            rowsAdded: 4,
            rowsDuplicate: 0,
            rowsError: 0,
            needsReview: 1,
            engineFailed: false,
            loanMatchFailed: false,
            discrepancy: null,
          }),
        })),
    );

    const { container, getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));
    fireEvent.click(getByRole('button', { name: /^Import \d+ transactions$/ }));

    await waitFor(() => expect(container.textContent).toContain('4 added'));
    expect(container.textContent).not.toContain('statement balance');
    expect(container.textContent).not.toContain('checked');
  });
});

// F-03 (v1.31.0): the History table's "View rows" link -- the rows THIS import added, reached
// through transactionsHref (src/lib/transaction-links.ts) rather than a hand-built querystring.
describe('ImportClient — F-03: History "View rows" link', () => {
  it('links each History row to exactly its own import, with no date or person filter riding along', () => {
    const { getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={HISTORY}
        simplefinManaged={[]}
      />,
    );

    const link = getByRole('link', { name: /view rows/i });
    expect(link.getAttribute('href')).toBe('/transactions?import=77');
  });
});

// MUST-6.1/6.2 (spec 2026-08-22 v1.6.0): the preview screen's per-card-value assignment UI.
describe('ImportClient — per-card assignment UI (MUST-6.1, MUST-6.2)', () => {
  const PEOPLE = [
    { id: 5, name: 'Alex' },
    { id: 6, name: 'Sam' },
  ];

  function cardMapping() {
    return { ...TD_CHEQUING, cardCol: 4 };
  }

  async function renderWithCardValues(cardValues: Array<Record<string, unknown>>, people = PEOPLE) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => previewBody({ mapping: cardMapping(), cardValues, columnOptions: [] }) })),
    );
    const view = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
        people={people}
      />,
    );
    fireEvent.submit(view.container.querySelector('form')!);
    await waitFor(() => expect(view.container.textContent).toContain('Preview —'));
    return view;
  }

  it('renders nothing about card assignments when the mapping has no cardCol -- the cardCol-null screen stays as it was', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => previewBody({ totalRows: 4 }) })));
    const { container } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
        people={PEOPLE}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));
    expect(container.textContent).not.toMatch(/account owner \(default\)/i);
  });

  it('lists each distinct card value with its row count', async () => {
    const { container } = await renderWithCardValues([
      { value: '-1001', rowCount: 3, assignedUserId: null, assignedUserName: null },
      { value: '-1002', rowCount: 2, assignedUserId: null, assignedUserName: null },
    ]);
    expect(container.textContent).toContain('-1001');
    expect(container.textContent).toContain('3 rows');
    expect(container.textContent).toContain('-1002');
    expect(container.textContent).toContain('2 rows');
  });

  it('says an unassigned value falls back to the account owner, rather than blocking the import (MUST-6.2)', async () => {
    const { container, getByRole } = await renderWithCardValues([
      { value: '-9999', rowCount: 1, assignedUserId: null, assignedUserName: null },
    ]);
    expect(container.textContent).toMatch(/falls back to the account owner/i);
    // Nothing about an unassigned value disables the commit button.
    expect((getByRole('button', { name: /^Import \d+ transactions$/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  // AutoSaveSelect is a CONTROLLED select (`value`, not `defaultValue`): when its `value` names
  // no matching <option>, the DOM does NOT fall back to the first option the way an uncontrolled
  // `defaultValue` select does -- per the HTML select algorithm, setting .value to something with
  // no matching option leaves selectedIndex at -1, so reading .value back gives "". That makes
  // asserting the initial `select.value` a real proof of preselection here, unlike the
  // defaultValue trap Task 5's ledger warned about for the old, uncontrolled version of this
  // select: a wrongly-missing <option> (or a wrong internal `value`) reads back as "", not as a
  // false-positive match. These tests check that initial value, then also re-choose the same
  // person and inspect what the mocked action actually received.
  it('preselects the already-assigned person, proved via its initial value and what re-choosing it submits', async () => {
    const { getByLabelText } = await renderWithCardValues([
      { value: '-1001', rowCount: 3, assignedUserId: 5, assignedUserName: 'Alex' },
    ]);
    const { setCardPersonAction } = await import('@/app/(app)/import/actions');
    const select = getByLabelText(/Person for -1001/i) as HTMLSelectElement;
    expect(select.value).toBe('5');

    fireEvent.change(select, { target: { value: '5' } });

    await waitFor(() => expect(setCardPersonAction).toHaveBeenCalled());
    const submitted = vi.mocked(setCardPersonAction).mock.calls[0][1] as FormData;
    expect(submitted.get('person')).toBe('5');
    expect(submitted.get('cardValue')).toBe('-1001');
    expect(submitted.get('accountId')).toBe('10');
  });

  it('preselects "account owner (default)" for a value with no assignment, proved the same way', async () => {
    const { getByLabelText } = await renderWithCardValues([
      { value: '-9999', rowCount: 1, assignedUserId: null, assignedUserName: null },
    ]);
    const { setCardPersonAction } = await import('@/app/(app)/import/actions');
    const select = getByLabelText(/Person for -9999/i) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => expect(setCardPersonAction).toHaveBeenCalled());
    const submitted = vi.mocked(setCardPersonAction).mock.calls[0][1] as FormData;
    expect(submitted.get('person')).toBe('');
  });

  it('still preselects an assignment to a person who is no longer in the active `people` list, instead of silently showing it as unassigned', async () => {
    // 99 is deliberately absent from PEOPLE -- a since-deactivated assignee (MUST-3.1). A
    // naive select offering only `people` as <option>s would fall back to the FIRST option
    // ("Account owner (default)") here and look identical to a genuinely unassigned row.
    const { getByLabelText } = await renderWithCardValues([
      { value: '-1001', rowCount: 3, assignedUserId: 99, assignedUserName: 'Retired Member' },
    ]);
    const { setCardPersonAction } = await import('@/app/(app)/import/actions');
    const select = getByLabelText(/Person for -1001/i) as HTMLSelectElement;
    expect(select.value).toBe('99');

    fireEvent.change(select, { target: { value: '99' } });

    await waitFor(() => expect(setCardPersonAction).toHaveBeenCalled());
    const submitted = vi.mocked(setCardPersonAction).mock.calls[0][1] as FormData;
    expect(submitted.get('person')).toBe('99');
  });

  it('submits a newly chosen person when the select is changed', async () => {
    const { getByLabelText } = await renderWithCardValues([
      { value: '-1001', rowCount: 3, assignedUserId: null, assignedUserName: null },
    ]);
    const { setCardPersonAction } = await import('@/app/(app)/import/actions');
    const select = getByLabelText(/Person for -1001/i) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: '6' } });

    await waitFor(() => expect(setCardPersonAction).toHaveBeenCalled());
    const submitted = vi.mocked(setCardPersonAction).mock.calls[0][1] as FormData;
    expect(submitted.get('person')).toBe('6');
  });
});

// F1 (post-1.6.0 review follow-up): saving an assignment used to leave the row showing the
// stale grey "Unassigned" hint right beside its own green "Saved." message, because the hint
// was keyed off `preview.cardValues[i].assignedUserId` -- useState data from the last
// /api/import/preview response, which revalidatePath('/import') cannot reach. The fix patches
// local `preview` state on save success instead of re-running the whole preview. As with every
// other assertion in this file about a saved assignment, these check rendered text / the real
// FormData delivered to the mocked action -- never a <select>'s own `.value`.
describe('ImportClient — F1: a saved assignment updates the row immediately instead of leaving a stale "Unassigned" hint', () => {
  const PEOPLE = [
    { id: 5, name: 'Alex' },
    { id: 6, name: 'Sam' },
  ];

  function cardMapping() {
    return { ...TD_CHEQUING, cardCol: 4 };
  }

  async function renderWithCardValues(cardValues: Array<Record<string, unknown>>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => previewBody({ mapping: cardMapping(), cardValues, columnOptions: [] }) })),
    );
    const view = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
        people={PEOPLE}
      />,
    );
    fireEvent.submit(view.container.querySelector('form')!);
    await waitFor(() => expect(view.container.textContent).toContain('Preview —'));
    return view;
  }

  it('drops the "Unassigned" hint the moment the save succeeds, with no second request', async () => {
    const { getByLabelText, queryByText } = await renderWithCardValues([
      { value: '-1001', rowCount: 3, assignedUserId: null, assignedUserName: null },
    ]);
    const { setCardPersonAction } = await import('@/app/(app)/import/actions');
    expect(queryByText(/Unassigned/i)).toBeTruthy();

    const select = getByLabelText(/Person for -1001/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '5' } });

    await waitFor(() => expect(queryByText(/Unassigned/i)).toBeNull());
    // AutoSaveSelect reports success with the tick icon, not a text message (the message the
    // mocked action returns is only ever surfaced on error -- see AutoSave.tsx's ErrorLine).
    await waitFor(() =>
      expect(document.querySelector('[data-autosave-status="saved"]')).toBeTruthy(),
    );
    // Confirms this was the cheap local-state patch, not a re-triggered preview round trip.
    expect(vi.mocked(setCardPersonAction)).toHaveBeenCalledTimes(1);
  });

  it('brings the "Unassigned" hint back the moment a clear-to-owner save succeeds', async () => {
    const { getByLabelText, queryByText } = await renderWithCardValues([
      { value: '-1001', rowCount: 3, assignedUserId: 5, assignedUserName: 'Alex' },
    ]);
    expect(queryByText(/Unassigned/i)).toBeNull();

    const select = getByLabelText(/Person for -1001/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => expect(queryByText(/Unassigned/i)).toBeTruthy());
  });

  it('does not disturb a sibling card value row when only one row is saved', async () => {
    const { getByLabelText, queryAllByText } = await renderWithCardValues([
      { value: '-1001', rowCount: 3, assignedUserId: null, assignedUserName: null },
      { value: '-1002', rowCount: 2, assignedUserId: null, assignedUserName: null },
    ]);
    expect(queryAllByText(/Unassigned/i).length).toBe(2);

    const select = getByLabelText(/Person for -1001/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '5' } });

    await waitFor(() => expect(queryAllByText(/Unassigned/i).length).toBe(1));
  });

  it('does not patch local state when the save itself fails', async () => {
    const { setCardPersonAction } = await import('@/app/(app)/import/actions');
    vi.mocked(setCardPersonAction).mockResolvedValueOnce({ error: 'Boom' });
    const { getByLabelText, queryByText } = await renderWithCardValues([
      { value: '-1001', rowCount: 3, assignedUserId: null, assignedUserName: null },
    ]);

    const select = getByLabelText(/Person for -1001/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '5' } });

    await waitFor(() => expect(queryByText(/Boom/i)).toBeTruthy());
    expect(queryByText(/Unassigned/i)).toBeTruthy();
  });
});

describe('ImportClient — no CSV mapping editor for an OFX preview (item BP)', () => {
  async function renderWithPreview(over: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => previewBody(over) })),
    );
    const view = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(view.container.querySelector('form')!);
    await waitFor(() => expect(view.container.textContent).toContain('Preview —'));
    return view;
  }

  it('renders no mapping editor and no date-format banner for an OFX preview', async () => {
    const { queryByText } = await renderWithPreview({
      source: 'ofx',
      dateFormatDetection: { candidates: [], status: 'none', detected: null },
      columnOptions: [],
    });
    // The banner told people their dates were unreadable over a file whose dates parsed fine,
    // beside controls that preview and commit both ignore for OFX (ruling R9).
    expect(queryByText(/Could not recognize this column's date format/)).toBeNull();
    expect(queryByText(/Date column/)).toBeNull();
  });

  it('still renders both for a CSV preview whose dates did not parse', async () => {
    const { getByText } = await renderWithPreview({
      source: 'csv',
      dateFormatDetection: { candidates: [], status: 'none', detected: null },
    });
    expect(getByText(/Could not recognize this column's date format/)).toBeTruthy();
  });

  // v1.13.1 fix round (item 5): the Preview card's description told an OFX viewer to "fix the
  // mapping", but an OFX preview has no mapping editor at all -- there is nothing to fix.
  it('does not tell an OFX viewer to fix the mapping', async () => {
    const { container } = await renderWithPreview({
      source: 'ofx',
      dateFormatDetection: { candidates: [], status: 'none', detected: null },
      columnOptions: [],
    });
    expect(container.textContent).not.toContain('Fix the mapping');
  });

  it('still tells a CSV viewer to fix the mapping', async () => {
    const { container } = await renderWithPreview({
      source: 'csv',
      dateFormatDetection: { candidates: [], status: 'none', detected: null },
    });
    expect(container.textContent).toContain('Fix the mapping');
  });
});

describe('ImportClient — responsive rows (v1.15.0, ruling S3)', () => {
  it('the History row\'s File cell carries cell-stack-headline; the preview table stays untouched (ruling S4)', () => {
    // No preview is rendered here (nothing was uploaded), so the History table is the only
    // <table> on the page -- the exact case ruling S4 exists for: the preview grid must never
    // gain cell-stack-headline or go responsive.
    const { container } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={HISTORY}
        simplefinManaged={[]}
      />,
    );
    const historyTable = container.querySelector('table');
    // When: Account: File: By: Added: Dupes: Errors: Undo -- File is the third cell.
    const headlineCell = historyTable?.querySelector('tbody tr td:nth-child(3)');
    expect(headlineCell?.className).toContain('cell-stack-headline');
  });

  // v1.16.0 Lane C item 3: When and Account are context for the row (the file is what tells one
  // import from another), so both now carry cell-stack-meta -- a small muted line under the
  // File headline instead of two more labelled rows of their own.
  it('the History row\'s When and Account cells carry cell-stack-meta', () => {
    const { container } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={HISTORY}
        simplefinManaged={[]}
      />,
    );
    const historyTable = container.querySelector('table');
    // When: Account: File: By: Added: Dupes: Errors: Undo.
    const whenCell = historyTable?.querySelector('tbody tr td:nth-child(1)');
    const accountCell = historyTable?.querySelector('tbody tr td:nth-child(2)');
    expect(whenCell?.className).toContain('cell-stack-meta');
    expect(accountCell?.className).toContain('cell-stack-meta');
  });
});

// Lane 5 (2026-08-30 savings-targets plan, ruling T8/T9/T10). Before this button existed, the
// only way to reach forkProfileIfBuiltin was a SUCCESSFUL commit (flow.ts:75-83) -- so a file
// whose preview reported 0 rows and 117 errors could never save the corrected mapping that would
// make it parse. These tests exercise the button import-client.tsx wires to saveMappingAction.
describe('ImportClient — Lane 5: saving a corrected mapping from the preview', () => {
  it('renders the save-mapping button in the preview step even when the preview reported errors and zero rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => previewBody({ totalRows: 0, errorCount: 117, rows: [], errors: [] }) })),
    );
    const { container, getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));
    expect(container.textContent).toContain('117 errors');

    expect(getByRole('button', { name: /save as a new profile/i })).toBeTruthy();
  });

  it('offers an editable "New profile name" field, defaulted to the account name, only for a built-in profile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => previewBody({}) })));
    const { container, getByLabelText, getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));

    expect(getByRole('button', { name: /save as a new profile/i })).toBeTruthy();
    expect((getByLabelText(/New profile name/i) as HTMLInputElement).value).toBe('Joint Chequing');
  });

  it('labels the button "Update <profile name>" for a custom profile, with no editable name field, never a bare "Save"', async () => {
    const CUSTOM_PROFILES = [{ id: 3, name: 'Tangerine Chequing', isBuiltin: false, mapping: TD_CHEQUING }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => previewBody({ profileId: 3, mapping: TD_CHEQUING }) })));
    const { container, getByRole, queryByLabelText, queryByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 3 }]}
        profiles={CUSTOM_PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));

    expect(getByRole('button', { name: 'Update Tangerine Chequing' })).toBeTruthy();
    expect(queryByLabelText(/New profile name/i)).toBeNull();
    expect(queryByRole('button', { name: /^Save$/ })).toBeNull();
  });

  it('submits the current mapping, profile, account and fork name when clicked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => previewBody({}) })));
    const { container, getByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));

    const { saveMappingAction } = await import('@/app/(app)/import/actions');
    fireEvent.click(getByRole('button', { name: /save as a new profile/i }));

    await waitFor(() => expect(saveMappingAction).toHaveBeenCalled());
    const submitted = vi.mocked(saveMappingAction).mock.calls[0][1] as FormData;
    expect(submitted.get('profileId')).toBe('1');
    expect(submitted.get('accountId')).toBe('10');
    expect(submitted.get('accountName')).toBe('Joint Chequing');
    expect(JSON.parse(submitted.get('mapping') as string)).toEqual(TD_CHEQUING);
  });

  it('shows the returned message inline once the save succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => previewBody({}) })));
    const { container, getByRole, getByText } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));

    const { saveMappingAction } = await import('@/app/(app)/import/actions');
    vi.mocked(saveMappingAction).mockResolvedValueOnce({
      message: 'Saved "TD Chequing/Debit (Joint Chequing)" as a new profile, and pointed this account at it.',
    });
    fireEvent.click(getByRole('button', { name: /save as a new profile/i }));

    await waitFor(() => expect(getByText(/pointed this account at it/i)).toBeTruthy());
  });

  it('surfaces a refusal inline instead of failing silently (a self-scoped viewer, e.g.)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => previewBody({}) })));
    const { container, getByRole, getByText } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));

    const { saveMappingAction } = await import('@/app/(app)/import/actions');
    vi.mocked(saveMappingAction).mockResolvedValueOnce({ error: 'Import is not available on this account.' });
    fireEvent.click(getByRole('button', { name: /save as a new profile/i }));

    await waitFor(() => expect(getByText(/not available on this account/i)).toBeTruthy());
  });

  it('renders no save-mapping panel at all for an OFX preview, which has no mapping to save', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => previewBody({ source: 'ofx', dateFormatDetection: { candidates: [], status: 'none', detected: null }, columnOptions: [] }) })),
    );
    const { container, queryByRole } = render(
      <ImportClient
        accounts={[{ id: 10, name: 'Joint Chequing', importProfileId: 1 }]}
        profiles={PROFILES}
        history={[]}
        simplefinManaged={[]}
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('Preview —'));

    expect(queryByRole('button', { name: /save as a new profile/i })).toBeNull();
    expect(queryByRole('button', { name: /^Update /i })).toBeNull();
  });
});
