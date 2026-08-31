import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTIFICATION_EVENTS } from '@/lib/notify/events';
import { NAME_MAX, USER_AGENT_MAX, renderEvent, truncateText, type RenderInput } from '@/lib/notify/render';
import { ITEM_KIND_LABELS } from '@/lib/warranty/constants';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('MUST-2.1: render.ts is pure', () => {
  it('imports neither @/db nor @/lib/env nor a node builtin', () => {
    const source = fs.readFileSync(path.join(root, 'src/lib/notify/render.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"]@\/db/);
    expect(source).not.toMatch(/from\s+['"]@\/lib\/env/);
    expect(source).not.toMatch(/from\s+['"]node:/);
  });
});

describe('MUST-6.14 / §10.1: coming_due', () => {
  it('uses the warranty verb for each kind rather than writing its own', () => {
    const base = {
      event: 'coming_due',
      variant: 'item',
      itemName: 'Dishwasher',
      expiryDate: '2026-09-01',
      todayIso: '2026-08-17',
      vendor: null,
      priceCents: null,
    } as const;
    expect(renderEvent({ ...base, kind: 'loan' }).body).toContain('paid off by');
    expect(renderEvent({ ...base, kind: 'subscription' }).body).toContain('cancel by');
    expect(renderEvent({ ...base, kind: 'contract' }).body).toContain('ends on');
    expect(renderEvent({ ...base, kind: 'warranty' }).body).toContain('expires');
  });

  it('renders the subject, the days remaining, and the optional vendor and price', () => {
    const { subject, body } = renderEvent({
      event: 'coming_due',
      variant: 'item',
      itemName: 'Netflix',
      kind: 'subscription',
      expiryDate: '2026-08-27',
      todayIso: '2026-08-17',
      vendor: 'Netflix Canada',
      priceCents: 2299,
    });
    expect(subject).toBe('Coming due: Netflix');
    expect(body).toContain('in 10 days');
    expect(body).toContain('Netflix Canada');
    expect(body).toContain('$22.99');
  });

  it('says "tomorrow" and "today" rather than "in 1 days" / "in 0 days"', () => {
    const base = { event: 'coming_due', variant: 'item', itemName: 'X', kind: 'warranty', todayIso: '2026-08-17', vendor: null, priceCents: null } as const;
    expect(renderEvent({ ...base, expiryDate: '2026-08-18' }).body).toContain('tomorrow');
    expect(renderEvent({ ...base, expiryDate: '2026-08-17' }).body).toContain('today');
  });
});

describe('§10.1: budget events', () => {
  it('renders the threshold subject and body with formatted money', () => {
    const { subject, body } = renderEvent({
      event: 'budget_threshold',
      scope: 'household',
      categoryName: 'Groceries',
      month: '2026-08',
      pct: 82,
      spentCents: 41000,
      limitCents: 50000,
    });
    expect(subject).toBe('Budget 82%: Groceries (August 2026)');
    expect(body).toBe('Household Groceries budget for August 2026 is at 82% — $410.00 of $500.00, $90.00 left.');
  });

  it('omits the "left" clause when a single jump takes pct past 100% (MUST-6.17)', () => {
    const { body } = renderEvent({
      event: 'budget_threshold',
      scope: 'household',
      categoryName: 'Gas',
      month: '2026-08',
      pct: 200,
      spentCents: 20000,
      limitCents: 10000,
    });
    expect(body).toBe('Household Gas budget for August 2026 is at 200% — $200.00 of $100.00.');
    expect(body).not.toContain('left');
  });

  it('says "Your" for the personal scope', () => {
    const { body } = renderEvent({
      event: 'budget_threshold',
      scope: 'personal',
      categoryName: 'Coffee',
      month: '2026-08',
      pct: 90,
      spentCents: 4500,
      limitCents: 5000,
    });
    expect(body.startsWith('Your Coffee budget')).toBe(true);
  });

  it('renders the exceeded subject and the amount over', () => {
    const { subject, body } = renderEvent({
      event: 'budget_exceeded',
      scope: 'household',
      categoryName: 'Restaurants',
      month: '2026-08',
      spentCents: 61000,
      limitCents: 50000,
    });
    expect(subject).toBe('Over budget: Restaurants (August 2026)');
    expect(body).toBe('Household Restaurants budget for August 2026 is blown — $610.00 of $500.00, $110.00 over.');
  });
});

describe('§10.1: the operational events', () => {
  it('backup_failed points at Settings and states the sweep still ran', () => {
    const { subject, body } = renderEvent({ event: 'backup_failed', dateIso: '2026-08-17', error: 'ENOSPC: no space left' });
    expect(subject).toBe('Nightly backup failed');
    expect(body).toContain('2026-08-17');
    expect(body).toContain('ENOSPC: no space left');
    expect(body).toContain('The maintenance sweep still ran. Check Settings → Backups.');
  });

  it('new_signin names the time, zone, ip and browser and tells the reader what to do', () => {
    const { subject, body } = renderEvent({
      event: 'new_signin',
      name: 'Sam',
      atLabel: '2026-08-17 21:14',
      tz: 'America/Toronto',
      ip: '192.168.1.44',
      userAgent: 'Mozilla/5.0 (iPhone)',
    });
    expect(subject).toBe('New sign-in to your account');
    expect(body).toContain('Sam signed in at 2026-08-17 21:14 (America/Toronto) from 192.168.1.44.');
    expect(body).toContain('Mozilla/5.0 (iPhone)');
    expect(body).toContain('If this was not you, change your password in Settings.');
  });

  it('restore_outcome distinguishes success from failure', () => {
    const base = {
      event: 'restore_outcome',
      sourceName: 'budget-2026-08-16.tar.gz',
      requestedByUsername: 'alex',
      finishedAt: '2026-08-17T03:12:04.000Z',
      receiptsRestored: 12,
      missingReceiptRows: 1,
    } as const;
    expect(renderEvent({ ...base, status: 'success', error: null }).subject).toBe('Restore succeeded');
    const failed = renderEvent({ ...base, status: 'failed', error: 'checksum mismatch' });
    expect(failed.subject).toBe('Restore FAILED');
    expect(failed.body).toContain('checksum mismatch');
    expect(failed.body).toContain('budget-2026-08-16.tar.gz');
    expect(failed.body).toContain('alex');
    expect(failed.body).toContain('12');
  });

  it('stale_import states the account, the weeks, the last import and why it matters', () => {
    const { subject, body } = renderEvent({
      event: 'stale_import',
      weeks: 3,
      lastImportIso: '2026-07-27',
      daysAgo: 21,
      accountName: 'Amex',
    });
    expect(subject).toBe('No transactions imported in 3 weeks');
    expect(body).toContain('Amex');
    expect(body).toContain('The last import was 2026-07-27 (21 days ago).');
    expect(body).toContain('Bank exports are how this app learns what you spent.');
  });
});

describe('Task 8 (v1.7.0): sync_failed', () => {
  it('points at Settings → Connections and states the date and the error', () => {
    const { subject, body } = renderEvent({
      event: 'sync_failed',
      dateIso: '2026-08-22',
      error: 'The SimpleFIN bridge returned HTTP 500.',
    });
    expect(subject).toBe('SimpleFIN sync failed');
    expect(body).toContain('2026-08-22');
    expect(body).toContain('The SimpleFIN bridge returned HTTP 500.');
    expect(body).toContain('Check Settings → Connections.');
  });

  it('never uses an em dash', () => {
    const { subject, body } = renderEvent({ event: 'sync_failed', dateIso: '2026-08-22', error: 'boom' });
    expect(subject).not.toContain('—');
    expect(body).not.toContain('—');
  });

  /**
   * SECURITY (Task 8, non-negotiable): the SimpleFIN access URL is a bearer credential and
   * must never reach a subject or a body. renderEvent's sync_failed case has exactly two
   * dynamic inputs (dateIso and error) and no third field a URL could ride in on, so this
   * pins that the subject is a fixed string that never varies with the error's content, and
   * that the body contains only what error.message actually said, verbatim, with nothing
   * else appended around it that could carry more than intended.
   */
  it('SECURITY: an access-URL-shaped error message reaches the body only, never the subject, and the subject never varies', () => {
    const FAKE_ACCESS_URL = 'https://fake-user:fake-pass@fake-bridge.example.test/simplefin';
    const { subject, body } = renderEvent({
      event: 'sync_failed',
      dateIso: '2026-08-22',
      error: `The bridge rejected the request for ${FAKE_ACCESS_URL}.`,
    });
    expect(subject).toBe('SimpleFIN sync failed');
    expect(subject).not.toContain(FAKE_ACCESS_URL);
    expect(subject).not.toContain('fake-pass');
    expect(body).toContain(FAKE_ACCESS_URL);

    const clean = renderEvent({ event: 'sync_failed', dateIso: '2026-08-22', error: 'A generic failure.' });
    expect(clean.subject).toBe(subject);
    expect(clean.body).not.toContain(FAKE_ACCESS_URL);
  });
});

describe('§10.2: the weekly digest', () => {
  const full = {
    event: 'weekly_digest',
    fromIso: '2026-08-10',
    toIso: '2026-08-16',
    householdSpentCents: 128455,
    personalSpentCents: 41230,
    topCategories: [
      { name: 'Groceries', cents: 40211 },
      { name: 'Restaurants', cents: 18840 },
      { name: 'Gas', cents: 12100 },
    ],
    topMerchants: [
      { name: 'LOBLAWS', cents: 21055 },
      { name: 'PETRO-CANADA', cents: 12100 },
    ],
    reviewCount: 12,
    overBudget: ['Restaurants', 'Coffee'],
  } as const;

  it('renders the subject as the date range', () => {
    expect(renderEvent(full).subject).toBe('Weekly summary — 2026-08-10 to 2026-08-16');
  });

  it('renders every section of the spec example', () => {
    const { body } = renderEvent(full);
    expect(body).toContain('Household spend: $1,284.55');
    expect(body).toContain('Your spend:');
    expect(body).toContain('$412.30');
    expect(body).toContain('Top categories (household)');
    expect(body).toContain('Groceries');
    expect(body).toContain('$402.11');
    expect(body).toContain('Top merchants (household)');
    expect(body).toContain('LOBLAWS');
    expect(body).toContain('12 transactions still need review.');
    expect(body).toContain('Over budget this month: Restaurants, Coffee.');
  });

  it('an empty week still sends, with its own sentence', () => {
    const { body } = renderEvent({
      ...full,
      householdSpentCents: 0,
      personalSpentCents: 0,
      topCategories: [],
      topMerchants: [],
      reviewCount: 0,
      overBudget: [],
    });
    expect(body).toContain('No transactions were recorded this week.');
  });
});

describe('Task 16 (v1.7.0): the monthly digest', () => {
  const full = {
    event: 'monthly_digest',
    month: '2026-07',
    incomeCents: 500000,
    spendCents: 320000,
    netCents: 180000,
    budgetedLimitCents: 200000,
    budgetedSpentCents: 150000,
    topMerchants: [
      { name: 'LOBLAWS', cents: 21055 },
      { name: 'PETRO-CANADA', cents: 12100 },
    ],
  } as const;

  it('renders the subject with the month label, no em dash', () => {
    const { subject } = renderEvent(full);
    expect(subject).toBe('Monthly summary for July 2026');
    expect(subject).not.toContain('—');
  });

  it('renders income, spend, net, top merchants and a budgets line under limit', () => {
    const { body } = renderEvent(full);
    expect(body).toContain('Income: $5,000.00');
    expect(body).toContain('Spent: $3,200.00');
    expect(body).toContain('Net: $1,800.00');
    expect(body).toContain('Top merchants');
    expect(body).toContain('LOBLAWS');
    expect(body).toContain('$210.55');
    expect(body).toContain('Budgets: $1,500.00 of $2,000.00 spent, $500.00 left.');
  });

  it('says "over" instead of "left" once spend passes the budgeted limit', () => {
    const { body } = renderEvent({ ...full, budgetedLimitCents: 100000, budgetedSpentCents: 150000 });
    expect(body).toContain('Budgets: $1,500.00 of $1,000.00 spent, $500.00 over.');
    expect(body).not.toContain('left.');
  });

  it('says nothing was budgeted when no category resolved a limit that month', () => {
    const { body } = renderEvent({ ...full, budgetedLimitCents: 0, budgetedSpentCents: 0 });
    expect(body).toContain('No budgets were set this month.');
  });

  it('omits the top-merchants block entirely when there were none', () => {
    const { body } = renderEvent({ ...full, topMerchants: [] });
    expect(body).not.toContain('Top merchants');
  });

  /**
   * Defect fix: a dormant household with no spend and no budgets in the closed month used to
   * get a real message reading Income $0.00 / Spent $0.00 / Net $0.00 / "No budgets were set
   * this month.", identically every month forever, indistinguishable from a working digest
   * that happened to see no activity. This gives the monthly digest the same "nothing to
   * report" treatment the weekly digest already has (see the weekly "an empty week still
   * sends" test above), in the same voice.
   */
  it('an empty month still sends, with its own sentence, not four lines of zeroes', () => {
    const { body } = renderEvent({
      ...full,
      incomeCents: 0,
      spendCents: 0,
      netCents: 0,
      budgetedLimitCents: 0,
      budgetedSpentCents: 0,
      topMerchants: [],
    });
    expect(body).toBe('No transactions were recorded last month.');
    expect(body).not.toContain('$0.00');
    expect(body).not.toContain('No budgets were set this month.');
  });

  it('is not treated as empty when a budget exists, even with zero income, spend and merchants', () => {
    const { body } = renderEvent({
      ...full,
      incomeCents: 0,
      spendCents: 0,
      netCents: 0,
      topMerchants: [],
      budgetedLimitCents: 50000,
      budgetedSpentCents: 0,
    });
    expect(body).toContain('Income: $0.00');
    expect(body).toContain('Budgets: $0.00 of $500.00 spent, $500.00 left.');
  });

  it('never uses an em dash or an arrow character, in the subject or the body', () => {
    const { subject, body } = renderEvent(full);
    expect(subject).not.toContain('—');
    expect(subject).not.toContain('→');
    expect(body).not.toContain('—');
    expect(body).not.toContain('→');
  });
});

describe('MUST-10.3: untrusted values are plain and truncated', () => {
  it('renders markup literally', () => {
    const { subject, body } = renderEvent({
      event: 'coming_due',
      variant: 'item',
      itemName: '<b>x</b>',
      kind: 'warranty',
      expiryDate: '2026-09-01',
      todayIso: '2026-08-17',
      vendor: null,
      priceCents: null,
    });
    expect(subject).toContain('<b>x</b>');
    expect(body).toContain('<b>x</b>');
  });

  it('truncates names to 80 characters and user agents to 120', () => {
    expect(NAME_MAX).toBe(80);
    expect(USER_AGENT_MAX).toBe(120);
    expect(truncateText('a'.repeat(200), NAME_MAX)).toHaveLength(NAME_MAX);
    expect(truncateText('a'.repeat(200), NAME_MAX).endsWith('…')).toBe(true);
    expect(truncateText('short', NAME_MAX)).toBe('short');

    const { body } = renderEvent({
      event: 'new_signin',
      name: 'Sam',
      atLabel: '2026-08-17 21:14',
      tz: 'UTC',
      ip: '1.2.3.4',
      userAgent: 'U'.repeat(400),
    });
    expect(body).not.toContain('U'.repeat(USER_AGENT_MAX + 1));
  });
});

/**
 * MUST-10.4, driven by the registry rather than a hand-copied list: every event id
 * NOTIFICATION_EVENTS declares gets at least one sample input here, so an event added to
 * the registry without an entry in this map fails the "covers every id" assertion below
 * instead of silently never being checked for a URL. update_available gets all three body
 * shapes (major / patch-with-apply-path / no-apply-path), because MUST-6.5's "no URL" claim
 * has to hold for each one independently.
 */
const SAMPLES_BY_EVENT: Record<string, RenderInput[]> = {
  coming_due: [
    { event: 'coming_due', variant: 'item', itemName: 'X', kind: 'warranty', expiryDate: '2026-09-01', todayIso: '2026-08-17', vendor: null, priceCents: null },
  ],
  budget_threshold: [
    { event: 'budget_threshold', scope: 'household', categoryName: 'C', month: '2026-08', pct: 80, spentCents: 1, limitCents: 2 },
  ],
  budget_exceeded: [
    { event: 'budget_exceeded', scope: 'personal', categoryName: 'C', month: '2026-08', spentCents: 3, limitCents: 2 },
  ],
  backup_failed: [{ event: 'backup_failed', dateIso: '2026-08-17', error: 'e' }],
  weekly_digest: [
    {
      event: 'weekly_digest',
      fromIso: '2026-08-10',
      toIso: '2026-08-16',
      householdSpentCents: 0,
      personalSpentCents: 0,
      topCategories: [],
      topMerchants: [],
      reviewCount: 0,
      overBudget: [],
    },
  ],
  new_signin: [{ event: 'new_signin', name: 'S', atLabel: 'x', tz: 'UTC', ip: '1.2.3.4', userAgent: null }],
  // v1.12.1 (item AA / SEC-4): the account-security pair sits beside new_signin here too.
  password_changed: [{ event: 'password_changed', name: 'S', atLabel: 'x', tz: 'UTC' }],
  mfa_disabled: [{ event: 'mfa_disabled', name: 'S', atLabel: 'x', tz: 'UTC' }],
  restore_outcome: [
    { event: 'restore_outcome', status: 'success', sourceName: 's', requestedByUsername: 'u', finishedAt: 'f', receiptsRestored: 0, missingReceiptRows: 0, error: null },
  ],
  stale_import: [{ event: 'stale_import', weeks: 3, lastImportIso: '2026-07-27', daysAgo: 21, accountName: 'Amex' }],
  update_available: [
    { event: 'update_available', currentVersion: '1.3.1', latestVersion: '1.4.0', severity: 'major', publishedAt: null, canApplyInApp: true },
    { event: 'update_available', currentVersion: '1.3.1', latestVersion: '1.4.0', severity: 'major', publishedAt: null, canApplyInApp: false },
    { event: 'update_available', currentVersion: '1.3.1', latestVersion: '1.4.0', severity: 'patch', publishedAt: null, canApplyInApp: true },
    { event: 'update_available', currentVersion: '1.3.1', latestVersion: '1.4.0', severity: 'minor', publishedAt: '2026-08-16T09:00:00Z', canApplyInApp: false },
  ],
  budget_pace: [
    { event: 'budget_pace', scope: 'household', categoryName: 'C', month: '2026-08', limitCents: 60000, spentCents: 41000, dayOfMonth: 12, projectedCents: 105900 },
  ],
  unusual_transaction: [
    { event: 'unusual_transaction', merchant: 'M', accountName: 'A', dateIso: '2026-08-14', amountCents: -41288, baselineCents: 12100, baselineKind: 'merchant', categoryName: 'C' },
    { event: 'unusual_transaction', merchant: 'M', accountName: 'A', dateIso: '2026-08-14', amountCents: -41288, baselineCents: 12100, baselineKind: 'category', categoryName: null },
  ],
  subscription_creep: [
    { event: 'subscription_creep', merchant: 'M', dateIso: '2026-08-14', newAmountCents: 2099, baselineCents: 1649, priorCount: 3 },
  ],
  duplicate_charge: [
    { event: 'duplicate_charge', merchant: 'M', amountCents: -8950, earlierDateIso: '2026-08-12', laterDateIso: '2026-08-13' },
  ],
  predicted_vs_actual: [
    { event: 'predicted_vs_actual', month: '2026-07', household: [{ name: 'C', expectedCents: 1, actualCents: 2 }], personal: [], totalDeltaCents: 1 },
    { event: 'predicted_vs_actual', month: '2026-07', household: [], personal: [{ name: 'C', expectedCents: 2, actualCents: 1 }], totalDeltaCents: -1 },
  ],
  suggested_budget_refresh: [
    { event: 'suggested_budget_refresh', month: '2026-08', household: [{ name: 'C', nowCents: 2, wasCents: 1 }], personal: [], changedCount: 1 },
    { event: 'suggested_budget_refresh', month: '2026-08', household: [{ name: 'C', nowCents: 2, wasCents: null }], personal: [], changedCount: 1 },
  ],
  sync_failed: [{ event: 'sync_failed', dateIso: '2026-08-22', error: 'The SimpleFIN bridge returned HTTP 500.' }],
  monthly_digest: [
    {
      event: 'monthly_digest',
      month: '2026-07',
      incomeCents: 0,
      spendCents: 0,
      netCents: 0,
      budgetedLimitCents: 0,
      budgetedSpentCents: 0,
      topMerchants: [],
    },
  ],
  // Lane 2, v1.17.0 (savings targets): the three savings_* events.
  savings_target_met: [{ event: 'savings_target_met', month: '2026-08', netCents: 150000, targetCents: 100000 }],
  savings_target_pace: [
    { event: 'savings_target_pace', month: '2026-08', dayOfMonth: 10, netCents: 40000, targetCents: 310000, proRatedTargetCents: 100000 },
  ],
  savings_month_closed: [
    { event: 'savings_month_closed', month: '2026-07', netCents: 150000, targetCents: 100000, met: true, streak: 1 },
    { event: 'savings_month_closed', month: '2026-07', netCents: 150000, targetCents: 100000, met: true, streak: 3 },
    { event: 'savings_month_closed', month: '2026-07', netCents: 50000, targetCents: 100000, met: false, streak: 0 },
  ],
  // Backlog item 17 / Part 4: modelled on update_available -- a version pair, nothing this
  // renderer resolves itself.
  pack_update_available: [
    { event: 'pack_update_available', packLabel: 'Canadian merchant pack', installedVersion: 1, bundledVersion: 2 },
  ],
};

describe('MUST-10.4: no notification body contains a link', () => {
  it('every registry event id has a sample input registered here', () => {
    expect(Object.keys(SAMPLES_BY_EVENT).sort()).toEqual(NOTIFICATION_EVENTS.map((e) => e.id).sort());
  });

  it('renders with no URL scheme, for every registered event and every update_available variant', () => {
    for (const def of NOTIFICATION_EVENTS) {
      const samples = SAMPLES_BY_EVENT[def.id];
      expect(samples, `no sample input registered for event id "${def.id}"`).toBeDefined();
      for (const input of samples!) {
        const { subject, body } = renderEvent(input);
        expect(`${subject}\n${body}`, `event ${def.id}`).not.toMatch(/https?:\/\//);
      }
    }
  });
});

describe('spec section 9: the six predictive messages', () => {
  it('budget_pace names the limit, the days elapsed, the projection and the overshoot', () => {
    const { subject, body } = renderEvent({
      event: 'budget_pace',
      scope: 'household',
      categoryName: 'Groceries',
      month: '2026-08',
      limitCents: 60000,
      spentCents: 41000,
      dayOfMonth: 12,
      projectedCents: 105900,
    });
    expect(subject).toBe('On pace to go over: Groceries (August 2026)');
    expect(body).toContain('Household Groceries budget for August 2026 is $600.00.');
    expect(body).toContain('You have spent $410.00 in 12 days.');
    expect(body).toContain('the month ends near $1,059.00, about $459.00 over.');
  });

  it('budget_pace says "Your" for a personal budget', () => {
    const { body } = renderEvent({
      event: 'budget_pace',
      scope: 'personal',
      categoryName: 'Groceries',
      month: '2026-08',
      limitCents: 60000,
      spentCents: 41000,
      dayOfMonth: 12,
      projectedCents: 105900,
    });
    expect(body.startsWith('Your Groceries budget')).toBe(true);
  });

  it('unusual_transaction names the merchant baseline it used', () => {
    const { subject, body } = renderEvent({
      event: 'unusual_transaction',
      merchant: 'CANADIAN TIRE',
      accountName: 'Joint Chequing',
      dateIso: '2026-08-14',
      amountCents: -41288,
      baselineCents: 12100,
      baselineKind: 'merchant',
      categoryName: 'Home & Garden',
    });
    expect(subject).toBe('Unusual charge: CANADIAN TIRE $412.88');
    expect(body).toContain('on 2026-08-14');
    expect(body).toContain('Joint Chequing');
    expect(body).toContain('3.4 times the $121.00 you usually spend at CANADIAN TIRE');
  });

  it('unusual_transaction says so when it fell back to the category baseline', () => {
    const { body } = renderEvent({
      event: 'unusual_transaction',
      merchant: 'CANADIAN TIRE',
      accountName: 'Joint Chequing',
      dateIso: '2026-08-14',
      amountCents: -41288,
      baselineCents: 12100,
      baselineKind: 'category',
      categoryName: 'Home & Garden',
    });
    expect(body).toContain('the $121.00 that Home & Garden charges usually run');
  });

  it('subscription_creep names both amounts, the rise and the percentage', () => {
    const { subject, body } = renderEvent({
      event: 'subscription_creep',
      merchant: 'NETFLIX',
      dateIso: '2026-08-14',
      newAmountCents: 2099,
      baselineCents: 1649,
      priorCount: 3,
    });
    expect(subject).toBe('Price went up: NETFLIX');
    expect(body).toBe(
      'NETFLIX charged $20.99 on 2026-08-14. The last 3 charges were $16.49. That is $4.50 more, about 27 percent.',
    );
  });

  it('MUST-14.10: duplicate_charge says it may be a real second charge', () => {
    const { subject, body } = renderEvent({
      event: 'duplicate_charge',
      merchant: 'BELL CANADA',
      amountCents: -8950,
      earlierDateIso: '2026-08-12',
      laterDateIso: '2026-08-13',
    });
    expect(subject).toBe('Possible duplicate: BELL CANADA $89.50');
    expect(body).toBe(
      'BELL CANADA charged $89.50 on 2026-08-12 and again on 2026-08-13. ' +
        'It may be a real second charge, or the bank may have reported one charge twice.',
    );
  });

  it('MUST-9.27: predicted_vs_actual says the expected figures were recomputed', () => {
    const { subject, body } = renderEvent({
      event: 'predicted_vs_actual',
      month: '2026-07',
      household: [
        { name: 'Groceries', expectedCents: 62000, actualCents: 71340 },
        { name: 'Gas', expectedCents: 20000, actualCents: 18000 },
      ],
      personal: [],
      totalDeltaCents: 21000,
    });
    expect(subject).toBe('July 2026: what we expected against what happened');
    expect(body).toContain('$620.00 expected, $713.40 actual, $93.40 difference');
    expect(body).toContain('$200.00 expected, $180.00 actual, -$20.00 difference');
    expect(body).toContain('July 2026 came in $210.00 over what the last six months pointed at.');
    expect(body).toContain('recomputed');
  });

  it('MUST-9.30 composition: a long category name cannot cut a figure off the line', () => {
    const { body } = renderEvent({
      event: 'predicted_vs_actual',
      month: '2026-07',
      household: [{ name: 'C'.repeat(200), expectedCents: 62000, actualCents: 71340 }],
      personal: [],
      totalDeltaCents: 9340,
    });
    // padded() only ever truncates the category name, which is what NAME_MAX is for. Every
    // figure is appended after it has run, so all three survive intact.
    expect(body).toContain('$620.00 expected, $713.40 actual, $93.40 difference');
    expect(body).not.toContain('C'.repeat(81));
  });

  it('MUST-14.10: suggested_budget_refresh says nothing has been changed', () => {
    const { subject, body } = renderEvent({
      event: 'suggested_budget_refresh',
      month: '2026-08',
      household: [
        { name: 'Groceries', nowCents: 78000, wasCents: 60000 },
        { name: 'Gas', nowCents: 12000, wasCents: null },
      ],
      personal: [],
      changedCount: 5,
    });
    expect(subject).toBe('New month: 5 suggested budgets changed');
    expect(body).toContain('$780.00 suggested, $600.00 set');
    expect(body).toContain('$120.00 suggested, no limit set');
    expect(body).toContain('Open Budgets to apply any of these. Nothing has been changed.');
  });

  it('MUST-9.37: every name passes through truncateText', () => {
    const long = 'M'.repeat(200);
    const { subject, body } = renderEvent({
      event: 'duplicate_charge',
      merchant: long,
      amountCents: -8950,
      earlierDateIso: '2026-08-12',
      laterDateIso: '2026-08-13',
    });
    expect(subject).not.toContain(long);
    expect(body).not.toContain(long);
  });
});

describe('MUST-6.4 / MUST-6.5: update_available renders three bodies and no URL', () => {
  const base = { event: 'update_available' as const, currentVersion: '1.3.1', latestVersion: '1.4.0', publishedAt: null };

  it('major', () => {
    const { subject, body } = renderEvent({ ...base, severity: 'major', canApplyInApp: true });
    expect(subject).toBe('Budget Tracker 1.4.0 is available (major update)');
    expect(body).toBe(
      'You are running 1.3.1. Version 1.4.0 is a major update, so this app will not install it on its own. ' +
        'Open Settings, read what changed, and press Review and update when you are ready.',
    );
  });

  it('fix wave item 2: major with no apply path gets the manual-update wording, not "press Review and update"', () => {
    const { subject, body } = renderEvent({ ...base, severity: 'major', canApplyInApp: false });
    expect(subject).toBe('Budget Tracker 1.4.0 is available (major update)');
    expect(body).toBe(
      'You are running 1.3.1. Version 1.4.0 is a major update, so this app will not install it on its own. ' +
        "This install has no in-app update trigger; see Settings for how to update by hand. " +
        "The release notes are on the project's GitHub releases page.",
    );
    expect(body).not.toContain('press Review and update');
  });

  it('patch with an apply path', () => {
    const { subject, body } = renderEvent({ ...base, severity: 'patch', canApplyInApp: true });
    expect(subject).toBe('Budget Tracker 1.4.0 is available');
    expect(body).toBe(
      'You are running 1.3.1. Version 1.4.0 is published. Automatic updates are switched off, so open Settings ' +
        'and press Update now when you want it.',
    );
  });

  it('minor with no apply path', () => {
    const { body } = renderEvent({ ...base, severity: 'minor', canApplyInApp: false });
    expect(body).toContain('This install has no in-app update trigger');
  });

  it('renders publishedAt with the app\'s one timestamp convention and carries no URL', () => {
    const { body } = renderEvent({ ...base, severity: 'patch', canApplyInApp: true, publishedAt: '2026-08-16T09:00:00Z' });
    expect(body).toContain('Published 2026-08-16 09:00.');
    expect(body).not.toMatch(/https?:/);
  });
});

describe('backlog item 17 / Part 4: pack_update_available names both versions, no URL, no auto-apply claim', () => {
  it('renders the subject and body', () => {
    const { subject, body } = renderEvent({
      event: 'pack_update_available',
      packLabel: 'Canadian merchant pack',
      installedVersion: 1,
      bundledVersion: 2,
    });
    expect(subject).toBe('Canadian merchant pack: version 2 is available');
    expect(body).toBe(
      'You installed v1; this build ships v2. Open Settings → Merchant rules to review what changed and apply it -- ' +
        'nothing is applied automatically.',
    );
    expect(body).not.toMatch(/https?:\/\//);
  });
});

describe('coming_due, the installment variant (ruling B15)', () => {
  it('renders an upcoming installment', () => {
    const { subject, body } = renderEvent({
      event: 'coming_due',
      variant: 'installment',
      itemName: 'Municipal tax',
      dueDate: '2026-09-30',
      amountCents: 120_000,
      todayIso: '2026-09-23',
      overdue: false,
    });
    expect(subject).toBe('Coming due: Municipal tax');
    expect(body).toBe('Bill "Municipal tax": $1,200.00 due 2026-09-30 (in 7 days).');
  });

  it('renders an overdue installment differently, and says how long', () => {
    const { subject, body } = renderEvent({
      event: 'coming_due',
      variant: 'installment',
      itemName: 'Municipal tax',
      dueDate: '2026-09-30',
      amountCents: 120_000,
      todayIso: '2026-10-05',
      overdue: true,
    });
    expect(subject).toBe('Overdue: Municipal tax');
    expect(body).toBe('Bill "Municipal tax": $1,200.00 was due 2026-09-30 and is still unpaid (5 days ago).');
  });

  it('takes the noun "Bill" from ITEM_KIND_LABELS, not from a literal', () => {
    // MUST-19.11 applied to notifications: if the label ever changes, this body changes with it.
    const { body } = renderEvent({
      event: 'coming_due',
      variant: 'installment',
      itemName: 'X',
      dueDate: '2026-09-30',
      amountCents: 100,
      todayIso: '2026-09-23',
      overdue: false,
    });
    expect(body.startsWith(`${ITEM_KIND_LABELS.bill} "X"`)).toBe(true);
  });
});

describe('v1.12.1: the two account-security events (item AA / SEC-4)', () => {
  it('renders the password-changed body', () => {
    const { subject, body } = renderEvent({
      event: 'password_changed',
      name: 'Alice',
      atLabel: '2026-08-27 09:14',
      tz: 'America/Toronto',
    });
    expect(subject).toBe('Your password was changed');
    expect(body).toContain('Alice');
    expect(body).toContain('2026-08-27 09:14');
    expect(body).toContain('signed out');
  });

  it('renders the mfa-disabled body', () => {
    const { subject, body } = renderEvent({
      event: 'mfa_disabled',
      name: 'Alice',
      atLabel: '2026-08-27 09:14',
      tz: 'America/Toronto',
    });
    expect(subject).toBe('Two-factor authentication was switched off');
    expect(body).toContain('turn it back on');
  });
});
