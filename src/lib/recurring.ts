import { and, asc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accounts, loanMatcherRules, transactions, warrantyItemTypes, warrantyItems } from '@/db/schema';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import { addDaysIso, daysBetweenIso } from '@/lib/dates';
import { listRecurringMarkRules, recurringMarkFor } from '@/lib/categorize/rules';
import {
  chargesAsOf,
  creepVerdict,
  formingRhythm,
  recurringVerdict,
  trailingRhythm,
  type RecurringCadence,
  type SpendRow,
} from '@/lib/predict/anomalies';
import { CREEP_BASELINE_DAYS, RECURRING_LATE_GRACE_DAYS, RECURRING_LOOKBACK_DAYS, RECURRING_MIN_CHARGES } from '@/lib/predict/constants';
import { divRound, medianCents } from '@/lib/predict/stats';
import { SPEND_ROW_WHERE } from '@/lib/spend-where';
import { billingAllowedForKind, ITEM_KINDS, type ItemKind } from '@/lib/warranty/constants';
import { notEnded } from '@/lib/warranty/expiry-sql';

/**
 * F-05 (2026-09-02 review, v1.31.0). The READ MODEL behind the Recurring charges card, the
 * Contracts & Coverage header line and the dashboard tile.
 *
 * THE DETECTOR'S VERDICT IS STORED NOWHERE. There is no recurring_charges table, no migration and no cached verdict:
 * every row below is derived on read from `transactions` (which merchant charged, when, how
 * much) and `warranty_items`/`loan_matcher_rules` (what the household has already recorded).
 * That is not an efficiency note, it is the feature's whole safety argument -- a stored
 * "subscription" row would outlive the evidence for it, would need a lifecycle nobody asked
 * for, and would turn a cadence the app GUESSED into a fact the app ASSERTS. A read model
 * cannot go stale, because there is nothing to go stale.
 *
 * Spec 2026-10-05 §2.2: what IS stored is the household's word about a merchant -- a 'recurring'
 * or 'not_recurring' merchant rule -- and this module only reads it. Known recurring is that
 * word, or a recorded item that covers a detected rhythm; Looks recurring is a detected rhythm
 * and nothing more.
 *
 * Spec 2026-10-06: a third tier, Forming, is listed; every row with a cadence carries next expected,
 * a monthly equivalent and the price-rise finding; a Known row that goes quiet stays and reads late.
 *
 * WHY IT IS NOT IN src/lib/insights.ts, next to householdInsights: that module answers "what
 * just happened that is worth a look" over a 365-day slice inside a 14-day lookback, and every
 * row it returns points at ONE transaction. This one answers "what is charging us on a rhythm"
 * over 1200 days and returns one row per MERCHANT. Folding them together would have meant one
 * function with two windows and two row shapes; they share the pure detectors in
 * src/lib/predict/anomalies.ts instead, which is the part that actually wanted sharing.
 *
 * WHY IT IS NOT IN src/lib/predict/: it needs @/db, and tests/ops/predict-invariants.test.ts
 * fails any file in that tree except history.ts that imports it (the same reason insights.ts
 * cites, micro-ruling M4).
 *
 * WHAT THIS MODULE MAY CLAIM. A cadence, an amount, a date, and whether the household has
 * already recorded something covering the merchant. It may not claim that a merchant is a
 * subscription, because no query below can tell one from a once-a-month grocery shop or a
 * utility bill that varies -- see recurringVerdict's own docblock. Callers render the measured
 * facts and offer Track; the household supplies the judgement.
 */

/** What already covers a merchant, and which record says so, so a wrong match is checkable. */
export interface RecurringCover {
  /**
   * 'rule' is a payment-matching rule that WOULD match this charge (the same substring test
   * applyPaymentMatchers runs, see `covers` below); 'item' is a recorded item whose name or
   * vendor reads as this merchant, which is a heuristic and is presented as one.
   */
  kind: 'rule' | 'item';
  itemId: number;
  itemName: string;
}

/** Spec 2026-10-05 §2.4. An account a merchant charged, by the name the household gave it. */
export interface RecurringAccount {
  id: number;
  name: string;
}

/**
 * Spec 2026-10-06 §2.2. 'known': the household marked it, or a record covers it. 'looks': a rhythm
 * only. 'forming': two charges a band apart, one short of a rhythm.
 */
