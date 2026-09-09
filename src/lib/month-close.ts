import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accounts, monthClosures, simplefinAccountLinks, simplefinConnections, transactions } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { addDaysIso, monthEnd, monthOf, todayIso } from '@/lib/dates';

/**
 * 2026-09-08. "Is last month's data all in?" — and the answer is a recorded fact, not a guess.
 *
 * WHY NOT INFERRED, in the owner's words: "what happens if 1 of the accounts doesnt have any entry
 * for 15 days in next month and there is nothing to import ... because we have simplefin too
 * transactions can auto come in too using logic we have now is not reliable."
 *
 * He is right, and the failure is specific. The obvious rule — "every account has been imported
 * since the month ended" — cannot distinguish a quiet savings account with nothing to fetch from
 * one whose statement has not arrived. Both look identical from the imports table: no new import,
 * no new rows. So a low-traffic account silently blocks the monthly summary forever, and no
 * deadline fixes that without eventually sending figures that are wrong.
 *
 * The split this module makes instead:
 *
 *   - A SimpleFIN-linked account IS reliably current, because a successful sync is a positive
 *     statement about the connection rather than an absence of news. Those close automatically.
 *   - A manually imported account is only complete when the person who ran the export says so.
 *     One click covers every manual account at once, including the quiet one.
 *
 * A household with only linked accounts therefore never sees a button; one with only manual
 * accounts closes each month with a single click; a mixed household — which this one is — presses
 * the same button and the linked half is checked for it.
 */

/** Days after the month end before a synced account is treated as having caught up. */
const POSTING_LAG_DAYS = 3;

export interface AccountReadiness {
  accountId: number;
  name: string;
  /** True when this account is SimpleFIN-linked; its readiness is then decided by the sync. */
  linked: boolean;
  /** For a linked account: has its connection synced past the month end plus the posting lag? */
  synced: boolean;
  lastSyncAt: string | null;
}

export interface MonthState {
  month: string;
  closed: boolean;
  closedAt: string | null;
  /** True when the household has at least one manual account, so a person must confirm. */
  needsConfirmation: boolean;
  accounts: AccountReadiness[];
  /** Linked accounts that have not synced past the month end yet — named in the caveat if closed anyway. */
  waiting: string[];
}

/**
 * Every account that could hold last month's money, with how we know whether its data is in.
 *
 * Inactive accounts are excluded: they cannot receive new transactions, so waiting on one would be
 * waiting forever for a statement nobody will ever import.
 */
export function accountReadiness(month: string): AccountReadiness[] {
  const cutoff = addDaysIso(monthEnd(month), POSTING_LAG_DAYS);
  const rows = getDb()
    .select({
      accountId: accounts.id,
      name: accounts.name,
      simplefinId: simplefinAccountLinks.simplefinAccountId,
      lastSyncAt: simplefinConnections.lastSyncAt,
    })
    .from(accounts)
    .leftJoin(simplefinAccountLinks, eq(simplefinAccountLinks.accountId, accounts.id))
    // One connection today, and the schema does not link an account to a specific one, so the
    // most recent successful sync across enabled connections is the honest signal.
    .leftJoin(simplefinConnections, eq(simplefinConnections.enabled, true))
    .where(eq(accounts.isActive, true))
    .all();

  const byAccount = new Map<number, AccountReadiness>();
  for (const row of rows) {
    const linked = row.simplefinId !== null;
    const synced = linked && row.lastSyncAt !== null && row.lastSyncAt.slice(0, 10) >= cutoff;
    const existing = byAccount.get(row.accountId);
    // Several connection rows can join the same account; keep the most favourable sync.
    if (existing === undefined || (synced && !existing.synced)) {
      byAccount.set(row.accountId, {
        accountId: row.accountId,
        name: row.name,
        linked,
        synced,
        lastSyncAt: row.lastSyncAt ?? null,
      });
    }
  }
  return [...byAccount.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The recorded closure for a month, or null. */
export function closureFor(month: string): { closedAt: string; summarySentAt: string | null } | null {
  const row = getDb()
    .select({ closedAt: monthClosures.closedAt, summarySentAt: monthClosures.summarySentAt })
    .from(monthClosures)
    .where(eq(monthClosures.month, month))
    .get();
  return row ?? null;
}

/**
 * Everything the Import page banner and the dashboard line need, for one month.
 *
 * `needsConfirmation` is false only when EVERY account is linked. That is the case where the app
 * genuinely knows, so `closeMonthIfAutomatic` will do it without anybody being asked.
 */
export function monthState(month: string): MonthState {
  const closure = closureFor(month);
  const list = accountReadiness(month);
  const manual = list.filter((row) => !row.linked);
  return {
    month,
    closed: closure !== null,
    closedAt: closure?.closedAt ?? null,
    needsConfirmation: manual.length > 0,
    accounts: list,
    waiting: list.filter((row) => row.linked && !row.synced).map((row) => row.name),
  };
}

/**
 * Months that have ended, are not closed, and could hold money — oldest first.
 *
 * Bounded by the household's own history: a month before the first transaction has nothing to
 * summarise and must never appear as an outstanding chore on a fresh install.
 */
export function openMonths(now: Date = new Date(), tz?: string): string[] {
  const first = getDb()
    .select({ earliest: sql<string | null>`min(${transactions.date})` })
    .from(transactions)
    .get();
  if (!first?.earliest) return [];

  const today = todayIso(now, tz);
  const currentMonth = monthOf(today);
  const closed = new Set(
    getDb().select({ month: monthClosures.month }).from(monthClosures).all().map((row) => row.month),
  );

  const out: string[] = [];
  let cursor = monthOf(first.earliest);
  // Ended months only: the month in progress is not late, it is simply not over.
  while (cursor < currentMonth) {
    if (!closed.has(cursor)) out.push(cursor);
    const [y, m] = cursor.split('-').map(Number);
    cursor = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  return out;
}

/** Record a month closed. `closedBy` null means the app decided; a user id means a person did. */
export function closeMonth(month: string, closedBy: number | null, at: Date = new Date()): void {
  getDb()
    .insert(monthClosures)
    .values({ month, closedBy, closedAt: nowIso(at) })
    .onConflictDoNothing()
    .run();
}

/**
 * Close every open month the app can decide on its own — i.e. for a household whose accounts are
 * ALL SimpleFIN-linked and all synced past the month end.
 *
 * Returns what it closed, so the caller can send those summaries. A household with any manual
 * account closes nothing here and waits for the button, which is the whole point: the app declines
 * to guess on behalf of a person who is the only one who knows.
 */
export function closeMonthsAutomatically(now: Date = new Date(), tz?: string): string[] {
  const closed: string[] = [];
  for (const month of openMonths(now, tz)) {
    const state = monthState(month);
    if (state.needsConfirmation) continue;
    if (state.accounts.length === 0) continue;
    if (state.waiting.length > 0) continue;
    closeMonth(month, null, now);
    closed.push(month);
  }
  return closed;
}

/** Months closed but whose summary has not gone out yet — oldest first. */
export function closedMonthsAwaitingSummary(): string[] {
  return getDb()
    .select({ month: monthClosures.month })
    .from(monthClosures)
    .where(isNull(monthClosures.summarySentAt))
    .orderBy(monthClosures.month)
    .all()
    .map((row) => row.month);
}

/** Marks a month's summary as sent, so it is never enqueued twice. */
export function markMonthSummarySent(month: string, at: Date = new Date()): void {
  getDb()
    .update(monthClosures)
    .set({ summarySentAt: nowIso(at) })
    .where(and(eq(monthClosures.month, month), isNull(monthClosures.summarySentAt)))
    .run();
}
