import { and, asc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { loanMatcherRules, transactions, warrantyItemTypes, warrantyItems } from '@/db/schema';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import { addDaysIso } from '@/lib/dates';
import { recurringVerdict, type RecurringCadence, type SpendRow } from '@/lib/predict/anomalies';
import { RECURRING_LOOKBACK_DAYS } from '@/lib/predict/constants';
import { SPEND_ROW_WHERE } from '@/lib/spend-where';
import { billingAllowedForKind, ITEM_KINDS, type ItemKind } from '@/lib/warranty/constants';

/**
 * F-05 (2026-09-02 review, v1.31.0). The READ MODEL behind the Recurring charges card, the
 * Contracts & Coverage header line and the dashboard tile.
 *
 * NOTHING IS STORED. There is no recurring_charges table, no migration and no cached verdict:
 * every row below is derived on read from `transactions` (which merchant charged, when, how
 * much) and `warranty_items`/`loan_matcher_rules` (what the household has already recorded).
 * That is not an efficiency note, it is the feature's whole safety argument -- a stored
 * "subscription" row would outlive the evidence for it, would need a lifecycle nobody asked
 * for, and would turn a cadence the app GUESSED into a fact the app ASSERTS. A read model
 * cannot go stale, because there is nothing to go stale.
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

/** The card is an audit list, not a second ledger: a dozen rows is a session, forty is a chore. */
export const RECURRING_MAX_ROWS = 12;

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

export interface RecurringChargeRow {
  /** `transactions.normalized_merchant`, i.e. uppercase, exactly as the ledger groups it. */
  merchant: string;
  cadence: RecurringCadence;
  chargeCount: number;
  /** Median charge magnitude -- "what this usually is", which is how a variable bill shows itself. */
  typicalCents: number;
  lastAmountCents: number;
  lastDate: string;
  /** The newest charge. The Track link prefills a new item from it, and nothing else. */
  transactionId: number;
  tracked: RecurringCover | null;
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
 * "Has not ended yet." Expressed the same way warrantyStatus() (src/lib/warranty/expiry.ts)
 * decides `expired`: open-ended and no-end-date items are live, and coverage is inclusive of
 * the expiry date itself.
 *
 * This matters more here than anywhere else on the item side, and in the opposite direction to
 * the usual: an ENDED contract whose merchant is still charging is the single most valuable row
 * this card can produce. Counting that item as "tracked" would hide the finding behind a badge.
 */
function notEnded(today: string): SQL {
  return sql`(${warrantyItems.isLifetime} = 1 or ${warrantyItems.expiryDate} is null or ${warrantyItems.expiryDate} >= ${today})`;
}

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
function readCharges(sliceStart: string, scope: number | null): SpendRow[] {
  const clauses = [gte(transactions.date, sliceStart), ...SPEND_ROW_WHERE, lt(transactions.amountCents, 0)];
  if (scope !== null) clauses.push(eq(transactions.attributedUserId, scope));
  return getDb()
    .select({
      id: transactions.id,
      date: transactions.date,
      merchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(and(...clauses))
    .orderBy(asc(transactions.date), asc(transactions.id))
    .all();
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

/**
 * Merchants whose charges have landed on a monthly or yearly cadence and are still landing.
 *
 * Order: NOT-yet-recorded rows first, then by typical amount descending, then merchant. The
 * first clause is the feature's actual question ("what is charging us that nobody has written
 * down"), and it is an ordering rather than a filter because the tracked rows are worth seeing
 * too -- a recorded item whose real charge has drifted away from its recorded billing amount is
 * the second-most useful row here.
 */
export function recurringCharges(input: { today: string; ownerUserId: number | null; viewer: Viewer }): RecurringChargeRow[] {
  const scope = resolveScope(input.viewer, input.ownerUserId);
  const slice = readCharges(addDaysIso(input.today, -RECURRING_LOOKBACK_DAYS), scope);

  const byMerchant = new Map<string, SpendRow[]>();
  for (const row of slice) {
    const bucket = byMerchant.get(row.merchant);
    if (bucket) bucket.push(row);
    else byMerchant.set(row.merchant, [row]);
  }

  const found: RecurringChargeRow[] = [];
  for (const [merchant, charges] of byMerchant) {
    const verdict = recurringVerdict({ charges, today: input.today });
    if (verdict === null) continue;
    found.push({
      merchant,
      cadence: verdict.cadence,
      chargeCount: verdict.chargeCount,
      typicalCents: verdict.typicalCents,
      lastAmountCents: verdict.latestAmountCents,
      lastDate: verdict.latestDateIso,
      transactionId: verdict.latestId,
      tracked: null,
    });
  }

  // Resolved only for the merchants that actually made the list -- two small queries either
  // way, but nothing is matched against a merchant nobody will read.
  if (found.length > 0) {
    const covering = needles(input.today, scope);
    for (const row of found) {
      const hit = covering.find((needle) => covers(needle, row.merchant));
      row.tracked = hit === undefined ? null : { kind: hit.kind, itemId: hit.itemId, itemName: hit.itemName };
    }
  }

  found.sort((a, b) => {
    if ((a.tracked === null) !== (b.tracked === null)) return a.tracked === null ? -1 : 1;
    if (a.typicalCents !== b.typicalCents) return b.typicalCents - a.typicalCents;
    return a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0;
  });
  return found.slice(0, RECURRING_MAX_ROWS);
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
