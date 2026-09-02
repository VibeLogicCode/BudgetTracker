// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import {
  NotificationsClient,
  isNotificationTab,
  type NotificationsPageData,
} from '@/app/(app)/settings/notifications/notifications-client';
import { SMTP_PRESETS } from '@/lib/notify/config';
import { NOTIFICATION_EVENTS, eventsFor, householdEligibleEvents } from '@/lib/notify/events';

const detect = vi.hoisted(() => vi.fn());
vi.mock('@/app/(app)/settings/notifications/actions', () => ({
  saveSmtpAction: vi.fn(async () => ({})),
  removeSmtpAction: vi.fn(async () => ({})),
  testSmtpAction: vi.fn(async () => ({})),
  saveTelegramTargetAction: vi.fn(async () => ({})),
  saveEmailTargetAction: vi.fn(async () => ({})),
  removeTargetAction: vi.fn(async () => ({})),
  testTargetAction: vi.fn(async () => ({})),
  savePreferencesAction: vi.fn(async () => ({})),
  detectTelegramChatIdAction: detect,
  // v1.28.0 Lane 2 (family channels).
  saveHouseholdTelegramTargetAction: vi.fn(async () => ({})),
  saveHouseholdEmailTargetAction: vi.fn(async () => ({})),
  removeHouseholdTargetAction: vi.fn(async () => ({})),
  testHouseholdTargetAction: vi.fn(async () => ({})),
  saveHouseholdPreferencesAction: vi.fn(async () => ({})),
  detectHouseholdTelegramChatIdAction: vi.fn(async () => ({})),
}));

afterEach(() => {
  cleanup();
  detect.mockReset();
});

const SETTINGS = {
  comingDueDays: 14,
  budgetThresholdPct: 80,
  staleImportWeeks: 3,
  dailyHour: 8,
  digestWeekday: 1,
  digestHour: 8,
};

function props(over: Partial<NotificationsPageData> = {}): NotificationsPageData {
  const role = over.role ?? 'admin';
  return {
    role,
    // v1.29.0: four URL-driven tabs replace six cards on one scroll. 'email' is page.tsx's own
    // default when `?tab=` is absent or malformed, so it is this fixture's default too -- every
    // existing test written before tabs existed keeps rendering the same content it always did
    // unless it explicitly asks for a different tab below.
    tab: over.tab ?? 'email',
    smtp: null,
    relayConfigured: over.smtp != null,
    targets: { telegram: null, email: null },
    events: over.events ?? eventsFor(role),
    prefs: {},
    settings: SETTINGS,
    deliveries: [],
    presets: SMTP_PRESETS,
    // v1.28.0 Lane 2 (family channels): mirrors page.tsx's own real narrowing -- a member's
    // copy carries no `targets` at all, matching how `smtp` above is withheld from one too.
    household: {
      targets: role === 'admin' ? { telegram: null, email: null } : null,
      eligibleEvents: householdEligibleEvents(),
      prefs: {},
    },
    ...over,
  };
}

function householdTargetFixture(
  over: Partial<NonNullable<NotificationsPageData['household']['targets']>['telegram']> = {},
) {
  return {
    id: 1,
    scope: 'household' as const,
    userId: null,
    createdByUserId: 1,
    channel: 'telegram' as const,
    destination: '-1001234567890',
    secretSet: false,
    enabled: true,
    verifiedAt: null,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    ...over,
  };
}

function target(over: Partial<NonNullable<NotificationsPageData['targets']['email']>> = {}) {
  return {
    id: 1,
    userId: 1,
    channel: 'email' as const,
    destination: 'sam@example.com',
    secretSet: false,
    enabled: true,
    verifiedAt: null,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    ...over,
  };
}

describe('MUST-11.2: the status banner', () => {
  it('says the app makes no outbound connection when nothing is configured', () => {
    const { container } = render(<NotificationsClient {...props()} />);
    expect(container.textContent).toContain(
      'Notifications are off. This app makes no outbound connection until you configure a channel here.',
    );
  });

  it('surfaces a live last_error, naming the channel', () => {
    const { container } = render(
      <NotificationsClient
        {...props({
          targets: { telegram: null, email: target({ lastError: 'chat not found', lastErrorAt: '2026-08-17T12:00:00.000Z' }) },
        })}
      />,
    );
    expect(container.textContent).toContain('chat not found');
    expect(container.textContent).toMatch(/email/i);
  });
});