export type RecurringTier = 'known' | 'looks' | 'forming';
export type RecurringKnownBy = 'mark' | 'tracked';

/** Spec 2026-10-06 §2.4. The creep finding Needs a look makes, carried onto the merchant's row. */
export interface RecurringPriceRise {
  fromCents: number;
  toCents: number;
}

export interface RecurringChargeRow {
  /** `transactions.normalized_merchant`, i.e. uppercase, exactly as the ledger groups it. */
  merchant: string;
  tier: RecurringTier;
  /** Why a Known row is known; null on a Looks or Forming row. A mark wins over a cover: only a mark can be undone. */
  knownBy: RecurringKnownBy | null;
  /** The band the charges sit in (trailingRhythm: the run it charges on now), or null: one charge, or irregular gaps. */
  cadence: RecurringCadence | null;
  chargeCount: number;
  /** Median charge magnitude; null with a single charge, where there is no "usually" to state. */
  typicalCents: number | null;
  lastAmountCents: number;
  lastDate: string;
  /** The newest charge. The Track link prefills from it, and the mark buttons post it. */
  transactionId: number;
  tracked: RecurringCover | null;
  /** Spec 2026-10-05 §2.4. Every account the merchant charged inside the window, newest charge first. */
  accounts: RecurringAccount[];
  /** Spec 2026-10-06 §2.3. lastDate plus the median gap, on any row with a cadence. May be in the past. */
  nextExpected: string | null;
  /** Spec 2026-10-06 §2.3. Known rows only: today is more than RECURRING_LATE_GRACE_DAYS past nextExpected. */
  late: boolean;
  /** Spec 2026-10-06 §2.1. typicalCents for a monthly rhythm, a twelfth of it for a yearly one; null without a cadence. */
  monthlyCents: number | null;
  /** Spec 2026-10-06 §2.4. Set when creepVerdict finds the newest charge went up. */
  priceRise: RecurringPriceRise | null;
}

export interface RecurringCharges {
  /** Sorted by merchant, never capped, and kept when the charges stop: a quiet Known row reads late. */
  known: RecurringChargeRow[];
  /** Biggest typical charge first. Spec 2026-10-06 §2.2: no cap. */
  looks: RecurringChargeRow[];
  /** Spec 2026-10-06 §2.2: listed, by merchant. */
  forming: RecurringChargeRow[];
  /**
   * Spec 2026-10-05 §2.4, owner ruling: the Account select's options -- every distinct account named
   * on a listed row of any tier, read BEFORE the account filter, by name then id.
   */
  accounts: RecurringAccount[];
  /** The account filter actually applied: input.accountId when it is among `accounts`, otherwise null (every account). */
  accountId: number | null;
}

export interface RecurringLoad {
  /** Sum of `billing_amount_cents` on live items billed monthly. */
  monthlyCents: number;
  /** Sum on live items billed annually. Deliberately NOT divided into the monthly figure. */
  annualCents: number;
  /** How many items the two figures were totalled from, so the caller can say "from N items". */
  itemCount: number;
}

/**
 * The kinds of item that can carry a billing cadence at all, derived from
 * `billingAllowedForKind` (src/lib/warranty/constants.ts) rather than written out again here.
 * A warranty on a fridge is not what "this merchant is already tracked" means, and a bill's
 * schedule replaces a cadence -- a bill reaches the tracked check through its payment RULE
 * instead, which is the thing that actually matches its charges.
 */
const RECURRING_ITEM_KINDS: ItemKind[] = ITEM_KINDS.filter(billingAllowedForKind);

/**
 * One indexed range scan over `transactions.date`, four narrow columns, grouped in JS -- the
 * same shape (and the same reasoning) as readSlice in src/lib/insights.ts. A SQL
 * `group by normalized_merchant having count(*) >= 3` pre-filter was considered and rejected:
 * the qualifying merchants would then have to come back into a second query as an IN list, one
 * bind parameter each, which is precisely the SQLITE_MAX_VARIABLE_NUMBER trap spend-where.ts's
 * own docblock describes -- and it grows with the household's merchant count, so it fails first
 * on the largest database.
 *
 * SPEND_ROW_WHERE, never a bare transfer filter: a monthly transfer to a savings account and a
 * monthly loan-principal movement both have textbook cadences and neither is a charge. A
 * standing transfer to a relative listed as "$400/month recurring" would be this card's worst
 * possible first impression.
 */
