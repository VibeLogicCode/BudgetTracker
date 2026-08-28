/**
 * Client-safe warranty constants and wording helpers (Ruling P4): this module is imported
 * by client components, so it must stay PURE -- no @/db import, no native db driver, no I/O.
 *
 * Subscription wording (spec section 19.6). An item is a subscription when its TYPE has
 * is_subscription = 1. That flag changes only the words on screen; status derivation stays
 * in src/lib/warranty/expiry.ts and knows nothing about subscriptions (MUST-19.12).
 *
 * v1.2.2 amendment: the tracker generalizes to "Contracts & Coverage" -- warranty,
 * subscription, contract and loan `kind`s (spec section 19, amended). The boolean
 * `isSubscription` helpers below are KEPT as thin wrappers over the `kind`-keyed ones
 * (isSub ? 'subscription' : 'warranty') so every existing call site keeps compiling AND
 * keeps showing the exact same words -- warranty/subscription wording is identical between
 * the old boolean matrix and the new kind matrix. Wiring contract/loan wording into pages
 * is Task 2; this module only builds the foundation.
 */

/** v1.2.2: the kinds an item type can be. Loans are dates + documents only -- no
 * balance math (spec section 17, decision recorded there). v1.12.0 adds a fifth, `bill`: an
 * item whose reminder data is an explicit SCHEDULE of due dates (bill_installments) rather
 * than a cadence, because a property tax bill falls due on irregular dates a municipality
 * picks and no interval expresses that. */
export const ITEM_KINDS = ['warranty', 'subscription', 'contract', 'loan', 'bill'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export function isItemKind(value: string): value is ItemKind {
  return (ITEM_KINDS as readonly string[]).includes(value);
}

/** Human labels for the admin page's kind <select> (five options, one per kind). */
export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  warranty: 'Warranty',
  subscription: 'Subscription',
  contract: 'Contract',
  loan: 'Loan',
  bill: 'Bill',
};

/**
 * The user-approved wording matrix (v1.2.2): what the add/edit form's date labels say, what
 * verb the expiry phrase uses, and what the "no end date" state is called, per kind.
 *
 *   warranty:     Purchase date / Warranty (months) / expires    / Expiry date  / Covered through    / Lifetime warranty
 *   subscription: Start date    / Duration (months)  / cancel by / Cancel-by date / Active through    / Ongoing (no end date)
 *   contract:     Start date    / Term (months)      / ends on   / End date     / In effect through  / Open-ended
 *   loan:         Start date    / Term (months)      / paid off by / Payoff date / Term runs through / Ongoing (no end date)
 *   bill:         Start date    / Term (months)      / ends on   / End date     / In effect through  / Ongoing (no end date)
 *
 * v1.2.2 Task 2 (controller ruling): this matrix SUPERSEDES the four old boolean label
 * helpers (`purchaseDateLabel`, `termLabel`, `expiryDateLabel`, `coveredThroughLabel`), which
 * are DELETED, not kept as wrappers -- keeping them alongside this matrix would leave
 * MUST-19.11's "one place" rule broken twice over. The wording changes below are deliberate
 * and owner-approved (spec §19.12): 'Warranty length' -> 'Warranty (months)', 'Period start'
 * -> 'Start date', 'Period length' -> 'Duration (months)', 'Cancel by' (label) -> 'Cancel-by
 * date' / 'Active through' depending on which of the two old helpers it replaces.
 */
const KIND_WORDING: Record<
  ItemKind,
  {
    start: string;
    term: string;
    expiryVerb: string;
    expiringVerb: string;
    end: string;
    coveredThrough: string;
    openEnded: string;
  }