describe('MUST-11.1 / §11.3: the admin SMTP section', () => {
  it('is absent for a member and present for an admin', () => {
    expect(render(<NotificationsClient {...props({ role: 'member' })} />).container.textContent).not.toContain('Outbound email');
    cleanup();
    expect(render(<NotificationsClient {...props({ role: 'admin' })} />).container.textContent).toContain('Outbound email');
  });

  it('MUST-8.15 / MUST-11.7: changing the preset prefills host/port/security and swaps the guide', () => {
    const { container, getByLabelText } = render(<NotificationsClient {...props()} />);
    const preset = getByLabelText(/preset/i) as HTMLSelectElement;

    fireEvent.change(preset, { target: { value: 'gmail' } });
    expect((getByLabelText(/^server/i) as HTMLInputElement).value).toBe('smtp.gmail.com');
    expect((getByLabelText(/^port/i) as HTMLInputElement).value).toBe('465');
    expect((getByLabelText(/encryption/i) as HTMLSelectElement).value).toBe('tls');
    expect(container.textContent).toContain('myaccount.google.com');
    expect(container.textContent).not.toContain('smtp2go.com');

    fireEvent.change(preset, { target: { value: 'smtp2go' } });
    expect((getByLabelText(/^server/i) as HTMLInputElement).value).toBe('mail.smtp2go.com');
    expect(container.textContent).toContain('smtp2go.com');
    expect(container.textContent).not.toContain('myaccount.google.com');
  });

  it('MUST-5.6: the password field is empty with the saved placeholder, and offers no reveal', () => {
    const { getByLabelText, container } = render(
      <NotificationsClient
        {...props({
          smtp: {
            preset: 'brevo',
            host: 'smtp-relay.brevo.com',
            port: 587,
            security: 'starttls',
            username: 'me@example.com',
            fromEmail: 'me@example.com',
            fromName: 'Budget Tracker',
            enabled: true,
            passwordSet: true,
            lastError: null,
            lastErrorAt: null,
            lastSuccessAt: '2026-08-17T12:00:00.000Z',
          },
        })}
      />,
    );
    const password = getByLabelText(/^password/i) as HTMLInputElement;
    expect(password.value).toBe('');
    expect(password.placeholder).toBe('•••••••• (saved)');
    expect(password.type).toBe('password');
    expect(container.textContent).not.toMatch(/reveal|show password/i);
  });

  it('a member whose email channel has no relay sees the explanation instead of the buttons', () => {
    const { container, queryByText } = render(
      <NotificationsClient {...props({ role: 'member', smtp: null, targets: { telegram: null, email: target() } })} />,
    );
    expect(container.textContent).toContain('An admin needs to set up outbound email before this can send.');
    expect(queryByText('Send test email')).toBeNull();
  });
});

describe('MUST-11.3: the matrix is generated from the registry', () => {
  it('renders one row per event with a Telegram and an Email checkbox', () => {
    const { container } = render(<NotificationsClient {...props({ tab: 'events' })} />);
    for (const event of NOTIFICATION_EVENTS) {
      expect(container.textContent).toContain(event.label);
      expect(container.querySelector(`input[name="pref:${event.id}:telegram"]`)).not.toBeNull();
      expect(container.querySelector(`input[name="pref:${event.id}:email"]`)).not.toBeNull();
    }
  });

  it('MUST-4.4: an injected registry entry the component has never heard of renders a row', () => {
    const future = {
      id: 'on_pace_overshoot',
      label: 'On pace to overshoot',
      blurb: 'Spending is tracking above the month’s limit.',
      audience: 'all',
      trigger: 'tick',
      defaultEnabled: false,
      householdEligible: false,
    } as const;
    const { container } = render(<NotificationsClient {...props({ tab: 'events', events: [...eventsFor('admin'), future] })} />);
    expect(container.textContent).toContain('On pace to overshoot');
    expect(container.querySelector('input[name="pref:on_pace_overshoot:email"]')).not.toBeNull();
  });

  it('MUST-4.3: admin-only rows are absent for a member', () => {
    const { container } = render(<NotificationsClient {...props({ role: 'member', tab: 'events' })} />);
    expect(container.textContent).not.toContain('The nightly backup failed');
    expect(container.textContent).not.toContain('A restore finished');
  });

  it('a column for an unconfigured channel is disabled and explains why', () => {
    const { container } = render(
      <NotificationsClient {...props({ tab: 'events', targets: { telegram: null, email: target() } })} />,
    );
    const telegram = container.querySelector('input[name="pref:coming_due:telegram"]') as HTMLInputElement;
    const email = container.querySelector('input[name="pref:coming_due:email"]') as HTMLInputElement;
    expect(telegram.disabled).toBe(true);
    expect(telegram.title).toBe('Set up this channel first.');
    expect(email.disabled).toBe(false);
  });

  it('reflects the effective value, not the raw stored one', () => {
    const { container } = render(
      <NotificationsClient
        {...props({
          tab: 'events',
          targets: { telegram: null, email: target() },
          prefs: { 'coming_due:email': false, 'weekly_digest:email': true },
        })}
      />,
    );
    expect((container.querySelector('input[name="pref:coming_due:email"]') as HTMLInputElement).defaultChecked).toBe(false);
    expect((container.querySelector('input[name="pref:weekly_digest:email"]') as HTMLInputElement).defaultChecked).toBe(true);
    expect((container.querySelector('input[name="pref:budget_exceeded:email"]') as HTMLInputElement).defaultChecked).toBe(true);
  });

  it('MUST-11.4: the always-visible sentence about what the messages contain', () => {
    const { container } = render(<NotificationsClient {...props({ tab: 'events' })} />);
    expect(container.textContent).toContain(
      'Messages contain amounts, category names and merchant names, and are delivered by Telegram or by your email provider.',
    );
  });

  it('MUST-5.8: the page says these credentials are inside the unencrypted backup', () => {
    const { container } = render(<NotificationsClient {...props({ tab: 'events' })} />);
    expect(container.textContent).toMatch(/backup/i);
  });

  it('MUST-17.2: the six v1.4.0 events render for a member with no component edit', () => {
    // The file's convention, at every one of its existing render sites: props() returns the
    // whole NotificationsPageData and is spread. There is no `data` prop.
    render(<NotificationsClient {...props({ role: 'member', tab: 'events' })} />);
    for (const id of [
      'budget_pace',
      'unusual_transaction',
      'subscription_creep',
      'duplicate_charge',
      'predicted_vs_actual',
      'suggested_budget_refresh',
    ]) {
      expect(document.querySelector(`input[name="pref:${id}:telegram"]`)).not.toBeNull();
      expect(document.querySelector(`input[name="pref:${id}:email"]`)).not.toBeNull();
    }
  });

  it('MUST-9.3: none of the six needs admin rights', () => {
    const memberIds = eventsFor('member').map((event) => event.id);
    for (const id of [
      'budget_pace',
      'unusual_transaction',
      'subscription_creep',
      'duplicate_charge',
      'predicted_vs_actual',
      'suggested_budget_refresh',
    ]) {
      expect(memberIds).toContain(id);
    }
  });

  it('renders the five knobs with their defaults in the hint text', () => {
    const { container, getByLabelText } = render(<NotificationsClient {...props({ tab: 'events' })} />);
    for (const name of ['comingDueDays', 'budgetThresholdPct', 'staleImportWeeks', 'dailyHour', 'digestWeekday', 'digestHour']) {
      expect(container.querySelector(`[name="${name}"]`)).not.toBeNull();
    }
    expect((getByLabelText(/days before/i) as HTMLInputElement).defaultValue).toBe('14');
  });
});