interface ChargeRow extends SpendRow {
  accountId: number;
}

function readCharges(sliceStart: string, scope: number | null): ChargeRow[] {
  const clauses = [gte(transactions.date, sliceStart), ...SPEND_ROW_WHERE, lt(transactions.amountCents, 0)];
  if (scope !== null) clauses.push(eq(transactions.attributedUserId, scope));
  return getDb()
    .select({
      id: transactions.id,
      date: transactions.date,
      merchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      amountCents: transactions.amountCents,
      // Spec 2026-10-05 §2.4: which account each charge landed on, read in the same scan.
      accountId: transactions.accountId,
    })
    .from(transactions)
    .where(and(...clauses))
    .orderBy(asc(transactions.date), asc(transactions.id))
    .all();
}

/** Account names in one read of a table that holds a handful of rows. Only ever printed beside a charge the viewer can already see. */
function accountNames(): Map<number, string> {
  return new Map(getDb().select({ id: accounts.id, name: accounts.name }).from(accounts).all().map((row) => [row.id, row.name]));
}

/** One entry per account, newest charge first. `charges` is oldest first (chargesAsOf). */
function accountsNewestFirst(charges: ChargeRow[], names: Map<number, string>): RecurringAccount[] {
  const seen = new Set<number>();
  const out: RecurringAccount[] = [];
  for (const charge of [...charges].reverse()) {
    if (seen.has(charge.accountId)) continue;
    seen.add(charge.accountId);
    out.push({ id: charge.accountId, name: names.get(charge.accountId) ?? '' });
  }
  return out;
}

/** Three characters, the same floor saveLoanRule enforces: shorter than that matches everything. */
const MIN_NEEDLE_CHARS = 3;

interface Needle extends RecurringCover {
  needle: string;
  /** A rule matches ONE way (merchant contains the rule text); an item's name may read either way. */
  bidirectional: boolean;
}

/**
 * Does `needle` cover `merchant`? Both are already uppercase (`normalizeMerchant` uppercases,
 * and `saveLoanRule` uppercases what it stores), so there is no lower() wrapper here for the
 * same reason src/lib/loans.ts has none.
 *
 * The two directions are NOT interchangeable, which is why the caller says which it wants:
 *
 *   - A RULE gets `merchant.includes(needle)` alone, because that is literally the test
 *     applyPaymentMatchers will run when the next charge lands. A badge saying "a rule covers
 *     this" for a rule that would not actually fire is a false statement about the app's own
 *     behaviour, not merely an imprecise guess.
 *   - An ITEM gets both directions, because "Netflix Premium" (the item) and "NETFLIX.COM"
 *     (the merchant) are the same commitment written two ways and neither contains the other
 *     whole. That is a heuristic and can be wrong, so the row NAMES the item it matched: a
 *     reader who does not recognise the pairing can see it and correct the record. The failure
 *     mode being guarded against is a badge that silently withholds the Track link.
 */
function covers(needle: Needle, merchant: string): boolean {
  if (needle.needle.length < MIN_NEEDLE_CHARS) return false;
  if (merchant.includes(needle.needle)) return true;
  return needle.bidirectional && merchant.length >= MIN_NEEDLE_CHARS && needle.needle.includes(merchant);
}

/**
 * Every rule and every live item that could cover a merchant, in two queries, both scoped by
 * `warranty_items.owner_user_id`. Rules come first in the returned order and win any tie: a rule
 * is a statement about what the app will DO with the next charge, an item-name match is a
 * resemblance.
 *
 * `notEnded` (src/lib/warranty/expiry-sql.ts) matters more here than anywhere else on the item
 * side, and in the opposite direction to the usual: an ENDED contract whose merchant is still
 * charging is the single most valuable row this card can produce. Counting that item as "tracked"
 * would hide the finding behind a badge, which is why the boundary this predicate draws is worth
 * one shared definition rather than a local `>=` that agrees with the badge until it doesn't.
 */