> = {
  warranty: {
    start: 'Purchase date',
    term: 'Warranty (months)',
    expiryVerb: 'expires',
    expiringVerb: 'Expires',
    end: 'Expiry date',
    coveredThrough: 'Covered through',
    openEnded: 'Lifetime warranty',
  },
  subscription: {
    start: 'Start date',
    term: 'Duration (months)',
    expiryVerb: 'cancel by',
    expiringVerb: 'Cancel',
    end: 'Cancel-by date',
    coveredThrough: 'Active through',
    openEnded: 'Ongoing (no end date)',
  },
  contract: {
    start: 'Start date',
    term: 'Term (months)',
    expiryVerb: 'ends on',
    expiringVerb: 'Ends',
    end: 'End date',
    coveredThrough: 'In effect through',
    openEnded: 'Open-ended',
  },
  loan: {
    start: 'Start date',
    term: 'Term (months)',
    expiryVerb: 'paid off by',
    expiringVerb: 'Paid off',
    end: 'Payoff date',
    coveredThrough: 'Term runs through',
    openEnded: 'Ongoing (no end date)',
  },
  // Ruling B5: `contract`'s row, because a bill's own dates describe the ITEM's life ("we have
  // owned this property since...") and never the schedule -- purchase_date is NOT NULL and
  // stays so. Duplicating one row of a wording matrix is not a MUST-19.11 violation: that rule
  // forbids a second PLACE, not a fifth row. The one departure from `contract` is `openEnded`:
  // "Open-ended" reads as a contract with no fixed term, and a bill that is simply ongoing is
  // better named the way a subscription and a loan already name it.
  bill: {
    start: 'Start date',
    term: 'Term (months)',
    expiryVerb: 'ends on',
    expiringVerb: 'Ends',
    end: 'End date',
    coveredThrough: 'In effect through',
    openEnded: 'Ongoing (no end date)',
  },
};

/** Add/edit form date-field label, keyed by kind. */
export function formStartLabel(kind: ItemKind): string {
  return KIND_WORDING[kind].start;
}

/** Add/edit form term-length label, keyed by kind. */
export function formTermLabel(kind: ItemKind): string {
  return KIND_WORDING[kind].term;
}

/**
 * Detail-page end-date field label, keyed by kind. Supersedes `expiryDateLabel`
 * (v1.2.2 Task 2 controller ruling -- see the KIND_WORDING docblock above).
 */
export function formEndLabel(kind: ItemKind): string {
  return KIND_WORDING[kind].end;
}

/** "No end date" wording -- the lifetime checkbox's label / the open-ended state, keyed by kind. */
export function formOpenEndedLabel(kind: ItemKind): string {
  return KIND_WORDING[kind].openEnded;
}

/**
 * The add form's submit button, keyed by kind. It read "Save warranty" whatever the type was,
 * so choosing Loan and being asked to "Save warranty" contradicted the select directly above
 * it. Derived from ITEM_KIND_LABELS rather than a fifth column in the matrix, because the
 * button is the kind's own noun and nothing more -- a separate string here could drift from
 * the label the admin page shows for the same kind.
 */
export function formSaveLabel(kind: ItemKind): string {
  return `Save ${ITEM_KIND_LABELS[kind].toLowerCase()}`;
}

/**
 * MUST-10.4's live computed date beside the term input, keyed by kind. Supersedes
 * `coveredThroughLabel` (v1.2.2 Task 2 controller ruling -- see the KIND_WORDING docblock
 * above).
 */
export function coveredThroughLabelForKind(kind: ItemKind): string {
  return KIND_WORDING[kind].coveredThrough;
}

/** MUST-19.11, generalized: the one place any of the four verbs is written. */
export function expiryNounForKind(kind: ItemKind): string {
  return KIND_WORDING[kind].expiryVerb;
}

/** List rows and the dashboard widget: "expires 2027-03-01" / "cancel by 2027-03-01" / etc. */
export function expiryPhraseForKind(kind: ItemKind, expiryDate: string): string {
  return `${expiryNounForKind(kind)} ${expiryDate}`;
}