describe('MUST-11.2: Detect chat ID', () => {
  it('MUST-8.11: is disabled with its hint before a token is saved', () => {
    const { container } = render(<NotificationsClient {...props({ tab: 'telegram' })} />);
    const button = personalTelegram(container).getByText('Detect chat ID') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('Save your bot token first');
  });

  it('renders a radio per chat and fills the Chat ID field on selection without saving', async () => {
    detect.mockResolvedValue({
      chats: [
        { chatId: '5551234', title: 'Sam Rivera', kind: 'private', lastMessageAt: '2026-08-17T12:00:00.000Z' },
        { chatId: '-1001234567890', title: 'Morgan Family', kind: 'group', lastMessageAt: '2026-08-16T12:00:00.000Z' },
      ],
    });
    const { container } = render(
      <NotificationsClient
        {...props({
          tab: 'telegram',
          targets: { telegram: target({ channel: 'telegram', destination: '', secretSet: true }), email: null },
        })}
      />,
    );
    fireEvent.click(personalTelegram(container).getByText('Detect chat ID'));
    await waitFor(() => expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(2));
    expect(container.textContent).toContain('Morgan Family');
    expect(container.textContent).toContain('-1001234567890');

    fireEvent.click(container.querySelectorAll('input[type="radio"]')[1] as HTMLInputElement);
    expect((personalTelegram(container).getByLabelText(/chat id/i) as HTMLInputElement).value).toBe('-1001234567890');
    // Nothing is saved until Save is pressed.
    const actions = await import('@/app/(app)/settings/notifications/actions');
    expect(actions.saveTelegramTargetAction).not.toHaveBeenCalled();
  });

  it('MUST-8.10: renders the exact empty-state and error sentences', async () => {
    const withToken = props({
      tab: 'telegram',
      targets: { telegram: target({ channel: 'telegram', destination: '', secretSet: true }), email: null },
    });

    detect.mockResolvedValue({ chats: [] });
    const first = render(<NotificationsClient {...withToken} />);
    fireEvent.click(personalTelegram(first.container).getByText('Detect chat ID'));
    await waitFor(() =>
      expect(first.container.textContent).toContain(
        'No messages yet. Open Telegram, find your bot, send it any message, then press this again.',
      ),
    );
    cleanup();

    detect.mockResolvedValue({
      error: 'That bot token was rejected by Telegram. Check you pasted the whole thing, then save it again.',
    });
    const second = render(<NotificationsClient {...withToken} />);
    fireEvent.click(personalTelegram(second.container).getByText('Detect chat ID'));
    await waitFor(() =>
      expect(second.container.textContent).toContain(
        'That bot token was rejected by Telegram. Check you pasted the whole thing, then save it again.',
      ),
    );
  });
});

describe('Fix: the Chat ID field explains the token-first flow while it is still empty', () => {
  it('shows the hint when there is no destination yet, and hides it once one is saved', () => {
    const empty = render(
      <NotificationsClient
        {...props({
          tab: 'telegram',
          targets: { telegram: target({ channel: 'telegram', destination: '', secretSet: true }), email: null },
        })}
      />,
    );
    expect(empty.container.textContent).toContain('Fill this in after saving the token above');
    cleanup();

    const filled = render(
      <NotificationsClient
        {...props({
          tab: 'telegram',
          targets: { telegram: target({ channel: 'telegram', destination: '5551234', secretSet: true }), email: null },
        })}
      />,
    );
    expect(filled.container.textContent).not.toContain('Fill this in after saving the token above');
  });
});