function needles(today: string, scope: number | null): Needle[] {
  const db = getDb();
  const ownerClause = scope === null ? [] : [eq(warrantyItems.ownerUserId, scope)];

  const rules = db
    .select({ itemId: loanMatcherRules.itemId, itemName: warrantyItems.name, needle: loanMatcherRules.merchantContains })
    .from(loanMatcherRules)
    .innerJoin(warrantyItems, eq(warrantyItems.id, loanMatcherRules.itemId))
    // A disabled rule is excluded because it would not match the next charge either -- the
    // badge and applyPaymentMatchers must agree about what is covered.
    .where(and(eq(loanMatcherRules.enabled, true), notEnded(today), ...ownerClause))
    .orderBy(asc(loanMatcherRules.id))
    .all();

  const items = db
    .select({ itemId: warrantyItems.id, itemName: warrantyItems.name, vendor: warrantyItems.vendor })
    .from(warrantyItems)
    .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(and(inArray(warrantyItemTypes.kind, RECURRING_ITEM_KINDS), notEnded(today), ...ownerClause))
    .orderBy(asc(warrantyItems.id))
    .all();

  const out: Needle[] = rules.map((rule) => ({
    kind: 'rule' as const,
    itemId: rule.itemId,
    itemName: rule.itemName,
    needle: rule.needle.trim().toUpperCase(),
    bidirectional: false,
  }));
  for (const item of items) {
    for (const text of [item.itemName, item.vendor]) {
      if (text === null) continue;
      const needle = text.trim().toUpperCase();
      if (needle.length < MIN_NEEDLE_CHARS) continue;
      out.push({ kind: 'item', itemId: item.itemId, itemName: item.itemName, needle, bidirectional: true });
    }
  }
  return out;
}

/**
 * Ruling R2, resolved in the S-01 order: `ownerScope(viewer)` is read FIRST and a non-null
 * result WINS, so the caller-supplied `ownerUserId` (a dashboard `?person=`) can only ever
 * narrow a viewer who was already entitled to any member's figures. `ownerUserId` is required
 * rather than optional for the same reason transactionsHref's scope fields are: a call site has
 * to write down whose money it is asking about, and "the whole household" has to be typed.
 */
function resolveScope(viewer: Viewer, ownerUserId: number | null): number | null {
  return ownerScope(viewer) ?? ownerUserId;
}

/** Spec 2026-10-06 §2.1. What a merchant comes to a month: a yearly charge is a twelfth of itself. */
function monthlyEquivalent(cadence: RecurringCadence | null, typicalCents: number | null): number | null {
  if (cadence === null || typicalCents === null) return null;
  return cadence === 'monthly' ? typicalCents : divRound(typicalCents, 12);
}

interface Candidate {
  row: RecurringChargeRow;
  charges: ChargeRow[];
  /** The rhythm's median gap, which next expected is measured from; null without a rhythm. */
  gapDays: number | null;
  /** A three-charge rhythm that has gone quiet: listed only if a record makes it Known. */
  quiet: boolean;
}

/**
 * Spec 2026-10-05 §2.3–§2.4 and 2026-10-06 §2.1–§2.4. Three tiers over the same charges.
 *
 * Known: the household marked the merchant 'recurring', or a recorded item or rule covers a rhythm.
 * A Known row never drops off for going quiet (2026-10-06 §2.3): a mark is kept whatever the dates
 * do, and a mark or a covered rhythm reads the run it charges on now (trailingRhythm), with no freshness check; its row reads late instead.
 * Looks: a fresh three-charge rhythm (recurringVerdict) and nothing more; a Looks rhythm that stops
 * is history and drops, as before. Forming: two charges a band apart, the newest recent. A
 * 'not_recurring' merchant is on no list.
 *
 * Every row with a cadence gets next expected (last charge plus the median gap) and a monthly
 * equivalent; Known rows past next expected by more than RECURRING_LATE_GRACE_DAYS are late. The
 * price rise is creepVerdict over the CREEP_BASELINE_DAYS slice, the window Needs a look reads.
 *
 * The account filter keeps a merchant that charged the chosen account at any point in the window.
 * The Account options are read before the filter; an account no row names reads as every account.
 * Known and Forming are sorted by merchant, Looks by typical amount descending; nothing is capped.
 */
