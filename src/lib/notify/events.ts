/**
 * The event registry (spec §4): PURE and client-safe (MUST-2.1). No @/db import, no
 * @/lib/env import, no node builtin: this module is imported by the client-side toggle
 * matrix, and importing @/db here fails the client webpack build outright (Ruling P4, the
 * same constraint that governs src/lib/warranty/constants.ts).
 *
 * MUST-4.4: the extension point. Adding an event type is: append one entry below, add one
 * case to renderEvent() in render.ts, and (for a scheduled event) one evaluator call. No
 * migration. No src/db/schema.ts change. No UI change: the matrix is generated from this
 * array.
 *
 * MUST-4.5: an `id` is PERMANENT once shipped. notification_prefs keys on the string, so
 * renaming one silently resets every user's stored preference for it.
 */
export type Channel = 'telegram' | 'email';
export const CHANNELS: readonly Channel[] = ['telegram', 'email'];

export function isChannel(value: string): value is Channel {
  return value === 'telegram' || value === 'email';
}

/** `h` for a household budget, `p` for the recipient's personal one (MUST-3.11). */
export type BudgetScopeKey = 'household' | 'personal';

/**
 * v1.28.0. Whether a notification_targets row is one person's channel or the household's
 * single shared one. Declared here rather than next to the table because the settings
 * matrix is a client component and this module is the client-safe half of notify (MUST-2.1).
 */
export type TargetScope = 'personal' | 'household';

export type NotificationAudience = 'all' | 'admin';
export type NotificationTrigger = 'daily_slot' | 'weekly_slot' | 'tick' | 'immediate';

export interface NotificationEventDef {
  /** The stable storage key. Never renamed once shipped (MUST-4.5). */
  readonly id: string;
  readonly label: string;
  /** One sentence under the label in the toggle matrix. */
  readonly blurb: string;
  readonly audience: NotificationAudience;
  readonly trigger: NotificationTrigger;
  readonly defaultEnabled: boolean;
  /**
   * v1.28.0. Whether an admin may route this event to the household's shared channel.
   * ORTHOGONAL to `audience`, which says who receives a message; this says whether the
   * message belongs in a room the whole family reads.
   *
   * The line: an event that describes HOUSEHOLD MONEY is eligible -- the digests, the
   * budget events, the spending alerts, the savings targets, what is coming due. An event
   * that describes an ACCOUNT, a SESSION or an OPERATIONAL OUTCOME is not. A group chat is
   * exactly the wrong place for "somebody signed in as you": the person who needs to act on
   * it is one person, the message names their account, and a shared room is the one place
   * they cannot un-see it or act on it privately.
   *
   * This is not merely a default the UI hides. An ineligible event is UNROUTABLE: refused by
   * setHouseholdEventPref at the write path and refused again at the send path
   * (src/lib/notify/outbox.ts's buildRequest), so a hand-edited notification_household_prefs
   * row cannot post a security event into a group chat.
   *
   * Note the invariant tests/lib/notify/events.test.ts asserts: every eligible event has
   * audience 'all'. Nothing admin-only is household money, and if a future event breaks that
   * pairing it is far likelier to be a mistake than a new idea.
   */
  readonly householdEligible: boolean;
}

/**
 * MUST-4.1: the defaults split on one line: ON for "something is wrong, or a deadline is
 * near"; OFF for the chattier informational events a person should opt into. new_signin
 * is on because a security event nobody switched on protects nobody.
 *
 * MUST-4.2: a default of ON has effect only once a channel exists. A user with no
 * notification_targets row receives nothing, defaults notwithstanding.
 */
