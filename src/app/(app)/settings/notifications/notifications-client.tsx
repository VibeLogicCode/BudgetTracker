'use client';

import { useActionState, useState } from 'react';
import { BellIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { AlertIcon, ClockIcon, ConfirmIcon, type IconComponent } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { PillNav } from '@/components/ui/PillNav';
import { RowDialog } from '@/components/ui/RowDialog';
import { TableWrap } from '@/components/ui/Table';
import { Field, hintClass, inputClass, selectClass } from '@/components/ui/form';
import { SubmitButton } from '@/components/SubmitButton';
import type { SmtpPreset, SmtpRecord, TargetRecord, UserSettings } from '@/lib/notify/config';
import type { SMTP_PRESETS } from '@/lib/notify/config';
import type { Channel, NotificationEventDef } from '@/lib/notify/events';
import { eventDef } from '@/lib/notify/events';
// v1.28.0 Lane 2 (family channels): the household row shape lives in its own module, distinct
// from the personal TargetRecord above (src/lib/notify/household.ts's own docblock explains
// why the two are not shared).
import type { NotificationTargetRow } from '@/lib/notify/household';
import type { DeliveryRow } from '@/lib/notify/outbox';
import {
  detectHouseholdTelegramChatIdAction,
  detectTelegramChatIdAction,
  removeHouseholdTargetAction,
  removeSmtpAction,
  removeTargetAction,
  saveEmailTargetAction,
  saveHouseholdEmailTargetAction,
  saveHouseholdPreferencesAction,
  saveHouseholdTelegramTargetAction,
  savePreferencesAction,
  saveSmtpAction,
  saveTelegramTargetAction,
  testHouseholdTargetAction,
  testSmtpAction,
  testTargetAction,
  type DetectChatIdState,
  type NotificationsState,
} from './actions';
import { EmailGuide, GuidePanel, TelegramGuide } from './guides';
import { NOTIFICATION_TABS, TAB_LABEL, type NotificationTab } from './tabs';

/**
 * v1.29.0 (notifications page restructure). Six long cards on one scroll became four short
 * URL-driven pages instead of four `useState`-driven panels, for the same reason nothing else
 * in this app switches views with client state: this app has no client-side router, on
 * purpose, so a "tab" that lives only in React state is not a URL -- it cannot be bookmarked,
 * cannot be linked to from elsewhere on the page (see the Recent deliveries empty state
 * below), and the back button does not undo it. PillNav's own docblock makes the identical
 * argument for why it renders `aria-current="page"` rather than `"true"`: that attribute is
 * only honest when each option genuinely IS a distinct page, which is exactly what a
 * `?tab=` link is and a panel toggle is not. Reusing PillNav completely unchanged -- rather
 * than reaching for a second, ARIA-`tablist`-flavoured widget -- is what keeps that argument
 * true here instead of merely quotable; see the deliberate absence of `role="tablist"` below
 * for the other half of that same reasoning.
 *
 * The tab vocabulary itself lives in ./tabs, NOT here -- page.tsx has to validate `?tab=` on
 * the server, and a Server Component cannot call a function it imported from a `'use client'`
 * module. See that file's docblock; it is a v1.29.1 fix for a crash v1.29.0 shipped.
 */

export interface NotificationsPageData {
  role: 'admin' | 'member';
  /** Which of the four URL-driven sections is active -- see NotificationTab's own docblock
   *  just above. Read from `?tab=` by page.tsx, defaulting to `'email'`. */
  tab: NotificationTab;
  /** Admins only: a member never receives the relay record (§11.3). */
  smtp: SmtpRecord | null;
  /** Everyone: whether an enabled relay exists, so a member's email card explains itself. */
  relayConfigured: boolean;
  targets: { telegram: TargetRecord | null; email: TargetRecord | null };
  events: readonly NotificationEventDef[];
  /** Effective values, keyed `${eventId}:${channel}` (MUST-3.7, resolved on the server). */
  prefs: Record<string, boolean>;
  settings: UserSettings;
  /**
   * Review fix (MED): `subject` and `attempts` are stripped server-side (page.tsx's
   * `toDeliveryForClient`): neither is ever rendered here, and for an admin's household-wide
   * view `subject` would otherwise carry other members' warranty/category names into a payload
   * nothing displays.
   */
  deliveries: (Omit<DeliveryRow, 'subject' | 'attempts'> & { userName: string })[];
  presets: typeof SMTP_PRESETS;
  /**
   * v1.28.0 Lane 2: the family (household) channels. Set by an admin (decision 1); routed
   * per eligible event, per channel (decision 2). `targets` is withheld from a member's
   * payload entirely -- the same §11.3 withholding `smtp` above already gets -- because a
   * member has no controls to render and no business seeing the family channel's destination
   * or secret state, only the CONSEQUENCE of it (which events go there instead of to them).
   */
  household: {
    targets: { telegram: NotificationTargetRow | null; email: NotificationTargetRow | null } | null;
    /** Already role-narrowed server-side, mirroring how `events` above is `eventsFor(role)` --
     *  a member's copy carries only the events their OWN role could ever receive personally. */
    eligibleEvents: readonly NotificationEventDef[];
    /** Resolved booleans, default false (not routed) when a pair was never touched. */
    prefs: Record<string, { telegram: boolean; email: boolean }>;
  };
}

const CHANNELS = ['telegram', 'email'] as const;
const PASSWORD_PLACEHOLDER = '•••••••• (saved)'; // MUST-5.6
const NO_CHANNEL_TOOLTIP = 'Set up this channel first.'; // MUST-11.3
/** §11.4: the three kind labels shown beside a detected chat. */
const KIND_LABEL = { private: 'Private chat', group: 'Group', supergroup: 'Group', channel: 'Channel' } as const;
const NO_RELAY = 'An admin needs to set up outbound email before this can send.'; // §11.3
const PRIVACY_SENTENCE =
  'Messages contain amounts, category names and merchant names, and are delivered by Telegram or by your email provider.'; // MUST-11.4
const BACKUP_SENTENCE =
  'The SMTP password and every bot token are stored encrypted in the database, which means they are inside the unencrypted backup archive along with everything else.'; // MUST-5.8
const DORMANT =
  'Notifications are off. This app makes no outbound connection until you configure a channel here.'; // §11.2
/**
 * v1.28.0 Lane 2, decision 4. The one sentence the brief requires "in view, not in a
 * collapsed guide" beside the routing matrix -- and, read-only, beside the member's own
 * summary of what an admin has routed away from them. Asserted verbatim by both call sites'
 * tests, so its exact wording is pinned here once rather than typed twice.
 */
const HOUSEHOLD_INSTEAD_OF_SENTENCE =
  "Turn one of these on and that event goes to the family channel instead of to each person's own notifications — not both.";
/** Could not reach the server at all (network drop, dev-server restart), distinct from the
 * server-returned `{ error }` shape DetectChatIdState already carries. */
const DETECT_UNREACHABLE = 'Could not reach the server. Check your connection and try again.';

/**
 * Review fix (LOW): the app's one timestamp convention (see settings/backups/backups-client.tsx),
 * applied everywhere this page shows a raw ISO string. §11.4's "relative time" wording is
 * amended to this fixed format: see the note beside MUST-11.2 in the design spec.
 */
function formatStamp(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

const STATUS_BADGE: Record<DeliveryRow['status'], { label: string; className: string; Icon: IconComponent }> = {
  sent: { label: 'Sent', className: 'badge--green', Icon: ConfirmIcon },
  failed: { label: 'Failed', className: 'badge--red', Icon: AlertIcon },
  pending: { label: 'Pending', className: 'badge--amber', Icon: ClockIcon },
};

/** §11.6: "status badge": sent/failed/pending are visually distinct, not bare text. Lane 4
 *  (2026-08-30 one-design-language plan) adds the lucide glyph each state already had a word
 *  for -- decorative, since the label text beside it still carries the fact for a screen
 *  reader. */
function DeliveryStatusBadge({ status }: { status: DeliveryRow['status'] }) {
  const { label, className, Icon } = STATUS_BADGE[status];
  return (
    <span className={`badge ${className}`}>
      <Icon aria-hidden="true" className="mr-1 inline h-3 w-3" />
      {label}
    </span>
  );
}

/**
 * Review fix (LOW): after a successful Remove, `data.smtp` flips to `null` on the next
 * server render, but this component's own `host`/`port`/`security`/`preset` state (seeded
 * once from the OLD `data.smtp` at mount) has no reason to re-run, so the form would keep
 * showing the deleted relay's values. The parent renders this with
 * `key={data.smtp ? 'set' : 'unset'}`, so a Remove (or a first Save) remounts it and every
 * `useState` initializer re-reads the current `data.smtp`.
 */
function SmtpFields({
  smtp,
  presets,
  smtpState,
  saveSmtp,
  runSmtpTest,
  runSmtpRemove,
  smtpTestState,
  smtpRemoveState,
}: {
  smtp: SmtpRecord | null;
  presets: typeof SMTP_PRESETS;
  smtpState: NotificationsState;
  saveSmtp: (formData: FormData) => void;
  runSmtpTest: (formData: FormData) => void;
  runSmtpRemove: (formData: FormData) => void;
  smtpTestState: NotificationsState;
  smtpRemoveState: NotificationsState;
}) {
  const [preset, setPreset] = useState<SmtpPreset>(smtp?.preset ?? 'brevo');
  const [host, setHost] = useState(smtp?.host ?? presets.brevo.host);
  const [port, setPort] = useState(String(smtp?.port ?? presets.brevo.port));
  const [security, setSecurity] = useState(smtp?.security ?? presets.brevo.security);

  // MUST-8.15: the picker prefills; every field stays editable afterwards.
  function choosePreset(next: SmtpPreset) {
    setPreset(next);
    setHost(presets[next].host);
    setPort(String(presets[next].port));
    setSecurity(presets[next].security);
  }

  return (
    <>
      {smtpState.error ? <Notice tone="error">{smtpState.error}</Notice> : null}
      {smtpState.message ? <Notice tone="success">{smtpState.message}</Notice> : null}
      {/*
        v1.29.0: eight-plus full-width fields (the worst offender a 3-character Port input
        stretched the width of the container) become four paired rows -- the same `grid gap-4
        sm:grid-cols-2` idiom this codebase already uses for a field pair (users-manager.tsx's
        "Add a user" card, settings/page.tsx's admin link grid, and this very file's routing
        table wrapper), not a new layout system. Encryption pairs with Preset rather than
        sitting alone on its own row: it has no natural partner among the remaining fields
        (Server/Port and Username/Password and From address/From name are each already a
        matched pair), and a lone full-width row would waste exactly the space this change
        exists to reclaim. Below `sm` every pair stacks back to one field per row, which is
        correct for a phone-width form.
      */}
      <form action={saveSmtp} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Preset" htmlFor="smtp-preset">
            <select
              id="smtp-preset"
              name="preset"
              className={selectClass}
              value={preset}
              onChange={(event) => choosePreset(event.target.value as SmtpPreset)}
            >
              <option value="brevo">Brevo</option>
              <option value="smtp2go">SMTP2GO</option>
              <option value="gmail">Gmail</option>
              <option value="custom">Custom SMTP</option>
            </select>
          </Field>
          <Field label="Encryption" htmlFor="smtp-security">
            <select
              id="smtp-security"
              name="security"
              className={selectClass}
              value={security}
              onChange={(e) => setSecurity(e.target.value as typeof security)}
            >
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS</option>
              <option value="none">None</option>
            </select>
          </Field>
        </div>
        {/* MUST-8.16 */}
        {security === 'none' ? (
          <Notice tone="warning">
            Credentials and message contents will cross the network unencrypted. Only use this for a relay on your own LAN.
          </Notice>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Server" htmlFor="smtp-host">
            <input id="smtp-host" name="host" className={inputClass} value={host} onChange={(e) => setHost(e.target.value)} />
          </Field>
          <Field label="Port" htmlFor="smtp-port">
            <input id="smtp-port" name="port" inputMode="numeric" className={inputClass} value={port} onChange={(e) => setPort(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username" htmlFor="smtp-username">
            <input id="smtp-username" name="username" className={inputClass} defaultValue={smtp?.username ?? ''} />
          </Field>
          <Field
            label="Password"
            htmlFor="smtp-password"
            hint={smtp?.passwordSet ? 'Leave blank to keep the saved password.' : undefined}
          >
            <input
              id="smtp-password"
              name="password"
              type="password"
              autoComplete="new-password"
              className={inputClass}
              placeholder={smtp?.passwordSet ? PASSWORD_PLACEHOLDER : ''}
              defaultValue=""
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From address" htmlFor="smtp-from">
            <input id="smtp-from" name="fromEmail" className={inputClass} defaultValue={smtp?.fromEmail ?? ''} />
          </Field>
          <Field label="From name" htmlFor="smtp-from-name">
            <input id="smtp-from-name" name="fromName" className={inputClass} defaultValue={smtp?.fromName ?? 'Budget Tracker'} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="enabled" defaultChecked={smtp?.enabled ?? true} />
          Enabled
        </label>
        <div className="flex flex-wrap gap-2">
          <SubmitButton>Save</SubmitButton>
        </div>
      </form>
      <div className="flex flex-wrap gap-2">
        <form action={runSmtpTest}>
          <SubmitButton variant="secondary">Send test email</SubmitButton>
        </form>
        {smtp ? (
          <form
            action={runSmtpRemove}
            onSubmit={(event) => {
              if (!window.confirm('Remove the outbound email settings? Email notifications will stop until it is set up again.')) {
                event.preventDefault();
              }
            }}
          >
            <SubmitButton variant="danger">Remove SMTP settings</SubmitButton>
          </form>
        ) : null}
      </div>
      {smtpTestState.error ? <Notice tone="error">{smtpTestState.error}</Notice> : null}
      {smtpTestState.message ? <Notice tone="success">{smtpTestState.message}</Notice> : null}
      {smtpRemoveState.message ? <Notice tone="success">{smtpRemoveState.message}</Notice> : null}
      {smtp?.lastSuccessAt ? <p className={hintClass}>Last successful send: {formatStamp(smtp.lastSuccessAt)}</p> : null}
      {/* MUST-11.7: only the selected preset's guide is ever rendered. */}
      <GuidePanel open={smtp === null}>
        <EmailGuide preset={preset} />
      </GuidePanel>
    </>
  );
}

/**
 * Review fix (LOW / MED-LOW): owns the Chat ID field, the detected-chat list and the Detect
 * button's own busy/error state, all reset together by the parent's `key={data.targets.telegram
 * ? 'set' : 'unset'}` the same way SmtpFields is. detect() now has a try/finally (MED-LOW): a
 * rejected action used to leave the button stuck disabled at "Working…" forever, since
 * `setDetecting(false)` never ran.
 */
function TelegramFields({
  telegram,
  telegramState,
  saveTelegram,
  runTelegramTest,
  runTelegramRemove,
  telegramTestState,
  telegramRemoveState,
}: {
  telegram: TargetRecord | null;
  telegramState: NotificationsState;
  saveTelegram: (formData: FormData) => void;
  runTelegramTest: (formData: FormData) => void;
  runTelegramRemove: (formData: FormData) => void;
  telegramTestState: NotificationsState;
  telegramRemoveState: NotificationsState;
}) {
  const [chatId, setChatId] = useState(telegram?.destination ?? '');
  const [detected, setDetected] = useState<DetectChatIdState | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  async function detect() {
    setDetecting(true);
    setDetectError(null);
    try {
      setDetected(await detectTelegramChatIdAction());
    } catch {
      setDetectError(DETECT_UNREACHABLE);
    } finally {
      setDetecting(false);
    }
  }

  return (
    <>
      {telegramState.error ? <Notice tone="error">{telegramState.error}</Notice> : null}
      {telegramState.message ? <Notice tone="success">{telegramState.message}</Notice> : null}
      {telegram && telegram.verifiedAt === null ? (
        <p className={hintClass}>Unverified — press Send test message to prove it works.</p>
      ) : null}
      {telegram?.lastError ? (
        <Notice tone="error">
          {telegram.lastError} ({telegram.lastErrorAt ? formatStamp(telegram.lastErrorAt) : telegram.lastErrorAt})
        </Notice>
      ) : null}
      {telegram?.lastSuccessAt ? <p className={hintClass}>Last successful send: {formatStamp(telegram.lastSuccessAt)}</p> : null}

      <form action={saveTelegram} className="flex flex-col gap-4">
        <Field
          label="Bot token"
          htmlFor="telegram-token"
          hint={telegram?.secretSet ? 'Leave blank to keep the saved token.' : undefined}
        >
          <input
            id="telegram-token"
            name="botToken"
            type="password"
            autoComplete="off"
            className={inputClass}
            placeholder={telegram?.secretSet ? PASSWORD_PLACEHOLDER : ''}
            defaultValue=""
          />
        </Field>
        <Field
          label="Chat ID"
          htmlFor="telegram-chat"
          hint={!telegram?.destination ? 'Fill this in after saving the token above — use Detect chat ID, or type it in yourself.' : undefined}
        >
          <input
            id="telegram-chat"
            name="destination"
            inputMode="numeric"
            className={inputClass}
            value={chatId}
            onChange={(event) => setChatId(event.target.value)}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-ink">
            {/* Round 2 fix (HIGH): defaults to the SAVED enabled state, never true, so a
                brand-new target's checkbox starts unchecked instead of silently asking to
                enable a channel that has no chat ID yet. Disabled outright while the chat ID
                field is empty — a disabled checkbox is excluded from the submitted form
                entirely, so the server always sees enabled=false in that state regardless of
                what was checked before the field was cleared. */}
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={telegram?.enabled ?? false}
              disabled={chatId.trim().length === 0}
            />
            Enabled
          </label>
          {chatId.trim().length === 0 ? <span className={hintClass}>Enter a chat ID first.</span> : null}
        </div>
        <div>
          <SubmitButton>Save</SubmitButton>
        </div>
      </form>

      {/* MUST-11.2: the Detect chat ID control, immediately beside the Chat ID field. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn--secondary"
          disabled={!telegram?.secretSet || detecting}
          onClick={detect}
        >
          {detecting ? 'Working…' : 'Detect chat ID'}
        </button>
        {!telegram?.secretSet ? <span className={hintClass}>Save your bot token first</span> : null}
      </div>
      {detectError ? <Notice tone="error">{detectError}</Notice> : null}
      {detected?.error ? <Notice tone="error">{detected.error}</Notice> : null}
      {detected?.chats?.length === 0 ? (
        <Notice tone="info">
          No messages yet. Open Telegram, find your bot, send it any message, then press this again.
        </Notice>
      ) : null}
      {detected?.chats && detected.chats.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {detected.chats.map((chat) => (
            <li key={chat.chatId}>
              <label className="flex flex-wrap items-center gap-2 text-sm text-ink">
                <input type="radio" name="detected-chat" value={chat.chatId} onChange={() => setChatId(chat.chatId)} />
                <span className="font-semibold">{chat.title}</span>
                <span className="text-muted">{KIND_LABEL[chat.kind]}</span>
                <span className="text-subtle">{chat.chatId}</span>
                {chat.lastMessageAt ? <span className="text-subtle">last message {formatStamp(chat.lastMessageAt)}</span> : null}
              </label>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <form action={runTelegramTest}>
          <input type="hidden" name="channel" value="telegram" />
          {/* Round 2 fix (MED): a token-only target (saved, but with no chat ID yet) has
              nowhere to send a test message — disabled on the saved destination, not the
              live chatId field, matching the Detect button's use of telegram?.secretSet. */}
          <SubmitButton variant="secondary" disabled={!telegram?.destination}>
            Send test message
          </SubmitButton>
        </form>
        {telegram ? (
          <form action={runTelegramRemove}>
            <input type="hidden" name="channel" value="telegram" />
            <SubmitButton variant="danger">Remove</SubmitButton>
          </form>
        ) : null}
      </div>
      {telegramTestState.error ? <Notice tone="error">{telegramTestState.error}</Notice> : null}
      {telegramTestState.message ? <Notice tone="success">{telegramTestState.message}</Notice> : null}
      {telegramRemoveState.message ? <Notice tone="success">{telegramRemoveState.message}</Notice> : null}

      {/* MUST-11.7: open by default until a token has been saved, collapsed afterwards. */}
      <GuidePanel open={!telegram?.secretSet}>
        <TelegramGuide />
      </GuidePanel>
    </>
  );
}

/**
 * v1.28.0 Lane 2. The family Telegram half of "Family channels" -- deliberately built by
 * reusing TelegramFields' own idiom (same field order, same Detect-chat-id flow, same
 * Unverified/last-error/last-success readouts) rather than a from-scratch form, per the
 * brief's own "not a parallel implementation" instruction. Two differences from the personal
 * version, both because a household row has no owning user: there is no per-user Enabled
 * checkbox (the household API's own upsertHouseholdTarget takes no `enabled` field -- once a
 * destination exists, the per-EVENT routing matrix is what decides whether anything actually
 * goes to it), and Remove opens a RowDialog (`onRemove`) instead of submitting inline, since
 * removing the household's only Telegram target is the destructive, page-level kind of
 * decision RowDialog's own docblock reserves a dialog for (it acts on data shared by every
 * member, not a row one person owns).
 */
function HouseholdTelegramFields({
  telegram,
  telegramState,
  saveTelegram,
  runTelegramTest,
  telegramTestState,
  onRemove,
  suggestedDestination,
}: {
  telegram: NotificationTargetRow | null;
  telegramState: NotificationsState;
  saveTelegram: (formData: FormData) => void;
  runTelegramTest: (formData: FormData) => void;
  telegramTestState: NotificationsState;
  onRemove: () => void;
  /**
   * The admin's OWN personal Telegram chat ID, offered as a starting point for a brand-new
   * family channel -- never applied once one already exists. This exists because of the
   * household API's own constraint (src/lib/notify/household.ts: upsertHouseholdTarget refuses
   * ANY empty destination, so there is no household equivalent of the personal form's
   * token-only save while Detect chat ID is used to discover one). The owner's own bug report
   * is the common case this answers directly: a bot already running in a group chat shared
   * with a spouse IS that admin's own personal Telegram destination already -- so prefilling
   * from it turns "you must already know the chat ID" into "here is a likely guess, confirm or
   * change it."
   */
  suggestedDestination?: string;
}) {
  const [chatId, setChatId] = useState(telegram?.destination ?? suggestedDestination ?? '');
  const [detected, setDetected] = useState<DetectChatIdState | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  async function detect() {
    setDetecting(true);
    setDetectError(null);
    try {
      setDetected(await detectHouseholdTelegramChatIdAction());
    } catch {
      setDetectError(DETECT_UNREACHABLE);
    } finally {
      setDetecting(false);
    }
  }

  return (
    <>
      {telegramState.error ? <Notice tone="error">{telegramState.error}</Notice> : null}
      {telegramState.message ? <Notice tone="success">{telegramState.message}</Notice> : null}
      {telegram && telegram.verifiedAt === null ? (
        <p className={hintClass}>Unverified — press Send family test message to prove it works.</p>
      ) : null}
      {telegram?.lastError ? (
        <Notice tone="error">
          {telegram.lastError} ({telegram.lastErrorAt ? formatStamp(telegram.lastErrorAt) : telegram.lastErrorAt})
        </Notice>
      ) : null}
      {telegram?.lastSuccessAt ? <p className={hintClass}>Last successful send: {formatStamp(telegram.lastSuccessAt)}</p> : null}

      {/*
        Every label and button below is prefixed "family" -- not decorative, but the fix for a
        real collision: this section sits on the same page as the personal Telegram card above,
        which has its own "Bot token" / "Chat ID" fields and "Detect chat ID" / "Send test
        message" buttons. Two controls sharing one accessible name is already a bad time for a
        screen-reader or voice-control user asking for "Chat ID" (which one?); giving each its
        own name fixes that for everyone, not just this file's own getByLabelText/getByText
        queries (tests/app/notifications-client.test.tsx pins the PERSONAL ones as unique).
      */}
      <form action={saveTelegram} className="flex flex-col gap-4">
        <Field
          label="Family bot token"
          htmlFor="household-telegram-token"
          hint={telegram?.secretSet ? 'Leave blank to keep the saved token.' : undefined}
        >
          <input
            id="household-telegram-token"
            name="botToken"
            type="password"
            autoComplete="off"
            className={inputClass}
            placeholder={telegram?.secretSet ? PASSWORD_PLACEHOLDER : ''}
            defaultValue=""
          />
        </Field>
        <Field
          label="Family chat ID"
          htmlFor="household-telegram-chat"
          hint={
            !telegram
              ? suggestedDestination
                ? 'Prefilled from your own Telegram channel above — the family channel is usually the same chat. Change it if not.'
                : 'A bot token and a chat ID are needed together here — there is no token-only save like the Telegram card above. Not sure of the number? Set up the personal Telegram channel above with the same bot first and press its Detect chat ID; the number it finds will be suggested here too.'
              : undefined
          }
        >
          <input
            id="household-telegram-chat"
            name="destination"
            inputMode="numeric"
            className={inputClass}
            value={chatId}
            onChange={(event) => setChatId(event.target.value)}
          />
        </Field>
        <div>
          <SubmitButton>Save</SubmitButton>
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn--secondary"
          disabled={!telegram?.secretSet || detecting}
          onClick={detect}
        >
          {detecting ? 'Working…' : 'Detect family chat ID'}
        </button>
        {!telegram?.secretSet ? <span className={hintClass}>Save the family bot token first</span> : null}
      </div>
      {detectError ? <Notice tone="error">{detectError}</Notice> : null}
      {detected?.error ? <Notice tone="error">{detected.error}</Notice> : null}
      {detected?.chats?.length === 0 ? (
        <Notice tone="info">
          No messages yet. Add the bot to the family chat, send it any message, then press this again.
        </Notice>
      ) : null}
      {detected?.chats && detected.chats.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {detected.chats.map((chat) => (
            <li key={chat.chatId}>
              <label className="flex flex-wrap items-center gap-2 text-sm text-ink">
                <input type="radio" name="household-detected-chat" value={chat.chatId} onChange={() => setChatId(chat.chatId)} />
                <span className="font-semibold">{chat.title}</span>
                <span className="text-muted">{KIND_LABEL[chat.kind]}</span>
                <span className="text-subtle">{chat.chatId}</span>
                {chat.lastMessageAt ? <span className="text-subtle">last message {formatStamp(chat.lastMessageAt)}</span> : null}
              </label>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <form action={runTelegramTest}>
          <input type="hidden" name="channel" value="telegram" />
          <SubmitButton variant="secondary" disabled={!telegram?.destination}>
            Send family test message
          </SubmitButton>
        </form>
        {telegram ? (
          <Button variant="danger" onClick={onRemove}>
            Remove
          </Button>
        ) : null}
      </div>
      {telegramTestState.error ? <Notice tone="error">{telegramTestState.error}</Notice> : null}
      {telegramTestState.message ? <Notice tone="success">{telegramTestState.message}</Notice> : null}
    </>
  );
}

/**
 * The family email half. Simpler than HouseholdTelegramFields: an email destination needs no
 * secret and no Detect step, so this mirrors the personal Email card's own body exactly,
 * including gating Send test / Remove behind `relayConfigured` the same way (§11.3: nothing
 * can send, personal or household, until an admin has set up the relay). No Enabled checkbox
 * here either, for the same reason as the Telegram half above.
 */
function HouseholdEmailFields({
  email,
  emailState,
  saveEmail,
  runEmailTest,
  emailTestState,
  relayConfigured,
  onRemove,
}: {
  email: NotificationTargetRow | null;
  emailState: NotificationsState;
  saveEmail: (formData: FormData) => void;
  runEmailTest: (formData: FormData) => void;
  emailTestState: NotificationsState;
  relayConfigured: boolean;
  onRemove: () => void;
}) {
  return (
    <>
      {emailState.error ? <Notice tone="error">{emailState.error}</Notice> : null}
      {emailState.message ? <Notice tone="success">{emailState.message}</Notice> : null}
      {email && email.verifiedAt === null ? (
        <p className={hintClass}>Unverified — press Send family test email to prove it works.</p>
      ) : null}
      {email?.lastError ? (
        <Notice tone="error">
          {email.lastError} ({email.lastErrorAt ? formatStamp(email.lastErrorAt) : email.lastErrorAt})
        </Notice>
      ) : null}
      {email?.lastSuccessAt ? <p className={hintClass}>Last successful send: {formatStamp(email.lastSuccessAt)}</p> : null}

      {/* "Family" prefixes here for the same reason HouseholdTelegramFields' own comment gives:
          the personal Email card above already has an "Email address" field and a "Send test
          email" button, so a shared name would be ambiguous for anyone querying by label or
          text, not only this file's own tests. */}
      <form action={saveEmail} className="flex flex-col gap-4">
        <Field label="Family email address" htmlFor="household-email-destination">
          <input
            id="household-email-destination"
            name="destination"
            type="email"
            className={inputClass}
            defaultValue={email?.destination ?? ''}
          />
        </Field>
        <div>
          <SubmitButton>Save</SubmitButton>
        </div>
      </form>

      {relayConfigured ? (
        <div className="flex flex-wrap gap-2">
          <form action={runEmailTest}>
            <input type="hidden" name="channel" value="email" />
            <SubmitButton variant="secondary" disabled={!email}>
              Send family test email
            </SubmitButton>
          </form>
          {email ? (
            <Button variant="danger" onClick={onRemove}>
              Remove
            </Button>
          ) : null}
        </div>
      ) : (
        <Notice tone="info">{NO_RELAY}</Notice>
      )}
      {emailTestState.error ? <Notice tone="error">{emailTestState.error}</Notice> : null}
      {emailTestState.message ? <Notice tone="success">{emailTestState.message}</Notice> : null}
    </>
  );
}

export function NotificationsClient(data: NotificationsPageData) {
  const [smtpState, saveSmtp] = useActionState<NotificationsState, FormData>(saveSmtpAction, {});
  const [telegramState, saveTelegram] = useActionState<NotificationsState, FormData>(saveTelegramTargetAction, {});
  const [emailState, saveEmail] = useActionState<NotificationsState, FormData>(saveEmailTargetAction, {});
  const [prefsState, savePrefs] = useActionState<NotificationsState, FormData>(savePreferencesAction, {});
  // The various runXAction() functions below only ever appear as a <form action={...}>, never
  // as an event handler, so `useActionState`'s dispatch (a plain (payload) => void) is what
  // gets bound, not the underlying async server action (which resolves to NotificationsState,
  // a shape `<form action>` cannot accept). This is the same wrapping every other form on this
  // page already needs for save/dispatch.
  const [smtpTestState, runSmtpTest] = useActionState<NotificationsState, FormData>(() => testSmtpAction(), {});
  const [smtpRemoveState, runSmtpRemove] = useActionState<NotificationsState, FormData>(() => removeSmtpAction(), {});
  const [telegramTestState, runTelegramTest] = useActionState<NotificationsState, FormData>(
    (_prev, formData) => testTargetAction(formData),
    {},
  );
  const [telegramRemoveState, runTelegramRemove] = useActionState<NotificationsState, FormData>(
    (_prev, formData) => removeTargetAction(formData),
    {},
  );
  const [emailTestState, runEmailTest] = useActionState<NotificationsState, FormData>(
    (_prev, formData) => testTargetAction(formData),
    {},
  );
  const [emailRemoveState, runEmailRemove] = useActionState<NotificationsState, FormData>(
    (_prev, formData) => removeTargetAction(formData),
    {},
  );

  // v1.28.0 Lane 2: family channels. Same useActionState wrapping as every save/test/remove
  // pair above, for the same reason (a plain dispatch is what `<form action>` needs).
  const [householdTelegramState, saveHouseholdTelegram] = useActionState<NotificationsState, FormData>(
    saveHouseholdTelegramTargetAction,
    {},
  );
  const [householdEmailState, saveHouseholdEmail] = useActionState<NotificationsState, FormData>(
    saveHouseholdEmailTargetAction,
    {},
  );
  const [householdTelegramTestState, runHouseholdTelegramTest] = useActionState<NotificationsState, FormData>(
    (_prev, formData) => testHouseholdTargetAction(formData),
    {},
  );
  const [householdEmailTestState, runHouseholdEmailTest] = useActionState<NotificationsState, FormData>(
    (_prev, formData) => testHouseholdTargetAction(formData),
    {},
  );
  const [householdTelegramRemoveState, runHouseholdTelegramRemove] = useActionState<NotificationsState, FormData>(
    (_prev, formData) => removeHouseholdTargetAction(formData),
    {},
  );
  const [householdEmailRemoveState, runHouseholdEmailRemove] = useActionState<NotificationsState, FormData>(
    (_prev, formData) => removeHouseholdTargetAction(formData),
    {},
  );
  const [householdPrefsState, saveHouseholdPrefs] = useActionState<NotificationsState, FormData>(
    saveHouseholdPreferencesAction,
    {},
  );
  // Which family channel's Remove dialog is open, if any -- the same nullable-slot idiom
  // RowDialog's own callers already use (merchant-rules-client.tsx's `deletingRule`), so this
  // dialog is only ever mounted while it is actually open.
  const [removingHouseholdChannel, setRemovingHouseholdChannel] = useState<Channel | null>(null);

  // Which of the household's eligible events are currently routed to a given channel -- used
  // both by the removal dialog (naming what stops arriving) and the member's read-only view
  // (naming what is arriving elsewhere).
  function routedToHousehold(channel: Channel): readonly NotificationEventDef[] {
    return data.household.eligibleEvents.filter((event) => data.household.prefs[event.id]?.[channel] ?? false);
  }

  function householdRemoveDialog() {
    const channel = removingHouseholdChannel;
    if (!channel) return null;
    const label = channel === 'telegram' ? 'Telegram' : 'email';
    const routed = routedToHousehold(channel);
    const removeAction = channel === 'telegram' ? runHouseholdTelegramRemove : runHouseholdEmailRemove;
    return (
      <RowDialog
        dialogId="remove-household-channel-dialog"
        title={`Remove the family ${label} channel?`}
        onClose={() => setRemovingHouseholdChannel(null)}
      >
        <p className="text-sm text-ink">
          {routed.length > 0
            ? `${routed.map((event) => event.label).join(', ')} ${routed.length === 1 ? 'is' : 'are'} routed here. Once this is removed, ${
                routed.length === 1 ? 'it goes' : 'they go'
              } back to each person individually.`
            : 'Nothing is currently routed to it, so removing it changes nothing anyone receives.'}
        </p>
        <div className="flex gap-2">
          <form action={removeAction} onSubmit={() => setRemovingHouseholdChannel(null)}>
            <input type="hidden" name="channel" value={channel} />
            <SubmitButton variant="danger" size="sm">
              Remove
            </SubmitButton>
          </form>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setRemovingHouseholdChannel(null)}>
            Cancel
          </button>
        </div>
      </RowDialog>
    );
  }

  const dormant =
    !(data.targets.telegram?.enabled ?? false) && !(data.targets.email?.enabled ?? false);
  const liveErrors = [
    data.targets.telegram?.lastError ? { channel: 'Telegram', error: data.targets.telegram.lastError } : null,
    data.targets.email?.lastError ? { channel: 'Email', error: data.targets.email.lastError } : null,
    data.smtp?.lastError ? { channel: 'Outbound email (SMTP)', error: data.smtp.lastError } : null,
  ].filter((entry): entry is { channel: string; error: string } => entry !== null);

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {dormant ? <Notice tone="info">{DORMANT}</Notice> : null}
      {liveErrors.map((entry) => (
        <Notice key={entry.channel} tone="error" title={entry.channel}>
          {entry.error}
        </Notice>
      ))}

      <PillNav
        groupLabel="Which notification settings to show"
        options={NOTIFICATION_TABS.map((key) => ({
          key,
          href: `/settings/notifications?tab=${key}`,
          label: TAB_LABEL[key],
          active: data.tab === key,
        }))}
      />

      {data.tab === 'email' ? (
        <>
          {/* §11.3: admins only. A member never sees this card at all. */}
          {data.role === 'admin' ? (
            <Card>
              <CardHeader title="Outbound email (SMTP)" description="One relay for the whole household." />
              <CardBody className="flex flex-col gap-4">
                {/* Review fix (LOW): keyed so a Remove (data.smtp -> null) or a first Save
                    (null -> a record) remounts this subtree instead of leaving stale local state
                    (host/port/security/preset) showing the deleted relay's values. */}
                <SmtpFields
                  key={data.smtp ? 'set' : 'unset'}
                  smtp={data.smtp}
                  presets={data.presets}
                  smtpState={smtpState}
                  saveSmtp={saveSmtp}
                  runSmtpTest={runSmtpTest}
                  runSmtpRemove={runSmtpRemove}
                  smtpTestState={smtpTestState}
                  smtpRemoveState={smtpRemoveState}
                />
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Email" description="Where the household relay sends your messages." />
            <CardBody className="flex flex-col gap-4">
              {emailState.error ? <Notice tone="error">{emailState.error}</Notice> : null}
              {emailState.message ? <Notice tone="success">{emailState.message}</Notice> : null}
              {data.targets.email && data.targets.email.verifiedAt === null ? (
                <p className={hintClass}>Unverified — press Send test email to prove it works.</p>
              ) : null}
              {data.targets.email?.lastError ? (
                <Notice tone="error">
                  {data.targets.email.lastError} ({data.targets.email.lastErrorAt ? formatStamp(data.targets.email.lastErrorAt) : data.targets.email.lastErrorAt})
                </Notice>
              ) : null}
              {data.targets.email?.lastSuccessAt ? (
                <p className={hintClass}>Last successful send: {formatStamp(data.targets.email.lastSuccessAt)}</p>
              ) : null}

              <form action={saveEmail} className="flex flex-col gap-4">
                <Field label="Email address" htmlFor="email-destination">
                  <input
                    id="email-destination"
                    name="destination"
                    type="email"
                    className={inputClass}
                    defaultValue={data.targets.email?.destination ?? ''}
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" name="enabled" defaultChecked={data.targets.email?.enabled ?? true} />
                  Enabled
                </label>
                <div>
                  <SubmitButton>Save</SubmitButton>
                </div>
              </form>

              {/* §11.3: where a member's email channel is unusable for want of a relay. */}
              {data.relayConfigured ? (
                <div className="flex flex-wrap gap-2">
                  <form action={runEmailTest}>
                    <input type="hidden" name="channel" value="email" />
                    <SubmitButton variant="secondary" disabled={!data.targets.email}>
                      Send test email
                    </SubmitButton>
                  </form>
                  {data.targets.email ? (
                    <form action={runEmailRemove}>
                      <input type="hidden" name="channel" value="email" />
                      <SubmitButton variant="danger">Remove</SubmitButton>
                    </form>
                  ) : null}
                </div>
              ) : (
                <Notice tone="info">{NO_RELAY}</Notice>
              )}
              {emailTestState.error ? <Notice tone="error">{emailTestState.error}</Notice> : null}
              {emailTestState.message ? <Notice tone="success">{emailTestState.message}</Notice> : null}
              {emailRemoveState.message ? <Notice tone="success">{emailRemoveState.message}</Notice> : null}
            </CardBody>
          </Card>

          {/*
            v1.28.0 Lane 2 / v1.29.0 split: the family EMAIL half of what used to be one
            "Family channels" card sharing all three sub-sections. Splitting it three ways
            (this file's other two halves are the Family Telegram card on the Telegram tab and
            the routing-matrix card on the Events tab) is what the page-length problem actually
            was: one card answering three different questions ("where do MY messages go",
            "where does the household's email go", "which events get routed away from me") is
            why this page was too long to scan in the first place, not a formatting issue a
            grid could fix. Each question now lives beside the other cards that answer the
            same one. Admin-only controls; a member sees the SAME unified read-only summary as
            before (naming both channels together, not split three ways) below, because it is
            one statement of fact about what already happened to their notifications, not a
            control surface -- splitting a sentence nobody can act on would not make it easier
            to find.
          */}
          {data.role === 'admin' ? (
            <Card>
              <CardHeader title="Family email" description="One address for the whole household." />
              <CardBody className="flex flex-col gap-4">
                <HouseholdEmailFields
                  key={data.household.targets?.email ? 'set' : 'unset'}
                  email={data.household.targets?.email ?? null}
                  emailState={householdEmailState}
                  saveEmail={saveHouseholdEmail}
                  runEmailTest={runHouseholdEmailTest}
                  emailTestState={householdEmailTestState}
                  relayConfigured={data.relayConfigured}
                  onRemove={() => setRemovingHouseholdChannel('email')}
                />
              </CardBody>
            </Card>
          ) : (
            (() => {
              const routedTelegram = routedToHousehold('telegram');
              const routedEmail = routedToHousehold('email');
              if (routedTelegram.length === 0 && routedEmail.length === 0) return null;
              return (
                <Card>
                  <CardHeader title="Family channel" description="Set up by an admin, for the whole household." />
                  <CardBody className="flex flex-col gap-2">
                    <p className="text-sm text-ink">{HOUSEHOLD_INSTEAD_OF_SENTENCE}</p>
                    {routedTelegram.length > 0 ? (
                      <p className="text-sm text-muted">
                        On Telegram: {routedTelegram.map((event) => event.label).join(', ')} — sent to the family chat instead of to you.
                      </p>
                    ) : null}
                    {routedEmail.length > 0 ? (
                      <p className="text-sm text-muted">
                        By email: {routedEmail.map((event) => event.label).join(', ')} — sent to the family address instead of to you.
                      </p>
                    ) : null}
                  </CardBody>
                </Card>
              );
            })()
          )}
        </>
      ) : null}

      {data.tab === 'telegram' ? (
        <>
          {/* §11.4: everyone. Two sub-cards; each shows its own last_error, last_success_at,
              and an Unverified badge until verified_at is set. */}
          <div id="telegram-channel">
          <Card>
            <CardHeader title="Telegram" description="Your own bot, messaging your own chat." />
            <CardBody className="flex flex-col gap-4">
              {/* Review fix (LOW): same remount-on-Remove/Save reasoning as SmtpFields above. */}
              <TelegramFields
                key={data.targets.telegram ? 'set' : 'unset'}
                telegram={data.targets.telegram}
                telegramState={telegramState}
                saveTelegram={saveTelegram}
                runTelegramTest={runTelegramTest}
                runTelegramRemove={runTelegramRemove}
                telegramTestState={telegramTestState}
                telegramRemoveState={telegramRemoveState}
              />
            </CardBody>
          </Card>
          </div>

          {/* v1.28.0 Lane 2 / v1.29.0 split: the family TELEGRAM half -- see the docblock
              beside the Family email card on the Email tab for why this used to share a card
              with that one and no longer does. */}
          {data.role === 'admin' ? (
            <Card>
              <CardHeader title="Family Telegram" description="One chat for the whole household." />
              <CardBody className="flex flex-col gap-4">
                <HouseholdTelegramFields
                  key={data.household.targets?.telegram ? 'set' : 'unset'}
                  telegram={data.household.targets?.telegram ?? null}
                  telegramState={householdTelegramState}
                  saveTelegram={saveHouseholdTelegram}
                  runTelegramTest={runHouseholdTelegramTest}
                  telegramTestState={householdTelegramTestState}
                  onRemove={() => setRemovingHouseholdChannel('telegram')}
                  suggestedDestination={data.targets.telegram?.destination || undefined}
                />
              </CardBody>
            </Card>
          ) : null}
        </>
      ) : null}

      {data.tab === 'events' ? (
        <>
          {/* §11.5: the matrix, generated from data.events. NO event is named in JSX. */}
          <Card>
            <CardHeader title="What you get told about" description="Per event, per channel." />
            <CardBody className="flex flex-col gap-4">
              {prefsState.error ? <Notice tone="error">{prefsState.error}</Notice> : null}
              {prefsState.message ? <Notice tone="success">{prefsState.message}</Notice> : null}
              <form action={savePrefs} className="flex flex-col gap-4">
                <TableWrap responsive>
                  <thead>
                    <tr>
                      <th className="text-left">Event</th>
                      <th>Telegram</th>
                      <th>Email</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.events.map((event) => (
                      <tr key={event.id}>
                        {/* v1.15.0 (responsive rows): the event name is what tells one row from
                            another in this matrix, so it is the phone card's headline. No
                            cell-stack-amount: nothing on this row is money. */}
                        <td className="text-left cell-stack-headline" data-label="Event">
                          <span className="font-semibold text-ink">{event.label}</span>
                          <span className="block text-muted">{event.blurb}</span>
                        </td>
                        {CHANNELS.map((channel) => {
                          const configured = data.targets[channel]?.enabled ?? false;
                          return (
                            <td key={channel} className="text-center" data-label={channel === 'telegram' ? 'Telegram' : 'Email'}>
                              <input
                                type="checkbox"
                                name={`pref:${event.id}:${channel}`}
                                defaultChecked={data.prefs[`${event.id}:${channel}`] ?? event.defaultEnabled}
                                disabled={!configured}
                                title={configured ? undefined : NO_CHANNEL_TOOLTIP}
                                aria-label={`${event.label} on ${channel}`}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
                <p className="text-sm text-muted">{PRIVACY_SENTENCE}</p>
                <p className={hintClass}>{BACKUP_SENTENCE}</p>
                {/* The five knobs, each with its default in the hint text. */}
                <Field label="Days before a due date to warn" htmlFor="comingDueDays" hint="Default 14.">
                  <input id="comingDueDays" name="comingDueDays" inputMode="numeric" className={inputClass} defaultValue={String(data.settings.comingDueDays)} />
                </Field>
                <Field label="Budget warning threshold (%)" htmlFor="budgetThresholdPct" hint="Default 80. 100 is the separate over-budget alert.">
                  <input id="budgetThresholdPct" name="budgetThresholdPct" inputMode="numeric" className={inputClass} defaultValue={String(data.settings.budgetThresholdPct)} />
                </Field>
                <Field label="Weeks without an import before nagging" htmlFor="staleImportWeeks" hint="Default 3.">
                  <input id="staleImportWeeks" name="staleImportWeeks" inputMode="numeric" className={inputClass} defaultValue={String(data.settings.staleImportWeeks)} />
                </Field>
                <Field label="Daily message hour" htmlFor="dailyHour" hint="Default 8 (24-hour clock).">
                  <input id="dailyHour" name="dailyHour" inputMode="numeric" className={inputClass} defaultValue={String(data.settings.dailyHour)} />
                </Field>
                <Field label="Weekly summary day" htmlFor="digestWeekday" hint="Default Monday.">
                  <select id="digestWeekday" name="digestWeekday" className={selectClass} defaultValue={String(data.settings.digestWeekday)}>
                    {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => (
                      <option key={day} value={String(index)}>
                        {day}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Weekly summary hour" htmlFor="digestHour" hint="Default 8 (24-hour clock).">
                  <input id="digestHour" name="digestHour" inputMode="numeric" className={inputClass} defaultValue={String(data.settings.digestHour)} />
                </Field>
                <div>
                  <SubmitButton>Save</SubmitButton>
                </div>
              </form>
            </CardBody>
          </Card>

          {/*
            v1.28.0 Lane 2 / v1.29.0 split: the ROUTING half of what used to be one "Family
            channels" card -- see the docblock beside the Family email card on the Email tab
            for why it no longer shares a card with the two target halves. Admin-only; a
            member's read-only equivalent lives on the Email tab (that card's own docblock
            says why it is not, itself, split three ways). Nothing renders here at all when
            householdEligibleEvents() is empty -- there is no routing control without an
            eligible event to route, and an always-present empty card would be the zero-state
            this codebase's design language asks to avoid.
          */}
          {data.role === 'admin' && data.household.eligibleEvents.length > 0 ? (
            <Card>
              <CardHeader
                title="Route to the family channel"
                description="A routed event goes to the family channel instead of to you."
              />
              <CardBody className="flex flex-col gap-4">
                {householdPrefsState.error ? <Notice tone="error">{householdPrefsState.error}</Notice> : null}
                {householdPrefsState.message ? <Notice tone="success">{householdPrefsState.message}</Notice> : null}
                <form action={saveHouseholdPrefs} className="flex flex-col gap-4">
                  <TableWrap responsive>
                    <thead>
                      <tr>
                        <th className="text-left">Event</th>
                        <th>Telegram</th>
                        <th>Email</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.household.eligibleEvents.map((event) => (
                        <tr key={event.id}>
                          <td className="text-left cell-stack-headline" data-label="Event">
                            <span className="font-semibold text-ink">{event.label}</span>
                            <span className="block text-muted">{event.blurb}</span>
                          </td>
                          {CHANNELS.map((channel) => {
                            const configured = data.household.targets?.[channel] != null;
                            return (
                              <td key={channel} className="text-center" data-label={channel === 'telegram' ? 'Telegram' : 'Email'}>
                                <input
                                  type="checkbox"
                                  name={`household-pref:${event.id}:${channel}`}
                                  defaultChecked={data.household.prefs[event.id]?.[channel] ?? false}
                                  disabled={!configured}
                                  title={configured ? undefined : NO_CHANNEL_TOOLTIP}
                                  aria-label={`${event.label} to the family channel on ${channel}`}
                                />
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </TableWrap>
                  {/* Decision 4, stated in view rather than left to a collapsed guide. */}
                  <p className="text-sm text-ink">{HOUSEHOLD_INSTEAD_OF_SENTENCE}</p>
                  <div>
                    <SubmitButton>Save routing</SubmitButton>
                  </div>
                </form>
              </CardBody>
            </Card>
          ) : null}
        </>
      ) : null}

      {data.tab === 'deliveries' ? (
        <>
          {/* §11.6: read-only. No retry button: the pump owns retries. */}
          <Card>
            <CardHeader title="Recent deliveries" description="The last twenty messages this app tried to send." />
            {data.deliveries.length === 0 ? (
              <EmptyState
                icon={BellIcon}
                title="Nothing sent yet."
                action={
                  <a href="/settings/notifications?tab=telegram#telegram-channel" className="btn btn--primary btn--sm">
                    Set up a channel
                  </a>
                }
              >
                Deliveries appear here once a channel is set up and an event fires.
              </EmptyState>
            ) : (
              <CardBody>
                <TableWrap responsive>
                  <thead>
                    <tr>
                      <th className="text-left">When</th>
                      {data.role === 'admin' ? <th className="text-left">Who</th> : null}
                      <th className="text-left">Event</th>
                      <th className="text-left">Channel</th>
                      <th className="text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.deliveries.map((row) => (
                      <tr key={row.id}>
                        <td data-label="When">{formatStamp(row.sentAt ?? row.createdAt)}</td>
                        {data.role === 'admin' ? <td data-label="Who">{row.userName}</td> : null}
                        {/* v1.15.0 (responsive rows): the event is what tells one delivery from
                            another -- When is nearly as specific, but the event is the thing a
                            person is actually looking for in this log -- so it is the headline. No
                            cell-stack-amount: a delivery carries no money of its own. */}
                        <td className="cell-stack-headline" data-label="Event">{eventDef(row.eventId)?.label ?? row.eventId}</td>
                        <td data-label="Channel">{row.channel}</td>
                        <td data-label="Status">
                          <DeliveryStatusBadge status={row.status} />
                          {row.lastError ? <span className="block text-muted">{row.lastError}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              </CardBody>
            )}
          </Card>
        </>
      ) : null}

      {householdRemoveDialog()}
    </div>
  );
}