// The page has three "Enabled" checkboxes (SMTP, Telegram, Email), all named "enabled" in
// separate <form>s, so neither text nor name alone is unique. Scoping from the Chat ID
// input's own <form> (unique by its #telegram-chat id) is what pins this to the Telegram one.
function telegramEnabledCheckbox(container: HTMLElement): HTMLInputElement {
  const chatIdInput = container.querySelector('#telegram-chat') as HTMLInputElement;
  const form = chatIdInput.closest('form') as HTMLFormElement;
  return form.querySelector('input[name="enabled"]') as HTMLInputElement;
}

/**
 * v1.28.0 Lane 2 (family channels): the admin page now also renders a "Family Telegram" card
 * with its own "Family chat ID" field and "Detect family chat ID" / "Send family test message"
 * buttons -- distinctly LABELLED (see notifications-client.tsx's own comment on
 * HouseholdTelegramFields), but a loose case-insensitive regex like /chat id/i still matches
 * both "Chat ID" and "Family chat ID" as a substring, and every query below predates that
 * second card. Scoping to the `#telegram-channel` wrapper (the personal Telegram Card's own
 * id, present since before this feature) is what keeps these pinned to the PERSONAL control
 * they were written to test, the same fix telegramEnabledCheckbox above already uses.
 */
function personalTelegram(container: HTMLElement) {
  return within(container.querySelector('#telegram-channel') as HTMLElement);
}

describe('Round 2 fix (HIGH): the Telegram Enabled checkbox defaults to the saved state and is disabled without a chat ID', () => {
  it('is unchecked and disabled for a brand-new target — the exact state guides.tsx step 6 leaves the form in', () => {
    const { container } = render(<NotificationsClient {...props({ tab: 'telegram' })} />);
    const checkbox = telegramEnabledCheckbox(container);
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
    expect(container.textContent).toContain('Enter a chat ID first.');
  });

  it('is unchecked and disabled for a saved token-only target (empty chat ID)', () => {
    const { container } = render(
      <NotificationsClient
        {...props({
          tab: 'telegram',
          targets: { telegram: target({ channel: 'telegram', destination: '', secretSet: true, enabled: false }), email: null },
        })}
      />,
    );
    const checkbox = telegramEnabledCheckbox(container);
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
  });

  it('is enabled and reflects the saved state once a chat ID exists', () => {
    const { container } = render(
      <NotificationsClient
        {...props({
          tab: 'telegram',
          targets: { telegram: target({ channel: 'telegram', destination: '5551234', secretSet: true, enabled: true }), email: null },
        })}
      />,
    );
    const checkbox = telegramEnabledCheckbox(container);
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(false);
  });

  it('typing a chat ID into the field re-enables the checkbox', () => {
    const { container } = render(<NotificationsClient {...props({ tab: 'telegram' })} />);
    const chatIdInput = personalTelegram(container).getByLabelText(/chat id/i) as HTMLInputElement;
    expect(telegramEnabledCheckbox(container).disabled).toBe(true);
    fireEvent.change(chatIdInput, { target: { value: '5551234' } });
    expect(telegramEnabledCheckbox(container).disabled).toBe(false);
  });
});

