import { getAccount } from '@/lib/accounts';
import { runEngine, type EngineResult } from '@/lib/categorize/engine';
import { nowIso } from '@/lib/clock';
import { todayIso } from '@/lib/dates';
import { readEnv } from '@/lib/env';
import { commitImport, type CommitRow } from '@/lib/import/commit';
import { DEDUP_HASH_VERSION } from '@/lib/import/dedup';
import { applyPaymentMatchers } from '@/lib/loans';
import { parseAmountToCents } from '@/lib/money';
import { recordBalanceSnapshot } from '@/lib/networth';
import type { RowError } from '@/lib/import/parse';
import { SimplefinError, fetchAccounts, type Fetcher, type SimplefinAccount } from './client';
import {
  MAX_WINDOW_DAYS,
  OVERLAP_DAYS,
  assertRequestBudget,
  consumeRequest,
  getAccessUrl,
  getConnection,
  listLinks,
  markLinksFirstSynced,
  markSynced,
  updateLinkBalance,
  type AccountLink,
} from './connection';

const DAY = 86400;

/**
 * end = now; start = last sync minus a 5-day overlap, clamped to the 90-day maximum.
 *
 * v1.61.0 item 3c. `pendingFrom` holds the start dates (YYYY-MM-DD) of links still waiting for
 * their first clean sync. The window starts at the earliest of the usual start and each of them,
 * taken as midnight UTC the day before (a margin for the household's zone), and never before the
 * 90-day floor. Without it, an account linked to a connection that had already synced got only
 * last-sync-minus-5-days, leaving a gap between its statements' end and that day.
 */
export function syncWindow(input: { lastSyncAt: string | null; now?: Date; pendingFrom?: string[] }): {
  startDate: number;
  endDate: number;
} {
  const now = input.now ?? new Date();
  const endDate = Math.floor(now.getTime() / 1000);
  const floor = endDate - MAX_WINDOW_DAYS * DAY;
  let start =
    input.lastSyncAt === null ? floor : Math.floor(new Date(input.lastSyncAt).getTime() / 1000) - OVERLAP_DAYS * DAY;
  for (const date of input.pendingFrom ?? []) {
    const midnight = Date.parse(`${date}T00:00:00.000Z`);
    if (Number.isFinite(midnight)) start = Math.min(start, Math.floor(midnight / 1000) - DAY);
  }
  return { startDate: Math.max(floor, start), endDate };
}

/** A link made with a start date whose first clean sync has not run yet (v1.61.0 item 3c). */
function isPendingFirstSync(link: AccountLink): boolean {
  return link.syncFrom !== null && link.firstSyncedAt === null;
}

export function postedToIsoDate(posted: number, tz?: string): string {
  const zone = tz ?? readEnv().tz;
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(posted * 1000),
  );
}

/**
 * Negative = debit, matching the app's sign convention with no transformation.
 * Delegates to the CSV importer's parseAmountToCents rather than duplicating
 * decimal-to-cents math: SimpleFIN permits arbitrary precision (e.g. "8.165"),
 * and a flat Number.EPSILON nudge is too small to correct the float error at
 * that magnitude — parseAmountToCents's magnitude-scaled epsilon rounds
 * correctly (817, not 816) and stays sign/format-compatible with every case
 * already covered here (thousands separators, plain "-12.34", etc).
 */
export function amountToCents(amount: string): number | null {
  if (typeof amount !== 'string') return null;
  return parseAmountToCents(amount);
}

export interface AccountSyncResult {
  simplefinAccountId: string;
  accountName: string;
  importId: number | null;
  added: number;
  duplicates: number;
  /**
   * v1.61.0. Possible duplicates of a row from another road (a hand-typed purchase, a statement):
   * not counted, waiting in Needs review until someone keeps or deletes them.
   */
  held: number;
  /** v1.61.0. Rows left out because a person already decided on them (deleted, or left out). */
  setAside: number;
  /** v1.61.0. Rows dated before the link's start date, which stay with the statements. */
  beforeStart: number;
  skippedPending: number;
  errors: number;
  currencyWarning: string | null;
}

export interface SyncResult {
  ranAt: string;
  accounts: AccountSyncResult[];
  errlist: string[];
  totalAdded: number;
  totalDuplicates: number;
  /**
   * v1.61.0. Possible duplicates this run held for Needs review, over every account. runSync always
   * sets it; optional only so a SyncResult built before v1.61.0 (the scheduler tests' stubs) still
   * types, and a reader treats a missing count as none.
   */
  totalHeld?: number;
  engine: EngineResult;
  /** true when runEngine threw after the rows were already committed — same contract as import/flow.ts. */
  engineFailed: boolean;
  loanLinksCreated: number;
  /** F5 fix-round: true when applyPaymentMatchers's own internal catch (MUST-13.5) fired. */
  loanMatchFailed: boolean;
}