export const NOTIFICATION_EVENTS: readonly NotificationEventDef[] = [
  {
    id: 'coming_due',
    label: 'Something is coming due',
    blurb: 'A warranty, subscription, contract or loan reaches its date soon, or a bill installment is due.',
    audience: 'all',
    trigger: 'daily_slot',
    defaultEnabled: true,
    householdEligible: true,
  },
  {
    id: 'budget_threshold',
    label: 'A budget is getting close',
    blurb: 'A category has passed the percentage you set for this month.',
    audience: 'all',
    trigger: 'tick',
    defaultEnabled: false,
    householdEligible: true,
  },
  {
    id: 'budget_exceeded',
    label: 'A budget is blown',
    blurb: 'A category has spent more than its limit for this month.',
    audience: 'all',
    trigger: 'tick',
    defaultEnabled: true,
    householdEligible: true,
  },
  {
    id: 'backup_failed',
    label: 'The nightly backup failed',
    blurb: 'The unattended 2am backup did not complete.',
    audience: 'admin',
    trigger: 'immediate',
    defaultEnabled: true,
    householdEligible: false,
  },
  {
    id: 'weekly_digest',
    label: 'Weekly spending summary',
    blurb: 'What the household spent over the last seven days.',
    audience: 'all',
    trigger: 'weekly_slot',
    defaultEnabled: false,
    householdEligible: true,
  },
  {
    id: 'new_signin',
    label: 'New sign-in to your account',
    blurb: 'Somebody signed in as you, from somewhere.',
    audience: 'all',
    trigger: 'immediate',
    defaultEnabled: true,
    householdEligible: false,
  },
  {
    id: 'password_changed',
    label: 'Your password was changed',
    blurb: 'Somebody changed the password on your account.',
    audience: 'all',
    trigger: 'immediate',
    defaultEnabled: true,
    householdEligible: false,
  },
  {
    id: 'mfa_disabled',
    label: 'Two-factor was switched off',
    blurb: 'Two-factor authentication was turned off on your account.',
    audience: 'all',
    trigger: 'immediate',
    defaultEnabled: true,
    householdEligible: false,
  },
  {
    id: 'restore_outcome',
    label: 'A restore finished',
    blurb: 'A backup was restored into this install, successfully or not.',
    audience: 'admin',
    trigger: 'immediate',
    defaultEnabled: true,
    householdEligible: false,
  },
  {
    id: 'stale_import',
    label: 'Nothing has been imported lately',
    blurb: 'An account has gone the number of weeks you set with no import, checked per account.',
    audience: 'all',
    trigger: 'daily_slot',
    defaultEnabled: false,
    householdEligible: false,
  },
  {
    id: 'update_available',
    label: 'An update is available',
    blurb: 'A newer version of Budget Tracker is published and is waiting for your say-so.',
    audience: 'admin',
    trigger: 'tick',
    defaultEnabled: true,
    householdEligible: false,
  },
  {
    id: 'budget_pace',
    label: 'On pace to go over budget',
    blurb: 'A category is heading past its limit before the month is out.',
    audience: 'all',
    trigger: 'daily_slot',
    defaultEnabled: true,
    householdEligible: true,
  },
  {
    id: 'unusual_transaction',
    label: 'An unusually large charge',
    blurb: 'A charge is several times what that merchant usually costs.',
    audience: 'all',
    trigger: 'tick',
    defaultEnabled: true,
    householdEligible: true,
  },
  {
    id: 'subscription_creep',
    label: 'A recurring charge went up',
    blurb: 'A subscription or bill came in higher than the last few did.',
    audience: 'all',
    trigger: 'daily_slot',
    defaultEnabled: true,
    householdEligible: true,
  },
  {
    id: 'duplicate_charge',
    label: 'A possible duplicate charge',
    blurb: 'The same merchant charged the same amount twice within a few days.',
    audience: 'all',
    trigger: 'tick',
    defaultEnabled: true,
    householdEligible: true,
  },
  {
    id: 'predicted_vs_actual',
    label: 'Last month, predicted against actual',
    blurb: 'Early each month, how the month just gone compared with what the six months before it pointed at.',
    audience: 'all',
    trigger: 'daily_slot',
    defaultEnabled: false,
    householdEligible: true,
  },
  {
    id: 'suggested_budget_refresh',
    label: 'New month, new suggested budgets',
    blurb: 'Early each month, the categories whose suggested budget has moved away from the limit you have set.',
    audience: 'all',
    trigger: 'daily_slot',
    defaultEnabled: false,
    householdEligible: true,
  },
  {
    id: 'sync_failed',
    label: 'A SimpleFIN sync failed',
    blurb: 'The unattended sync could not finish and needs a look.',
    audience: 'admin',
    trigger: 'immediate',
    defaultEnabled: true,
    householdEligible: false,
  },
  {
    id: 'monthly_digest',
    label: 'Monthly household summary',
    blurb: 'Income, spending and budgets for the month that just ended.',
    audience: 'all',
    trigger: 'daily_slot',
    defaultEnabled: false,
    householdEligible: true,
  },
  {
    // Lane 2, spec docs/superpowers/plans/2026-08-30-savings-targets.md. Ruling T3: household
    // scope only, so this fires against ONE pooled figure -- never a per-person one.
    id: 'savings_target_met',
    label: "You hit this month's savings target",
    blurb: "This month's net income has reached the savings target you set.",
    audience: 'all',
    trigger: 'tick',
    defaultEnabled: true,
    householdEligible: true,
  },
  {
    // Ruling T5: pro-rated against the day of the month, not a projection to month end --
    // see evaluate/savings.ts's fireSavingsPace for why that distinction matters here.
    id: 'savings_target_pace',
    label: 'On pace to miss the savings target',
    blurb: "Net so far this month is behind the pace this month's savings target needs.",
    audience: 'all',
    trigger: 'daily_slot',
    defaultEnabled: true,
    householdEligible: true,
  },
  {
    id: 'savings_month_closed',
    label: "Last month's savings, against target",
    blurb: "How last month's net compared with the savings target you set for it.",
    audience: 'all',
    trigger: 'daily_slot',
    defaultEnabled: true,
    householdEligible: true,
  },
  {
    // Backlog item 17 / Part 4 (version awareness): "wire a line into the existing notification
    // digest so it can be told once, rather than only on a page visit". Modelled exactly on
    // update_available immediately above -- same audience, same trigger label, same default --
    // because a preset pack update is the identical shape of fact (a version comparison, nothing
    // urgent, admin's call whether to act), evaluated the same way (src/lib/canadian-pack.ts's
    // notifyCanadianPackUpdateAvailable, called from runUpdateTick alongside the app's own check;
    // see that function's docblock for why it only ever NOTIFIES, never applies anything).
    id: 'pack_update_available',
    label: 'A merchant rules pack update is available',
    blurb: 'A merchant rules pack you installed (e.g. the Canadian pack) has a newer version published.',
    audience: 'admin',
    trigger: 'tick',
    defaultEnabled: true,
    householdEligible: false,
  },
];

