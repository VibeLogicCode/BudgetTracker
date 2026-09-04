// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdatesClient, type UpdatesViewProps } from '@/app/(app)/settings/updates-client';
import {
  applyUpdateAction,
  checkForUpdateNowAction,
  dismissUpdateAction,
  enableUpdateChecksAction,
  reviewUpdateAction,
} from '@/app/(app)/settings/actions';

vi.mock('@/app/(app)/settings/actions', () => ({
  enableUpdateChecksAction: vi.fn(async () => ({})),
  disableUpdateChecksAction: vi.fn(async () => ({})),
  setAutoApplyAction: vi.fn(async () => ({})),
  checkForUpdateNowAction: vi.fn(async () => ({})),
  reviewUpdateAction: vi.fn(async () => ({})),
  applyUpdateAction: vi.fn(async () => ({})),
  dismissUpdateAction: vi.fn(async () => ({})),
}));

afterEach(cleanup);

/**
 * Clicking (not just submitting the form directly) matters for "Review and update": its
 * onClick opens the review panel at urgent priority, separate from the form's own action.
 */
function submit(label: string): void {
  fireEvent.click(screen.getByText(label));
}

const base: UpdatesViewProps = {
  currentVersion: '1.3.1',
  enabled: true,
  autoApply: true,
  lastCheckedAt: '2026-08-18T09:30:00.000Z',
  lastCheckError: null,
  latestVersion: null,
  latestPublishedAt: null,
  dismissedVersion: null,
  lastAppliedAt: null,
  lastApplyError: null,
  applyRequestedVersion: null,
  applyRequestedAt: null,
  severity: 'none',
  canApplyInApp: true,
  watchtowerError: null,
  canadianPackUpdate: null,
};

describe('MUST-9.3: the off state', () => {
  it('renders the verbatim copy and exactly one button', () => {
    render(<UpdatesClient {...base} enabled={false} autoApply={false} lastCheckedAt={null} />);
    expect(screen.getByText('Budget Tracker v1.3.1 · update checks are off.')).toBeTruthy();
    expect(
      screen.getByText(/That request carries the version you are running and nothing else/),
    ).toBeTruthy();
    expect(screen.getByText(/A major version never does/)).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button').textContent).toContain('Enable update checks');
  });
});

describe('MUST-9.4: the on state', () => {
  it('shows Up to date, the timestamp in iso.slice(0,16) form, and the three controls', () => {
    render(<UpdatesClient {...base} />);
    expect(screen.getByText('Up to date (v1.3.1)')).toBeTruthy();
    expect(screen.getByText(/Last checked 2026-08-18 09:30/)).toBeTruthy();
    for (const label of ['Check now', 'Install small updates automatically', 'Disable update checks']) {
      expect(screen.getByText(new RegExp(label))).toBeTruthy();
    }
    expect(screen.queryByText('Update now')).toBeNull();
  });

  it('renders Never when nothing has been checked yet', () => {
    render(<UpdatesClient {...base} lastCheckedAt={null} />);
    expect(screen.getByText(/Last checked Never/)).toBeTruthy();
  });

  it.each([
    ['patch', 'Patch update', 'Update now'],
    ['minor', 'Minor update', 'Update now'],
    ['major', 'Major update', 'Review and update'],
  ] as const)('%s offers the right badge and primary control', (severity, badge, control) => {
    render(<UpdatesClient {...base} severity={severity} latestVersion="1.4.0" />);
    expect(screen.getByText('Version 1.4.0 is available')).toBeTruthy();
    expect(screen.getByText(badge)).toBeTruthy();
    expect(screen.getByText(control)).toBeTruthy();
    expect(screen.getByText('Not now')).toBeTruthy();
  });

  it('surfaces a check error and an apply error in error notices', () => {
    render(<UpdatesClient {...base} lastCheckError="GitHub returned 500." lastApplyError="Watchtower said no." />);
    expect(screen.getByText('GitHub returned 500.')).toBeTruthy();
    expect(screen.getByText('Watchtower said no.')).toBeTruthy();
  });

  it('MUST-5.9: a dismissed version collapses to the status line and a Show again control', () => {
    render(<UpdatesClient {...base} severity="minor" latestVersion="1.4.0" dismissedVersion="1.4.0" />);
    expect(screen.getByText('Version 1.4.0 is available — you chose to skip it for now.')).toBeTruthy();
    expect(screen.getByText('Show again')).toBeTruthy();
    expect(screen.queryByText('Update now')).toBeNull();
  });

  // Review fix (MED): pins the carried property — a major severity must NEVER render a bare
  // apply control, panel open or closed. Only the it.each's own control assertion was
  // checked before; this rules out "Update now" or a stray "Install ..." slipping in.
  it('MUST-9.5: a major severity never renders a bare apply control while the panel is closed', () => {
    render(<UpdatesClient {...base} severity="major" latestVersion="1.4.0" />);
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Install /i })).toBeNull();
  });
});

