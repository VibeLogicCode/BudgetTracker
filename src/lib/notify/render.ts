import { daysBetweenIso, monthLabel } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import { divRound } from '@/lib/predict/stats';
import { ITEM_KIND_LABELS, expiryPhraseForKind, type ItemKind } from '@/lib/warranty/constants';

/**
 * MUST-10.1: ONE channel-agnostic renderer. Telegram sends `subject + '\n\n' + body`;
 * email sends `subject` as the Subject header and `body` as the text part. One renderer,
 * two envelopes: the two channels can never drift apart in wording, and every message is
 * testable as a pure function.
 *
 * PURE (MUST-2.1). Every value arrives already resolved: the evaluators do the querying.
 *
 * MUST-10.4: no body contains a link. The server has no reliable idea of the URL the
 * family uses (LAN IP, reverse-proxy hostname, Tailscale name), and a wrong link is worse
 * than no link.
 */
export const NAME_MAX = 80;
export const USER_AGENT_MAX = 120;

/** MUST-10.3: every value from user or import data is plain text and bounded. */
export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export interface DigestLine {
  name: string;
  cents: number;
}

/** One category's line in the predicted-against-actual report (spec section 9.6). */
export interface PredictedLine {
  name: string;
  expectedCents: number;
  actualCents: number;
}

/** One category's line in the suggested-budget refresh (spec section 9.7). */
export interface RefreshLine {
  name: string;
  nowCents: number;
  /** null when the category has no resolved limit for the month. */
  wasCents: number | null;
}

/**
 * 2026-09-09. One thing that is due, in the batched coming_due message.
 *
 * Deliberately carries the SOURCE FIELDS rather than a pre-composed sentence. The line's wording is
 * a presentation decision and belongs in this file with every other one -- an evaluator handing
 * over finished prose is how a second, drifting voice for the same event gets started.
 */
export interface ComingDueEntry {
  /** An installment on a bill, or an item's own expiry. */
  kind: 'installment' | 'expiry';
  name: string;
  /** Due date for an installment, expiry date for an item. */
  dateIso: string;
  /** Installments only: past its due date and still unpaid. Always false for an expiry. */
  overdue: boolean;
  /** Installments only. */
  amountCents: number | null;
  /** Expiries only: which of the four end-date verbs this item's type takes. */
  itemKind: ItemKind | null;
  /**
   * Expiries only, both optional in the data. Carried so the batched line loses NOTHING the
   * per-item message used to say -- that one put Vendor and Price on lines of their own, which is
   * exactly the shape that makes twenty of them unreadable. One line, same facts.
   */
  vendor: string | null;
  priceCents: number | null;
}

/** 2026-09-09. One account that has gone quiet, in the batched stale_import message. */
export interface StaleAccountLine {
  name: string;
  lastImportIso: string;
  daysAgo: number;
}