export function eventDef(id: string): NotificationEventDef | undefined {
  return NOTIFICATION_EVENTS.find((event) => event.id === id);
}

export function isNotificationEventId(value: string): boolean {
  return eventDef(value) !== undefined;
}

/**
 * MUST-4.3: audience 'admin' events are never enqueued for a member, never rendered in a
 * member's matrix, and are skipped for a user who has since been demoted.
 */
export function eventsFor(role: 'admin' | 'member'): readonly NotificationEventDef[] {
  return role === 'admin' ? NOTIFICATION_EVENTS : NOTIFICATION_EVENTS.filter((event) => event.audience === 'all');
}

/**
 * v1.28.0: the events an admin may route to a family channel. PURE, so the settings matrix
 * can render the household column from the same registry the personal one comes from
 * (MUST-4.4: adding an event is still one append to the array above).
 */
export function householdEligibleEvents(): readonly NotificationEventDef[] {
  return NOTIFICATION_EVENTS.filter((event) => event.householdEligible);
}

/** The one predicate every household guard calls. An unknown id is never eligible. */
export function isHouseholdEligible(eventId: string): boolean {
  return eventDef(eventId)?.householdEligible === true;
}

/**
 * MUST-3.11: the dedup keys, exactly. user_id and channel are already part of the unique
 * index (MUST-3.9) and are never repeated inside a key.
 *
 * MUST-3.12 (pruning safety): every key below is either bounded to a calendar period that
 * evaluation only visits within the current few days, or derived from a monotonically
 * increasing timestamp that never recurs, so the 400-day retention sweep can never
 * resurrect an already-delivered event.
 */
