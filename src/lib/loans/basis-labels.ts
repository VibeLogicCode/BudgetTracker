import type { InterestBasis } from './interest';

/**
 * How each rate basis is described to a household, in one place.
 *
 * WHY THE LABELS ARE SENTENCES rather than the jargon. "APR, monthly compounding" is precise and
 * tells somebody who is not an accountant nothing. The person filling this in is holding a
 * statement and has to recognise their own loan in one of six lines, so each line says what
 * HAPPENS -- "one twelfth charged each month" -- and names the loan it usually is.
 *
 * WHY NO DEFAULT is offered anywhere (ruling I5). Every rate already in the database was typed
 * while the form promised the app did no interest maths, so a default would silently reinterpret
 * it: a rate quoted per month read as a yearly one understates the interest twelve-fold. Not
 * choosing is a real answer, and it is the one every existing loan keeps.
 */
export const BASIS_LABELS: Record<InterestBasis, string> = {
  none: 'Interest-free — no interest is charged',
  apr_monthly: 'Yearly rate, one twelfth charged each month',
  apr_semiannual: 'Yearly rate compounded twice a year (Canadian mortgages)',
  per_month: 'Monthly rate, charged each month',
  simple_on_principal: 'Yearly rate on the original amount, never compounding',
  apr_daily: 'Yearly rate, worked out daily (lines of credit)',
};

/** The second line under each option: which loans it is, so the choice can be recognised. */
export const BASIS_HINTS: Record<InterestBasis, string> = {
  none: 'A loan between people with no interest agreed. Every payment comes off the balance.',
  apr_monthly: 'Most car loans, bank personal loans and US-style mortgages.',
  apr_semiannual: 'Canadian fixed mortgages. About 1% a month less than dividing the rate by twelve.',
  per_month: 'Used where a rate is quoted per month rather than per year.',
  simple_on_principal: 'The "5% a year on the $10,000" agreement. The charge never changes as you repay.',
  apr_daily: 'A balance that moves during the month, so each day is worked out on that day’s balance.',
};

/**
 * What the screen calls each figure, which differs by which way the loan points (ruling I16).
 *
 * EVERY label the loan page prints comes from here. F5 (review) found the ledger card spelling one
 * of them inline -- `direction === 'lent' ? 'They have paid' : 'Paid in interest'` -- which already
 * disagreed with `INTEREST_WORDING.lent.paid` three lines away in this file. One table, and a
 * direction that cannot be half-applied.
 */
export const INTEREST_WORDING: Record<
  'owed' | 'lent',
  {
    charged: string;
    paid: string;
    free: string;
    /** The hero: what the whole thing comes to today, interest included. */
    owingToday: string;
    /** What has been written down, before this cycle's accrual. */
    balance: string;
    /** This cycle so far, never yet charged. */
    accruing: string;
    /** Principal repaid since the statement. */
    paidOff: string;
  }
> = {
  owed: {
    charged: 'Interest charged',
    paid: 'Paid in interest',
    free: 'Interest-free — every payment is principal',
    owingToday: 'Owing today',
    balance: 'Balance',
    accruing: 'building up this cycle',
    paidOff: 'Paid off the loan',
  },
  lent: {
    charged: 'Interest earned',
    paid: 'Interest they have paid you',
    free: 'Interest-free — every payment reduces what they owe',
    owingToday: 'Owed to you today',
    balance: 'Balance',
    accruing: 'building up this cycle',
    paidOff: 'They have paid off',
  },
};

/**
 * U6. The engine writes one description per row; the direction decides which words a person reads.
 *
 * F7 (review): a lookup on the row's KIND, not a chain of String.replace over the sentence the
 * engine wrote. replace() rewrites the first match only and matches anywhere -- "Payment" inside
 * "Payment reversed" became "They paid reversed" -- and it silently did nothing at all for a
 * description nobody had thought to list.
 */
export const LEDGER_ROW_WORDS: Record<'owed' | 'lent', Record<string, string>> = {
  owed: {
    opening: 'Opening balance',
    advance: 'Advance',
    payment: 'Payment',
    interest: 'Interest posted',
    adjustment: 'Correction',
    accrued: 'Building up this cycle',
  },
  lent: {
    opening: 'Opening balance',
    advance: 'Lent out',
    payment: 'They paid',
    interest: 'Interest earned',
    adjustment: 'Correction',
    accrued: 'Building up this cycle',
  },
};

/** The order the select offers them: the commonest first, the specialist ones after. */
export const BASIS_ORDER: readonly InterestBasis[] = [
  'apr_monthly',
  'apr_semiannual',
  'per_month',
  'simple_on_principal',
  'apr_daily',
  'none',
] as const;