export type RenderInput =
  | {
      event: 'coming_due';
      /**
       * Ruling B15: REQUIRED, not optional. Making it required forces every existing call site
       * to write `variant: 'item'`, which is a compiler-checked edit rather than a silent
       * default that would let an old-shaped call quietly mean something new. There is no new
       * event id: "something is coming due" is one idea and stays one switch in the matrix
       * (MUST-4.5 makes the id permanent anyway).
       */
      variant: 'item';
      itemName: string;
      kind: ItemKind;
      expiryDate: string;
      todayIso: string;
      vendor: string | null;
      priceCents: number | null;
    }
  | {
      event: 'coming_due';
      variant: 'installment';
      itemName: string;
      dueDate: string;
      amountCents: number;
      todayIso: string;
      overdue: boolean;
    }
  | {
      /**
       * 2026-09-09. ONE message listing everything due, in place of one message per item.
       *
       * The two variants above are what this composes from conceptually and what the app sent
       * until now; they are RETAINED rather than deleted for the reason evaluateBudgets is
       * (evaluate/index.ts): a per-item alert is one line to restore, and its wording is pinned by
       * tests that would otherwise have to be rewritten to bring it back. Nothing calls them today.
       */
      event: 'coming_due';
      variant: 'batch';
      todayIso: string;
      entries: readonly ComingDueEntry[];
      /** Items beyond the ones listed, so a large library says so rather than silently truncating. */
      omitted: number;
    }
  | {
      event: 'budget_threshold';
      scope: 'household' | 'personal';
      categoryName: string;
      month: string;
      pct: number;
      spentCents: number;
      limitCents: number;
    }
  | {
      event: 'budget_exceeded';
      scope: 'household' | 'personal';
      categoryName: string;
      month: string;
      spentCents: number;
      limitCents: number;
    }
  | { event: 'backup_failed'; dateIso: string; error: string }
  | {
      event: 'weekly_digest';
      /**
       * v1.28.0. REQUIRED, not optional, and for ruling B15's reason (see coming_due above):
       * making it required forces every existing call site to write `variant: 'personal'`, which
       * is a compiler-checked edit rather than a silent default. There is no new event id --
       * MUST-4.5 makes ids permanent and the weekly digest is one idea and one switch in the
       * matrix; what changes is who the message is addressed to.
       */
      variant: 'personal';
      fromIso: string;
      toIso: string;
      householdSpentCents: number;
      personalSpentCents: number;
      topCategories: readonly DigestLine[];
      topMerchants: readonly DigestLine[];
      reviewCount: number;
      budgets: BudgetSummary;
      openMonths: readonly string[];
    }
  | {
      event: 'weekly_digest';
      /**
       * The family channel's digest. It carries no `personalSpentCents` because there is no
       * "you" reading it: a group chat is read by everybody, so "Your spend" would be a
       * different number for each of them and wrong for all but one. Its place is taken by
       * `members` plus `unattributedCents`, which together sum to householdSpentCents.
       */
      variant: 'household';
      fromIso: string;
      toIso: string;
      householdSpentCents: number;
      /** One line per person, in users.id order. Named, so the group can see who is who. */
      members: readonly DigestLine[];
      /**
       * The money nobody has claimed. It is a line in its own right rather than a rounding
       * remainder: in a joint household an unattributed pile is the thing worth a conversation,
       * and without it the member lines silently fail to add up to the total.
       */
      unattributedCents: number;
      topCategories: readonly DigestLine[];
      topMerchants: readonly DigestLine[];
      reviewCount: number;
      budgets: BudgetSummary;
      openMonths: readonly string[];
    }
  | { event: 'new_signin'; name: string; atLabel: string; tz: string; ip: string; userAgent: string | null }
  | { event: 'password_changed'; name: string; atLabel: string; tz: string }
  | { event: 'mfa_disabled'; name: string; atLabel: string; tz: string }
  | {
      event: 'restore_outcome';
      status: 'success' | 'failed';
      sourceName: string;
      requestedByUsername: string;
      finishedAt: string;
      receiptsRestored: number;
      missingReceiptRows: number;
      error: string | null;
    }
  | {
      event: 'stale_import';
      variant: 'single';
      weeks: number;
      lastImportIso: string;
      daysAgo: number;
      /**
       * v1.13.0 ruling R14 (item AM / PROD-10). Required, not optional: the alert now groups by
       * account, so every message names which one has gone quiet -- omitting it would let a call
       * site silently fall back to the old, ambiguous household-wide wording.
       */
      accountName: string;
    }
  | {
      /**
       * 2026-09-09. ONE message naming every account that has gone quiet, in place of one message
       * per account. Ruling R14's point stands and is kept -- the message still names which
       * accounts, so five quiet accounts never read as five identical repeats -- but it is a
       * LIST, not five notifications. The evaluator sends this and nothing else.
       */
      event: 'stale_import';
      variant: 'batch';
      weeks: number;
      accounts: readonly StaleAccountLine[];
    }
  | {
      event: 'update_available';
      currentVersion: string;
      latestVersion: string;
      severity: 'patch' | 'minor' | 'major';
      publishedAt: string | null;
      canApplyInApp: boolean;
    }
  | {
      event: 'budget_pace';
      scope: 'household' | 'personal';
      categoryName: string;
      month: string;
      limitCents: number;
      spentCents: number;
      dayOfMonth: number;
      projectedCents: number;
    }
  | {
      event: 'unusual_transaction';
      merchant: string;
      accountName: string;
      dateIso: string;
      /** Signed, negative for a spend. */
      amountCents: number;
      baselineCents: number;
      baselineKind: 'merchant' | 'category';
      categoryName: string | null;
    }
  | {
      event: 'subscription_creep';
      merchant: string;
      dateIso: string;
      newAmountCents: number;
      baselineCents: number;
      priorCount: number;
    }
  | {
      event: 'duplicate_charge';
      merchant: string;
      /** Signed, negative for a spend. */
      amountCents: number;
      earlierDateIso: string;
      laterDateIso: string;
    }
  | {
      event: 'predicted_vs_actual';
      month: string;
      household: readonly PredictedLine[];
      personal: readonly PredictedLine[];
      /**
       * Review round 1 (item 3): NULLABLE, and null omits the total sentence entirely. The
       * sentence is a positive factual claim about HOUSEHOLD state ("across every household
       * category with a suggestion, August came in $X over"), so a recipient whose message
       * correctly carries no Household block has no true value to put in it. It used to be
       * passed 0 for a self-scoped recipient, which rendered "$0.00 over" while the real
       * household delta was $113.40 -- a false zero, not the vacuously-true zero a household
       * with no suggested top-level category produces. Those two cases have to render
       * differently, so the type distinguishes them.
       */
      totalDeltaCents: number | null;
    }
  | {
      event: 'suggested_budget_refresh';
      month: string;
      household: readonly RefreshLine[];
      personal: readonly RefreshLine[];
      changedCount: number;
    }
  // Task 8 (v1.7.0): exactly two dynamic fields on purpose. SECURITY: `error` must be
  // error.message ONLY (see raise.ts's raiseSyncFailed) -- the SimpleFIN access URL is a
  // bearer credential and this event id must never carry a third field a URL could ride in
  // on, such as the connection row or the request that failed.
  | { event: 'sync_failed'; dateIso: string; error: string }
  // Task 16 (v1.7.0): the monthly household digest. `month` is the month that JUST ENDED
  // (the evaluator's job, not this renderer's, to pick it), and every figure here is already
  // resolved by the evaluator from existing report/budget helpers -- cashflowTrend for
  // income/spend/net, budgetTotals(budgetProgress(month)) for the budgeted pair, topMerchants
  // for the merchant lines. This renderer does no aggregation of its own.
  | {
      event: 'monthly_digest';
      month: string;
      incomeCents: number;
      spendCents: number;
      netCents: number;
      budgetedLimitCents: number;
      budgetedSpentCents: number;
      topMerchants: readonly DigestLine[];
      /**
       * 2026-09-09. How the closed month's savings came out, or null when there was no resolved
       * target -- and null for a self-scoped recipient, for whom a household savings figure is
       * ruling R2's leak and has no personal analogue to narrow to (ruling T3).
       *
       * This is where savings_target_met went. It used to fire on a five-minute TICK, the moment
       * net first crossed the target, which for a household paid monthly means a push notification
       * on payday every month saying something they could already see. It is a fact about a month,
       * so it belongs in the message about that month.
       */
      savings: { netCents: number; targetCents: number; met: boolean } | null;
    }
  // Lane 2 (spec docs/superpowers/plans/2026-08-30-savings-targets.md). Ruling T3: household
  // scope only, so none of the three savings events below carries a `scope` field the way the
  // budget events do -- there is exactly one figure per month, not a household/personal pair.
  | { event: 'savings_target_met'; month: string; netCents: number; targetCents: number }
  | {
      event: 'savings_target_pace';
      month: string;
      dayOfMonth: number;
      netCents: number;
      targetCents: number;
      /** targetCents pro-rated to dayOfMonth (ruling T5) -- computed by the evaluator, never
       *  recomputed here (MUST-2.1: this renderer is pure and does no arithmetic of its own). */
      proRatedTargetCents: number;
    }
  | {
      event: 'savings_month_closed';
      month: string;
      netCents: number;
      targetCents: number;
      met: boolean;
      /** From savingsStreak (src/lib/savings-target.ts), already inclusive of this closed month.
       *  Never restated here: this renderer only picks the wording, per ruling T1's "one
       *  definition of saved/met" and the same rule extended to "one definition of streak". */
      streak: number;
    }
  | {
      /** Backlog item 17 / Part 4: modelled on 'update_available' above -- a version comparison,
       *  nothing this renderer resolves itself (src/lib/canadian-pack.ts's
       *  notifyCanadianPackUpdateAvailable passes already-resolved numbers, the same discipline
       *  runUpdateCheck follows for the app's own version pair). */
      event: 'pack_update_available';
      packLabel: string;
      installedVersion: number;
      bundledVersion: number;
    };