function scopeLetter(scope: BudgetScopeKey): 'h' | 'p' {
  return scope === 'household' ? 'h' : 'p';
}

/** Once per item per expiry date, EVER. Editing the date is a new fact and a new key. */
export function comingDueKey(itemId: number, expiryDate: string): string {
  return `due:${itemId}:${expiryDate}`;
}

/**
 * v1.12.0. Once per installment per due date, EVER -- editing the date is a new fact and gets a
 * new key, exactly as comingDueKey treats an edited expiry date.
 *
 * The `bill:` prefix is LOAD-BEARING. comingDueKey is `due:<itemId>:<date>`, and an item's own
 * end date can legitimately equal one of its installment due dates; under a shared prefix one
 * message would silently suppress the other.
 */
export function installmentDueKey(installmentId: number, dueDate: string): string {
  return `bill:${installmentId}:${dueDate}`;
}

/**
 * v1.12.0, ruling B16. MUST-3.12 requires every dedup key to be bounded to a calendar period
 * evaluation only visits within the current few days, or derived from a never-recurring
 * timestamp. An overdue installment stays overdue for ever, so a date-free key
 * (`overdue:<id>`) would be announced once and then RE-announced whenever the 400-day retention
 * sweep pruned it -- the exact resurrection MUST-3.12 forbids. Keying it by calendar month makes
 * it an honest monthly nag with a bounded key.
 *
 * `month` is YYYY-MM.
 */
export function installmentOverdueKey(installmentId: number, month: string): string {
  return `overdue:${installmentId}:${month}`;
}

/** Once per scope/category/month/threshold. The pct is the user's configured threshold. */
export function budgetThresholdKey(scope: BudgetScopeKey, categoryId: number, month: string, pct: number): string {
  return `budget:${scopeLetter(scope)}:${categoryId}:${month}:${pct}`;
}

/** Once per scope/category/month. Pinned at 100 so it can never collide with a threshold. */
export function budgetExceededKey(scope: BudgetScopeKey, categoryId: number, month: string): string {
  return `budget:${scopeLetter(scope)}:${categoryId}:${month}:100`;
}

export function backupFailedKey(dateIso: string): string {
  return `backup-failed:${dateIso}`;
}

export function weeklyDigestKey(slotDateIso: string): string {
  return `digest:${slotDateIso}`;
}

/**
 * v1.28.0. Every household send's dedup key is the event's own key wearing this prefix, and
 * the row it guards carries user_id NULL.
 *
 * Uniqueness does NOT depend on the prefix: notification_outbox_dedup_uq is
 * (COALESCE(user_id, -1), channel, dedup_key), so -1 already gives the household its own
 * namespace, separate from every real user id. The prefix earns its place twice over anyway:
 * a household row is self-describing in Settings -> Recent deliveries and in a `select
 * dedup_key` at 2am, and no future refactor that keys on dedup_key alone -- a purge, an
 * audit, a "has this already fired" probe -- can silently conflate the family channel's copy
 * with a member's.
 *
 * MUST-3.12 (pruning safety) is inherited from the wrapped key and never weakened: prefixing
 * a bounded key leaves it bounded.
 */
export const HOUSEHOLD_DEDUP_PREFIX = 'hh:';