/**
 * The /warranties list row for a Bill (item Q, v1.13.1). MUST-19.11: the one place this wording
 * is written -- warranties-client.tsx composes nothing of its own.
 *
 * Dates and counts only, never an amount (ruling P4). The cell this feeds is a fixed-width
 * column beside eight others, and a bill's money already has a home on its own detail page; a
 * due date and an overdue count are what stop the row reading "Ongoing" while the bill is three
 * weeks late.
 *
 * nextDueDate null means every installment on this bill is paid, which is genuinely open-ended
 * from the list's point of view -- so it falls back to the same word every other open-ended kind
 * uses rather than inventing a second one.
 */
export function billScheduleLabel(nextDueDate: string | null, overdueCount: number): string {
  if (nextDueDate === null) return openEndedDisplayLabel('bill');
  if (overdueCount > 0) return `${overdueCount} overdue · next ${nextDueDate}`;
  return `Next due ${nextDueDate}`;
}

/**
 * MUST-19.11: the one place either verb is written. No component hard-codes them.
 * Return type widened to `string` (not a two-value literal union) -- now that
 * `expiryNounForKind` has four possible outputs, a literal-union return type here would
 * require an unchecked cast to compile, which is exactly the kind of silent-mismatch risk
 * the type system should catch, not paper over (v1.2.2 Task 2 review fix).
 */
export function expiryNoun(isSubscription: boolean): string {
  return expiryNounForKind(isSubscription ? 'subscription' : 'warranty');
}

/** List rows and the dashboard widget: "expires 2027-03-01" / "cancel by 2027-03-01". */
export function expiryPhrase(isSubscription: boolean, expiryDate: string): string {
  return expiryPhraseForKind(isSubscription ? 'subscription' : 'warranty', expiryDate);
}

/**
 * T9 delta, generalized in v1.2.2: the day-count form of the 'expiring' badge -- "Expires in
 * 12 days" / "Cancel in 12 days" / "Ends in 12 days" / "Paid off in 12 days" -- shown by
 * StatusBadge across every kind. `days` is expected to already be computed by the caller
 * (daysBetweenIso(today, expiryDate)), matching src/lib/warranty/expiry.ts's statusLabel()
 * exactly except for the swapped verb (MUST-19.11: this is the one other place any of the
 * four verbs is written, and it is still here in constants.ts, not hard-coded into a
 * component). Wiring contract/loan into the badge itself is Task 2's job; this helper is
 * ready for it now.
 */