function money(cents: number): string {
  return formatCents(cents, { currency: true });
}

/**
 * Owner report, 2026-09-08: a Telegram alert read "Budget 98.61999999999999%: Home Improvement".
 *
 * `pct` arrives as a raw float from budgetProgress (spent / limit * 100), and $147.93 of $150.00 is
 * genuinely 98.61999999999999 in binary floating point. Interpolating it straight into a sentence
 * published every figure IEEE-754 could produce.
 *
 * Two decimals, then trailing zeros dropped via Number(): 98.62, 180.99, and a clean 100 rather
 * than 100.00. Rounding is a PRESENTATION decision made here and nowhere else -- the stored figure
 * and every comparison against a threshold keep full precision, because a budget that fires at
 * 99.996% must not be rounded into firing at 100 and then described as over.
 */
function percent(value: number): string {
  return String(Number(value.toFixed(2)));
}

function scopeWord(scope: 'household' | 'personal'): string {
  return scope === 'household' ? 'Household' : 'Your';
}

/**
 * "third month running" is the sentence savings_month_closed exists to send (Lane 2 plan), so
 * the streak needs a word shape, not a bare integer sitting next to "month running". Handles
 * the 11th/12th/13th exception explicitly -- savingsStreak's own `max` (default 24) never
 * reaches a SECOND such exception (111th etc.), so this need not handle one.
 */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function inDays(todayIso: string, targetIso: string): string {
  const days = daysBetweenIso(todayIso, targetIso);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** notify §11.4's amendment: iso.slice(0, 16).replace('T', ' ') is the app's ONE convention. */
function publishedLine(publishedAt: string | null): string {
  if (publishedAt === null) return '';
  return `\n\nPublished ${publishedAt.slice(0, 16).replace('T', ' ')}.`;
}

/**
 * Two columns, padded, so a digest reads as a table in a plain-text message.
 *
 * 2026-09-09: NO LONGER USED BY THE DIGESTS. Telegram sends plain text with no parse_mode, so a
 * phone renders it in a PROPORTIONAL font -- and a column built with padEnd, which assumes every
 * character is the same width, comes out visibly ragged. It looked correct in the tests and in
 * email, and wrong in the only place the household actually reads it.
 *
 * `Name: $figure` (nameAndMoney below) reads correctly in any font, which is why the budget block
 * added a day earlier already used that shape. This is the rest of the file catching up.
 *
 * Kept because the two month-boundary reports below compose on top of it (predictedLines and
 * refreshLines append a second and third figure to an aligned first column, and their exact output
 * is pinned by MUST-9.30's tests). Those are email-shaped reports that a household enables
 * deliberately; the digests are the ones that land on a phone every week.
 */
function padded(lines: readonly DigestLine[], indent = '  '): string[] {
  const width = lines.reduce((max, line) => Math.max(max, truncateText(line.name, NAME_MAX).length), 0);
  return lines.map((line) => `${indent}${truncateText(line.name, NAME_MAX).padEnd(width + 2)}${money(line.cents)}`);
}

/**
 * 2026-09-09. The digest's one line shape: `Name: $figure`, no alignment.
 *
 * See padded() above for why. Whole dollars for the same reason budgetLines uses them -- these are
 * scanning figures, and nobody reconciles a merchant total from a notification.
 */
function nameAndMoney(lines: readonly DigestLine[]): string[] {
  return lines.map((line) => `${truncateText(line.name, NAME_MAX)}: ${wholeMoney(line.cents)}`);
}

/**
 * MUST-9.30: the existing two-column padded() helper aligns the category name against the
 * expected figure; the other two figures are appended after it has run.
 *
 * Nothing composite is ever handed to padded(). It applies truncateText(name, NAME_MAX), so a
 * composite left column would let an 80-character category name cut the last dollar amount
 * off the line. Only the category name goes in, which is what NAME_MAX is for.
 *
 * Every figure goes through money(), which never prints a leading plus (MUST-9.39), so a
 * category that came in under its expectation reads -$20.00 and one that came in over reads
 * $93.40. Section 9.6's example line shows a plus; MUST-9.39 is the binding rule.
 */
function predictedLines(rows: readonly PredictedLine[]): string[] {
  return padded(rows.map((row) => ({ name: row.name, cents: row.expectedCents }))).map((line, index) => {
    const row = rows[index];
    return `${line} expected, ${money(row.actualCents)} actual, ${money(row.actualCents - row.expectedCents)} difference`;
  });
}

/** Same composition, with "no limit set" where the category has never had one. */
function refreshLines(rows: readonly RefreshLine[]): string[] {
  return padded(rows.map((row) => ({ name: row.name, cents: row.nowCents }))).map((line, index) => {
    const was = rows[index].wasCents;
    return `${line} suggested, ${was === null ? 'no limit set' : `${money(was)} set`}`;
  });
}

/**
 * 2026-09-08 (owner report: "there is 1 message per budget can we not send a summary message with
 * key figures and less repetative text"). One budget's standing, with the figures that matter.
 *
 * Replaces the bare `string[]` of category names the digest used to carry. Names alone forced the
 * household to go and look up every figure, which is why the per-category alerts existed at all --
 * and those alerts are what this now absorbs.
 */
export interface BudgetStanding {
  name: string;
  spentCents: number;
  limitCents: number;
}

/**
 * 2026-09-09. One budget the month is not over yet but is heading past, with where the projection
 * lands. This is what budget_pace used to send one message per category for, on a DAILY slot.
 */
export interface BudgetPaceStanding extends BudgetStanding {
  /** Month-end spend if the rest of the month looks like the part already spent. */
  projectedCents: number;
}

/**
 * What the digest says about budgets. THE THREE LISTS ARE DISJOINT, and the order is the order a
 * household should read them in:
 *
 *   over   the limit is gone. Nothing to predict.
 *   pace   not over yet, but the projection lands past the limit if nothing changes.
 *   close  at the warning percentage, and NOT projected over -- which makes it the mildest of the
 *          three, not the second.
 *
 * `pace` sits between them because it is the only one that is actionable and not yet true: a
 * category at 30 percent on the 8th heading for 400 percent belongs above one sitting at 85 percent
 * that the projection says will finish under. A static threshold and a prediction are different
 * facts, and before this the summary only ever carried the threshold.
 *
 * A category appears in exactly one list. Naming it twice under two headings is the repetition
 * every other part of this redesign removed.
 */
export interface BudgetSummary {
  over: readonly BudgetStanding[];
  pace: readonly BudgetPaceStanding[];
  close: readonly BudgetStanding[];
}

type WeeklyDigestInput = Extract<RenderInput, { event: 'weekly_digest' }>;

/**
 * `Name: $spent of $limit, $gap over|left` -- the one budget line shape, used everywhere.
 *
 * Whole dollars, not cents: this is a scanning figure, and nobody reconciles from a phone
 * notification. Dollars over rather than a percentage, because "$81 over" is what a household
 * feels and "180.99%" is what a spreadsheet feels.
 *
 * NOT padded() -- see that helper's own note. Telegram sends plain text with no parse_mode, so it
 * renders in a proportional font and column alignment built with padEnd comes out ragged on every
 * phone. `Name: figures` reads correctly in any font.
 */
function budgetLines(rows: readonly BudgetStanding[]): string[] {
  return rows.map((row) => {
    const gap = row.spentCents - row.limitCents;
    const tail = gap > 0 ? `${wholeMoney(gap)} over` : `${wholeMoney(-gap)} left`;
    return `${truncateText(row.name, NAME_MAX)}: ${wholeMoney(row.spentCents)} of ${wholeMoney(row.limitCents)}, ${tail}`;
  });
}

/** Whole dollars, rounded to the nearest. Summaries scan; only a single-charge alert needs cents. */
function wholeMoney(cents: number): string {
  return money(Math.round(Math.abs(cents) / 100) * 100).replace(/\.00$/, '');
}

/**
 * 2026-09-08. The standing reminder for a month nobody has confirmed complete.
 *
 * A month is never auto-closed and its summary is never auto-sent, so without this the only signal
 * that one is waiting would be its absence -- and an absence nobody notices is how a household ends
 * up never seeing a monthly summary again. It rides the weekly summary rather than being a message
 * of its own, because the weekly is already in front of them and a nag with its own notification
 * would be exactly the noise this whole change removes.
 */
function openMonthReminder(months: readonly string[]): string[] {
  if (months.length === 0) return [];
  const named = months.map((month) => monthLabel(month)).join(' and ');
  return ['', `${named} ${months.length === 1 ? 'is' : 'are'} not closed. Close on the Import page to get the summary.`];
}

/**
 * 2026-09-09. `Name: $spent of $limit, on pace for $projected` -- the pace line.
 *
 * Deliberately the SAME `Name: $spent of $limit` opening as budgetLines, with a different tail.
 * One shape learned once: the reader's eye already knows where the two figures are, and the clause
 * after the comma is the only thing that varies between the three headings.
 *
 * NO PERCENTAGE. The per-category alert said "at that rate the month ends near $620, about $120
 * over"; a summary line has room for the landing figure, which is the number somebody acts on.
 * "124%" is what a spreadsheet feels.
 */
function paceLines(rows: readonly BudgetPaceStanding[]): string[] {
  return rows.map(
    (row) =>
      `${truncateText(row.name, NAME_MAX)}: ${wholeMoney(row.spentCents)} of ${wholeMoney(row.limitCents)}, ` +
      `on pace for ${wholeMoney(row.projectedCents)}`,
  );
}

/** The budget block both digest variants share. Omitted entirely when there is nothing to say. */
function budgetBlock(budgets: BudgetSummary): string[] {
  const parts: string[] = [];
  if (budgets.over.length > 0) parts.push('', 'Over', ...budgetLines(budgets.over));
  // 2026-09-09: between Over and Close, because a projection that lands past the limit is more
  // use than a threshold that has merely been touched. See BudgetSummary's own note.
  if (budgets.pace.length > 0) parts.push('', 'On pace to go over', ...paceLines(budgets.pace));
  if (budgets.close.length > 0) parts.push('', 'Close', ...budgetLines(budgets.close));
  if (budgets.over.length > 0) {
    const total = budgets.over.reduce((sum, row) => sum + (row.spentCents - row.limitCents), 0);
    parts.push('', `Total over: ${wholeMoney(total)}.`);
  }
  return parts;
}

/**
 * 2026-09-09. The batched "what is due" message.
 *
 * Owner report: "there is 1 message per budget can we not send a summary message with key figures
 * and less repetitive text so its easier to read and digest info" -- said about budgets, and the
 * same complaint applies unchanged here. Five items inside the window used to be five
 * notifications, each with its own subject, arriving in the same minute.
 *
 * OVERDUE FIRST and under its own heading, because a bill that is late and one that is due next
 * Tuesday are different news and a single flat list buries the first in the second. Money is whole
 * dollars for the same reason the digest's are (wholeMoney): nobody reconciles from a phone.
 *
 * NOT padded() -- Telegram renders plain text in a proportional font, so column alignment built
 * with padEnd comes out ragged on a phone. `Name: figures` reads correctly in any font.
 */
function renderComingDueBatch(input: Extract<RenderInput, { event: 'coming_due'; variant: 'batch' }>): {
  subject: string;
  body: string;
} {
  const line = (entry: ComingDueEntry): string => {
    const name = truncateText(entry.name, NAME_MAX);
    if (entry.kind === 'installment') {
      const amount = entry.amountCents === null ? '' : `${wholeMoney(entry.amountCents)}, `;
      if (entry.overdue) {
        const daysAgo = daysBetweenIso(entry.dateIso, input.todayIso);
        return `${name}: ${amount}due ${entry.dateIso} (${daysAgo} day${daysAgo === 1 ? '' : 's'} ago)`;
      }
      return `${name}: ${amount}due ${entry.dateIso} (${inDays(input.todayIso, entry.dateIso)})`;
    }
    // The verb comes from expiryPhraseForKind (MUST-6.14 / MUST-19.11), never from a literal here.
    const kind = entry.itemKind ?? 'warranty';
    const detail = [
      entry.vendor === null ? '' : truncateText(entry.vendor, NAME_MAX),
      entry.priceCents === null ? '' : money(entry.priceCents),
    ]
      .filter((part) => part !== '')
      .join(' ');
    const tail = detail === '' ? '' : `, ${detail}`;
    return `${name}: ${expiryPhraseForKind(kind, entry.dateIso)} (${inDays(input.todayIso, entry.dateIso)})${tail}`;
  };

  const overdue = input.entries.filter((entry) => entry.overdue);
  const upcoming = input.entries.filter((entry) => !entry.overdue);

  const parts: string[] = [];
  if (overdue.length > 0) parts.push('Overdue', ...overdue.map(line));
  if (upcoming.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push('Coming up', ...upcoming.map(line));
  }
  if (input.omitted > 0) parts.push('', `And ${input.omitted} more.`);

  // The subject carries the counts, so the message can be triaged from the lock screen without
  // being opened -- which is the whole reason for batching rather than sending one of each.
  const total = input.entries.length + input.omitted;
  const subject =
    overdue.length > 0
      ? `${overdue.length} overdue, ${total - overdue.length} coming due`
      : `${total} coming due`;
  return { subject, body: parts.join('\n').trimEnd() };
}

/** The tail both digest variants share when the week held nothing at all. */
function emptyDigestTail(input: WeeklyDigestInput): string {
  // A week with no transactions can still hold budgets that went over earlier in the month, so the
  // budget block is appended here too rather than being treated as spend-only news.
  const tail: string[] = ['No transactions were recorded this week.'];
  if (input.reviewCount > 0) tail.push(`${input.reviewCount} transactions still need review.`);
  tail.push(...budgetBlock(input.budgets));
  return tail.join('\n').trimEnd();
}

/** The tables and footer both variants share, appended after each one's own header block. */
function digestTail(input: WeeklyDigestInput, parts: string[]): string {
  if (input.topCategories.length > 0) {
    parts.push('', 'Top categories (household)', ...nameAndMoney(input.topCategories));
  }
  if (input.topMerchants.length > 0) {
    parts.push('', 'Top merchants (household)', ...nameAndMoney(input.topMerchants));
  }
  // 2026-09-08: the budget block replaces the old one-line "Over budget this month: A, B, C."
  // That line named categories and gave no figures, which is exactly why a separate alert per
  // category had to exist. With the figures here, those alerts have nothing left to add.
  parts.push(...budgetBlock(input.budgets));
  parts.push('');
  if (input.reviewCount > 0) parts.push(`${input.reviewCount} transactions still need review.`);
  return parts.join('\n').trimEnd();
}

function renderDigest(input: Extract<WeeklyDigestInput, { variant: 'personal' }>): string {
  const empty =
    input.householdSpentCents === 0 &&
    input.personalSpentCents === 0 &&
    input.topCategories.length === 0 &&
    input.topMerchants.length === 0;
  if (empty) return emptyDigestTail(input);

  // Byte-for-byte what v1.3.0 shipped, including the hand-aligned two spaces after "Your spend:".
  // The household variant below is a SECOND body, not a reshaped first one, precisely so this
  // string cannot drift while nobody is looking (tests/lib/notify/render.test.ts pins it).
  return digestTail(input, [
    `Household spend: ${money(input.householdSpentCents)}`,
    `Your spend:      ${money(input.personalSpentCents)}`,
  ]);
}

/**
 * v1.28.0: the family channel's digest.
 *
 * "showing household level spend to each member spend rather then just your spend" is what the
 * household asked for, and the per-member block is the whole point: one message in the group chat
 * that says what the household spent AND who spent it. Built from the SAME padded() two-column
 * helper as everything else in this file, so it reads as a table in a Telegram message and in a
 * plain-text email without a second style existing anywhere.
 *
 * Unattributed sits inside the same padded block rather than after it, so its figure lines up
 * with the members' and the column of numbers visibly adds to the total above it.
 */
function renderHouseholdDigest(input: Extract<WeeklyDigestInput, { variant: 'household' }>): string {
  const empty =
    input.householdSpentCents === 0 &&
    input.members.every((line) => line.cents === 0) &&
    input.unattributedCents === 0 &&
    input.topCategories.length === 0 &&
    input.topMerchants.length === 0;
  if (empty) return emptyDigestTail(input);

  const parts: string[] = [`Household spend: ${money(input.householdSpentCents)}`];
  const who: DigestLine[] = [...input.members, { name: 'Unattributed', cents: input.unattributedCents }];
  parts.push('', 'Who spent it', ...nameAndMoney(who));
  return digestTail(input, parts);
}

/**
 * Task 16 (v1.7.0): the monthly digest, sharing the weekly digest's plain-text table style
 * (the same padded() helper) rather than inventing a second one.
 *
 * Defect fix: a real closed calendar month for a dormant household IS truly empty -- no
 * income, no spend, no merchants and no budget ever resolved -- and used to render a full
 * message reading Income $0.00 / Spent $0.00 / Net $0.00 / "No budgets were set this month.",
 * identically every month forever, with no way to tell it apart from a working digest. This
 * now gets the same "nothing to report" branch the weekly digest already has (renderDigest
 * above), in the same voice, rather than repeating a message that reads all zeroes.
 */
function renderMonthlyDigest(input: Extract<RenderInput, { event: 'monthly_digest' }>): string {
  const empty =
    input.incomeCents === 0 &&
    input.spendCents === 0 &&
    input.netCents === 0 &&
    input.topMerchants.length === 0 &&
    input.budgetedLimitCents === 0;
  if (empty) return 'No transactions were recorded last month.';

  const parts: string[] = [
    `Income: ${money(input.incomeCents)}`,
    `Spent: ${money(input.spendCents)}`,
    `Net: ${money(input.netCents)}`,
  ];
  if (input.topMerchants.length > 0) {
    parts.push('', 'Top merchants', ...nameAndMoney(input.topMerchants));
  }
  parts.push('');
  if (input.budgetedLimitCents > 0) {
    const remainingCents = input.budgetedLimitCents - input.budgetedSpentCents;
    parts.push(
      remainingCents >= 0
        ? `Budgets: ${money(input.budgetedSpentCents)} of ${money(input.budgetedLimitCents)} spent, ${money(remainingCents)} left.`
        : `Budgets: ${money(input.budgetedSpentCents)} of ${money(input.budgetedLimitCents)} spent, ${money(-remainingCents)} over.`,
    );
  } else {
    parts.push('No budgets were set this month.');
  }
  // 2026-09-09: savings_target_met's fact, in the message about the month it is a fact about.
  if (input.savings !== null) {
    const { netCents, targetCents, met } = input.savings;
    parts.push(
      met
        ? `Savings: ${money(netCents)} against a ${money(targetCents)} target — met.`
        : `Savings: ${money(netCents)} against a ${money(targetCents)} target, ${money(targetCents - netCents)} short.`,
    );
  }
  return parts.join('\n').trimEnd();
}

export function renderEvent(input: RenderInput): { subject: string; body: string } {
  switch (input.event) {
    case 'coming_due': {
      if (input.variant === 'batch') return renderComingDueBatch(input);
      const name = truncateText(input.itemName, NAME_MAX);
      if (input.variant === 'installment') {
        // The noun comes from ITEM_KIND_LABELS, not from a literal (MUST-19.11): a bill
        // installment is a BILL's installment, and one place names that kind.
        const noun = ITEM_KIND_LABELS.bill;
        const amount = money(input.amountCents);
        if (input.overdue) {
          const daysAgo = daysBetweenIso(input.dueDate, input.todayIso);
          return {
            subject: `Overdue: ${name}`,
            body:
              `${noun} "${name}": ${amount} was due ${input.dueDate} and is still unpaid ` +
              `(${daysAgo} day${daysAgo === 1 ? '' : 's'} ago).`,
          };
        }
        return {
          subject: `Coming due: ${name}`,
          body: `${noun} "${name}": ${amount} due ${input.dueDate} (${inDays(input.todayIso, input.dueDate)}).`,
        };
      }
      // MUST-6.14: the verb comes from expiryPhraseForKind() so notifications never become
      // a second place any of the four verbs is written (MUST-19.11 of the warranty spec).
      const phrase = expiryPhraseForKind(input.kind, input.expiryDate);
      const lines = [`${ITEM_KIND_LABELS[input.kind]} "${name}" ${phrase} (${inDays(input.todayIso, input.expiryDate)}).`];
      if (input.vendor) lines.push(`Vendor: ${truncateText(input.vendor, NAME_MAX)}`);
      if (input.priceCents !== null) lines.push(`Price: ${money(input.priceCents)}`);
      return { subject: `Coming due: ${name}`, body: lines.join('\n') };
    }
    case 'budget_threshold': {
      const category = truncateText(input.categoryName, NAME_MAX);
      const label = monthLabel(input.month);
      const remainingCents = input.limitCents - input.spentCents;
      // MUST-6.17: a single import can jump straight past 100%, firing this message
      // alongside budget_exceeded. When that happens remainingCents is negative, and "$X
      // left" would read as still having room, so the remaining clause is omitted here
      // entirely; budget_exceeded is the message that talks about being over.
      const remainingClause = remainingCents >= 0 ? `, ${money(remainingCents)} left` : '';
      return {
        subject: `Budget ${percent(input.pct)}%: ${category} (${label})`,
        body:
          `${scopeWord(input.scope)} ${category} budget for ${label} is at ${percent(input.pct)}% — ` +
          `${money(input.spentCents)} of ${money(input.limitCents)}${remainingClause}.`,
      };
    }
    case 'budget_exceeded': {
      const category = truncateText(input.categoryName, NAME_MAX);
      const label = monthLabel(input.month);
      return {
        subject: `Over budget: ${category} (${label})`,
        body:
          `${scopeWord(input.scope)} ${category} budget for ${label} is over — ` +
          `${money(input.spentCents)} of ${money(input.limitCents)}, ${money(input.spentCents - input.limitCents)} over.`,
      };
    }
    case 'backup_failed':
      return {
        subject: 'Nightly backup failed',
        body: [
          `The nightly backup on ${input.dateIso} did not complete.`,
          input.error,
          'The maintenance sweep still ran. Check Settings → Backups.',
        ].join('\n\n'),
      };
    case 'weekly_digest':
      // The subjects differ on purpose: a member is in the family group chat AND has their own
      // channel, and "Household weekly summary" is how they tell at a glance which one they are
      // looking at. The personal subject is unchanged from v1.3.0.
      return input.variant === 'household'
        ? {
            subject: `Household weekly summary — ${input.fromIso} to ${input.toIso}`,
            body: renderHouseholdDigest(input),
          }
        : { subject: `Weekly summary — ${input.fromIso} to ${input.toIso}`, body: renderDigest(input) };
    case 'new_signin': {
      const lines = [
        `${truncateText(input.name, NAME_MAX)} signed in at ${input.atLabel} (${input.tz}) from ${input.ip}.`,
      ];
      if (input.userAgent) lines.push(truncateText(input.userAgent, USER_AGENT_MAX));
      lines.push('If this was not you, change your password in Settings.');
      return { subject: 'New sign-in to your account', body: lines.join('\n\n') };
    }
    case 'password_changed':
      return {
        subject: 'Your password was changed',
        body: [
          `${truncateText(input.name, NAME_MAX)}'s password was changed at ${input.atLabel} (${input.tz}).`,
          'Every other signed-in session was signed out.',
          'If this was not you, sign in and change it again straight away.',
        ].join('\n\n'),
      };
    case 'mfa_disabled':
      return {
        subject: 'Two-factor authentication was switched off',
        body: [
          `Two-factor authentication was turned off on ${truncateText(input.name, NAME_MAX)}'s account at ${input.atLabel} (${input.tz}).`,
          'Every other signed-in session was signed out.',
          'If this was not you, sign in, change your password and turn it back on.',
        ].join('\n\n'),
      };
    case 'restore_outcome': {
      const lines = [
        `Source: ${truncateText(input.sourceName, NAME_MAX)}`,
        `Requested by: ${truncateText(input.requestedByUsername, NAME_MAX)}`,
        `Finished: ${input.finishedAt}`,
        `Receipts restored: ${input.receiptsRestored}; rows with a missing receipt: ${input.missingReceiptRows}`,
      ];
      if (input.error) lines.push(`Error: ${input.error}`);
      return { subject: input.status === 'success' ? 'Restore succeeded' : 'Restore FAILED', body: lines.join('\n') };
    }
    case 'stale_import':
      if (input.variant === 'batch') {
        // 2026-09-09. Ruling R14 said every message must NAME the quiet account, because five
        // household-wide messages read as five identical repeats. That still holds -- and one
        // message that names all five satisfies it better than five that name one each.
        const names = input.accounts.map(
          (account) =>
            `${truncateText(account.name, NAME_MAX)}: last import ${account.lastImportIso} (${account.daysAgo} days ago)`,
        );
        return {
          subject:
            input.accounts.length === 1
              ? `${truncateText(input.accounts[0].name, NAME_MAX)} has not been imported in ${input.weeks} weeks`
              : `${input.accounts.length} accounts have not been imported in ${input.weeks} weeks`,
          body: [...names, '', 'Bank exports are how this app learns what you spent.'].join('\n'),
        };
      }
      // v1.13.0 ruling R14 (item AM / PROD-10): the account is named in its own line so five
      // separate messages for five separate accounts never read as identical repeats of each
      // other. The exact "last import was..." sentence is unchanged from before this ruling.
      return {
        subject: `No transactions imported in ${input.weeks} weeks`,
        body: [
          `${truncateText(input.accountName, NAME_MAX)} has not been imported in ${input.weeks} weeks.`,
          `The last import was ${input.lastImportIso} (${input.daysAgo} days ago).`,
          'Bank exports are how this app learns what you spent.',
        ].join('\n'),
      };
    case 'update_available': {
      const major = input.severity === 'major';
      const subject = major
        ? `Budget Tracker ${input.latestVersion} is available (major update)`
        : `Budget Tracker ${input.latestVersion} is available`;
      if (major) {
        // Fix wave item 2: the app's own "Review and update" screen only exists on an
        // install with an apply path (Watchtower configured). An install without one — see
        // §7.4's fallback, updates-client.tsx's !canApplyInApp branch — has no such button to
        // press, so it gets the honest manual-update wording instead of an instruction it
        // cannot follow.
        // Pre-tag follow-up: Settings → About only shows the LOCAL bundled changelog, which
        // is unreachable-as-"the release notes" on a no-apply-path install that hasn't
        // updated yet -- reworded to point at the actual source instead (no URL, per
        // MUST-10.4), following the patch/minor tail's honest-template phrasing below.
        const tail = input.canApplyInApp
          ? 'Open Settings, read what changed, and press Review and update when you are ready.'
          : "This install has no in-app update trigger; see Settings for how to update by hand. " +
            "The release notes are on the project's GitHub releases page.";
        return {
          subject,
          body:
            `You are running ${input.currentVersion}. Version ${input.latestVersion} is a major update, so this ` +
            `app will not install it on its own. ${tail}` +
            publishedLine(input.publishedAt),
        };
      }
      // MUST-6.5: no body carries a URL (notify MUST-10.4), and publishedAt renders with the
      // app's one timestamp convention and nothing else. Version strings are re-serialised
      // from parsed integers upstream (MUST-4.2), so nothing from the remote payload reaches
      // a message body unparsed.
      // Pre-tag follow-up: "cannot update itself" is false for a pre-1.3.1-compose install --
      // an old Watchtower can still auto-pull it even though this app has no apply path to
      // trigger one. Reworded to the neutral, truthful claim: no in-app trigger, not "no
      // updating happens".
      const tail = input.canApplyInApp
        ? 'Automatic updates are switched off, so open Settings and press Update now when you want it.'
        : 'This install has no in-app update trigger; see Settings for how it updates.';
      return {
        subject,
        body: `You are running ${input.currentVersion}. Version ${input.latestVersion} is published. ${tail}${publishedLine(input.publishedAt)}`,
      };
    }
    case 'budget_pace': {
      const category = truncateText(input.categoryName, NAME_MAX);
      const label = monthLabel(input.month);
      return {
        subject: `On pace to go over: ${category} (${label})`,
        body:
          `${scopeWord(input.scope)} ${category} budget for ${label} is ${money(input.limitCents)}. ` +
          `You have spent ${money(input.spentCents)} in ${input.dayOfMonth} days. ` +
          `At that rate the month ends near ${money(input.projectedCents)}, ` +
          `about ${money(input.projectedCents - input.limitCents)} over.`,
      };
    }
    case 'unusual_transaction': {
      const merchant = truncateText(input.merchant, NAME_MAX);
      const account = truncateText(input.accountName, NAME_MAX);
      const spend = Math.abs(input.amountCents);
      // A multiple is not an amount, so it is not money()'s business (MUST-9.39). It is still
      // integer arithmetic: tenths through divRound, then split, rather than a float divide
      // and toFixed. MUST-3.5's rule is scoped to src/lib/predict/, but there is no reason to
      // introduce the one float in the codebase that does not need to exist.
      const tenths = divRound(spend * 10, input.baselineCents);
      const multiple = `${Math.trunc(tenths / 10)}.${tenths % 10}`;
      const usual =
        input.baselineKind === 'merchant'
          ? `the ${money(input.baselineCents)} you usually spend at ${merchant}`
          : `the ${money(input.baselineCents)} that ${truncateText(input.categoryName ?? 'those', NAME_MAX)} charges usually run`;
      return {
        subject: `Unusual charge: ${merchant} ${money(spend)}`,
        body:
          `${merchant} charged ${money(spend)} on ${input.dateIso} (${account}). ` +
          `This is about ${multiple} times ${usual}.`,
      };
    }
    case 'subscription_creep': {
      const merchant = truncateText(input.merchant, NAME_MAX);
      const rise = input.newAmountCents - input.baselineCents;
      const pct = divRound(rise * 100, input.baselineCents);
      return {
        subject: `Price went up: ${merchant}`,
        body:
          `${merchant} charged ${money(input.newAmountCents)} on ${input.dateIso}. ` +
          `The last ${input.priorCount} charges were ${money(input.baselineCents)}. ` +
          `That is ${money(rise)} more, about ${pct} percent.`,
      };
    }
    case 'duplicate_charge': {
      const merchant = truncateText(input.merchant, NAME_MAX);
      const amount = money(Math.abs(input.amountCents));
      return {
        subject: `Possible duplicate: ${merchant} ${amount}`,
        body:
          `${merchant} charged ${amount} on ${input.earlierDateIso} and again on ${input.laterDateIso}. ` +
          'It may be a real second charge, or the bank may have reported one charge twice.',
      };
    }
    case 'predicted_vs_actual': {
      const label = monthLabel(input.month);
      const blocks: string[] = [];
      if (input.household.length > 0) blocks.push(['Household', ...predictedLines(input.household)].join('\n'));
      if (input.personal.length > 0) blocks.push(['Yours', ...predictedLines(input.personal)].join('\n'));
      // null means "this recipient gets no household figures at all" -- no sentence, rather than
      // a sentence asserting zero. See totalDeltaCents's own docblock above.
      const totalDeltaCents = input.totalDeltaCents;
      if (totalDeltaCents !== null) {
        blocks.push(
          `Across every household category with a suggestion, ${label} came in ${money(Math.abs(totalDeltaCents))} ` +
            `${totalDeltaCents >= 0 ? 'over' : 'under'} what the last six months pointed at.`,
        );
      }
      // MUST-9.27: nothing was stored in advance, and the message says so rather than letting
      // the reader take "predicted" for a recorded forecast.
      blocks.push('The expected figures are recomputed from the six months before that one. Nothing was recorded in advance.');
      return { subject: `${label}: what we expected against what happened`, body: blocks.join('\n\n') };
    }
    case 'suggested_budget_refresh': {
      const label = monthLabel(input.month);
      // Task 9 review carry: input.month is read here (the month the suggestions are FOR,
      // T), rather than left declared and unused. The subject stays month-free (pinned by an
      // existing exact-match test), so the month appears as the body's opening line instead.
      const blocks: string[] = [`Suggested budgets for ${label}.`];
      if (input.household.length > 0) blocks.push(['Household', ...refreshLines(input.household)].join('\n'));
      if (input.personal.length > 0) blocks.push(['Yours', ...refreshLines(input.personal)].join('\n'));
      // MUST-9.33: the message never applies anything.
      blocks.push('Open Budgets to apply any of these. Nothing has been changed.');
      return {
        subject: `New month: ${input.changedCount} suggested budget${input.changedCount === 1 ? '' : 's'} changed`,
        body: blocks.join('\n\n'),
      };
    }
    case 'sync_failed':
      // SECURITY: the subject is a fixed string that never varies with input.error, and the
      // body carries input.error verbatim with no other dynamic field mixed in. Whatever
      // reaches input.error is entirely raiseSyncFailed's responsibility to keep clean (it
      // passes error.message and nothing else) -- this renderer adds no additional risk of
      // its own by never echoing anything else.
      return {
        subject: 'SimpleFIN sync failed',
        body: [
          `The automatic SimpleFIN sync on ${input.dateIso} did not complete.`,
          input.error,
          'Check Settings → Connections.',
        ].join('\n\n'),
      };
    case 'monthly_digest':
      return { subject: `Monthly summary for ${monthLabel(input.month)}`, body: renderMonthlyDigest(input) };
    case 'savings_target_met': {
      const label = monthLabel(input.month);
      return {
        subject: `Savings target met: ${label}`,
        body: `${label}: you saved ${money(input.netCents)}, past the ${money(input.targetCents)} target.`,
      };
    }
    case 'savings_target_pace': {
      const label = monthLabel(input.month);
      return {
        subject: `On pace to miss savings: ${label}`,
        body:
          `${label}'s savings target is ${money(input.targetCents)}. ` +
          `${input.dayOfMonth} days in, you have saved ${money(input.netCents)}, short of the ` +
          `${money(input.proRatedTargetCents)} that pace needs by now.`,
      };
    }
    case 'savings_month_closed': {
      const label = monthLabel(input.month);
      if (!input.met) {
        return {
          subject: `Savings target missed: ${label}`,
          body: `${label}: you saved ${money(input.netCents)}, short of the ${money(input.targetCents)} target.`,
        };
      }
      // Ruling from the Lane 2 plan: "one month alone is noise", so the streak clause only
      // appears once there is an actual streak (2 or more) to report.
      const streakClause = input.streak >= 2 ? ` This is the ${ordinal(input.streak)} month running.` : '';
      return {
        subject: `Savings target met: ${label}`,
        body: `${label}: you saved ${money(input.netCents)}, past the ${money(input.targetCents)} target.${streakClause}`,
      };
    }
    case 'pack_update_available':
      // MUST-10.4 (no URL in a body): points at the settings page by NAME, the same way
      // update_available's own no-apply-path tail says "see Settings" rather than linking one.
      return {
        subject: `${input.packLabel}: version ${input.bundledVersion} is available`,
        body:
          `You installed v${input.installedVersion}; this build ships v${input.bundledVersion}. ` +
          'Open Settings → Merchant rules to review what changed and apply it -- nothing is applied automatically.',
      };
  }
}
