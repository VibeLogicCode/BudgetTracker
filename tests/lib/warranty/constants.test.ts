import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BILLING_CYCLES,
  BILLING_CYCLE_LABELS,
  ITEM_KINDS,
  ITEM_KIND_LABELS,
  billingAllowedForKind,
  billingAmountLabelForKind,
  billingCycleSuffixForKind,
  billingSectionLabelForKind,
  coveredThroughLabelForKind,
  expiryNoun,
  expiryNounForKind,
  expiryPhrase,
  expiryPhraseForKind,
  expiringSoonLabel,
  expiringSoonLabelForKind,
  ITEM_TYPE_IMMUTABLE_ERROR,
  formEndLabel,
  formSaveLabel,
  formOpenEndedLabel,
  formStartLabel,
  formTermLabel,
  isBillingCycle,
  isItemKind,
  loanFieldsAllowedForKind,
  productFieldsAllowedForKind,
  openEndedDisplayLabel,
  billScheduleLabel,
  installmentsAllowedForKind,
  matchingAllowedForKind,
  installmentStateLabel,
  INSTALLMENT_SECTION_LABEL,
  INSTALLMENT_KIND_ERROR,
  MATCHING_KIND_ERROR,
  matchingBlurbForKind,
  INSTALLMENT_STATES,
  LOAN_DIRECTIONS,
  LOAN_DIRECTION_LABELS,
  isLoanDirection,
  loanSignedDelta,
  isLoanRepayment,
} from '@/lib/warranty/constants';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('subscription wording (MUST-19.10 / MUST-19.11)', () => {
  it('swaps the expiry noun on the flag and nothing else', () => {
    expect(expiryNoun(false)).toBe('expires');
    expect(expiryNoun(true)).toBe('cancel by');
  });

  it('builds the list/widget phrase', () => {
    expect(expiryPhrase(false, '2027-03-01')).toBe('expires 2027-03-01');
    expect(expiryPhrase(true, '2027-03-01')).toBe('cancel by 2027-03-01');
  });
});

/**
 * v1.2.2 Task 2 controller ruling: `purchaseDateLabel`, `termLabel`, `expiryDateLabel` and
 * `coveredThroughLabel` (the boolean-keyed detail/form label helpers) are DELETED, superseded
 * by the kind-keyed matrix below -- not kept as wrappers, unlike expiryNoun/expiryPhrase/
 * expiringSoonLabel above. The owner approved the resulting wording changes as deliberate.
 * Old -> new, logged here so the change is traceable from the test that used to pin the old
 * text:
 *
 *   purchaseDateLabel(false)      'Purchase date'    -> formStartLabel('warranty')      'Purchase date'    (same)
 *   purchaseDateLabel(true)       'Period start'      -> formStartLabel('subscription')  'Start date'       (CHANGED)
 *   termLabel(false)              'Warranty length'   -> formTermLabel('warranty')       'Warranty (months)'(CHANGED)
 *   termLabel(true)               'Period length'     -> formTermLabel('subscription')   'Duration (months)'(CHANGED)
 *   expiryDateLabel(false)        'Expiry date'       -> formEndLabel('warranty')        'Expiry date'      (same)
 *   expiryDateLabel(true)         'Cancel by'         -> formEndLabel('subscription')    'Cancel-by date'   (CHANGED)
 *   coveredThroughLabel(false)    'Covered through'   -> coveredThroughLabelForKind('warranty')     'Covered through'  (same)
 *   coveredThroughLabel(true)     'Cancel by'         -> coveredThroughLabelForKind('subscription') 'Active through'   (CHANGED)
 */
describe('kind-keyed form/detail labels (v1.2.2 Task 2 — supersede the boolean helpers)', () => {
  it('formStartLabel matches the approved matrix, including the changed subscription wording', () => {
    expect(formStartLabel('warranty')).toBe('Purchase date');
    expect(formStartLabel('subscription')).toBe('Start date');
    expect(formStartLabel('contract')).toBe('Start date');
    expect(formStartLabel('loan')).toBe('Start date');
  });

  it('formTermLabel matches the approved matrix, including the changed warranty/subscription wording', () => {
    expect(formTermLabel('warranty')).toBe('Warranty (months)');
    expect(formTermLabel('subscription')).toBe('Duration (months)');
    expect(formTermLabel('contract')).toBe('Term (months)');
    expect(formTermLabel('loan')).toBe('Term (months)');
  });

  it('formEndLabel supersedes expiryDateLabel, including the changed subscription wording', () => {
    expect(formEndLabel('warranty')).toBe('Expiry date');
    expect(formEndLabel('subscription')).toBe('Cancel-by date');
    expect(formEndLabel('contract')).toBe('End date');
    expect(formEndLabel('loan')).toBe('Payoff date');
  });

  it('coveredThroughLabelForKind supersedes coveredThroughLabel, including the changed subscription wording', () => {
    expect(coveredThroughLabelForKind('warranty')).toBe('Covered through');
    expect(coveredThroughLabelForKind('subscription')).toBe('Active through');
    expect(coveredThroughLabelForKind('contract')).toBe('In effect through');
    expect(coveredThroughLabelForKind('loan')).toBe('Term runs through');
  });
});

