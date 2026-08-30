'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { ReceiptUploader, type StagedFile, type SuggestedFieldsDto } from '@/components/warranty/ReceiptUploader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Field, inputClass, labelClass, selectClass, textareaClass } from '@/components/ui/form';
import { isIsoDate } from '@/lib/dates';
import {
  BILLING_CYCLE_LABELS,
  BILLING_CYCLES,
  billingAllowedForKind,
  billingAmountLabelForKind,
  billingSectionLabelForKind,
  coveredThroughLabelForKind,
  formOpenEndedLabel,
  formStartLabel,
  formTermLabel,
  loanFieldsAllowedForKind,
  LOAN_DIRECTIONS,
  LOAN_DIRECTION_LABELS,
  type ItemKind,
  formSaveLabel,
  productFieldsAllowedForKind,
} from '@/lib/warranty/constants';
import { computeExpiryDate } from '@/lib/warranty/expiry';
import { createWarrantyAction, type WarrantyActionState } from '../actions';

export interface WarrantyPrefill {
  purchaseDate?: string;
  vendor?: string;
  priceCents?: number;
  transactionId?: number;
}

const initial: WarrantyActionState = {};

function centsToInput(cents: number | undefined): string {
  return cents === undefined ? '' : (cents / 100).toFixed(2);
}

// v1.14.0 fix round (review C, item 1): the loan hints below were written in the frame of a
// debt the household owes ("what you borrowed") and read backwards for a 'lent' loan, where the
// household is the one owed money. Both hints, and the balance field's own label, follow the
// live Direction selection instead of assuming 'owed'.
function principalHintForDirection(direction: string): string {
  return direction === 'lent'
    ? 'What you lent out. Used for the payoff bar.'
    : 'What you borrowed. Used for the payoff bar.';
}

function balanceLabelForDirection(direction: string): string {
  return direction === 'lent' ? 'Balance still owed to you' : 'Balance still owed';
}

function balanceHintForDirection(direction: string): string {
  return direction === 'lent'
    ? "Today's balance. Repayments you link will take it down; further advances raise it."
    : "Today's balance. Payments you link will take it down from here.";
}