describe('MUST-7.8 / MUST-7.9: no apply path', () => {
  it('renders the fallback copy and NO apply button anywhere — absent, not disabled', () => {
    render(<UpdatesClient {...base} severity="minor" latestVersion="1.4.0" canApplyInApp={false} />);
    expect(screen.getByText('This install updates by hand.')).toBeTruthy();
    expect(screen.getByText(/Both scripts tag a rollback point first/)).toBeTruthy();
    expect(screen.getByText('install/synology-compose-pull.yml')).toBeTruthy();
    expect(screen.queryByText('Update now')).toBeNull();
    expect(screen.queryByText('Review and update')).toBeNull();
    // MUST-11.6's rule, applied here too: no address on the page is clickable.
    expect(document.querySelectorAll('a[href]')).toHaveLength(0);
  });

  it('MUST-8.7: a malformed WATCHTOWER_URL is reported, not swallowed', () => {
    render(
      <UpdatesClient
        {...base}
        canApplyInApp={false}
        watchtowerError="The WATCHTOWER_URL in your compose file is not a valid internal address."
      />,
    );
    expect(screen.getByText('The WATCHTOWER_URL in your compose file is not a valid internal address.')).toBeTruthy();
  });
});

describe('MUST-9.6 / review fix (MED): the review fetch has an honest pending state', () => {
  it('shows a pending line, not the failure sentence, while the request is in flight; the failure sentence only once it settles without a release', async () => {
    let resolveReview!: (value: { version: string }) => void;
    vi.mocked(reviewUpdateAction).mockImplementationOnce(
      () => new Promise((resolve) => { resolveReview = resolve; }),
    );

    render(<UpdatesClient {...base} severity="major" latestVersion="1.4.0" />);
    submit('Review and update');

    await waitFor(() => expect(screen.getByText('Fetching release notes…')).toBeTruthy());
    expect(screen.queryByText(/could not be fetched/)).toBeNull();

    resolveReview({ version: '1.4.0' });

    await waitFor(() => expect(screen.getByText(/could not be fetched/)).toBeTruthy());
    expect(screen.queryByText('Fetching release notes…')).toBeNull();
    // MUST-9.6: the confirm button is still offered even though the notes never arrived.
    expect(screen.getByText('Install 1.4.0')).toBeTruthy();
  });
});

describe('MUST-4.8 / MUST-9.5: remote changelog markup renders as literal text', () => {
  it('a bullet containing raw HTML is shown as characters, never interpreted', async () => {
    vi.mocked(reviewUpdateAction).mockResolvedValueOnce({
      version: '1.4.0',
      release: {
        heading: '[1.4.0] - 2026-08-18',
        notes: [],
        groups: [{ title: 'Added', items: ['<b>bold via HTML</b> should stay literal, only **this** renders bold'] }],
      },
    });

    const { container } = render(<UpdatesClient {...base} severity="major" latestVersion="1.4.0" />);
    submit('Review and update');

    await waitFor(() => expect(container.textContent).toContain('should stay literal'));
    // The full literal string, angle brackets and all — no HTML was parsed out of it.
    expect(container.textContent).toContain('<b>bold via HTML</b> should stay literal, only this renders bold');
    // No <b> tag was ever created from the raw markup — React escaped it as text.
    expect(container.querySelector('b')).toBeNull();
    // The renderer's own inline form (**...**) still works on the same string.
    const bold = Array.from(container.querySelectorAll('strong')).find((el) => el.textContent === 'this');
    expect(bold).toBeTruthy();
  });
});