describe('item kinds (v1.2.2 — Contracts & Coverage)', () => {
  it('lists the five kinds and recognises them with the guard', () => {
    expect(ITEM_KINDS).toEqual(['warranty', 'subscription', 'contract', 'loan', 'bill']);
    for (const kind of ITEM_KINDS) expect(isItemKind(kind)).toBe(true);
    expect(isItemKind('lease')).toBe(false);
  });

  it('has a human label for every kind, for the admin select', () => {
    expect(ITEM_KIND_LABELS).toEqual({
      warranty: 'Warranty',
      subscription: 'Subscription',
      contract: 'Contract',
      loan: 'Loan',
      bill: 'Bill',
    });
  });

  it('matches the user-approved wording matrix exactly', () => {
    expect(formStartLabel('warranty')).toBe('Purchase date');
    expect(formTermLabel('warranty')).toBe('Warranty (months)');
    expect(expiryNounForKind('warranty')).toBe('expires');
    expect(formOpenEndedLabel('warranty')).toBe('Lifetime warranty');

    expect(formStartLabel('subscription')).toBe('Start date');
    expect(formTermLabel('subscription')).toBe('Duration (months)');
    expect(expiryNounForKind('subscription')).toBe('cancel by');
    expect(formOpenEndedLabel('subscription')).toBe('Ongoing (no end date)');

    expect(formStartLabel('contract')).toBe('Start date');
    expect(formTermLabel('contract')).toBe('Term (months)');
    expect(expiryNounForKind('contract')).toBe('ends on');
    expect(formOpenEndedLabel('contract')).toBe('Open-ended');

    expect(formStartLabel('loan')).toBe('Start date');
    expect(formTermLabel('loan')).toBe('Term (months)');
    expect(expiryNounForKind('loan')).toBe('paid off by');
    expect(formOpenEndedLabel('loan')).toBe('Ongoing (no end date)');
  });

  it('builds the expiry phrase for every kind', () => {
    expect(expiryPhraseForKind('warranty', '2027-03-01')).toBe('expires 2027-03-01');
    expect(expiryPhraseForKind('subscription', '2027-03-01')).toBe('cancel by 2027-03-01');
    expect(expiryPhraseForKind('contract', '2027-03-01')).toBe('ends on 2027-03-01');
    expect(expiryPhraseForKind('loan', '2027-03-01')).toBe('paid off by 2027-03-01');
  });

  it('builds the day-count expiring-soon badge label for every kind', () => {
    expect(expiringSoonLabelForKind('warranty', 12)).toBe('Expires in 12 days');
    expect(expiringSoonLabelForKind('subscription', 1)).toBe('Cancel in 1 day');
    expect(expiringSoonLabelForKind('contract', 0)).toBe('Ends today');
    expect(expiringSoonLabelForKind('loan', 3)).toBe('Paid off in 3 days');
  });

  it('the boolean helpers are thin wrappers that produce identical text to before (compile-compat)', () => {
    expect(expiryNoun(false)).toBe(expiryNounForKind('warranty'));
    expect(expiryNoun(true)).toBe(expiryNounForKind('subscription'));
    expect(expiryPhrase(false, '2027-03-01')).toBe(expiryPhraseForKind('warranty', '2027-03-01'));
    expect(expiryPhrase(true, '2027-03-01')).toBe(expiryPhraseForKind('subscription', '2027-03-01'));
    expect(expiringSoonLabel(false, 12)).toBe(expiringSoonLabelForKind('warranty', 12));
    expect(expiringSoonLabel(true, 12)).toBe(expiringSoonLabelForKind('subscription', 12));
  });
});