export function NewWarrantyClient({
  people,
  types,
  currentUserId,
  today,
  prefill,
  isAdmin,
}: {
  people: { id: number; name: string }[];
  /** Delta T9: an optional type dropdown, with a blank "none" choice, plus listItemTypes(). */
  types: { id: number; name: string; kind: ItemKind }[];
  currentUserId: number;
  today: string;
  prefill: WarrantyPrefill;
  /** v1.12.1 (item BH): admins get the link to Settings → Item types; members get the sentence. */
  isAdmin: boolean;
}) {
  const [state, action] = useActionState(createWarrantyAction, initial);

  // MUST-11.4 / MUST-10.3: values that arrive as prefill are user-visible by the time the
  // form renders, so `touched` starts true for them and OCR can never overwrite them.
  const [purchaseDate, setPurchaseDate] = useState(prefill.purchaseDate ?? '');
  const [vendor, setVendor] = useState(prefill.vendor ?? '');
  const [price, setPrice] = useState(centsToInput(prefill.priceCents));
  const [touched, setTouched] = useState({
    purchaseDate: prefill.purchaseDate !== undefined,
    vendor: prefill.vendor !== undefined,
    price: prefill.priceCents !== undefined,
  });
  const [suggested, setSuggested] = useState({ purchaseDate: false, vendor: false, price: false });

  // IMPORTANT 6: `touched` mirrored into a ref, kept in sync by the effect below. onSuggestions
  // reads touchedRef.current directly instead of using setTouched's updater purely to PEEK at
  // the latest value (as it did before) -- a setState updater must be a pure function of its
  // previous value, and calling setPurchaseDate/setVendor/setPrice/setSuggested from inside
  // one is a side effect that React StrictMode's double-invocation would run twice. Reading a
  // ref carries no such contract and still sees the up-to-date value, since this callback only
  // ever runs from an async fetch resolution that lands strictly after any render+effect
  // cycle a same-tick keystroke would have already completed -- the race protection MUST-10.3
  // depends on is unchanged.
  const touchedRef = useRef(touched);
  useEffect(() => {
    touchedRef.current = touched;
  }, [touched]);

  const [months, setMonths] = useState('');
  const [isLifetime, setIsLifetime] = useState(false);
  const [typeId, setTypeId] = useState('');
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [billingCycle, setBillingCycle] = useState('');
  const [billingAmount, setBillingAmount] = useState('');

  const onStagedChange = useCallback((files: StagedFile[]) => setStaged(files), []);

  /** MUST-10.3: only EMPTY, untouched fields are filled from a suggestion. */
  const onSuggestions = useCallback((fields: SuggestedFieldsDto) => {
    const current = touchedRef.current;
    if (fields.purchaseDate && !current.purchaseDate) {
      setPurchaseDate(fields.purchaseDate);
      setSuggested((s) => ({ ...s, purchaseDate: true }));
    }
    if (fields.vendor && !current.vendor) {
      setVendor(fields.vendor);
      setSuggested((s) => ({ ...s, vendor: true }));
    }
    if (fields.priceCents !== undefined && !current.price) {
      setPrice(centsToInput(fields.priceCents));
      setSuggested((s) => ({ ...s, price: true }));
    }
  }, []);

  const monthsNumber = /^\d+$/.test(months) ? Number(months) : null;
  const expiry =
    !isLifetime && monthsNumber !== null && monthsNumber > 0 && isIsoDate(purchaseDate)
      ? computeExpiryDate({ purchaseDate, warrantyMonths: monthsNumber, isLifetime: false })
      : null;
  // Delta T9, generalized to `kind` in v1.2.2 Task 2: the selected type's kind decides every
  // date label on this form -- via the KIND_WORDING matrix helpers in constants.ts, the one
  // place this wording lives (MUST-19.11). No type selected reads as a plain warranty.
  const selectedType = types.find((t) => String(t.id) === typeId);
  const selectedKind: ItemKind = selectedType?.kind ?? 'warranty';
  // v1.3.0: Billing fields only apply to subscription/contract kinds. Switching the type
  // away from one of those clears whatever was entered, so a stale value never gets to
  // submit alongside a kind that does not carry billing (fields simply leave the DOM, and
  // an absent form field posts as blank -> null, same mechanism as every other optional
  // field on this form).
  const billingApplicable = billingAllowedForKind(selectedKind);
  useEffect(() => {
    if (!billingApplicable) {
      setBillingCycle('');
      setBillingAmount('');
    }
  }, [billingApplicable]);

  // v1.3.1: the loan money fields follow the SELECTED kind live, same pattern as billing above.
  const [principal, setPrincipal] = useState('');
  const [interestRate, setInterestRate] = useState('');
  const [currentBalance, setCurrentBalance] = useState('');
  // v1.14.0 (spec BU, ruling P16): the Direction control follows the SAME loanApplicable gate
  // as the money fields below -- no second kind === 'loan' check -- and resets to 'owed' in the
  // same effect, so a person who picks 'lent' and then switches the type away does not have a
  // hidden 'lent' value silently posted for an item this form no longer offers it on.
  const [loanDirection, setLoanDirection] = useState('owed');
  const loanApplicable = loanFieldsAllowedForKind(selectedKind);
  const productApplicable = productFieldsAllowedForKind(selectedKind);
  useEffect(() => {
    if (!loanApplicable) {
      setPrincipal('');
      setInterestRate('');
      setCurrentBalance('');
      setLoanDirection('owed');
    }
  }, [loanApplicable]);

  /**
   * The prefill marker. OCR filling a blank field is helpful right up until nobody can
   * tell which values a machine guessed, so each guessed field says so and offers the
   * one-click way out.
   */
  const suggestedNote = (flag: boolean, clear: () => void) =>
    flag ? (
      <span className="flex items-center gap-1.5 text-xs text-warning">
        suggested from receipt
        <button type="button" onClick={clear} className="btn btn--ghost btn--sm px-1.5 text-xs underline">
          clear
        </button>
      </span>
    ) : null;

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        eyebrow="Contracts & Coverage"
        title="Add item"
        description="Attach the receipt first and the date, vendor and price fill themselves in."
        actions={
          <Link href="/warranties" className="btn btn--ghost btn--sm">
            Back to items
          </Link>
        }
      />
      <FormError message={state.error} />

      <Card>
        <CardHeader title="Receipt" description="Photograph it or attach a PDF. Reading happens on this machine — nothing is uploaded anywhere." />
        <CardBody>
          <ReceiptUploader onStagedChange={onStagedChange} onSuggestions={onSuggestions} />
        </CardBody>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader title="The item" />
        <CardBody>
          <form action={action} className="flex flex-col gap-4">
            <input
              type="hidden"
              name="staged"
              value={JSON.stringify(staged.map((f) => ({ stagingId: f.stagingId, originalFilename: f.originalFilename })))}
            />
            <input type="hidden" name="transactionId" value={prefill.transactionId ?? ''} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" className="sm:col-span-2">
                <input name="name" required maxLength={200} className={inputClass} />
              </Field>

              {/* v1.12.1 (item BH). Switched to htmlFor/id so the label's accessible name stays
                  "Type" -- Field renders a bare wrapping <label> when htmlFor is absent, and the
                  hint paragraph added below would otherwise be folded into that label's
                  accessible name (breaking getByLabelText('Type') at every other call site that
                  renders the default, bill-less fixture). */}
              <Field label="Type" htmlFor="warranty-type">
                <select
                  id="warranty-type"
                  name="typeId"
                  value={typeId}
                  onChange={(e) => setTypeId(e.target.value)}
                  className={selectClass}
                >
                  <option value="">— none —</option>
                  {types.map((type) => (
                    <option key={type.id} value={type.id}>{type.name}</option>
                  ))}
                </select>
                {/* v1.12.1 (item BH). v1.12.0 added the `bill` kind, seeded no item type of that
                    kind (and deliberately does not -- warranty_item_types is user-managed and this
                    app has never seeded a row into it), and offers only existing types here. So an
                    owner who read the release note and came looking for "Bill" found nothing and had
                    no pointer to where one is made. Shown only when there is at least one type and
                    none of them is a bill: with no types at all the person's problem is a different
                    one, and the form's own empty state is about that. */}
                {types.length > 0 && !types.some((type) => type.kind === 'bill') ? (
                  <p className="mt-1.5 text-xs text-muted">
                    Tracking a bill with due dates? First add an item type with kind Bill under{' '}
                    {isAdmin ? (
                      <Link href="/settings/item-types" className="text-accent-text underline underline-offset-2">
                        Settings → Item types
                      </Link>
                    ) : (
                      <span className="font-medium text-ink">Settings → Item types</span>
                    )}
                    .
                  </p>
                ) : null}
              </Field>

              <Field
                label="Vendor"
                htmlFor="warranty-vendor"
                hint={suggestedNote(suggested.vendor, () => {
                  setVendor('');
                  setSuggested((s) => ({ ...s, vendor: false }));
                })}
              >
                <input
                  id="warranty-vendor"
                  name="vendor"
                  maxLength={200}
                  value={vendor}
                  onChange={(e) => {
                    setVendor(e.target.value);
                    setTouched((t) => ({ ...t, vendor: true }));
                    setSuggested((s) => ({ ...s, vendor: false }));
                  }}
                  className={inputClass}
                />
              </Field>

              {/* A model and a serial describe a physical purchase; a loan, a subscription and
                  a contract have neither. Gated rather than relabelled -- there is no sensible
                  loan-flavoured name for "Serial number". */}
              {productApplicable ? (
                <>
                  <Field label="Model">
                    <input name="model" maxLength={200} className={inputClass} />
                  </Field>

                  <Field label="Serial number">
                    <input name="serial" maxLength={200} className={inputClass} />
                  </Field>
                </>
              ) : null}

              <Field
                label={formStartLabel(selectedKind)}
                htmlFor="warranty-purchase-date"
                hint={suggestedNote(suggested.purchaseDate, () => {
                  setPurchaseDate('');
                  setSuggested((s) => ({ ...s, purchaseDate: false }));
                })}
              >
                <input
                  id="warranty-purchase-date"
                  type="date"
                  name="purchaseDate"
                  required
                  max={today}
                  value={purchaseDate}
                  onChange={(e) => {
                    setPurchaseDate(e.target.value);
                    setTouched((t) => ({ ...t, purchaseDate: true }));
                    setSuggested((s) => ({ ...s, purchaseDate: false }));
                  }}
                  className={inputClass}
                />
              </Field>

              {/* What a thing cost, which only a purchase has. A loan's money is its original
                  amount and balance; a subscription's and a contract's is the billing pair
                  below. Asking for "Price" as well meant the form asked for the same fact
                  twice and stored neither answer where the record keeps it. */}
              {productApplicable ? (
                <Field
                  label="Price"
                  htmlFor="warranty-price"
                  hint={suggestedNote(suggested.price, () => {
                    setPrice('');
                    setSuggested((s) => ({ ...s, price: false }));
                  })}
                >
                  <input
                    id="warranty-price"
                    name="price"
                    inputMode="decimal"
                    value={price}
                    onChange={(e) => {
                      setPrice(e.target.value);
                      setTouched((t) => ({ ...t, price: true }));
                      setSuggested((s) => ({ ...s, price: false }));
                    }}
                    className={inputClass}
                  />
                </Field>
              ) : null}

              {/* Billing applies to every kind EXCEPT warranty -- a subscription and a
                  contract are billed, and so is a loan, which has a monthly payment
                  (BILLING_WORDING carries a loan row for exactly that). This comment used to
                  say "hidden entirely for warranty/loan", which the gate has not done since
                  v1.3.1 added loans; a stale reason is worse than none, because the next
                  reader trusts it. An absent field posts as blank -> null
                  (readBillingCycle/readBillingAmountCents in actions.ts). */}
              {billingApplicable ? (
                <>
                  <Field label={billingSectionLabelForKind(selectedKind)}>
                    <select
                      name="billingCycle"
                      value={billingCycle}
                      onChange={(e) => setBillingCycle(e.target.value)}
                      className={selectClass}
                    >
                      <option value="">Not set</option>
                      {BILLING_CYCLES.map((cycle) => (
                        <option key={cycle} value={cycle}>{BILLING_CYCLE_LABELS[cycle]}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label={billingAmountLabelForKind(selectedKind)}>
                    <input
                      name="billingAmount"
                      inputMode="decimal"
                      placeholder="e.g. 15.99"
                      value={billingAmount}
                      onChange={(e) => setBillingAmount(e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                </>
              ) : null}

              {/* MUST-14.1: rendered exactly when the SELECTED type's kind is 'loan'. Hidden
                  entirely otherwise, so an absent field posts as blank -> null, the same
                  mechanism every other optional field on this form uses. */}
              {loanApplicable ? (
                <>
                  {/* v1.14.0 (spec BU, ruling P16). First field in the block, so a reader picks
                      the direction before typing amounts. Reuses loanFieldsAllowedForKind as
                      its gate, exactly like the fields below -- no second predicate. */}
                  <Field label="Direction" hint="Which way this loan points.">
                    <select
                      name="loanDirection"
                      value={loanDirection}
                      onChange={(e) => setLoanDirection(e.target.value)}
                      className={selectClass}
                    >
                      {LOAN_DIRECTIONS.map((direction) => (
                        <option key={direction} value={direction}>{LOAN_DIRECTION_LABELS[direction]}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Original amount" hint={principalHintForDirection(loanDirection)}>
                    <input
                      name="principal"
                      inputMode="decimal"
                      placeholder="e.g. 28000.00"
                      value={principal}
                      onChange={(e) => setPrincipal(e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Interest rate" hint="Shown for reference only — this app does no interest math.">
                    <span className="flex items-center gap-2">
                      <input
                        name="interestRate"
                        inputMode="decimal"
                        placeholder="e.g. 5.49"
                        value={interestRate}
                        onChange={(e) => setInterestRate(e.target.value)}
                        className={`${inputClass} w-28`}
                      />
                      <span className="text-sm text-muted">%</span>
                    </span>
                  </Field>
                  <Field label={balanceLabelForDirection(loanDirection)} hint={balanceHintForDirection(loanDirection)}>
                    <input
                      name="currentBalance"
                      inputMode="decimal"
                      placeholder="e.g. 19550.00"
                      value={currentBalance}
                      onChange={(e) => setCurrentBalance(e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                </>
              ) : null}
            </div>

            <fieldset className="flex flex-col gap-2">
              {/* v1.2.2 Task 2 (reviewer-flagged): this legend used to hard-code "Warranty
                  length" regardless of the selected type's kind, breaking MUST-19.11's
                  one-place rule. Routed through formTermLabel() like every other date label
                  on this form. */}
              <legend className={labelClass}>{formTermLabel(selectedKind)}</legend>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="number"
                  name="warrantyMonths"
                  min={1}
                  placeholder="months"
                  value={months}
                  disabled={isLifetime}
                  aria-label={formTermLabel(selectedKind)}
                  onChange={(e) => setMonths(e.target.value)}
                  className="field-control w-28"
                />
                <label className="flex items-center gap-2 text-sm text-muted">
                  <input
                    type="checkbox"
                    name="isLifetime"
                    checked={isLifetime}
                    onChange={(e) => {
                      setIsLifetime(e.target.checked);
                      // MUST-3.5: a lifetime warranty has no term to store.
                      if (e.target.checked) setMonths('');
                    }}
                    className="accent-accent"
                  />
                  {formOpenEndedLabel(selectedKind)}
                </label>
                {/* MUST-10.4: the clamp rule is visible rather than surprising. Delta T9,
                    generalized to `kind` in v1.2.2 Task 2: the label switches per the
                    selected type's kind via coveredThroughLabelForKind(). */}
                {expiry ? (
                  <span className="badge badge--accent">
                    {coveredThroughLabelForKind(selectedKind)} {expiry}
                  </span>
                ) : null}
              </div>
              <span className="field-hint">Leave both blank if you do not know the term.</span>
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Owner">
                <select name="ownerUserId" defaultValue={String(currentUserId)} className={selectClass}>
                  {people.map((person) => (
                    <option key={person.id} value={person.id}>{person.name}</option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Notes">
              <textarea name="notes" maxLength={2000} rows={3} className={textareaClass} />
            </Field>

            {/* Never disabled by OCR: the Save button's only busy state is the form submission
                itself, via useFormStatus inside SubmitButton (MUST-10.2 step 2). */}
            <SubmitButton className="w-fit">{formSaveLabel(selectedKind)}</SubmitButton>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
