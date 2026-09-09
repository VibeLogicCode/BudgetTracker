import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, insertTestUser, type TestDb } from '../../../helpers/db';
import { saveEmailTarget, saveSmtp, saveTelegramTarget, saveUserSettings, DEFAULT_USER_SETTINGS } from '@/lib/notify/config';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { MAX_NEW_ROWS_PER_USER_PER_EVALUATION, evaluateComingDue } from '@/lib/notify/evaluate/coming-due';
import { comingDueBatchKey, installmentDueKey, installmentOverdueKey } from '@/lib/notify/events';
import { addInstallment } from '@/lib/warranty/installments';

let t: TestDb;
const NOW = new Date('2026-08-17T12:00:00Z');
const TZ = 'UTC';

beforeEach(() => {
  t = createTestDb();
  resetOutboxPumpForTests();
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

function emailUser(): number {
  const userId = insertTestUser(t.db, { username: `u${Math.random().toString(36).slice(2, 8)}` });
  saveSmtp({
    preset: 'brevo',
    host: 'h',
    port: 587,
    security: 'starttls',
    username: 'u',
    password: 'p',
    fromEmail: 'f@e.com',
    fromName: 'Budget Tracker',
    enabled: true,
  });
  saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
  return userId;
}

function bothChannelsUser(): number {
  const userId = emailUser();
  saveTelegramTarget({ userId, destination: '5551234', botToken: '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx', enabled: true });
  return userId;
}

function typeId(kind: 'warranty' | 'subscription' | 'contract' | 'loan' | 'bill'): number {
  const row = t.db.get<{ id: number }>(
    sql`insert into warranty_item_types (name, is_subscription, kind, created_at)
        values (${`${kind}-${Math.random().toString(36).slice(2, 8)}`}, ${kind === 'subscription' ? 1 : 0}, ${kind}, ${'2026-01-01T00:00:00.000Z'})
        returning id`,
  );
  return row.id;
}

function item(over: {
  ownerUserId: number;
  name?: string;
  expiryDate?: string | null;
  isLifetime?: boolean;
  kind?: 'warranty' | 'subscription' | 'contract' | 'loan' | 'bill';
  vendor?: string | null;
  priceCents?: number | null;
}): number {
  // warranty_items CHECK constraints (drizzle/0002_warranty_tracker.sql) require:
  //   is_lifetime = 0 OR (warranty_months IS NULL AND expiry_date IS NULL)
  //   (warranty_months IS NULL) = (expiry_date IS NULL)
  // A lifetime item can therefore never carry an expiry_date; a non-lifetime item with an
  // expiry_date needs a paired, positive warranty_months. Neither is part of what this
  // evaluator reads, so a fixed 12 satisfies the CHECK without affecting any assertion.
  const isLifetime = over.isLifetime ?? false;
  const expiryDate = isLifetime ? null : (over.expiryDate ?? null);
  const warrantyMonths = expiryDate === null ? null : 12;
  const row = t.db.get<{ id: number }>(
    sql`insert into warranty_items
          (name, vendor, purchase_date, warranty_months, is_lifetime, expiry_date, price_cents, owner_user_id, type_id, created_at, updated_at)
        values (${over.name ?? 'Dishwasher'}, ${over.vendor ?? null}, ${'2024-01-01'}, ${warrantyMonths},
                ${isLifetime ? 1 : 0}, ${expiryDate}, ${over.priceCents ?? null},
                ${over.ownerUserId}, ${typeId(over.kind ?? 'warranty')}, ${'2026-01-01T00:00:00.000Z'}, ${'2026-01-01T00:00:00.000Z'})
        returning id`,
  );
  return row.id;
}

function queued(): { dedup_key: string; subject: string }[] {
  return t.sqlite
    .prepare(`select dedup_key, subject from notification_outbox order by id`)
    .all() as { dedup_key: string; subject: string }[];
}

/**
 * 2026-09-09: ONE MESSAGE, NOT ONE PER ITEM.
 *
 * Every claim MUST-6.10 to MUST-6.14 makes is still made below; what changed is the delivery. An
 * item is still announced once ever, an edited date is still a new fact and a new announcement, the
 * verb still comes from the item's kind, and the cap still bounds one evaluation. They are now
 * asserted against ONE outbox row whose body names everything, rather than against a row each --
 * which is the owner's "1 message per X ... can we not send a summary" complaint, applied to the
 * one remaining evaluator that still worked that way.
 */
function bodies(): string[] {
  return (t.sqlite.prepare('select body from notification_outbox order by id').all() as { body: string }[]).map((r) => r.body);
}

describe('MUST-6.10: the window', () => {
  it('includes exactly today and exactly today + N, and excludes today + N + 1', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, comingDueDays: 14 });
    item({ ownerUserId: userId, name: 'Today', expiryDate: '2026-08-17' });
    item({ ownerUserId: userId, name: 'Edge', expiryDate: '2026-08-31' });
    item({ ownerUserId: userId, name: 'Beyond', expiryDate: '2026-09-01' });
    item({ ownerUserId: userId, name: 'Past', expiryDate: '2026-08-16' });

    // ONE row now, whatever the count -- the count is in the subject instead.
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(queued()).toHaveLength(1);
    expect(queued()[0]?.subject).toBe('2 coming due');
    expect(bodies()[0]).toContain('Today');
    expect(bodies()[0]).toContain('Edge');
    expect(bodies()[0]).not.toContain('Beyond');
    expect(bodies()[0]).not.toContain('Past');
  });

  it('never fires for a lifetime item or an item with no expiry date', () => {
    const userId = emailUser();
    item({ ownerUserId: userId, name: 'Lifetime', expiryDate: '2026-08-20', isLifetime: true });
    item({ ownerUserId: userId, name: 'Open', expiryDate: null });
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(0);
    expect(queued()).toHaveLength(0);
  });

  it('honours the user’s own comingDueDays', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, comingDueDays: 3 });
    item({ ownerUserId: userId, name: 'Soon', expiryDate: '2026-08-20' });
    item({ ownerUserId: userId, name: 'Later', expiryDate: '2026-08-21' });
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(bodies()[0]).toContain('Soon');
    expect(bodies()[0]).not.toContain('Later');
  });
});