export function expiringSoonLabelForKind(kind: ItemKind, days: number): string {
  const verb = KIND_WORDING[kind].expiringVerb;
  if (days <= 0) return `${verb} today`;
  return `${verb} in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * T9 delta: the day-count form of the 'expiring' badge -- "Expires in 12 days" /
 * "Cancel in 12 days" -- shown by StatusBadge on both the list and the detail page.
 */
export function expiringSoonLabel(isSubscription: boolean, days: number): string {
  return expiringSoonLabelForKind(isSubscription ? 'subscription' : 'warranty', days);
}

/**
 * Ruling P4: the list page's sort control is rendered by a client component, so the sort
 * names themselves must not transitively import @/db or the native db driver -- src/lib/
 * warranty/search.ts (which does) re-exports these for server-side use instead of
 * redeclaring them.
 */
export type WarrantySort = 'expiry' | 'name' | 'purchase';
export const WARRANTY_SORTS: readonly WarrantySort[] = ['expiry', 'name', 'purchase'];

export function isWarrantySort(value: string): value is WarrantySort {
  return (WARRANTY_SORTS as readonly string[]).includes(value);
}

/**
 * v1.3.0 user request: billing cycle + amount for subscriptions and contracts only. Kept
 * here (not items.ts) for the same client-safety reason as everything else in this file --
 * the add/edit forms are client components and need the enum, the labels and the display
 * suffix without dragging in @/db.
 */
export const BILLING_CYCLES = ['monthly', 'annual'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export function isBillingCycle(value: string): value is BillingCycle {
  return (BILLING_CYCLES as readonly string[]).includes(value);
}

/** The add/edit form's Billing <select> options. */
export const BILLING_CYCLE_LABELS: Record<BillingCycle, string> = {
  monthly: 'Monthly',
  annual: 'Annual',
};

/**
 * v1.14.0 (spec BU, ruling P4). Which way a loan points. 'owed' is a debt the household owes --
 * every loan before this release, and every non-loan item forever. 'lent' is money someone owes
 * the household. Kept here (not loans.ts) for the same client-safety reason as everything else in
 * this file -- the item forms are client components and need the enum, the labels and the one
 * helper that owns the sign flip without dragging in @/db (tests/ops/client-bundle.test.ts).
 */
export const LOAN_DIRECTIONS = ['owed', 'lent'] as const;
export type LoanDirection = (typeof LOAN_DIRECTIONS)[number];

export function isLoanDirection(value: string): value is LoanDirection {
  return (LOAN_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * The transaction's amount re-expressed in the loan's own frame. NEGATIVE always means "this
 * balance goes DOWN", whichever way the loan points. This is NOT the delta finally applied --
 * link() still clamps a repayment at the outstanding balance -- it is the SIGN and the
 * MAGNITUDE the clamp then works from.
 *
 *   owed, -100  ->  -100   money out pays the debt down      (today's behaviour, unchanged)
 *   owed, +100  ->  +100   money in is a disbursement        (today's behaviour, unchanged)
 *   lent, -100  ->  +100   money out lends more; they owe us more
 *   lent, +100  ->  -100   money in is a repayment
 */
export function loanSignedDelta(direction: LoanDirection, amountCents: number): number {
  // `|| 0` only ever fires on amountCents === 0: JS negation of 0 is -0, and Object.is(-0, 0)
  // is false, which would make a zero-amount transaction compare unequal to plain 0 downstream.
  return direction === 'lent' ? -amountCents || 0 : amountCents;
}

/** Sugar for loanSignedDelta(direction, amountCents) < 0. */
export function isLoanRepayment(direction: LoanDirection, amountCents: number): boolean {
  return loanSignedDelta(direction, amountCents) < 0;
}

/** Plain-language, in the voice of the household. Used by both item forms and the detail row. */
export const LOAN_DIRECTION_LABELS: Record<LoanDirection, string> = {
  owed: 'We owe this',
  lent: 'Owed to us',
};

/**
 * v1.3.1: widened to include 'loan'. A loan's billing pair is its regular PAYMENT
 * (see BILLING_WORDING) -- the amount and the cadence, not an interest calculation.
 *
 * v1.12.0 (ruling B4): an ALLOWLIST, not a negation. This read `kind !== 'warranty'`, and a
 * negative gate is a gate that admits every kind nobody has thought of yet: adding 'bill' under
 * it would silently have handed a bill the cadence fields ruling C4 forbids, with no compiler
 * error and no test failure. A bill's schedule REPLACES the cadence; it never sits beside it.
 *
 * This is still the ENTIRE server-side rule. assertBillingMatchesKind() in items.ts calls this
 * predicate, setItemTypeKind()'s clearing pass calls it, and both forms gate their fieldset on
 * it -- so one edit moves every one of them together. The rule lives here, in the app layer,
 * rather than in SQL, because a CHECK on warranty_items cannot see across to
 * warranty_item_types.kind; drizzle/0005_billing_cycle.sql's own header says so, which is why
 * widening it needs no DDL and no table rebuild (MUST-11.6).
 */
export function billingAllowedForKind(kind: ItemKind): boolean {
  return kind === 'subscription' || kind === 'contract' || kind === 'loan';
}

/** v1.3.1: the four money columns are loan-only, by the same app-layer argument. */
export function loanFieldsAllowedForKind(kind: ItemKind): boolean {
  return kind === 'loan';
}

/**
 * Model, serial number and price describe a PHYSICAL PURCHASE, so they belong to `warranty`
 * and to nothing else. A loan has no model and no serial, and its money lives in the loan
 * columns; a subscription's and a contract's money live in the billing pair. Showing a bare
 * "Price" beside "Original amount" on a loan is what prompted this: the form asked for the
 * same fact twice under two names, and neither answer was the one the record keeps.
 *
 * Same app-layer argument as the two gates above: a CHECK on `warranty_items` cannot see
 * across to `warranty_item_types.kind`, so applicability is enforced here and in items.ts.
 *
 * NOTE for the edit form: this decides what a form OFFERS, never what it may hide. An item
 * whose type changed after it was saved can still hold a model or a price, and a field with a
 * value in it must stay on screen -- hiding a stored value is how data gets silently dropped
 * on the next save.
 */
export function productFieldsAllowedForKind(kind: ItemKind): boolean {
  return kind === 'warranty';
}

/**
 * v1.12.0: a due-date SCHEDULE instead of a cadence, and bills only. Property tax is two to six
 * installments a year on fixed, irregular dates a municipality sets; no cadence expresses that,
 * and a reminder that fires on the wrong day is worse than no reminder.
 *
 * Same "a gate decides what a form OFFERS, never what it may HIDE" note productFieldsAllowedForKind
 * carries: the detail page renders the Installments section whenever the item HAS installments,
 * whatever the kind (ruling B7). This predicate gates ADD and MARK PAID, not the section.
 */
export function installmentsAllowedForKind(kind: ItemKind): boolean {
  return kind === 'bill';
}

/**
 * v1.12.0: which kinds may carry merchant-matching rules at all. A matched transaction takes a
 * payment off a loan's balance, or marks a bill's earliest unpaid installment paid; for the
 * other three kinds there is nothing for a match to do.
 */
export function matchingAllowedForKind(kind: ItemKind): boolean {
  return kind === 'loan' || kind === 'bill';
}

/**
 * Refused when an update tries to move an item to a different type (v1.10.2). Lives here with
 * the rest of the kind wording, not in the action: MUST-19.11 keeps user-facing kind wording in
 * one place, and actions.ts has a test asserting its exports are all actions -- a string
 * constant exported from there breaks that guard for no reason.
 */
export const ITEM_TYPE_IMMUTABLE_ERROR =
  'The type cannot be changed after an item is saved. Delete this item and add it again to change its type.';

/**
 * MUST-12.3: the second wording matrix, beside KIND_WORDING. The `warranty` row exists only
 * so the record is total; it is unreachable through the UI, because
 * billingAllowedForKind('warranty') is false.
 *
 * MUST-12.4: BILLING_CYCLE_LABELS (Monthly / Annual) is unchanged and shared -- the cadence
 * has the same name for a subscription and for a loan; only the noun around it differs.
 */
const BILLING_WORDING: Record<ItemKind, { section: string; amount: string; monthly: string; annual: string }> = {
  warranty: { section: 'Billing', amount: 'Amount', monthly: '/ month', annual: '/ year' },
  subscription: { section: 'Billing', amount: 'Amount', monthly: '/ month', annual: '/ year' },
  contract: { section: 'Billing', amount: 'Amount', monthly: '/ month', annual: '/ year' },
  loan: { section: 'Payment', amount: 'Payment amount', monthly: 'per month', annual: 'per year' },
  // Present only so the record is total, and unreachable: billingAllowedForKind('bill') is
  // false, exactly as the `warranty` row's own comment above explains.
  bill: { section: 'Billing', amount: 'Amount', monthly: '/ month', annual: '/ year' },
};

export function billingSectionLabelForKind(kind: ItemKind): string {
  return BILLING_WORDING[kind].section;
}

export function billingAmountLabelForKind(kind: ItemKind): string {
  return BILLING_WORDING[kind].amount;
}

/** Appended after the formatted amount: `${formatCents(cents)} ${billingCycleSuffixForKind(kind, cycle)}` -> "$15.99 / month". */
export function billingCycleSuffixForKind(kind: ItemKind, cycle: BillingCycle): string {
  return cycle === 'monthly' ? BILLING_WORDING[kind].monthly : BILLING_WORDING[kind].annual;
}

/**
 * The user-approved per-kind label shown in place of a blank end date when an item is
 * open-ended (the "no end date" / Lifetime checkbox, i.e. isLifetime = true). Deliberately a
 * SEPARATE matrix from KIND_WORDING's `openEnded` above: that one is the checkbox's own
 * label text ("Lifetime warranty", "Ongoing (no end date)", ...); this one is the short
 * word shown wherever the end date itself would otherwise render blank (list rows, the
 * detail page's end-date field) -- the two read very differently on purpose.
 */
const OPEN_ENDED_DISPLAY_LABEL: Record<ItemKind, string> = {
  warranty: 'Lifetime',
  subscription: 'Lifetime',
  contract: 'Ongoing',
  loan: 'Open-ended',
  bill: 'Ongoing',
};

export function openEndedDisplayLabel(kind: ItemKind): string {
  return OPEN_ENDED_DISPLAY_LABEL[kind];
}

/**
 * v1.12.0: the four states an installment can be in. Declared HERE rather than beside the data
 * layer in installments.ts for the Ruling P4 reason that governs this whole module: the detail
 * page is a client component and calls installmentStateLabel(), so both the labels and the type
 * they are keyed by have to live somewhere that never imports @/db. installments.ts imports the
 * type from here; it does not redeclare it.
 *
 * The state is DERIVED at read time, never stored -- see installmentStateFor() -- so there is no
 * column that can disagree with the dates it is computed from.
 */
export type InstallmentState = 'paid' | 'overdue' | 'due_soon' | 'scheduled';
export const INSTALLMENT_STATES: readonly InstallmentState[] = ['paid', 'overdue', 'due_soon', 'scheduled'];

/** MUST-19.11: the one place the section is named. */
export const INSTALLMENT_SECTION_LABEL = 'Installments';

const INSTALLMENT_STATE_LABELS: Record<InstallmentState, string> = {
  paid: 'Paid',
  overdue: 'Overdue',
  due_soon: 'Due soon',
  scheduled: 'Scheduled',
};

export function installmentStateLabel(state: InstallmentState): string {
  return INSTALLMENT_STATE_LABELS[state];
}

/**
 * v1.12.0. Replaces the string literal 'Payment matching only applies to loans.' that was
 * hard-coded in warranties/actions.ts. Lives here with the rest of the kind wording, not in the
 * action: MUST-19.11 keeps user-facing kind wording in one place, and actions.ts has a test
 * asserting its exports are all actions -- a string constant exported from there breaks that
 * guard for no reason. Same argument as ITEM_TYPE_IMMUTABLE_ERROR above.
 */
export const MATCHING_KIND_ERROR = 'Payment matching only applies to loans and bills.';

/** v1.12.0: refused by addInstallment() in the data layer and by addInstallmentAction. */
export const INSTALLMENT_KIND_ERROR = 'A due-date schedule only applies to bills.';

/**
 * v1.14.0 (spec BU, ruling P3). Refused by assertLoanDirectionMatchesKind() in
 * src/lib/warranty/items.ts, beside LOAN_KIND_ERROR's precedent -- 'owed' is the value every
 * non-loan row carries forever, so only writing 'lent' onto one is worth refusing.
 */
export const LOAN_DIRECTION_KIND_ERROR = 'Only a loan can be owed to us.';

/**
 * The sentence above the Payment matching rules table. Both arms keep MUST-14.6's budget
 * promise, because that is the thing a person is most likely to get wrong about this feature:
 * a matched payment is still a real transaction in the budget and in the reports.
 *
 * Only 'loan' and 'bill' are reachable -- matchingAllowedForKind() gates the whole card -- and
 * the other three fall through to the loan sentence rather than inventing a fourth string for a
 * screen nobody can reach.
 */
export function matchingBlurbForKind(kind: ItemKind): string {
  if (kind === 'bill') {
    return (
      "When a transaction's merchant contains this text, the app marks the next unpaid installment on this bill " +
      'as paid and records which transaction paid it. The payment still counts in your budget and in your reports.'
    );
  }
  return (
    "When a transaction's merchant contains this text, the app treats it as a payment on this loan and takes it " +
    'off the balance. The payment still counts in your budget and in your reports.'
  );
}