export function recurringCharges(input: {
  today: string;
  ownerUserId: number | null;
  viewer: Viewer;
  /** Spec 2026-10-05 §2.4. Keep only merchants that charged this account; null is every account. */
  accountId: number | null;
}): RecurringCharges {
  const scope = resolveScope(input.viewer, input.ownerUserId);
  const slice = readCharges(addDaysIso(input.today, -RECURRING_LOOKBACK_DAYS), scope);

  const byMerchant = new Map<string, ChargeRow[]>();
  for (const row of slice) {
    const bucket = byMerchant.get(row.merchant);
    if (bucket) bucket.push(row);
    else byMerchant.set(row.merchant, [row]);
  }

  const marks = listRecurringMarkRules();
  const names = accountNames();
  const candidates: Candidate[] = [];

  for (const [merchant, all] of byMerchant) {
    const mark = recurringMarkFor(merchant, marks);
    // Spec 2026-10-05 §2.3: a not_recurring merchant is on no list.
    if (mark === 'not_recurring') continue;
    const charges = chargesAsOf(all, input.today);
    if (charges.length === 0) continue;
    // Spec 2026-10-06 §2.3: the rhythm the merchant charges on now (trailingRhythm) -- next expected and late are read from it.
    const rhythm = trailingRhythm({ charges, today: input.today });
    let tier: RecurringTier;
    let quiet = false;
    if (mark === 'recurring') tier = 'known';
    else if (recurringVerdict({ charges, today: input.today }) !== null) tier = 'looks';
    else if (rhythm !== null && rhythm.chargeCount >= RECURRING_MIN_CHARGES) {
      tier = 'looks';
      quiet = true;
    } else if (formingRhythm({ charges, today: input.today }) !== null) tier = 'forming';
    else continue;
    const latest = charges[charges.length - 1];
    const typicalCents = charges.length > 1 ? medianCents(charges.map((charge) => Math.abs(charge.amountCents))) : null;
    const cadence = rhythm?.cadence ?? null;
    candidates.push({
      charges,
      quiet,
      gapDays: rhythm?.medianGapDays ?? null,
      row: {
        merchant,
        tier,
        knownBy: mark === 'recurring' ? 'mark' : null,
        cadence,
        chargeCount: charges.length,
        typicalCents,
        lastAmountCents: Math.abs(latest.amountCents),
        lastDate: latest.date,
        transactionId: latest.id,
        tracked: null,
        accounts: accountsNewestFirst(charges, names),
        nextExpected: null,
        late: false,
        monthlyCents: monthlyEquivalent(cadence, typicalCents),
        priceRise: null,
      },
    });
  }

  // A cover makes a Looks row Known -- and keeps a quiet one Known (spec 2026-10-06 §2.3).
  if (candidates.length > 0) {
    const covering = needles(input.today, scope);
    for (const { row } of candidates) {
      const hit = covering.find((needle) => covers(needle, row.merchant));
      row.tracked = hit === undefined ? null : { kind: hit.kind, itemId: hit.itemId, itemName: hit.itemName };
      if (row.tier === 'looks' && row.tracked !== null) {
        row.tier = 'known';
        row.knownBy = 'tracked';
      }
    }
  }

  // Looks keeps its stale rule: an unmarked, uncovered rhythm that stopped is history.
  const listed = candidates.filter((candidate) => !candidate.quiet || candidate.row.tier === 'known');
  const creepStart = addDaysIso(input.today, -CREEP_BASELINE_DAYS);
  for (const { row, charges, gapDays } of listed) {
    row.nextExpected = gapDays === null ? null : addDaysIso(row.lastDate, gapDays);
    row.late =
      row.tier === 'known' && row.nextExpected !== null && daysBetweenIso(row.nextExpected, input.today) > RECURRING_LATE_GRACE_DAYS;
    // Spec 2026-10-06 §2.4: the same verdict, over the same window, as Needs a look.
    const rise = creepVerdict({ charges: charges.filter((charge) => charge.date >= creepStart), today: input.today });
    row.priceRise = rise === null ? null : { fromCents: rise.baselineCents, toCents: rise.newAmountCents };
  }

  // Spec 2026-10-05 §2.4, owner ruling: the options are every account a listed row names, before the filter.
  const optionById = new Map<number, RecurringAccount>();
  for (const { row } of listed) for (const account of row.accounts) optionById.set(account.id, account);
  const options = [...optionById.values()].sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.id - b.id,
  );
  const accountId = input.accountId !== null && optionById.has(input.accountId) ? input.accountId : null;
  const charged = (charges: ChargeRow[]) => accountId === null || charges.some((charge) => charge.accountId === accountId);

  const kept = listed.filter(({ charges }) => charged(charges)).map(({ row }) => row);
  const byName = (a: RecurringChargeRow, b: RecurringChargeRow) => (a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0);
  const known = kept.filter((row) => row.tier === 'known').sort(byName);
  const looks = kept
    .filter((row) => row.tier === 'looks')
    .sort((a, b) => (b.typicalCents ?? 0) - (a.typicalCents ?? 0) || byName(a, b));
  const forming = kept.filter((row) => row.tier === 'forming').sort(byName);
  return { known, looks, forming, accounts: options, accountId };
}