// v1.3.0 user request: billing cycle + amount for subscriptions/contracts, and a per-kind
// open-ended DISPLAY label (distinct from formOpenEndedLabel's checkbox-label wording).
describe('billing cycle constants (v1.3.0)', () => {
  it('lists exactly monthly and annual, recognised by the guard', () => {
    expect(BILLING_CYCLES).toEqual(['monthly', 'annual']);
    expect(isBillingCycle('monthly')).toBe(true);
    expect(isBillingCycle('annual')).toBe(true);
    expect(isBillingCycle('weekly')).toBe(false);
  });

  it('has a human label for each cycle', () => {
    expect(BILLING_CYCLE_LABELS).toEqual({ monthly: 'Monthly', annual: 'Annual' });
  });

  it('builds the display suffix used after the formatted amount', () => {
    expect(billingCycleSuffixForKind('subscription', 'monthly')).toBe('/ month');
    expect(billingCycleSuffixForKind('subscription', 'annual')).toBe('/ year');
  });

  // v1.3.1: widened to include 'loan' -- see the MUST-12.1 describe block below for the
  // full matrix.
  it('allows billing for subscription, contract and loan kinds, still not warranty', () => {
    expect(billingAllowedForKind('subscription')).toBe(true);
    expect(billingAllowedForKind('contract')).toBe(true);
    expect(billingAllowedForKind('loan')).toBe(true);
    expect(billingAllowedForKind('warranty')).toBe(false);
  });
});

describe('open-ended DISPLAY label per kind (v1.3.0)', () => {
  it('matches the user-approved matrix, distinct from the checkbox label wording', () => {
    expect(openEndedDisplayLabel('warranty')).toBe('Lifetime');
    expect(openEndedDisplayLabel('subscription')).toBe('Lifetime');
    expect(openEndedDisplayLabel('contract')).toBe('Ongoing');
    expect(openEndedDisplayLabel('loan')).toBe('Open-ended');
    // The two matrices are deliberately different strings for warranty/subscription/loan --
    // this label is a short word for a blank-value slot; formOpenEndedLabel is a full
    // checkbox sentence.
    expect(openEndedDisplayLabel('warranty')).not.toBe(formOpenEndedLabel('warranty'));
    expect(openEndedDisplayLabel('subscription')).not.toBe(formOpenEndedLabel('subscription'));
    expect(openEndedDisplayLabel('loan')).not.toBe(formOpenEndedLabel('loan'));
  });
});