describe('MUST-6.11: only the item’s owner is notified', () => {
  it('ignores another member’s items', () => {
    const mine = emailUser();
    const theirs = emailUser();
    item({ ownerUserId: theirs, name: 'Theirs', expiryDate: '2026-08-20' });
    expect(evaluateComingDue({ userId: mine, now: NOW, tz: TZ })).toBe(0);
    expect(evaluateComingDue({ userId: theirs, now: NOW, tz: TZ })).toBe(1);
  });
});

describe('MUST-6.12: announced once ever, per item and expiry date', () => {
  it('a second evaluation of the same slot enqueues nothing', () => {
    const userId = emailUser();
    item({ ownerUserId: userId, expiryDate: '2026-08-20' });
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(evaluateComingDue({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(0);
    expect(queued()).toHaveLength(1);
  });

  it('an unchanged window stays silent for as long as it stays unchanged', () => {
    // The property that makes batching safe: the ledger is the batch key's contents, so a window
    // that gains nothing produces nothing, day after day, exactly as the per-item keys did.
    const userId = emailUser();
    item({ ownerUserId: userId, expiryDate: '2026-08-25' });
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    for (const day of ['2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21']) {
      expect(evaluateComingDue({ userId, now: new Date(`${day}T12:00:00Z`), tz: TZ })).toBe(0);
    }
    expect(queued()).toHaveLength(1);
  });

  it('a NEW item joining the window sends one message that names them all', () => {
    const userId = emailUser();
    item({ ownerUserId: userId, name: 'Fridge', expiryDate: '2026-08-25' });
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    item({ ownerUserId: userId, name: 'Boiler', expiryDate: '2026-08-26' });
    expect(evaluateComingDue({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(1);
    // The second message is the current board, not a note about the newcomer alone: a list of what
    // is due is more use than "one more thing was added to a list you cannot see".
    expect(bodies()[1]).toContain('Boiler');
    expect(bodies()[1]).toContain('Fridge');
  });

  it('editing the expiry date produces a second, correctly-keyed message', () => {
    const userId = emailUser();
    const id = item({ ownerUserId: userId, expiryDate: '2026-08-20' });
    evaluateComingDue({ userId, now: NOW, tz: TZ });
    t.db.run(sql`update warranty_items set expiry_date = ${'2026-08-25'} where id = ${id}`);
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    // The per-item keys are still the ledger; they now ride inside the batch key.
    expect(queued().map((r) => r.dedup_key)).toEqual([`due:batch:due:${id}:2026-08-20`, `due:batch:due:${id}:2026-08-25`]);
  });
});

describe('MUST-6.13: the flood guard', () => {
  it('names at most 20 and counts the rest, picking them up next slot', () => {
    const userId = emailUser();
    for (let i = 0; i < 25; i += 1) item({ ownerUserId: userId, name: `Item ${i}`, expiryDate: '2026-08-20' });
    expect(MAX_NEW_ROWS_PER_USER_PER_EVALUATION).toBe(20);
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(bodies()[0]).toContain('And 5 more.');
    // The five it did not name are still new tomorrow, which is what makes the cap a deferral
    // rather than a silent drop.
    expect(evaluateComingDue({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(1);
    expect(evaluateComingDue({ userId, now: new Date('2026-08-19T12:00:00Z'), tz: TZ })).toBe(0);
    expect(queued()).toHaveLength(2);
  });

  it('the cap never crowds a new item out: the 21st item is announced, not silently discarded', () => {
    // The failure this guards: take the first 20 candidates in priority order and, once those 20
    // are already announced, a genuinely new 21st produces a key identical to the row already in
    // the outbox. The unique index discards it and that item is never announced at all.
    const userId = emailUser();
    for (let i = 0; i < 20; i += 1) item({ ownerUserId: userId, name: `Old ${i}`, expiryDate: '2026-08-20' });
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    item({ ownerUserId: userId, name: 'Newcomer', expiryDate: '2026-08-21' });
    expect(evaluateComingDue({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(1);
    expect(bodies()[1]).toContain('Newcomer');
  });

  it('one row per channel: a user with both channels gets the same message twice, once each', () => {
    const userId = bothChannelsUser();
    for (let i = 0; i < 25; i += 1) item({ ownerUserId: userId, name: `Item ${i}`, expiryDate: '2026-08-20' });
    // Still ONE logical message; enqueue fans it out per channel as it does for every event.
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(queued()).toHaveLength(2);
  });
});

describe('MUST-6.14: the verb comes from the item’s kind', () => {
  it('a loan says "paid off by" and a subscription "cancel by", in the one message', () => {
    const userId = emailUser();
    item({ ownerUserId: userId, name: 'Car loan', expiryDate: '2026-08-20', kind: 'loan' });
    item({ ownerUserId: userId, name: 'Netflix', expiryDate: '2026-08-21', kind: 'subscription' });
    evaluateComingDue({ userId, now: NOW, tz: TZ });
    expect(bodies()[0]).toContain('paid off by');
    expect(bodies()[0]).toContain('cancel by');
  });

  it('includes the vendor and the price when they are set', () => {
    // The per-item message put these on lines of their own. The batched line keeps both facts --
    // batching is about how many notifications arrive, not about telling the household less.
    const userId = emailUser();
    item({ ownerUserId: userId, name: 'Fridge', expiryDate: '2026-08-20', vendor: 'Costco', priceCents: 129999 });
    evaluateComingDue({ userId, now: NOW, tz: TZ });
    expect(bodies()[0]).toContain('Costco');
    expect(bodies()[0]).toContain('$1,299.99');
  });
});

describe('installments in the coming-due evaluation', () => {
  function billWith(userId: number, dues: string[], amountCents = 120_000): { itemId: number; ids: number[] } {
    const itemId = item({ ownerUserId: userId, name: 'Municipal tax', kind: 'bill', expiryDate: null });
    return { itemId, ids: dues.map((dueDate) => addInstallment({ itemId, dueDate, amountCents })) };
  }

  function keysFor(userId: number): string[] {
    return (
      t.sqlite
        .prepare('select dedup_key from notification_outbox where user_id = ? order by dedup_key')
        .all(userId) as { dedup_key: string }[]
    ).map((r) => r.dedup_key);
  }

  it('carries an installment inside the window under its own installmentDueKey token', () => {
    const userId = bothChannelsUser();
    const { ids } = billWith(userId, ['2026-08-20']);
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(new Set(keysFor(userId))).toEqual(new Set([comingDueBatchKey([installmentDueKey(ids[0]!, '2026-08-20')])]));
  });

  it('says nothing the next day about the same installment', () => {
    const userId = emailUser();
    billWith(userId, ['2026-08-20']);
    evaluateComingDue({ userId, now: NOW, tz: TZ });
    expect(evaluateComingDue({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(0);
  });

  it('nags monthly about an overdue one, not daily (ruling B16)', () => {
    const userId = emailUser();
    const { ids } = billWith(userId, ['2026-05-01']);
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(keysFor(userId)).toEqual([comingDueBatchKey([installmentOverdueKey(ids[0]!, '2026-08')])]);
    expect(bodies()[0]).toContain('Overdue');
    // Tomorrow: nothing.
    expect(evaluateComingDue({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(0);
    // Next calendar month: one more. installmentOverdueKey carries the month, so September's
    // token is new and the batch is a new fact rather than a repeat.
    expect(evaluateComingDue({ userId, now: new Date('2026-09-02T12:00:00Z'), tz: TZ })).toBe(1);
    expect(keysFor(userId).sort()).toEqual(
      [
        comingDueBatchKey([installmentOverdueKey(ids[0]!, '2026-08')]),
        comingDueBatchKey([installmentOverdueKey(ids[0]!, '2026-09')]),
      ].sort(),
    );
  });

  it('an item expiry that falls on one of its own installment dates is TWO lines, not one', () => {
    // The distinct key prefixes are what make this true; a shared prefix would let one line
    // silently suppress the other, inside the batch key exactly as it would have between rows.
    const userId = emailUser();
    const itemId = item({ ownerUserId: userId, name: 'Municipal tax', kind: 'bill', expiryDate: '2026-08-20' });
    const installmentId = addInstallment({ itemId, dueDate: '2026-08-20', amountCents: 120_000 });
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(keysFor(userId)).toEqual([
      comingDueBatchKey([`bill:${installmentId}:2026-08-20`, `due:${itemId}:2026-08-20`]),
    ]);
    expect(queued()[0]?.subject).toBe('2 coming due');
  });

  it('never announces a paid installment or another household member’s', () => {
    const mine = emailUser();
    const theirs = emailUser();
    const { ids } = billWith(mine, ['2026-08-20', '2026-08-21']);
    billWith(theirs, ['2026-08-20']);
    t.sqlite.prepare('update bill_installments set paid_at = ? where id = ?').run('2026-08-01T00:00:00.000Z', ids[0]);
    expect(evaluateComingDue({ userId: mine, now: NOW, tz: TZ })).toBe(1);
    expect(keysFor(mine)).toEqual([comingDueBatchKey([installmentDueKey(ids[1]!, '2026-08-21')])]);
  });

  it('spends the shared flood cap on overdue rows first, then upcoming, then item expiries', () => {
    // The cap bounds one message. When it bites, the household should lose the least urgent line,
    // not the most -- which is the only reason the order matters.
    const userId = emailUser();
    const dues: string[] = [];
    for (let i = 0; i < MAX_NEW_ROWS_PER_USER_PER_EVALUATION + 5; i += 1) {
      dues.push(`2026-08-${String(18 + (i % 10)).padStart(2, '0')}`);
    }
    const { ids } = billWith(userId, ['2026-05-01', ...dues]);
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(keysFor(userId)[0]).toContain(installmentOverdueKey(ids[0]!, '2026-08'));
    // Overdue leads the message, ahead of everything merely upcoming.
    expect(bodies()[0].startsWith('Overdue')).toBe(true);
  });
});