describe('Round 2 fix (MED): Send test message is disabled without a saved chat ID', () => {
  it('is disabled for a token-only target and enabled once a destination is saved', () => {
    const withoutDestination = render(
      <NotificationsClient
        {...props({
          tab: 'telegram',
          targets: { telegram: target({ channel: 'telegram', destination: '', secretSet: true, enabled: false }), email: null },
        })}
      />,
    );
    expect((personalTelegram(withoutDestination.container).getByText('Send test message') as HTMLButtonElement).disabled).toBe(
      true,
    );
    cleanup();

    const withDestination = render(
      <NotificationsClient
        {...props({
          tab: 'telegram',
          targets: { telegram: target({ channel: 'telegram', destination: '5551234', secretSet: true, enabled: true }), email: null },
        })}
      />,
    );
    expect((personalTelegram(withDestination.container).getByText('Send test message') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe('MUST-11.8: the guide closing line matches the rendered button label', () => {
  it('asserts against the button, not a duplicated literal', () => {
    const { getByText, container } = render(
      <NotificationsClient
        {...props({
          tab: 'telegram',
          targets: { telegram: target({ channel: 'telegram', destination: '1', secretSet: true }), email: null },
        })}
      />,
    );
    const label = (getByText('Send test message') as HTMLButtonElement).textContent ?? '';
    expect(container.textContent).toContain(`press ${label}`);
  });
});

describe('§11.4: the unverified badge', () => {
  it('shows until verified_at is set', () => {
    const unverified = render(<NotificationsClient {...props({ targets: { telegram: null, email: target() } })} />);
    expect(unverified.container.textContent).toContain('Unverified');
    cleanup();
    const verified = render(
      <NotificationsClient {...props({ targets: { telegram: null, email: target({ verifiedAt: '2026-08-17T12:00:00.000Z' }) } })} />,
    );
    expect(verified.container.textContent).not.toContain('Unverified');
  });
});

describe('§11.6: recent deliveries', () => {
  it('lists when, event, channel, status and the scrubbed error, with no retry button', () => {
    const { container, queryByText } = render(
      <NotificationsClient
        {...props({
          tab: 'deliveries',
          deliveries: [
            {
              id: 3,
              userId: 1,
              userName: 'Sam',
              channel: 'email',
              eventId: 'coming_due',
              status: 'failed',
              lastError: '550 mailbox unavailable',
              createdAt: '2026-08-17T12:00:00.000Z',
              sentAt: null,
            },
          ],
        })}
      />,
    );
    expect(container.textContent).toContain('Something is coming due');
    expect(container.textContent).toContain('550 mailbox unavailable');
    expect(queryByText(/retry/i)).toBeNull();
  });

  it('renders the timestamp in the app convention, not a raw ISO string', () => {
    const { container } = render(
      <NotificationsClient
        {...props({
          tab: 'deliveries',
          deliveries: [
            {
              id: 1,
              userId: 1,
              userName: 'Sam',
              channel: 'telegram',
              eventId: 'coming_due',
              status: 'sent',
              lastError: null,
              createdAt: '2026-08-17T12:34:56.000Z',
              sentAt: '2026-08-17T12:35:00.000Z',
            },
          ],
        })}
      />,
    );
    expect(container.textContent).toContain('2026-08-17 12:35');
    expect(container.textContent).not.toContain('2026-08-17T12:35:00.000Z');
  });

  it('review fix (LOW): renders each status as a badge, distinguishing sent/failed/pending', () => {
    const row = (status: 'sent' | 'failed' | 'pending') => ({
      id: 1,
      userId: 1,
      userName: 'Sam',
      channel: 'email' as const,
      eventId: 'coming_due',
      status,
      lastError: null,
      createdAt: '2026-08-17T12:00:00.000Z',
      sentAt: null,
    });
    const sent = render(<NotificationsClient {...props({ tab: 'deliveries', deliveries: [row('sent')] })} />);
    const sentBadge = sent.container.querySelector('.badge');
    expect(sentBadge?.textContent).toBe('Sent');
    expect(sentBadge?.className).toContain('badge--green');
    cleanup();

    const failed = render(<NotificationsClient {...props({ tab: 'deliveries', deliveries: [row('failed')] })} />);
    const failedBadge = failed.container.querySelector('.badge');
    expect(failedBadge?.textContent).toBe('Failed');
    expect(failedBadge?.className).toContain('badge--red');
    cleanup();

    const pending = render(<NotificationsClient {...props({ tab: 'deliveries', deliveries: [row('pending')] })} />);
    const pendingBadge = pending.container.querySelector('.badge');
    expect(pendingBadge?.textContent).toBe('Pending');
    expect(pendingBadge?.className).toContain('badge--amber');
  });

  it('review fix (LOW): shows an EmptyState instead of an empty table when there are zero rows', () => {
    // The page has one other <table> (the event/channel matrix), so scope the "no table"
    // assertion to the deliveries table specifically by checking its header cell is absent.
    const { container, queryByText } = render(<NotificationsClient {...props({ tab: 'deliveries', deliveries: [] })} />);
    expect(container.textContent).toContain('Nothing sent yet.');
    expect(queryByText('When')).toBeNull();
  });
});

describe('review fix (MED-LOW): Detect chat ID recovers from a rejected action', () => {
  it('re-enables the button and shows an inline error instead of sticking at "Working…"', async () => {
    detect.mockRejectedValue(new Error('network dropped'));
    const { container } = render(
      <NotificationsClient
        {...props({
          tab: 'telegram',
          targets: { telegram: target({ channel: 'telegram', destination: '', secretSet: true }), email: null },
        })}
      />,
    );
    // Captured once, before the click: an exact-text query still resolves uniquely (guides.tsx's
    // "press Detect chat ID" is a different string), but re-querying by text after the click
    // would not need to change either way — grabbing the same node keeps the assertion below
    // about this element regardless of its label at that instant ("Working…" vs "Detect chat ID").
    const button = personalTelegram(container).getByText('Detect chat ID') as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(button.textContent).toBe('Detect chat ID');
    expect(container.textContent).toContain('Could not reach the server');
  });
});

describe('review fix (LOW): stale local state does not survive a Remove', () => {
  it('the SMTP form resets to preset defaults once data.smtp goes from set to null', () => {
    const configured = props({
      smtp: {
        preset: 'gmail',
        host: 'smtp.gmail.com',
        port: 465,
        security: 'tls',
        username: 'me@example.com',
        fromEmail: 'me@example.com',
        fromName: 'Budget Tracker',
        enabled: true,
        passwordSet: true,
        lastError: null,
        lastErrorAt: null,
        lastSuccessAt: null,
      },
    });
    const { getByLabelText, rerender } = render(<NotificationsClient {...configured} />);
    expect((getByLabelText(/^server/i) as HTMLInputElement).value).toBe('smtp.gmail.com');

    // Simulate the server re-render a successful Remove causes: data.smtp -> null.
    rerender(<NotificationsClient {...props({ smtp: null })} />);
    expect((getByLabelText(/^server/i) as HTMLInputElement).value).toBe(SMTP_PRESETS.brevo.host);
  });

  it('the Telegram Chat ID field clears once data.targets.telegram goes from set to null', () => {
    const configured = props({
      tab: 'telegram',
      targets: { telegram: target({ channel: 'telegram', destination: '5551234', secretSet: true }), email: null },
    });
    const { container, rerender } = render(<NotificationsClient {...configured} />);
    expect((personalTelegram(container).getByLabelText(/chat id/i) as HTMLInputElement).value).toBe('5551234');

    rerender(<NotificationsClient {...props({ tab: 'telegram', targets: { telegram: null, email: null } })} />);
    expect((personalTelegram(container).getByLabelText(/chat id/i) as HTMLInputElement).value).toBe('');
  });
});

describe('review fix (MED): the admin payload never carries a delivery subject or attempts count', () => {
  it('toDeliveryForClient (page.tsx) strips subject and attempts, keeping everything the UI renders', async () => {
    const { toDeliveryForClient } = await import('@/app/(app)/settings/notifications/page');
    const raw = {
      id: 3,
      userId: 7,
      channel: 'email' as const,
      eventId: 'coming_due',
      subject: 'Coming due: Water heater warranty',
      status: 'sent' as const,
      attempts: 1,
      lastError: null,
      createdAt: '2026-08-17T12:00:00.000Z',
      sentAt: '2026-08-17T12:00:05.000Z',
    };
    const mapped = toDeliveryForClient(raw, 'Sam');
    const serialized = JSON.stringify(mapped);
    expect(serialized).not.toMatch(/"subject"/);
    expect(serialized).not.toMatch(/"attempts"/);
    expect(mapped).toMatchObject({
      id: 3,
      userId: 7,
      channel: 'email',
      eventId: 'coming_due',
      status: 'sent',
      lastError: null,
      createdAt: '2026-08-17T12:00:00.000Z',
      sentAt: '2026-08-17T12:00:05.000Z',
      userName: 'Sam',
    });
  });
});

describe('v1.15.0 (responsive rows, ruling S3): the preference matrix headline', () => {
  it('the Event cell of the first row carries cell-stack-headline', () => {
    const { container } = render(<NotificationsClient {...props({ tab: 'events' })} />);
    // v1.29.0: the preference matrix and the (admin-only) routing matrix both now live on the
    // Events tab, having moved off a page that used to also carry SMTP/Telegram/Email/
    // deliveries -- none of which render a table of their own. The preference matrix is still
    // the FIRST <table> on this tab; the routing matrix, when it renders at all, is the second.
    const matrix = container.querySelectorAll('table')[0];
    const headlineCell = matrix.querySelector('tbody tr td:first-child');
    expect(headlineCell?.className).toContain('cell-stack-headline');
  });
});

describe('MUST-5.3: no credential ever reaches these props', () => {
  it('the serialized props contain no password and no token field', () => {
    const serialized = JSON.stringify(props({ targets: { telegram: target({ channel: 'telegram', secretSet: true }), email: target() } }));
    expect(serialized).not.toMatch(/"password"/);
    expect(serialized).not.toMatch(/"botToken"/);
    expect(serialized).not.toMatch(/"secretEncrypted"/);
    expect(serialized).toContain('"secretSet":true');
  });

  it('v1.28.0 Lane 2: the same holds for the family channel -- serialized props and the rendered token field', () => {
    const data = props({
      tab: 'telegram',
      household: {
        targets: { telegram: householdTargetFixture({ secretSet: true }), email: null },
        eligibleEvents: householdEligibleEvents(),
        prefs: {},
      },
    });
    const serialized = JSON.stringify(data);
    expect(serialized).not.toMatch(/"botToken"/);
    expect(serialized).not.toMatch(/"secretEncrypted"/);
    expect(serialized).toContain('"secretSet":true');

    const { container } = render(<NotificationsClient {...data} />);
    const tokenField = container.querySelector('#household-telegram-token') as HTMLInputElement;
    expect(tokenField.value).toBe('');
    expect(tokenField.placeholder).toBe('•••••••• (saved)');
  });
});

describe('v1.28.0 Lane 2 / v1.29.0 split: the family channel cards', () => {
  // v1.29.0: the single "Family channels" card (one heading, three sub-sections) was split
  // three ways across the Email/Telegram/Events tabs -- see notifications-client.tsx's own
  // docblock beside the Family email card for why. There is no longer one render that shows
  // every family control at once, so what used to be one assertion against one render is now
  // one assertion per tab that actually carries it -- nothing here is weaker, each render
  // covers exactly the sub-section its own tab now owns.
  it('renders for an admin, and its controls are entirely absent for a member', () => {
    const adminTelegram = render(<NotificationsClient {...props({ role: 'admin', tab: 'telegram' })} />);
    expect(adminTelegram.container.textContent).toContain('Family Telegram');
    cleanup();

    const adminEmail = render(<NotificationsClient {...props({ role: 'admin', tab: 'email' })} />);
    expect(adminEmail.container.textContent).toContain('Family email');
    cleanup();

    const memberTelegram = render(<NotificationsClient {...props({ role: 'member', tab: 'telegram' })} />);
    expect(memberTelegram.container.textContent).not.toContain('Family Telegram');
    expect(memberTelegram.container.querySelector('#household-telegram-token')).toBeNull();
    cleanup();

    const memberEmail = render(<NotificationsClient {...props({ role: 'member', tab: 'email' })} />);
    expect(memberEmail.container.textContent).not.toContain('Family email');
    cleanup();

    const memberEvents = render(<NotificationsClient {...props({ role: 'member', tab: 'events' })} />);
    expect(memberEvents.container.querySelector('input[name^="household-pref:"]')).toBeNull();
  });

  it('a member sees nothing about the family channel when nothing is routed away from them -- no zero state', () => {
    const { container } = render(<NotificationsClient {...props({ role: 'member', tab: 'email' })} />);
    expect(container.textContent).not.toContain('Family channel');
  });

  it('a member sees a read-only explanation naming exactly what is routed away from them once an admin has routed something', () => {
    const eligible = householdEligibleEvents();
    const comingDue = eligible.find((event) => event.id === 'coming_due')!;
    const { container } = render(
      <NotificationsClient
        {...props({
          role: 'member',
          tab: 'email',
          household: {
            targets: null,
            eligibleEvents: eligible,
            prefs: { [comingDue.id]: { telegram: false, email: true } },
          },
        })}
      />,
    );
    expect(container.textContent).toContain('Family channel');
    expect(container.textContent).toContain(comingDue.label);
    // No controls -- read-only, per the brief's own choice of wording.
    expect(container.querySelector('input[name^="household-pref:"]')).toBeNull();
    expect(container.querySelector('#household-telegram-token')).toBeNull();
  });

  it('states the routing consequence in view, for both an admin and a member who is affected by it', () => {
    const SENTENCE =
      "Turn one of these on and that event goes to the family channel instead of to each person's own notifications — not both.";
    // For an admin the sentence sits beside the routing matrix (Events tab); for an affected
    // member it sits on the read-only summary card (Email tab) -- the two places that sentence
    // now lives since the split.
    const admin = render(<NotificationsClient {...props({ role: 'admin', tab: 'events' })} />);
    expect(admin.container.textContent).toContain(SENTENCE);
    cleanup();

    const eligible = householdEligibleEvents();
    const comingDue = eligible.find((event) => event.id === 'coming_due')!;
    const member = render(
      <NotificationsClient
        {...props({
          role: 'member',
          tab: 'email',
          household: { targets: null, eligibleEvents: eligible, prefs: { [comingDue.id]: { telegram: false, email: true } } },
        })}
      />,
    );
    expect(member.container.textContent).toContain(SENTENCE);
  });

  it('the routing matrix lists exactly householdEligibleEvents() -- an excluded security event has no control', () => {
    const eligible = householdEligibleEvents();
    const { container } = render(
      <NotificationsClient
        {...props({ tab: 'events', household: { targets: { telegram: null, email: null }, eligibleEvents: eligible, prefs: {} } })}
      />,
    );
    for (const event of eligible) {
      expect(container.querySelector(`input[name="household-pref:${event.id}:telegram"]`)).not.toBeNull();
      expect(container.querySelector(`input[name="household-pref:${event.id}:email"]`)).not.toBeNull();
    }
    // new_signin is a security event -- householdEligibleEvents() excludes it (household.ts's
    // own contract), and this asserts the matrix never invents a control it was not handed.
    expect(eligible.some((event) => event.id === 'new_signin')).toBe(false);
    expect(container.querySelector('input[name="household-pref:new_signin:telegram"]')).toBeNull();
    expect(container.querySelector('input[name="household-pref:new_signin:email"]')).toBeNull();
  });

  it('a column for an unconfigured family channel is disabled and explains why, exactly like the personal matrix', () => {
    const eligible = householdEligibleEvents();
    const comingDue = eligible.find((event) => event.id === 'coming_due')!;
    const { container } = render(
      <NotificationsClient
        {...props({
          tab: 'events',
          household: { targets: { telegram: null, email: householdTargetFixture({ channel: 'email' }) }, eligibleEvents: eligible, prefs: {} },
        })}
      />,
    );
    const telegramBox = container.querySelector(`input[name="household-pref:${comingDue.id}:telegram"]`) as HTMLInputElement;
    const emailBox = container.querySelector(`input[name="household-pref:${comingDue.id}:email"]`) as HTMLInputElement;
    expect(telegramBox.disabled).toBe(true);
    expect(telegramBox.title).toBe('Set up this channel first.');
    expect(emailBox.disabled).toBe(false);
  });

  it('removing a family channel opens a RowDialog naming what stops arriving; Cancel writes nothing, confirming calls removeHouseholdTargetAction', async () => {
    const eligible = householdEligibleEvents();
    const comingDue = eligible.find((event) => event.id === 'coming_due')!;
    const { container, getByText } = render(
      <NotificationsClient
        {...props({
          tab: 'telegram',
          household: {
            targets: { telegram: householdTargetFixture(), email: null },
            eligibleEvents: eligible,
            prefs: { [comingDue.id]: { telegram: true, email: false } },
          },
        })}
      />,
    );
    // Exactly one "Remove" button exists before the dialog opens: the personal Telegram card
    // renders none of its own (its target is null in this fixture), so this is the family
    // Telegram one.
    fireEvent.click(getByText('Remove'));
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain(comingDue.label);

    const actionsModule = await import('@/app/(app)/settings/notifications/actions');
    fireEvent.click(within(dialog).getByText('Cancel'));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(actionsModule.removeHouseholdTargetAction).not.toHaveBeenCalled();

    fireEvent.click(getByText('Remove'));
    const reopened = container.querySelector('[role="dialog"]') as HTMLElement;
    fireEvent.click(within(reopened).getByText('Remove'));
    await waitFor(() => expect(actionsModule.removeHouseholdTargetAction).toHaveBeenCalledTimes(1));
    const submitted = vi.mocked(actionsModule.removeHouseholdTargetAction).mock.calls[0]?.[0] as FormData;
    expect(submitted.get('channel')).toBe('telegram');
  });

  it('setting a family Telegram channel submits to saveHouseholdTelegramTargetAction', async () => {
    const { container } = render(<NotificationsClient {...props({ tab: 'telegram' })} />);
    const tokenField = container.querySelector('#household-telegram-token') as HTMLInputElement;
    const chatField = container.querySelector('#household-telegram-chat') as HTMLInputElement;
    fireEvent.change(tokenField, { target: { value: '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx' } });
    fireEvent.change(chatField, { target: { value: '-1001234567890' } });
    fireEvent.click(tokenField.closest('form')!.querySelector('button[type="submit"]')!);

    const actionsModule = await import('@/app/(app)/settings/notifications/actions');
    await waitFor(() => expect(actionsModule.saveHouseholdTelegramTargetAction).toHaveBeenCalledTimes(1));
    const submitted = vi.mocked(actionsModule.saveHouseholdTelegramTargetAction).mock.calls[0]?.[1] as FormData;
    expect(submitted.get('destination')).toBe('-1001234567890');
    expect(submitted.get('botToken')).toBe('123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx');
  });

  it('toggling a routing checkbox and saving submits to saveHouseholdPreferencesAction', async () => {
    const eligible = householdEligibleEvents();
    const comingDue = eligible.find((event) => event.id === 'coming_due')!;
    const { container } = render(
      <NotificationsClient
        {...props({
          tab: 'events',
          household: { targets: { telegram: null, email: householdTargetFixture({ channel: 'email' }) }, eligibleEvents: eligible, prefs: {} },
        })}
      />,
    );
    const emailBox = container.querySelector(`input[name="household-pref:${comingDue.id}:email"]`) as HTMLInputElement;
    fireEvent.click(emailBox);
    fireEvent.click(emailBox.closest('form')!.querySelector('button[type="submit"]')!);

    const actionsModule = await import('@/app/(app)/settings/notifications/actions');
    await waitFor(() => expect(actionsModule.saveHouseholdPreferencesAction).toHaveBeenCalledTimes(1));
    const submitted = vi.mocked(actionsModule.saveHouseholdPreferencesAction).mock.calls[0]?.[1] as FormData;
    expect(submitted.get(`household-pref:${comingDue.id}:email`)).toBe('on');
  });
});

describe('v1.29.0: four URL-driven tabs', () => {
  it('isNotificationTab accepts exactly the four tab values and rejects anything else', () => {
    expect(isNotificationTab('email')).toBe(true);
    expect(isNotificationTab('telegram')).toBe(true);
    expect(isNotificationTab('events')).toBe(true);
    expect(isNotificationTab('deliveries')).toBe(true);
    expect(isNotificationTab('sms')).toBe(false);
    expect(isNotificationTab('')).toBe(false);
    expect(isNotificationTab(undefined)).toBe(false);
    expect(isNotificationTab(42)).toBe(false);
  });

  it('each tab renders its own distinctive heading and none of the others', () => {
    const email = render(<NotificationsClient {...props({ tab: 'email' })} />);
    expect(email.container.textContent).toContain('Outbound email (SMTP)');
    expect(email.container.textContent).not.toContain('What you get told about');
    expect(email.container.textContent).not.toContain('Recent deliveries');
    cleanup();

    const telegram = render(<NotificationsClient {...props({ tab: 'telegram' })} />);
    expect(telegram.container.textContent).toContain('Family Telegram');
    expect(telegram.container.textContent).not.toContain('Outbound email (SMTP)');
    expect(telegram.container.textContent).not.toContain('What you get told about');
    cleanup();

    const events = render(<NotificationsClient {...props({ tab: 'events' })} />);
    expect(events.container.textContent).toContain('What you get told about');
    expect(events.container.textContent).not.toContain('Recent deliveries');
    expect(events.container.textContent).not.toContain('Outbound email (SMTP)');
    cleanup();

    const deliveries = render(<NotificationsClient {...props({ tab: 'deliveries' })} />);
    expect(deliveries.container.textContent).toContain('Recent deliveries');
    expect(deliveries.container.textContent).not.toContain('What you get told about');
    expect(deliveries.container.textContent).not.toContain('Outbound email (SMTP)');
  });

  it('the PillNav marks exactly one option aria-current="page", matching the passed tab', () => {
    const { container } = render(<NotificationsClient {...props({ tab: 'events' })} />);
    const current = container.querySelectorAll('nav a[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe('Events');
  });

  it('the PillNav renders all four options in order, each linking to its own ?tab=', () => {
    const { container } = render(<NotificationsClient {...props({ tab: 'email' })} />);
    const nav = container.querySelector('nav[aria-label="Which notification settings to show"]') as HTMLElement;
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Email', 'Telegram', 'Events', 'Deliveries']);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/settings/notifications?tab=email',
      '/settings/notifications?tab=telegram',
      '/settings/notifications?tab=events',
      '/settings/notifications?tab=deliveries',
    ]);
  });

  it('a member on the Email tab does not see the "Outbound email (SMTP)" heading', () => {
    const { container } = render(<NotificationsClient {...props({ role: 'member', tab: 'email' })} />);
    expect(container.textContent).not.toContain('Outbound email (SMTP)');
  });
});
