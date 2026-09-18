# Loan interest, statement reconciliation and anchor history — design

**Date:** 2026-09-18
**Status:** Feature request (2026-09-18). Rulings **I1–I24**, **A1–A5**, **R1–R12**, **L1–L6**, **S1–S14**
below are the planner's; each names the code fact that forced it and each is reversible.
**Target release:** v1.47.0 (built on v1.46.0). One release, all of it.
**Migration:** `drizzle/0025_loan_interest.sql`, journal idx 25. Additive: one `ALTER TABLE ADD COLUMN`,
one `CREATE TABLE`, one seeding `INSERT…SELECT`. No table rebuild, no row rewritten.

**Withdraws, in the open:** the 2026-08-17 loans spec §13.1 / **MUST-13.1** ("interest_rate_bps is
display only") and the §23 deferral of "interest accrual of any kind; per-payment principal/interest
splits". Same shape as the lent-direction spec withdrawing warranty §17 item 29. Nothing else.

---

## Problem

The app stores an interest rate on a loan and does nothing with it. The request: calculate interest,
show monthly and annual figures, show how interest has grown, and account for it when a payment is
applied. Rates may be quoted per year or per month. Alongside it, an accepted premise and its remedy:
the app's figure will drift from the lender's, so there should be a manual, logged reconciliation
against a statement. Loans in scope are an interest-free personal loan, a personal loan with
interest, a mortgage, and a line of credit — the last with PDF statements, sometimes CSV.

Taken literally, three parts of that produce misleading numbers. §7 says what is built instead.

## Facts verified before designing

1. **The anchor VALUE is not stored; only the anchor DATE is.** `recomputeBalance`
   (`src/lib/loans.ts:448`) never reads `balanceUpdatedAt`; it recovers an implied anchor as
   `currentBalanceCents − Σ signed applied` and replays forward. The stored balance is "the figure a
   person typed, minus every payment linked since". This is the source of the documented "removing an
   old payment can push the balance above your statement" hint, and of its mirror, a late import that
   double-subtracts.
2. **The anchor date is the TYPING time.** No form field carries an "as of" date today.
3. **MUST-13.1 is two guards, not one:** the whole-file arithmetic regex in
   `tests/ops/loan-invariants.test.ts` AND the function-scoped "never references interestRateBps"
   case in `tests/lib/loan-payoff.test.ts`. Both must go together or the second blocks an
   interest-aware projection.
4. **Copy that becomes a lie** and is rewritten in the same commit: the schema loan docblock,
   the `loans.ts` header, `items.ts:87`, the form hint at `warranty-detail-client.tsx:1317`
   ("Shown for reference only — this app does no interest math."), the MUST-14.4 comment at
   `actions.ts:185`, and the unassign hint. This repo treats a stale docblock as a defect.
5. **`applied_cents` clamps at the interest-blind stored balance**, so a final payment of
   balance-plus-interest clamps. The ledger must simulate with `amount_cents` (I10).
6. **`link()` already applies POSITIVE frame deltas in full, with no ceiling.**
   `assignTransactionToLoan` documents both signs ("a disbursement or an adjustment");
   `spend-where.ts` already classifies borrowing as not-income; `applyPaymentMatchers` skips
   positive transactions (P8). A revolving balance is therefore already representable (L1).
7. **A loan item already accepts `application/pdf` receipts**: `warranty_receipts.mime` includes it,
   `sniff.ts` detects the signature, files land under a random name with sha256 (MUST-4.2),
   `ocr_text`/`ocr_status` hold the text layer. Statement storage needs no new file machinery.
8. **`extractPdfText`** (`src/lib/warranty/ocr/pdf.ts`) is text-layer only with every remote fetch
   disabled (MUST-7.14); under `MIN_PDF_TEXT_CHARS` it throws `ScannedPdfError` (MUST-7.15).
9. **`parse.ts` detects `dateOrder`** rather than assuming it, and `closingBalancesByDate` takes the
   chronologically last row of a date. `parseAmountToCents` and `parseDateString` exist.
10. Payments are bucketed by `transactions.date`, never `loan_payments.created_at` (the v1.25.0 fix).
    Interest must follow the same rule.

---

## 1. Interest model (I1–I2)

**I1.** One model: interest on the outstanding balance, posted once a month, unpaid interest joins
the balance. This is what every mortgage, car loan, personal loan and line of credit actually does,
and it is what an amortisation schedule is. Two buckets: *principal* and an *interest pot*; owing =
principal + pot. Plain wording for the help page: *"Each month the app works out one month's interest
on what you owed at the start of that month and adds it. A payment pays that interest first; whatever
is left comes off the loan."*

**I2 (reversed from the first pass).** `simple_on_principal` is a basis after all — the classic
family loan quoted on the original amount. Modelling it as amortising misstates interest by roughly
half over two years ($10,000 at 5% over two years: $1,000 flat vs about $530 amortising).

## 2. The rate basis (I3–I6)

**I3.** One nullable column, `warranty_items.interest_rate_basis`, saying how the rate is charged.
Not a period column plus a compounding column: two columns for one fact are two columns that can
disagree. `interest_rate_bps` keeps its meaning — the number the lender printed, in basis points.

**I4.** The enum, with its form label:

| value | label | mechanics | for |
|---|---|---|---|
| `none` | Interest-free | charge always 0; rate must be 0 or NULL | interest-free personal loan |
| `apr_monthly` | Yearly rate, one twelfth charged each month | opening balance × `bps×1e5/12` ppb | car loan, bank personal loan, US-style mortgage |
| `apr_semiannual` | Yearly rate compounded twice a year, charged monthly (Canadian mortgages) | sixth-root monthly factor | Canadian fixed mortgage |
| `per_month` | Monthly rate, charged each month | opening balance × `bps×1e5` ppb | loans quoted per month |
| `simple_on_principal` | Yearly rate on the original amount, no compounding | `principal_cents × bps×1e5/12` ppb, independent of balance, stops at zero owing | the family "5% a year on the $10,000" |
| `apr_daily` | Yearly rate, accrued daily on the balance (lines of credit) | each day's closing balance × `round(bps×1e5/365)` ppb, accumulated in integer nano-cents, rounded once, posted month end | line of credit |
| `NULL` | Not set — rate shown for reference only | nothing computed | every existing row |

**`none` is a value, not an absence.** An interest-free loan is a positive claim: the screen says
*"Interest-free — every payment is principal"*, runs the payoff projection, and reconciles like any
other. `NULL` means "we do not know", which is a weaker and different statement, and would hide the
loan from every interest surface. Storing `bps 0` under `apr_monthly` would be a lie in the column.

**I5.** NULL for every existing row, and **no default in the form**. Every rate in the database was
typed under a promise that nothing would be calculated from it; a 1.5%-per-month rate typed as "1.5"
would be read as yearly and understated twelve times. Existing installs change behaviour in no way
on upgrade. Detail-page nudge under the rate row: *"Say how this rate is charged to see interest
estimates."*

**I6.** Cross-column rules in the app layer beside the existing asserts in `items.ts` (a CHECK cannot
be added to an existing table — 0007's argument): a basis requires a rate unless it is `none`;
`none` requires rate 0 or NULL; `simple_on_principal` requires `principal_cents`; the basis joins
`assertLoanFieldsMatchKind`'s loan-fields-absent check; `setItemTypeKind` nulls it with the other
loan columns (MUST-12.5). Zod enum mirrors the CHECK.

## 3. Convention and arithmetic (I7–I8)

**I7.** Whole calendar months for the four monthly bases: charge computed on the balance at the
**start** of the month, posted at the **end**. Reasons: a monthly-payment loan matches exactly; the
payment's day within the month becomes irrelevant to the charge, which matters because a CSV gives
the bank's date and the lender's posting date differs by one to three days; and it reuses the month
bucketing `debtOverTime` and `payoffProjection` already use. The anchor month is pro-rated by days
from the anchor date through month end ÷ days in month. `apr_daily` walks days instead and needs no
pro-rating.

**I8.** The rate becomes **one integer in parts per billion**, derived once: `apr_monthly` →
`bps × 1e5 / 12`; `per_month` → `bps × 1e5`; `apr_semiannual` → `round(((1 + bps/20000)^(1/6) − 1) × 1e9)`;
`apr_daily` → `round(bps × 1e5 / 365)`. Every charge is
`roundHalfAwayFromZero(balanceCents × ppb / 1e9)` — integer cents before it touches anything. The one
non-integer operation in the feature is a sixth root on a **rate**; no float ever carries a money
value between steps. Pinned test values: $300,000 at 5.00% → `apr_monthly` $1,250.00, `per_month` at
0.50% $1,500.00, `apr_semiannual` ≈ $1,237 (about 1% below r/12, which is why the option exists);
$10,000 at 5% `simple_on_principal` → $41.67 every month; $20,000 at 8% `apr_daily` → ≈ $131.51 over
30 days. 365 days fixed; leap years ignored, stated in the help.

## 4. Payment allocation (I9–I11)

**I9.** Interest first, then principal. Overpayment is all principal; underpayment leaves interest
owing and the row is flagged *"Did not cover the month's interest."* Example: $300,000 at 5% yearly,
$1,800 payment → $1,250 interest, $550 principal, owing $299,450; next month's charge $1,247.71.
`none` rows show no split — repeating "$0 interest" on every row is noise.

**I10.** The ledger simulates with the payment's honest `amount_cents`, not `applied_cents`, so a
clamped final payment reaches $0 instead of leaving phantom interest owing forever. `link()`,
`applied_cents` and the clamp are **not changed**.

**I11.** Ledger rows carry a second muted line, *"Interest $1,250.00 · Principal $550.00"*. Rows on or
before the anchor read *"Before your <date> statement — already in that figure"*. On an `apr_daily`
loan a positive link is worded **Advance**.

## 5. Storage: derived, never stored (I12–I15)

**I12.** Interest is **derived on read**. No accrual table, no scheduler, no new writer to
`current_balance_cents`, no new reversal step. Accrued interest is a pure function of (anchor
balance, anchor date, rate, basis, payments since, today); storing its outputs would cache a function
that costs microseconds over a few hundred rows, and the cache would need a scheduler, a reversal
step on undo, a rule for what happens when a person re-anchors, and a second thing that can disagree
with the human anchor. Every undo path — `unassignTransactionFromLoan`,
`reverseLoanLinksForTransactions`, `undoImport` — is complete for free. **MUST-13.16 and its test stay
byte-identical.**

**I13.** The anchor stays the human anchor, made explicit: a real as-of date, a wall (R5), and a
history (A1).

**I14.** One pure module, `src/lib/loans/interest.ts`: inputs are plain numbers and dates; it imports
nothing from `@/db`, reads no clock, and never spells `'lent'` (P4 — the caller re-signs with
`loanSignedDelta`). `loans.ts` gains one reader that gathers inputs with the two-queries-then-fold
shape `debtOverTime` uses (MUST-15.8, no N+1).

**I15.** Interest is **never a transaction**. It never writes `transactions`, touches a category or a
budget, or appears in `Fees > Interest` or any spend figure. The payment already is the spend
(MUST-13.2); counting the interest inside it again would double-count.

## 6. Direction, display, projection (I16–I19)

**I16.** All interest figures are non-negative magnitudes in the loan's own frame; direction chooses
the words. `owed`: "Interest charged", "paid in interest"; joins *What we owe* and therefore
`loansTotalOwedCents` and net worth. `lent`: "Interest earned", "owed to you in interest"; joins
*Who owes us*, **not** net worth as an asset (P6 stands). The simulation is identical either way.

**I17.** The detail-page money block, when a basis is set: **"Owing now (our estimate since your
<date> statement)"** leads — it *replaces* the balance headline, with the typed figure as a labelled
sub-row *"Statement 1 Sep: $200,310"*. Two headline figures for one loan would make a reader choose.
Then: interest this month; *"a year at today's balance, if it stayed there"*; interest since the
anchor; interest by month (month, charged, paid, cumulative) with statement rows inline; per-row
splits; the Statements list; the Reconcile button; and, when any anchor carries it,
**"Interest from your statements: $X (N statements)"**.

**I18.** `payoffProjection` becomes interest-aware when a basis is set: simulate forward from
owing-now with the six-month mean payment, adding each month's charge, to zero; the 1,200-month cap
stays; null when the mean payment does not exceed the monthly charge, and the page says *"At this
pace the balance is not going down."* Without this the dashboard would contradict the detail page.

**I19.** Loans card: the row figure becomes owing-now, the meta line gains *"~$1,250/mo interest"* and
a stale marker. Reports debt chart: `debtOverTime` uses segment closing balances; UNKNOWN only
before the first anchor; loans with basis NULL are byte-identical to today.

## 7. Honesty (I20–I21)

**I20.** The app claims **an estimate, from the rate you gave and the balance you confirmed on
<date>**. It must never claim a figure is what the lender charged, a lifetime total, or a statement
reconciliation it did not do. The disclaimer appears once each: the detail block footer (*"Estimated
from your rate and the balance you set on <date>. Your lender's statement can differ — it may charge
interest on different days, round differently, add fees, or have changed your rate. Reconcile from
your latest statement to bring the estimate back into line."*), the form beside the basis select, and
one paragraph in the help page. Not on the card, not on Reports.

**I21.** **Two figures carry no caveat at all**, and they are the point of the anchor history:
the movement between two statements beyond linked transactions (A5), and Σ `stated_interest_cents` —
the interest figures printed on the household's own statements (S3).

## 8. Where the literal request would mislead

1. **"Annual interest"** as rate × today's balance overstates on any amortising loan — the balance
   falls all year. Built instead: *"a year at today's balance, if it stayed there"* plus the real
   since-anchor total.
2. **"Account for it when a payment is applied"**, read as writing interest into the stored balance,
   would mix an estimate into the one column that is a human fact, break the anchor and undo model,
   and only accrue when a payment happened — a skipped month would accrue nothing. Built instead:
   derive, never write (I12).
3. **Interest from the original principal forward** would print a lifetime figure ignoring
   prepayments, rate changes and fees — confidently wrong on the largest number in the household.
   Built instead: since-anchor only, labelled with its date.
4. **A bare rate with no period** is a 12× trap either way (I3–I5).
5. **A Canadian mortgage at r/12** runs about 1% high every month (I4, I8).
6. **A rate edited on its own** would silently rewrite history. Built instead: reconcile from the
   statement that shows the new rate; segments freeze their opening rate (R6/R7).

## 9. Anchor history (A1–A5, R1–R12)

**R1.** Reconciliation *is* the anchor pattern, with an as-of date, a wall and a memory. Not a new
concept, not an adjustment event.

**A1. `loan_anchors`** — append-only, `ON DELETE CASCADE` from `warranty_items`:

| column | meaning | can the app state it? |
|---|---|---|
| `as_of_date` (`CHECK LIKE '____-__-__'`) | the date the figure is true as of | fact |
| `balance_cents` (`CHECK >= 0`) | the figure a person confirmed | fact |
| `source` (`'migrated'\|'form'\|'first-entry'\|'reconcile'`) | which path wrote the row | fact |
| `created_at`, `created_by_user_id` (SET NULL) | when, who | fact |
| `note` | free text | fact |
| `interest_rate_bps`, `interest_rate_basis` | the rate in force from this date | fact (confirmed) |
| `payments_between_cents` (signed) | Σ re-signed `applied_cents` for linked rows after the previous as-of through this one | fact about *linked* movements |
| `estimated_interest_cents` | our estimate for the closed segment; NULL when the opening row had no basis | our estimate |
| `app_balance_cents` | what the app said the balance was at this date | our estimate |
| `difference_cents` | `balance_cents − app_balance_cents` | fact (arithmetic on two knowns) |
| `stated_interest_cents` (`CHECK >= 0`, nullable) | the interest figure printed on the statement | **lender fact** |
| `prefilled_from` (`'pdf'\|'csv'`, nullable) | how the figure was proposed | fact |
| `prefill_balance_cents` (nullable) | what the extractor proposed, before any edit | fact |
| `receipt_id` → `warranty_receipts` (SET NULL) | the stored statement | fact |

No unique index on `(item_id, as_of_date)`: correcting a statement is a second row. Order everywhere
`as_of_date ASC, id ASC`. **R4:** no attribution of `difference_cents` to interest / principal / fees
/ unlinked movement is stored or guessed — one uniform label, no threshold heuristics.
`warranty_items.current_balance_cents` / `balance_updated_at` become a **cache** of the newest row.

**A2/A3. Migration and seeding.** One `migrated` anchor per loan that has one:
`as_of_date = substr(balance_updated_at,1,10)`, `balance_cents = current + Σ signed undo of applied
over rows dated after that`, rate copied, basis NULL, comparison columns NULL, note *"Carried over
from the balance set before statement history existed."* **Property pinned by a migration test:
replaying the seeded row forward reproduces `current_balance_cents` exactly — no household sees a
number move on upgrade.** Pre-existing double-subtractions are not corrected by the migration; the
first real reconciliation corrects them, and the stale marker asks for one.

**R3 (superseded in name and shape by A1).** The first pass named this table
`loan_reconciliations`, snapshotted `prior_as_of`/`prior_balance_cents` on every row, and ruled that
existing anchors were not back-filled. All three were changed: the table is `loan_anchors`, it is
seeded (A3), and the `prior_*` columns are dropped — the previous row is always present to read, and
a second copy is a second thing that can disagree. Named for the feature, not the parent table.
Not folded into a generic `audit_log`: an audit row cannot hold the comparison columns or serve as
the history the ledger reads.

**A4/R2. One writer for every human balance.**

```
setLoanAnchor({ itemId, asOfDate, balanceCents, source, actorUserId,
                rateBps?, basis?, note?, statedInterestCents?,
                prefilledFrom?, prefillBalanceCents?, receiptId? })
```

is the only code path that writes `current_balance_cents` from a human figure. It computes the
comparison fields (R4), appends the row, sets `balance_updated_at` to the as-of date and
`current_balance_cents` to the confirmed figure replayed forward through linked movements dated after
it. Callers: the Reconcile action (`'reconcile'`, as-of = statement date — all three intake routes
converge here, S1); the item form's balance field, which remains **only** for a loan with no anchor
yet (`'form'`, as-of = today); `createLoanFromTransaction` (`'first-entry'`, as-of = the day before
the transaction). `updateWarrantyItem` gives up the balance pair; `assertBalanceAnchorPairing` stays
and is also asserted inside the writer. `recomputeBalance` replays from the newest row with the wall;
the implied-anchor trick retires.

**R5. The wall.** Payments dated on or before the as-of date get `applied_cents = 0` — the existing
"recorded, not moved" convention — so reversing or deleting them is a no-op and MUST-13.16 needs no
change. Those rows read *"Before your <date> statement — already in that figure"*. A statement figure
is end-of-day.

**R6/R7.** Nothing is rewritten. Owing restarts from the statement; a closed segment uses the rate
frozen on the row that opens it; the correction is its own line in the by-month list.

**A5.** Implied interest between two consecutive rows = `balance − (previous.balance −
payments_between)`, worded *"Between your 1 Aug and 1 Sep statements the balance moved $X beyond your
linked transactions — interest, fees, or anything not linked here."*

**R8.** The Reconcile form previews before writing: *"Our estimate for 1 Sep is $200,273. Your
statement says $200,310 — $37 more."* A reconciliation is not undone; it is corrected by another row.
It is not tied to a transaction.

**R9. What the UI may claim, by state.** No anchor → the block is hidden, as today. Anchor from the
form or `migrated`, never reconciled → *"Based on the balance you set on 12 Mar. Reconcile to a
statement to check our estimate."* Reconciled within two months → *"Checked against your 1 Sep
statement — our estimate was $37 low."* Reconciled more than two months ago → *"Not checked against a
statement since 1 Mar (6 months). The longer that goes, the further our figures drift."* Closed
segments exist → adds the between-statements fact and, where entered, the stated interest.
**Never** "your interest", "you paid $X in interest this year" (unless from `stated_interest_cents`,
labelled "from your statements"), or "matches your lender". **Always** "our estimate" before any
rate-derived figure and "since your <date> statement" after it.

**R10. Prompting without nagging.** Staleness = newest `as_of_date` more than two months old (two
missed statements), one rule for every loan and basis. It surfaces in exactly two places: the detail
status line always, and one muted phrase on the Loans card meta line (*"not checked since Mar"*) only
when stale. No banner, no notification, no digest line, no red — a self-hiding marker is information;
a card that appears to scold is not this app.

**R11.** For a `lent` loan the form reads *"the figure you and they agree on"*, stated interest is
*"interest they paid you this period"*, and implied movement is *"interest they owe you, fees, or
anything not linked"*. The frame is applied by `loanSignedDelta` before anything reaches
`interest.ts` — the literal `'lent'` stays banned in `loans.ts` (P4).

**R12. Deferred from this surface:** voiding an anchor row (append-only correction rows suffice); a
per-loan staleness period; a digest line; a chart of the anchor history; PDF prefill for a `credit`
account's balance snapshot (the S7 extractor is written to be reusable for it); rules matching
incoming money as advances (L3).

## 10. Revolving balances (L1–L6)

**L1.** A revolving balance is representable **with no change** to `loan_payments`, `applied_cents`
or the clamp. A draw is money into chequing assigned to an owed loan — a positive frame delta
`link()` already applies in full with no ceiling. The clamp still only applies to repayments and is
still right: a line of credit cannot be owed less than zero.

**L2.** An advance is the **existing** disbursement link with different wording, not a negative
payment and not a new row kind. A `kind` column would be a second place the direction lives, which is
the drift P4 exists to prevent.

**L3.** Rules still match outgoing money only (P8); advances are manual-assign in v1. **L4.** An
unlinked draw surfaces at the next reconciliation inside `difference_cents`, under the same uniform
label — visibly contaminated rather than silently wrong.

**L5 (partially reversed).** Right: never model one line of credit as both an account and a loan
item — net worth would count it twice; and where a CSV exists the account route is better, because
the posted interest row is a **fact**, categorised `Fees > Interest`. Wrong: calling the loan item a
"fallback". A **PDF-only** line of credit cannot become an account — there is no honest path from a
PDF to transactions, and parsing transaction tables out of arbitrary lender PDFs is confidently-wrong
at scale. **The loan item with `apr_daily`, reconciled per statement, is the primary route for a
PDF-only LOC.** Help text says *"pick by what your lender gives you"*.

**L6.** `payoffProjection` returns null when any advance is linked in its six-month window — a
balance being drawn on has no payoff month — and the page says *"Being drawn on — no payoff date to
project."*

## 11. Statement intake (S1–S14)

**S1.** **Extraction pre-fills; only a person writes an anchor.** PDF and CSV never call
`setLoanAnchor`; they produce candidates for the reconcile form, shown with the text they came from.
An automatic write would let one mis-parsed statement corrupt the only figures the app states as fact.

**S2.** `source` does not gain `pdf`/`csv` — in all three routes the path is `reconcile`. Provenance
is its own columns (A1), so a row answers three separate questions: who confirmed it, what was
proposed, and whether they had to correct it. The last is the audit trail that says whether the
extractor can be trusted for this lender.

**S3. Manual** — minimum: statement date and closing balance. Prefilled and editable: rate and basis.
Optional: note, and **"Interest charged this statement"** (`stated_interest_cents`), the figure the
statement prints. That is a lender fact and it is what makes *"Interest paid from your statements:
$X (N statements)"* sayable without qualification.

**S4/S5. CSV** — a distinct, small path reusing `splitRows`, `dateOrder` detection,
`closingBalancesByDate`, `parseAmountToCents` and `parseDateString`. The person picks the date and
balance columns in the existing preview picker. **No** import profile, **no** transactions written,
**no** account snapshot — the loan has no account, and the statement's rows are the other side of
payments already linked. The closing balance is the running balance on the chronologically last row
by detected order, never "the bottom row"; the statement date prefills from it and is editable.

**S6–S8. PDF** — text layer only (MUST-7.14/7.15 stand), capped with `truncateOcrText`. Candidates
are found by **keyword proximity, not per-lender parsers**: money tokens via `parseAmountToCents`,
date tokens via `parseDateString`, each scored by the nearest keyword family on the same line
(balance: *closing balance, new balance, current balance, principal balance, balance owing,
outstanding balance, solde*; date: *statement date, as of, closing date, date du relevé*; interest:
*interest charged, interest this period, finance charge, intérêts*) — one constants table, English
and French. The best candidate prefills; every other appears as a chip with ~40 characters of
surrounding text, so a reader can see *"Minimum payment due $312.00"* and know why not to pick it.
Two equal top scores → neither prefills. None → empty field and a notice. A scanned PDF → the
existing refusal, re-worded for this screen (*"Type the figures from the statement instead"*).
Photo OCR is not offered for statements: Tesseract on a page of small digits is where a wrong digit
in a balance comes from, and typing two numbers is faster than checking twelve. Extracted text is
attacker-influenced: rendered as text nodes only, bound as parameters (MUST-13.3).

**S9. PDF statements are stored by default** as a receipt on the loan item, with a *"Don't keep this
file"* checkbox (owner decision, 2026-09-18). The stored file is the evidence behind the logged
figure, and every piece of machinery exists. A statement is more sensitive than a receipt — account
number, full name, address — so **MUST-13.9's backup guidance gains a clause naming loan
statements**. Declining reads the file once from the temp directory and deletes it; the row keeps
`prefilled_from 'pdf'` with `receipt_id NULL`, which is still truthful. **S10:** CSVs are read once
and discarded in v1.

**S14.** Upload actions follow the receipt contract: same-origin first, session auth,
`MAX_RECEIPT_BYTES`, MIME sniffed not trusted, the OCR rate-limit shape.

## 12. Coverage of the four kinds

| kind | basis | balance moves | reconcile from |
|---|---|---|---|
| interest-free personal loan | `none` | payments, top-ups via manual assign | agreed figure |
| personal loan with interest | `apr_monthly` / `simple_on_principal` / `per_month` | payments | bank statement or agreed figure |
| mortgage | `apr_semiannual` (Canada) / `apr_monthly` | payments, lump sums | periodic statement; rate at renewal via reconcile |
| line of credit | item `apr_daily` (PDF) or `credit` account (CSV) | payments **and** advances | monthly statement |

## 13. Retiring MUST-13.1 (I24)

**MUST-13.1′:** *Interest is DERIVED, never stored; computed only in `src/lib/loans/interest.ts`;
shown only for a loan whose basis a person has set.*

Delete the whole-file regex in `loan-invariants.test.ts` and the "never references interestRateBps"
case in `loan-payoff.test.ts` (keep its clock guard). Add:

- **G1** across `src/`, arithmetic on `interestRateBps` appears only in `interest.ts` and
  `readInterestRateBps`; the `/100` display formatting moves behind one `formatRateBps()` helper.
- **G2** `interest.ts` contains no `@/db` import, no `getDb`, no `new Date(`/`Date.now(`/`todayIso(`,
  and no literal `'lent'`.
- **G3** the set of `.set({ currentBalanceCents` writers is today's five plus `setLoanAnchor`.
- **G4** the docblocks and copy in "Facts verified" item 4 are rewritten in the same commit.

Tests: per-basis pinned values (I8); allocation and underpayment (I9); clamped final payment reaching
$0 (I10); anchor-month pro-rating; lent frame; a revolving fixture (draw, repay, draw, reconcile)
matching a hand ledger; L6's null; PDF candidate scoring against synthetic statement texts including
balance-vs-minimum-payment and French; the scanned refusal wording; the CSV last-row rule under both
date orders; **S1 property** — an upload alone writes no anchor row and changes no item; **S2** — a
corrected prefill records both figures; **parity property** — with basis NULL every `LoanSummary`
field, every `DebtPoint` and every `payoffProjection` equals today's output, and the seeded cache
reproduces `current_balance_cents` exactly; **undo-completeness property** — link a payment, unassign
it, and every derived figure equals the never-linked run; likewise through `undoImport`.

## 14. v1 scope (one release)

1. Migration 0025: basis column, `loan_anchors` with every column in A1, the seed.
2. `setLoanAnchor` as single writer; `recomputeBalance` from the newest row with the wall;
   `updateWarrantyItem` drops the balance pair; `createLoanFromTransaction` writes `first-entry`.
3. `src/lib/loans/interest.ts` — six strategies, segments, the daily walk.
4. `LoanSummary.interest` / `.reconciliation`; card, totals (net worth follows), detail block with
   the owing-now headline, by-month list with statement rows inline, per-row splits, Statements list,
   Reconcile form with three entry points and preview, stale marker.
5. `payoffProjection` interest-aware plus L6; `debtOverTime` from segments.
6. Form: basis select, asserts, Advance wording, rate-change nudge; copy and docblocks rewritten;
   help paragraph plus the account-vs-item guidance; MUST-13.9 wording.
7. Guard retirement and replacements; migration test; per-basis tests; revolving fixture; intake tests.

## 15. Deliberately deferred

Scanned or photographed statement OCR; parsing statement transactions out of a PDF; per-lender
templates; CSV column auto-detection; remembering the confirmed keyword or column per loan; storing
CSVs; PDF prefill for account balance snapshots; rules matching incoming money as advances; a rate on
a `credit` account; 30/360 and 366-day years and the lender's own cycle day; voiding an anchor row; a
digest line for stale loans; charts of interest or anchors; extra-payment and refinance what-ifs;
per-payment splits on the Transactions page; interest on arrears for `simple_on_principal`.

## 16. Open questions

- Does the line-of-credit statement print "interest charged this period"? If so its exact phrase
  should seed the PDF keyword table.
- `apr_daily` fixed at 365 — acceptable? (Matters only in leap years, about 0.3%.)
- The family loan: "5% a year on the original amount" (`simple_on_principal`) or "on what is still
  owed" (`apr_monthly`)? The basis select asks this directly, so it needs no answer in advance.