describe('M-7 (2026-09-02 review): duplicate group titles in one release do not collide on key', () => {
  it('renders both same-titled groups without a React duplicate-key warning', async () => {
    vi.mocked(reviewUpdateAction).mockResolvedValueOnce({
      version: '1.4.0',
      release: {
        heading: '[1.4.0] - 2026-08-18',
        notes: [],
        groups: [
          { title: 'Added', items: ['first Added bullet'] },
          { title: 'Added', items: ['second Added bullet'] },
        ],
      },
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(<UpdatesClient {...base} severity="major" latestVersion="1.4.0" />);
    submit('Review and update');

    await waitFor(() => expect(container.textContent).toContain('second Added bullet'));
    expect(container.textContent).toContain('first Added bullet');
    for (const call of errorSpy.mock.calls) {
      expect(String(call[0])).not.toMatch(/same key/);
    }
    errorSpy.mockRestore();
  });
});

describe("MUST-9.8: the two apply outcomes render their exact sentences", () => {
  it('the accepted sentence is shown verbatim', async () => {
    vi.mocked(applyUpdateAction).mockResolvedValueOnce({
      message: 'Update requested. Watchtower is pulling 1.4.0 and will restart this app in a moment. Reload this page in a minute or two.',
    });
    render(<UpdatesClient {...base} severity="minor" latestVersion="1.4.0" />);
    submit('Update now');
    await waitFor(() =>
      expect(
        screen.getByText(
          'Update requested. Watchtower is pulling 1.4.0 and will restart this app in a moment. Reload this page in a minute or two.',
        ),
      ).toBeTruthy(),
    );
  });

  it('the accepted-unconfirmed sentence is shown verbatim', async () => {
    vi.mocked(applyUpdateAction).mockResolvedValueOnce({
      message:
        'Update requested. This app is being replaced right now, so it could not wait for a reply. Reload this page in a minute or two — the version at the bottom of this card will tell you whether it worked.',
    });
    render(<UpdatesClient {...base} severity="minor" latestVersion="1.4.0" />);
    submit('Update now');
    await waitFor(() =>
      expect(
        screen.getByText(
          'Update requested. This app is being replaced right now, so it could not wait for a reply. Reload this page in a minute or two — the version at the bottom of this card will tell you whether it worked.',
        ),
      ).toBeTruthy(),
    );
  });
});

describe('MUST-7.3: the card never receives a token', () => {
  it('the props type carries canApplyInApp and no credential field', () => {
    const keys = Object.keys(base);
    expect(keys).toContain('canApplyInApp');
    for (const key of keys) expect(key.toLowerCase()).not.toContain('token');
    expect(JSON.stringify(base).toLowerCase()).not.toContain('bearer');
  });
});

describe('backlog item 17 / Part 4: the preset-pack update notice', () => {
  it('is absent when no pack update is pending', () => {
    render(<UpdatesClient {...base} />);
    expect(screen.queryByText('Preset rules: an update is available')).toBeNull();
  });

  it('shows both versions and a link to the merchant-rules page when one is pending', () => {
    const { container } = render(<UpdatesClient {...base} canadianPackUpdate={{ installedVersion: 1, bundledVersion: 2 }} />);
    expect(screen.getByText('Preset rules: an update is available')).toBeTruthy();
    expect(container.textContent).toContain('installed is v1; this build ships v2');
    const link = screen.getByRole('link', { name: /Review the change and apply it/ });
    expect(link.getAttribute('href')).toBe('/settings/merchant-rules');
  });

  it('still shows the pack notice even when app update checks are off', () => {
    render(<UpdatesClient {...base} enabled={false} autoApply={false} lastCheckedAt={null} canadianPackUpdate={{ installedVersion: 1, bundledVersion: 2 }} />);
    expect(screen.getByText('Preset rules: an update is available')).toBeTruthy();
  });
});

describe('item H: updates-client.tsx passes server actions to useActionState directly', () => {
  it('passes every server action to useActionState directly (item H)', () => {
    // The cause, asserted as source shape, because the symptom (stale props after Check now) is
    // not observable in jsdom: a closure defined in a 'use client' module is a CLIENT function,
    // so React never processes a server-action response for it and the router never refreshes.
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/app/(app)/settings/updates-client.tsx'),
      'utf8',
    );
    const wrapped = [...source.matchAll(/useActionState\(\s*async\s*\(/g)];
    // reviewUpdateAction is the one deliberate exception: it revalidates nothing and returns a
    // different state type (settings/actions.ts:280-284).
    expect(wrapped).toHaveLength(1);
  });

  it('shows the action\'s own message when nothing changed', async () => {
    vi.mocked(checkForUpdateNowAction).mockResolvedValueOnce({
      message: 'You are on the newest published version.',
    });
    render(<UpdatesClient {...base} />);
    submit('Check now');
    await waitFor(() => expect(screen.getByText('You are on the newest published version.')).toBeTruthy());
  });
});

describe('Task 3d, symptom A: the client prefers the freshest action result over stale props', () => {
  it('Check now resolving a new version updates the header and offers Update now with NO prop change', async () => {
    // base is rendered as-is below -- props never change. Only checkForUpdateNowAction's OWN
    // resolved value (what actions.ts's checkForUpdateNowAction now returns after its write)
    // moves the UI. This is the bug: before the fix, offered/severity/dismissed were derived
    // from props alone, so this exact scenario left the header reading "Up to date" and no
    // Update now button until the page was reloaded by hand.
    vi.mocked(checkForUpdateNowAction).mockResolvedValueOnce({
      message: 'Version 9.9.9 is available.',
      latestVersion: '9.9.9',
      severity: 'minor',
      lastCheckedAt: '2026-08-18T09:35:00.000Z',
    });
    render(<UpdatesClient {...base} />);
    expect(screen.getByText('Up to date (v1.3.1)')).toBeTruthy();

    submit('Check now');

    await waitFor(() => expect(screen.getByText('Version 9.9.9 is available')).toBeTruthy());
    expect(screen.queryByText('Up to date (v1.3.1)')).toBeNull();
    expect(screen.getByText('Minor update')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeTruthy();
  });
});

describe('Task 3d, symptom B: the pending block replaces the apply buttons', () => {
  const NOW = new Date('2026-08-18T09:30:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('an apply requested 5 minutes ago hides Update now and the pending notice names the version', () => {
    const fiveMinutesAgo = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    render(
      <UpdatesClient
        {...base}
        severity="minor"
        latestVersion="1.4.0"
        applyRequestedVersion="1.4.0"
        applyRequestedAt={fiveMinutesAgo}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
    expect(screen.getByText(/Watchtower is pulling 1\.4\.0/)).toBeTruthy();
  });

  it('an apply requested 31 minutes ago no longer counts as pending — Update now is back', () => {
    const thirtyOneMinutesAgo = new Date(NOW.getTime() - 31 * 60_000).toISOString();
    render(
      <UpdatesClient
        {...base}
        severity="minor"
        latestVersion="1.4.0"
        applyRequestedVersion="1.4.0"
        applyRequestedAt={thirtyOneMinutesAgo}
      />,
    );
    expect(screen.getByRole('button', { name: 'Update now' })).toBeTruthy();
    expect(screen.queryByText(/Watchtower is pulling 1\.4\.0/)).toBeNull();
  });

  it('a pending request for a DIFFERENT version does not suppress the button for this one', () => {
    render(
      <UpdatesClient
        {...base}
        severity="minor"
        latestVersion="1.4.0"
        applyRequestedVersion="1.3.9"
        applyRequestedAt={new Date(NOW.getTime() - 5 * 60_000).toISOString()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Update now' })).toBeTruthy();
  });

  it('MUST-7.3: the pending notice never carries a token, only the version and a timestamp', () => {
    render(
      <UpdatesClient
        {...base}
        severity="minor"
        latestVersion="1.4.0"
        applyRequestedVersion="1.4.0"
        applyRequestedAt={new Date(NOW.getTime() - 5 * 60_000).toISOString()}
      />,
    );
    expect(document.body.textContent?.toLowerCase()).not.toContain('bearer');
    expect(document.body.textContent?.toLowerCase()).not.toContain('token');
  });
});

/**
 * v1.31.0 item M-3. Task 3d fixed the stale-props symptom for Check now and Update now only; the
 * other four update actions returned { message } alone and were still read from props on the next
 * render, so on an install where the props do not arrive they appeared to do nothing until a
 * manual reload. "Not now" was the visible one: `dismissed` came from props.dismissedVersion.
 *
 * Each test renders with props that NEVER change and moves the UI through the action's own
 * resolved value alone -- the same construction Task 3d's own symptom-A test uses.
 */
describe('item M-3: the other four update actions also hand back what they just wrote', () => {
  it('Not now hides the offer with NO prop change', async () => {
    vi.mocked(dismissUpdateAction).mockResolvedValueOnce({
      message: 'Skipping 1.4.0 for now. You will still be told when a newer version is published.',
      latestVersion: '1.4.0',
      severity: 'minor',
      dismissedVersion: '1.4.0',
      resolvedAt: '2026-08-18T09:35:00.000Z',
    });
    render(<UpdatesClient {...base} severity="minor" latestVersion="1.4.0" />);
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy();

    submit('Not now');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Show again' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
  });

  it('Enable update checks leaves the off state with NO prop change', async () => {
    vi.mocked(enableUpdateChecksAction).mockResolvedValueOnce({
      message: 'Update checks are on. This app will ask GitHub once a day whether a newer version is published.',
      enabled: true,
      severity: 'none',
      latestVersion: null,
      resolvedAt: '2026-08-18T09:35:00.000Z',
    });
    render(<UpdatesClient {...base} enabled={false} autoApply={false} lastCheckedAt={null} />);
    expect(screen.getByRole('button', { name: 'Enable update checks' })).toBeTruthy();

    submit('Enable update checks');

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Enable update checks' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
  });

  it('ranks two action results by resolvedAt, not by the order resolveView lists them', async () => {
    // Enable wipes every `update.` key (MUST-3.4), so its payload's `latestVersion: null` is a
    // DEFINED value. Check runs afterwards and finds 9.9.9. Under the old fixed ordering the
    // enable result sat wherever it was listed and could beat the later, truer answer; the
    // resolvedAt stamps make the later write win regardless of listing order.
    vi.mocked(enableUpdateChecksAction).mockResolvedValueOnce({
      message: 'Update checks are on. This app will ask GitHub once a day whether a newer version is published.',
      enabled: true,
      latestVersion: null,
      severity: 'none',
      resolvedAt: '2026-08-18T09:35:00.000Z',
    });
    vi.mocked(checkForUpdateNowAction).mockResolvedValueOnce({
      message: 'Version 9.9.9 is available.',
      enabled: true,
      latestVersion: '9.9.9',
      severity: 'minor',
      resolvedAt: '2026-08-18T09:36:00.000Z',
    });
    render(<UpdatesClient {...base} enabled={false} autoApply={false} lastCheckedAt={null} />);

    submit('Enable update checks');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy());

    submit('Check now');
    await waitFor(() => expect(screen.getByText('Version 9.9.9 is available')).toBeTruthy());
    expect(screen.queryByText('Up to date (v1.3.1)')).toBeNull();
  });
});

/**
 * v1.31.0 item M-6. `pending` compares a wall-clock reading against a server-written timestamp,
 * and UpdatesClient is rendered on the SERVER for the initial HTML and again on hydration. While
 * it read Date.now() during render, a request landing within a few hundred milliseconds of
 * MUST-7.6's 30-minute boundary produced different markup on the two sides -- pending notice vs.
 * `Update now` -- which is a hydration mismatch. The window is narrow; the determinism is not
 * optional.
 *
 * The contract these two tests pin together: the SERVER render never depends on the clock, and the
 * pending state arrives from an effect afterwards. Before the fix the first test would have found
 * the pending sentence in the server HTML (the clock says pending) while a hydrating client a few
 * hundred ms later could compute the opposite.
 */
describe('item M-6: pending is not derived from the clock during the first render', () => {
  const NOW = new Date('2026-08-18T09:30:00.000Z');
  const fiveMinutesAgo = new Date(NOW.getTime() - 5 * 60_000).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('the server render does not read the clock, at either side of the 30-minute boundary', () => {
    const props = {
      ...base,
      severity: 'minor' as const,
      latestVersion: '1.4.0',
      applyRequestedVersion: '1.4.0',
      applyRequestedAt: fiveMinutesAgo,
    };
    // Inside the 30-minute window by the clock, and 31 minutes outside it. Both server renders
    // must agree, because neither may read the clock at all.
    const inside = renderToStaticMarkup(<UpdatesClient {...props} />);
    vi.setSystemTime(new Date(NOW.getTime() + 31 * 60_000));
    const outside = renderToStaticMarkup(<UpdatesClient {...props} />);
    // Asserted on the two branch markers rather than on the whole markup: a whole-string compare
    // fails with two 2KB blobs a reader has to diff by eye, and these two strings are exactly what
    // the branch decides between.
    for (const html of [inside, outside]) {
      expect(html, 'the server render derived `pending` from the clock').not.toContain('Watchtower is pulling');
      expect(html, 'the server render derived `pending` from the clock').toContain('Update now');
    }
  });

  it('the pending notice arrives after the effect, on the client', () => {
    render(
      <UpdatesClient
        {...base}
        severity="minor"
        latestVersion="1.4.0"
        applyRequestedVersion="1.4.0"
        applyRequestedAt={fiveMinutesAgo}
      />,
    );
    // render() flushes effects, so by here the clock HAS been read -- on the client only.
    expect(screen.getByText(/Watchtower is pulling 1\.4\.0/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
  });
});