describe('MUST-12.1 … MUST-12.4: the widened rule and the wording matrix', () => {
  it('billingAllowedForKind is true for loan and still false for warranty', () => {
    expect(billingAllowedForKind('loan')).toBe(true);
    expect(billingAllowedForKind('subscription')).toBe(true);
    expect(billingAllowedForKind('contract')).toBe(true);
    expect(billingAllowedForKind('warranty')).toBe(false);
  });

  it('loanFieldsAllowedForKind is true for loan alone', () => {
    expect(ITEM_KINDS.filter((kind) => loanFieldsAllowedForKind(kind))).toEqual(['loan']);
  });

  it('returns the MUST-12.3 table for all four kinds', () => {
    for (const kind of ['warranty', 'subscription', 'contract'] as const) {
      expect(billingSectionLabelForKind(kind)).toBe('Billing');
      expect(billingAmountLabelForKind(kind)).toBe('Amount');
      expect(billingCycleSuffixForKind(kind, 'monthly')).toBe('/ month');
      expect(billingCycleSuffixForKind(kind, 'annual')).toBe('/ year');
    }
    expect(billingSectionLabelForKind('loan')).toBe('Payment');
    expect(billingAmountLabelForKind('loan')).toBe('Payment amount');
    expect(billingCycleSuffixForKind('loan', 'monthly')).toBe('per month');
    expect(billingCycleSuffixForKind('loan', 'annual')).toBe('per year');
    // MUST-12.4: the cadence labels are shared and unchanged.
    expect(BILLING_CYCLE_LABELS).toEqual({ monthly: 'Monthly', annual: 'Annual' });
  });

  it('MUST-12.3: the kind-agnostic billingCycleSuffix is DELETED, not wrapped', () => {
    // A source-level check rather than a type error: a real `import { billingCycleSuffix }`
    // in this file would break `tsc --noEmit` for the whole suite, which is a worse signal
    // than a failing assertion. Wording must live in exactly one place.
    const source = fs.readFileSync(path.join(root, 'src/lib/warranty/constants.ts'), 'utf8');
    expect(source).not.toMatch(/export function billingCycleSuffix\s*\(/);
    const callers = fs
      .readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((name) => /\.tsx?$/.test(name))
      .filter((name) => /billingCycleSuffix\s*\(/.test(fs.readFileSync(path.join(root, 'src', name), 'utf8')))
      .filter((name) => !/billingCycleSuffixForKind\s*\(/.test(fs.readFileSync(path.join(root, 'src', name), 'utf8')));
    expect(callers).toEqual([]);
  });
});

describe('client safety (Ruling P4)', () => {
  it('imports nothing from the database layer', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/warranty/constants.ts'), 'utf8');
    // A client component imports this module; a db import would pull better-sqlite3
    // into the browser bundle.
    expect(source).not.toMatch(/from '@\/db\//);
    expect(source).not.toMatch(/better-sqlite3|drizzle-orm/);
  });
});

describe('v1.10.2: product-field applicability and the submit-button noun', () => {
  it('confines model, serial and price to a physical purchase', () => {
    expect(productFieldsAllowedForKind('warranty')).toBe(true);
    for (const kind of ['subscription', 'contract', 'loan'] as const) {
      expect(productFieldsAllowedForKind(kind)).toBe(false);
    }
  });

  it('names the kind on the submit button for every kind', () => {
    expect(formSaveLabel('warranty')).toBe('Save warranty');
    expect(formSaveLabel('subscription')).toBe('Save subscription');
    expect(formSaveLabel('contract')).toBe('Save contract');
    expect(formSaveLabel('loan')).toBe('Save loan');
  });

  it('derives the button noun from ITEM_KIND_LABELS, so the two cannot drift apart', () => {
    for (const kind of ITEM_KINDS) {
      expect(formSaveLabel(kind)).toBe(`Save ${ITEM_KIND_LABELS[kind].toLowerCase()}`);
    }
  });

  it('says how to change a type instead of only refusing', () => {
    // The refusal is only actionable if it names the way out, since there is no longer a
    // control for it.
    expect(ITEM_TYPE_IMMUTABLE_ERROR).toMatch(/delete this item and add it again/i);
  });
});

/**
 * v1.12.0: five kinds against five gates, written as a TABLE rather than as five assertions.
 * The table is the point. billingAllowedForKind used to read `kind !== 'warranty'`, and a
 * negative gate silently admits every kind nobody has thought of yet -- adding 'bill' under it
 * would have handed a bill the cadence fields ruling C4 forbids. A table fails loudly the moment
 * a sixth kind is added without a decision about each gate (ruling B4).
 */
describe('the five kinds against the five applicability gates', () => {
  const expected: Record<
    string,
    { billing: boolean; loan: boolean; product: boolean; installments: boolean; matching: boolean }
  > = {
    warranty: { billing: false, loan: false, product: true, installments: false, matching: false },
    subscription: { billing: true, loan: false, product: false, installments: false, matching: false },
    contract: { billing: true, loan: false, product: false, installments: false, matching: false },
    loan: { billing: true, loan: true, product: false, installments: false, matching: true },
    bill: { billing: false, loan: false, product: false, installments: true, matching: true },
  };

  it('has a row for every kind and a kind for every row', () => {
    expect([...ITEM_KINDS].sort()).toEqual(Object.keys(expected).sort());
  });

  for (const kind of ITEM_KINDS) {
    it(`${kind}`, () => {
      const row = expected[kind];
      expect({
        billing: billingAllowedForKind(kind),
        loan: loanFieldsAllowedForKind(kind),
        product: productFieldsAllowedForKind(kind),
        installments: installmentsAllowedForKind(kind),
        matching: matchingAllowedForKind(kind),
      }).toEqual(row);
    });
  }

  it('every Record<ItemKind, ...> matrix is total, which is what the compiler enforces', () => {
    for (const kind of ITEM_KINDS) {
      expect(typeof ITEM_KIND_LABELS[kind]).toBe('string');
      expect(ITEM_KIND_LABELS[kind].length).toBeGreaterThan(0);
      expect(typeof formStartLabel(kind)).toBe('string');
      expect(typeof formTermLabel(kind)).toBe('string');
      expect(typeof formEndLabel(kind)).toBe('string');
      expect(typeof formOpenEndedLabel(kind)).toBe('string');
      expect(typeof coveredThroughLabelForKind(kind)).toBe('string');
      expect(typeof billingSectionLabelForKind(kind)).toBe('string');
      expect(typeof billingAmountLabelForKind(kind)).toBe('string');
      expect(typeof openEndedDisplayLabel(kind)).toBe('string');
    }
    expect(Object.keys(ITEM_KIND_LABELS)).toHaveLength(5);
  });

  it("bill's label is Bill, and reuses contract's date wording (ruling B5)", () => {
    expect(ITEM_KIND_LABELS.bill).toBe('Bill');
    expect(formStartLabel('bill')).toBe('Start date');
    expect(formTermLabel('bill')).toBe('Term (months)');
    expect(formEndLabel('bill')).toBe('End date');
    expect(expiryNounForKind('bill')).toBe('ends on');
    expect(coveredThroughLabelForKind('bill')).toBe('In effect through');
    expect(openEndedDisplayLabel('bill')).toBe('Ongoing');
    // The one place B5's enumeration parts from `contract`: the open-ended checkbox label.
    expect(formOpenEndedLabel('bill')).toBe('Ongoing (no end date)');
    // Those dates describe the ITEM's life ("we have owned this property since..."), never the
    // schedule -- warranty_items.purchase_date is NOT NULL and stays so.
  });

  it('names the four installment states in one place', () => {
    expect(INSTALLMENT_SECTION_LABEL).toBe('Installments');
    expect(INSTALLMENT_STATES).toEqual(['paid', 'overdue', 'due_soon', 'scheduled']);
    expect(installmentStateLabel('paid')).toBe('Paid');
    expect(installmentStateLabel('overdue')).toBe('Overdue');
    expect(installmentStateLabel('due_soon')).toBe('Due soon');
    expect(installmentStateLabel('scheduled')).toBe('Scheduled');
  });

  it('names both refusals and both matching blurbs in one place (MUST-19.11)', () => {
    expect(MATCHING_KIND_ERROR).toBe('Payment matching only applies to loans and bills.');
    expect(INSTALLMENT_KIND_ERROR).toBe('A due-date schedule only applies to bills.');
    expect(matchingBlurbForKind('loan')).toContain('takes it off the balance');
    expect(matchingBlurbForKind('bill')).toContain('next unpaid installment');
    expect(matchingBlurbForKind('bill')).not.toContain('balance');
    // Both blurbs must keep the budget promise MUST-14.6 requires above the rules table.
    expect(matchingBlurbForKind('loan')).toContain('still counts in your budget');
    expect(matchingBlurbForKind('bill')).toContain('still counts in your budget');
  });
});

describe('billScheduleLabel (item Q, ruling P4)', () => {
  it('names the next due date when nothing is overdue', () => {
    expect(billScheduleLabel('2026-09-30', 0)).toBe('Next due 2026-09-30');
  });

  it('leads with the overdue count when there is one', () => {
    // A bill three weeks late used to read "Ongoing" on this row, which is the whole defect.
    expect(billScheduleLabel('2026-06-30', 2)).toBe('2 overdue · next 2026-06-30');
  });

  it('says "1 overdue", singular', () => {
    expect(billScheduleLabel('2026-06-30', 1)).toBe('1 overdue · next 2026-06-30');
  });

  it('falls back to the open-ended word when there is no unpaid installment left', () => {
    expect(billScheduleLabel(null, 0)).toBe(openEndedDisplayLabel('bill'));
  });

  it('renders no amount (ruling P4: dates and counts only)', () => {
    expect(billScheduleLabel('2026-09-30', 3)).not.toMatch(/\$|\d+\.\d\d/);
  });
});

describe('loanSignedDelta (spec BU, ruling P4)', () => {
  it('is the identity for an owed loan, so today’s behaviour is unchanged by construction', () => {
    expect(loanSignedDelta('owed', -50_000)).toBe(-50_000);
    expect(loanSignedDelta('owed', 50_000)).toBe(50_000);
    expect(loanSignedDelta('owed', 0)).toBe(0);
  });

  it('negates for a lent loan: money out lends more, money in repays', () => {
    expect(loanSignedDelta('lent', -50_000)).toBe(50_000);
    expect(loanSignedDelta('lent', 50_000)).toBe(-50_000);
    expect(loanSignedDelta('lent', 0)).toBe(0);
  });

  it('isLoanRepayment reads "this balance goes down" in either frame', () => {
    expect(isLoanRepayment('owed', -50_000)).toBe(true);
    expect(isLoanRepayment('owed', 50_000)).toBe(false);
    expect(isLoanRepayment('lent', -50_000)).toBe(false);
    expect(isLoanRepayment('lent', 50_000)).toBe(true);
  });

  it('labels are written in the household’s voice and cover every value', () => {
    expect(LOAN_DIRECTIONS.map((d) => LOAN_DIRECTION_LABELS[d])).toEqual(['Borrowed — we owe them', 'Lent out — they owe us']);
    expect(isLoanDirection('owed')).toBe(true);
    expect(isLoanDirection('lent')).toBe(true);
    expect(isLoanDirection('given')).toBe(false);
  });
});