/**
 * IDEMPOTENT on purpose. enqueue() wraps every household key with this, and one caller
 * (householdWeeklyDigestKey) hands it a key that is already wrapped -- so wrapping twice has to
 * be a no-op rather than producing `hh:hh:digest-week:...`, which would dedup against nothing
 * and put a second digest in the group chat. Enforcing "wrap exactly once" by convention across
 * two files is the kind of rule that holds until the third caller.
 */
export function householdDedupKey(key: string): string {
  return key.startsWith(HOUSEHOLD_DEDUP_PREFIX) ? key : `${HOUSEHOLD_DEDUP_PREFIX}${key}`;
}

export function isHouseholdDedupKey(key: string): boolean {
  return key.startsWith(HOUSEHOLD_DEDUP_PREFIX);
}

/**
 * v1.28.0. The household digest is keyed by the MONDAY of the week it covers, not by the
 * firing member's slot date -- the one place a household key may not simply wrap the personal
 * one.
 *
 * Every member has their OWN digest_weekday and digest_hour (§3.5), so weeklyDigestKey's slot
 * date differs per person. Wrapping it would mean a household where one partner picked Monday
 * and the other Friday gets TWO family digests every week, which is the "N copies in the group
 * chat" failure this whole feature exists to remove -- just at a slower cadence. Collapsing to
 * the week makes it exactly one: whichever member's slot comes first that week produces it, and
 * everybody else's slot finds the key already taken and enqueues nothing.
 *
 * `mondayIso` comes from mondayOfIsoWeek() in evaluate/slots.ts, the same helper staleImportKey
 * is fed from, and carries the same pruning-safety argument: the key advances every week and
 * never repeats.
 */
export function householdWeeklyDigestKey(mondayIso: string): string {
  return householdDedupKey(`digest-week:${mondayIso}`);
}

export function newSigninKey(sessionCreatedAt: string): string {
  return `signin:${sessionCreatedAt}`;
}

/**
 * v1.12.1 (item AA / SEC-4). Keyed on the moment it happened, which never recurs -- the same
 * MUST-3.12 shape newSigninKey uses, and the reason neither needs a calendar bound: a key that
 * can never be generated a second time cannot be resurrected by the 400-day retention sweep.
 */
export function passwordChangedKey(atIso: string): string {
  return `password_changed:${atIso}`;
}

export function mfaDisabledKey(atIso: string): string {
  return `mfa_disabled:${atIso}`;
}

export function restoreOutcomeKey(finishedAt: string): string {
  return `restore:${finishedAt}`;
}

/**
 * v1.13.0 ruling R14. BOTH arguments are required, so the compiler names the one call site -- an
 * optional accountId would leave the old household-wide key reachable, and a stale key that still
 * exists is a stale key somebody will eventually pass.
 */
export function staleImportKey(mondayIso: string, accountId: number): string {
  return `stale:${mondayIso}:${accountId}`;
}

/**
 * Once per remote version, ever. Versions only ever go up, so this key never recurs.
 *
 * MUST-6.3 (pruning safety, honestly stated): there is ONE residual case. An install that
 * stays on its current version for more than 400 days while the same newer release remains
 * the latest will have its `update:<version>` row pruned by the retention sweep and will be
 * told once more, on the following check, that that version is available. One reminder every
 * 400 days about an update you have been ignoring for 400 days is correct behaviour, not a
 * defect, and it is the only condition under which this key can regenerate.
 */
export function updateAvailableKey(version: string): string {
  return `update:${version}`;
}

/**
 * Once per scope, per category, per month, EVER (MUST-9.8). It fires on the first day at or
 * after the 7th on which the projection crosses the threshold, and never again that month,
 * whether the projection later gets worse or better. Re-alerting on a moving projection is
 * how a useful alert becomes an ignored one.
 *
 * MUST-9.9 (pruning safety): the key carries the month and the evaluator only ever visits the
 * current month, so a row pruned by the 400-day sweep belongs to a month never evaluated again.
 */