/**
 * The label the import history shows for this run -- in the HOUSEHOLD's clock, not UTC (review E8).
 *
 * nowIso gives an instant; a person reading "simplefin 2026-04-03 01:00" at nine in the evening on
 * the 2nd has to work out that it means now. The date comes from todayIso, which already knows the
 * zone, and the time from the same Date rendered in it.
 */
function syncLabel(at: Date): string {
  const { tz } = readEnv();
  const time = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  return `simplefin ${todayIso(at, tz)} ${time}`;
}

export async function runSync(input: { userId: number; fetcher?: Fetcher; now?: Date }): Promise<SyncResult> {
  const now = input.now ?? new Date();
  const connection = getConnection();
  if (!connection) throw new SimplefinError('bad_token', 'There is no SimpleFIN connection configured yet.', 409);
  if (!connection.enabled) throw new SimplefinError('bad_token', 'The SimpleFIN connection is disabled.', 409);

  // Budget check happens BEFORE the request so a refusal never burns a call.
  assertRequestBudget(now);

  const accessUrl = getAccessUrl();
  if (accessUrl === null) throw new SimplefinError('bad_token', 'There is no SimpleFIN connection configured yet.', 409);

  // Read before the request, because a link waiting for its first sync widens the window. A
  // closed account is skipped below, so its start date must not widen the window for the others.
  const links = listLinks();
  const pendingFrom = links
    .filter((link) => isPendingFirstSync(link) && getAccount(link.accountId)?.isActive === true)
    .map((link) => link.syncFrom as string);
  const window = syncWindow({ lastSyncAt: connection.lastSyncAt, now, pendingFrom });
  consumeRequest(now);
  const set = await fetchAccounts({ accessUrl, startDate: window.startDate, endDate: window.endDate, fetcher: input.fetcher });

  const results: AccountSyncResult[] = [];
  const insertedIds: number[] = [];
  /** Links this run fetched that were waiting for their first sync; stamped only on a clean run. */
  const firstSynced: string[] = [];

  for (const remote of set.accounts as SimplefinAccount[]) {
    const link = links.find((candidate) => candidate.simplefinAccountId === remote.id);
    if (!link) continue; // unmapped remote accounts are ignored by design

    const account = getAccount(link.accountId);
    // v1.60.0 (fix round): a deactivated account stops syncing. Its rows and balances would
    // otherwise keep arriving after the day it was deactivated, on an account the household no
    // longer counts.
    if (!account || !account.isActive) continue;

    const rows: CommitRow[] = [];
    const errors: RowError[] = [];
    let skippedPending = 0;
    let beforeStart = 0;
    let rowIndex = 0;

    for (const txn of remote.transactions ?? []) {
      const index = rowIndex;
      rowIndex += 1;

      if (txn.pending === true) {
        // Pending rows change id and amount before settling — never store them.
        skippedPending += 1;
        continue;
      }
      const externalId = typeof txn.id === 'string' ? txn.id.trim() : '';
      if (externalId.length === 0) {
        errors.push({ rowIndex: index, cells: [String(txn.description ?? '')], reason: 'malformed row' });
        continue;
      }
      const amountCents = amountToCents(String(txn.amount ?? ''));
      if (amountCents === null) {
        errors.push({ rowIndex: index, cells: [externalId, String(txn.amount ?? '')], reason: 'unparseable amount' });
        continue;
      }
      const description = String(txn.description ?? '').trim();
      if (description.length === 0) {
        errors.push({ rowIndex: index, cells: [externalId], reason: 'missing description' });
        continue;
      }

      const postedNum = Number(txn.posted);
      if (!Number.isFinite(postedNum)) {
        // A malformed/missing posted date would otherwise reach
        // Intl.DateTimeFormat with an Invalid Date and throw a RangeError,
        // crashing the whole sync AFTER the request budget was already spent.
        errors.push({ rowIndex: index, cells: [externalId, String(txn.posted)], reason: 'unparseable date' });
        continue;
      }
      const date = postedToIsoDate(postedNum);
      // v1.61.0 item 3c. A permanent floor, not only the first window's edge: a wider window later
      // (another link's first sync, a long outage) must never bring statement-era rows back.
      if (link.syncFrom !== null && date < link.syncFrom) {
        beforeStart += 1;
        continue;
      }
      rows.push({
        rowIndex: index,
        rawDate: String(txn.posted),
        date,
        rawDescription: description,
        amountCents,
        // SimpleFIN has no CSV balanceCol concept at all -- its own balance snapshot is
        // written separately below (source: 'simplefin', off remote.balance), independent of
        // this per-transaction field, which v1.8.0's CandidateRow adds for the CSV path only.
        balanceCents: null,
        cells: [],
        occurrenceIndex: 0,
        // SimpleFIN rows dedup on external_id, not on the CSV hash.
        dedupHash: '',
        hashVersion: DEDUP_HASH_VERSION,
        externalId,
      });
    }

    // v1.61.0. origin 'simplefin' so these rows are compared only with rows from another road (a
    // hand-typed purchase, a statement), never with this account's own earlier sync rows. No
    // rowDecisions: nobody is looking, so a possible duplicate is HELD for Needs review, not
    // inserted (owner decision 1).
    const committed = commitImport({
      accountId: link.accountId,
      profileId: null,
      filename: syncLabel(now),
      importedBy: input.userId,
      rows,
      errors,
      at: now,
      origin: 'simplefin',
    });
    insertedIds.push(...committed.insertedTransactionIds);
    if (isPendingFirstSync(link)) firstSynced.push(link.simplefinAccountId);

    const balanceCents = amountToCents(String(remote.balance ?? ''));
    // Same guard as the per-transaction posted date: a malformed balance-date
    // must not throw out of Intl.DateTimeFormat and crash the whole sync.
    const balanceDateRaw = remote['balance-date'];
    const balanceDate =
      typeof balanceDateRaw === 'number' && Number.isFinite(balanceDateRaw) ? postedToIsoDate(balanceDateRaw) : null;
    updateLinkBalance({
      simplefinAccountId: remote.id,
      balanceCents,
      balanceDate,
    });

    // Balance snapshot capture (spec 2026-08-22, v1.7.0, Task 6). Both fields are required --
    // a null balanceCents (unparseable) or null balanceDate (missing/malformed) would produce
    // a meaningless or undated row, so recordBalanceSnapshot is simply not called at all
    // rather than being handed a null it would have to reject itself. This account's rows
    // from commitImport() above are already committed, so -- same reasoning as the runEngine
    // try/catch below, just one loop iteration earlier -- a snapshot failure (a locked db, a
    // schema mismatch, anything) must not throw out of the sync and lose those rows' place in
    // markSynced(), nor stop the loop from reaching the REMAINING linked accounts.
    if (balanceCents !== null && balanceDate !== null) {
      try {
        recordBalanceSnapshot({ accountId: link.accountId, date: balanceDate, balanceCents, source: 'simplefin' });
      } catch (error) {
        console.error('[simplefin] balance snapshot failed', error);
      }
    }

    const currency = String(remote.currency ?? link.currency ?? 'CAD').toUpperCase();
    results.push({
      simplefinAccountId: remote.id,
      accountName: account.name,
      importId: committed.importId,
      added: committed.rowsAdded,
      duplicates: committed.rowsDuplicate,
      held: committed.rowsHeld,
      setAside: committed.rowsSetAside,
      beforeStart,
      skippedPending,
      errors: errors.length,
      currencyWarning:
        currency === 'CAD'
          ? null
          : `${account.name} reports ${currency}. This app stores integer cents with no conversion, so mixing currencies will distort your reports.`,
    });
  }

  // The rows are already committed here, so a categorizer failure must not
  // throw out of the sync (import/flow.ts makes the same trade): throwing
  // would skip markSynced(), leaving last_sync_at stale so the next sync
  // re-fetches a window it already stored, and would surface as "sync failed"
  // even though every row is safely in the database. Uncategorized rows are
  // exactly what the review queue is for.
  let engine: EngineResult;
  let engineFailed = false;
  try {
    engine = runEngine(insertedIds);
  } catch {
    engineFailed = true;
    engine = { processed: 0, categorized: 0, transfers: 0, skipped: 0, changed: 0 };
  }
  // MUST-13.7: same post-commit slot as import/flow.ts, on the sync's own inserted ids.
  // Same out-param pattern as flow.ts for F5's loanMatchFailed.
  const loanMatchReport = { failed: false };
  const loanLinksCreated = applyPaymentMatchers(insertedIds, undefined, loanMatchReport);

  /*
    THE WINDOW ONLY MOVES WHEN EVERY BANK ANSWERED (review E2).

    last_sync_at is where the next window starts, and the overlap is five days. Stamping it after a
    run the bridge told us was partial meant a bank down for twelve days lost days one to seven
    permanently -- no gap on screen, no alert, and no way back except a household noticing months
    later that a week of its own statements is missing.

    What DID arrive is already committed above, and duplicates are impossible (every row carries a
    dedup hash), so re-fetching the overlap next time costs a little bandwidth and nothing else.
  */
  if (set.errlist.length === 0) {
    markSynced(now);
    // v1.61.0 item 3c: the same rule for a new link's first pull. A partial run leaves it pending,
    // so the next run reaches back to its start date again.
    markLinksFirstSynced(firstSynced, now);
  }

  return {
    ranAt: nowIso(now),
    accounts: results,
    errlist: set.errlist,
    totalAdded: results.reduce((sum, row) => sum + row.added, 0),
    totalDuplicates: results.reduce((sum, row) => sum + row.duplicates, 0),
    totalHeld: results.reduce((sum, row) => sum + row.held, 0),
    engine,
    engineFailed,
    loanLinksCreated,
    loanMatchFailed: loanMatchReport.failed,
  };
}