/**
 * Spec 2026-10-06 §2.6. A marked merchant's next charge, as the Dashboard's Coming up card lists it.
 * NOT a bill: it has no amountCents, so nothing that totals UpcomingBill rows (the card's header,
 * safeToSpend's billsDueCents) can add it by accident. A recurring charge is usually already inside a
 * category budget; counting it again would count it twice.
 */
export interface ExpectedCharge {
  merchant: string;
  /** Last charge plus the median gap. May be in the past: late, or still inside the grace. */
  expectedDate: string;
  /** The median charge; the card prints "about" it. */
  typicalCents: number;
  late: boolean;
  /** The account the newest charge landed on. */
  accountName: string;
}

/**
 * Spec 2026-10-06 §2.6. Known merchants BY MARK only, with a rhythm, whose next charge falls on or
 * before today + `days`: a tracked merchant already shows through its item's own rows, so a marked
 * merchant something covers is left out too. The overdue bound is the card's (COMING_UP_OVERDUE_DAYS),
 * applied there as it is to bills. Scoped like upcomingBills -- the viewer only, no person pill.
 */
export function expectedRecurringCharges(input: { today: string; days: number; viewer: Viewer }): ExpectedCharge[] {
  const windowEnd = addDaysIso(input.today, input.days);
  const out: ExpectedCharge[] = [];
  for (const row of recurringCharges({ today: input.today, ownerUserId: null, viewer: input.viewer, accountId: null }).known) {
    if (row.knownBy !== 'mark' || row.tracked !== null) continue;
    if (row.nextExpected === null || row.typicalCents === null || row.nextExpected > windowEnd) continue;
    out.push({
      merchant: row.merchant,
      expectedDate: row.nextExpected,
      typicalCents: row.typicalCents,
      late: row.late,
      accountName: row.accounts[0]?.name ?? '',
    });
  }
  return out.sort((a, b) =>
    a.expectedDate < b.expectedDate ? -1 : a.expectedDate > b.expectedDate ? 1 : a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0,
  );
}

/**
 * The RECORDED load: what the household has already written down, totalled. This is the one
 * figure on this feature that is not a guess at all -- somebody typed each amount in -- which is
 * exactly why it is kept separate from the card above rather than blended into one headline
 * number. Every caller's wording says "recorded", so the total is never read as a claim about
 * what the household actually pays.
 *
 * The two cycles are returned SEPARATELY and never combined. Folding $1,180/year into
 * "$98/month" would invent a monthly payment nobody makes, and would double-count against the
 * monthly figure in any total a reader formed from the pair.
 *
 * Both halves of the billing pair are required, matching the Billing column's own rule
 * (warranties-client.tsx): an amount with no cycle is not a cadence, and a cycle with no amount
 * is not money.
 */
export function recurringLoad(input: { today: string; ownerUserId: number | null; viewer: Viewer }): RecurringLoad {
  const scope = resolveScope(input.viewer, input.ownerUserId);
  const clauses: SQL[] = [
    notEnded(input.today),
    sql`${warrantyItems.billingCycle} is not null`,
    sql`${warrantyItems.billingAmountCents} is not null`,
  ];
  if (scope !== null) clauses.push(eq(warrantyItems.ownerUserId, scope));

  const row = getDb()
    .select({
      monthlyCents: sql<number>`coalesce(sum(case when ${warrantyItems.billingCycle} = 'monthly' then ${warrantyItems.billingAmountCents} else 0 end), 0)`,
      annualCents: sql<number>`coalesce(sum(case when ${warrantyItems.billingCycle} = 'annual' then ${warrantyItems.billingAmountCents} else 0 end), 0)`,
      itemCount: sql<number>`count(*)`,
    })
    .from(warrantyItems)
    .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(and(inArray(warrantyItemTypes.kind, RECURRING_ITEM_KINDS), ...clauses))
    .get();

  return {
    monthlyCents: row?.monthlyCents ?? 0,
    annualCents: row?.annualCents ?? 0,
    itemCount: row?.itemCount ?? 0,
  };
}