export function budgetPaceKey(scope: BudgetScopeKey, categoryId: number, month: string): string {
  return `pace:${scopeLetter(scope)}:${categoryId}:${month}`;
}

/** Once per transaction, ever. 14 days of lookback against 400 days of retention (MUST-9.14). */
export function unusualTransactionKey(transactionId: number): string {
  return `unusual:${transactionId}`;
}

/**
 * Once per price change, ever, keyed on the INCREASED charge. Next month's charge at the new
 * price does not fire again, because by then the median of the preceding charges has moved
 * (MUST-9.17). A second rise is a different transaction id and a legitimately new message.
 */
export function subscriptionCreepKey(transactionId: number): string {
  return `creep:${transactionId}`;
}

/** MUST-9.22: the two ids sorted ascending, so the same pair keys the same either way round. */
export function duplicateChargeKey(lowerId: number, higherId: number): string {
  const first = Math.min(lowerId, higherId);
  const second = Math.max(lowerId, higherId);
  return `dupe:${first}:${second}`;
}

/** Once per reported month, ever. The evaluator only ever visits the immediately previous one. */
export function predictedVsActualKey(month: string): string {
  return `predvs:${month}`;
}

/** Once per current month, ever. Same pruning argument as predictedVsActualKey. */
export function suggestedBudgetRefreshKey(month: string): string {
  return `suggest:${month}`;
}

/**
 * Once per calendar day, max (Task 8 / design ruling 7). The scheduler only ever raises this
 * against "today", so a row the 400-day sweep prunes belongs to a date that will never be
 * visited again — same pruning argument as backupFailedKey.
 */
export function syncFailedKey(dateIso: string): string {
  return `sync-failed:${dateIso}`;
}

/**
 * Once per reported month, ever (Task 16, v1.7.0). The evaluator only ever visits the month it
 * just closed, so a row the 400-day sweep prunes belongs to a month that will never be
 * evaluated again -- same pruning argument as predictedVsActualKey. A dedicated `monthly-`
 * prefix (rather than reusing weeklyDigestKey's `digest:` one) keeps the two dedup keys
 * visually and lexically distinct even though a YYYY-MM month key and a YYYY-MM-DD slot date
 * could never collide on length alone.
 */
export function monthlyDigestKey(month: string): string {
  return `monthly-digest:${month}`;
}

/**
 * Lane 2, spec docs/superpowers/plans/2026-08-30-savings-targets.md. Household-scoped only
 * (ruling T3), so unlike budgetPaceKey/budgetThresholdKey there is no category id and no
 * scopeLetter to carry -- one household has exactly one savings target per month, ever.
 *
 * Once per month, EVER. Pruning safety mirrors predictedVsActualKey/monthlyDigestKey: the
 * evaluator only ever visits the current (or, for the closed-month key below, the just-ended)
 * month, so a row the 400-day retention sweep prunes belongs to a month that will never be
 * evaluated again.
 */
export function savingsTargetMetKey(month: string): string {
  return `savings-met:${month}`;
}

/** Once per month, ever -- the first daily slot at or after day 7 that qualifies, same pruning
 *  argument as savingsTargetMetKey above. */
export function savingsTargetPaceKey(month: string): string {
  return `savings-pace:${month}`;
}

/** Once per reported (closed) month, ever. Distinct prefix from monthlyDigestKey's
 *  `monthly-digest:` and weeklyDigestKey's `digest:` so none of the three can ever collide. */
export function savingsMonthClosedKey(month: string): string {
  return `savings-closed:${month}`;
}

/**
 * Once per (pack, version), ever -- same shape as updateAvailableKey, and the same reasoning:
 * pack versions only ever go up, so this key never recurs, and the one residual pruning case
 * updateAvailableKey's own docblock documents (a 400-day-stale reminder resurfacing once) applies
 * here identically.
 */
export function packUpdateAvailableKey(packId: string, version: number): string {
  return `pack-update:${packId}:${version}`;
}
