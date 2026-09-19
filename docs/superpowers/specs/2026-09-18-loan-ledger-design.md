# Loan ledger, interest posting, and loan notifications — design

**Date:** 2026-09-18
**Status:** Owner feedback on v1.47.0 (2026-09-18), answered by the owner in a planning session.
Rulings **D1–D6**, **C1–C4**, **A1–A8**, **P1–P7**, **K1–K5**, **R1–R3**, **U1–U8**, **N1–N9**,
**S1–S6**, **G1–G3**, **M1–M4**, **T1–T6** below. Each names the fact that forced it.
**Target release:** v1.48.0 (built on v1.47.0). One release, all of it.
**Migration:** `drizzle/0026_loan_ledger.sql`, journal idx 26. Additive: two `CREATE TABLE`, one
`ALTER TABLE ADD COLUMN`, one backfill `INSERT…SELECT`. No table rebuild.

**Withdraws, in the open:** the 2026-09-18 interest spec's ruling **I5** ("no default basis"); its §1
model of calendar-month posting (replaced by a posting cycle, §3); and these items of its §15 deferral
list: CSV column auto-detection, remembering the confirmed column per loan, storing the statement
file (S9's checkbox), the digest line for stale loans, charts of interest, and the lender's own cycle
day. Everything else in §15 stays deferred (§14 here).

---

## 1. Problem

The owner created a loan: $10,000, 10%, borrowed 2026-07-01, saved 2026-09-18. The page showed the
balance as $10,000.00, "You set this on 2026-09-19", a rate, and nothing about interest. Expected:
two months of interest already computed, a ledger like a bank's, interest recomputed when a payment
lands mid-month, and the whole thing kept up to date without the owner doing anything. For a personal
loan there is no statement to check against; the app *is* the record.

Three causes, all in v1.47.0:

1. **No basis was set**, so the engine did nothing (ruling I5: no default). The owner's expectation
   is the reasonable one; a rate with a period is what a loan has.
2. **The item form never writes a first anchor.** `loan_anchors.source` declares `'form'`; nothing
   uses it. The only anchor writer is `reconcileLoanAction`. `interestFor` returns `null` without an
   anchor. So even with a basis set, a form-created loan shows no interest until reconciled.
3. **"You set this on"** prints `balanceUpdatedAt.slice(0, 10)` — a UTC instant. An evening save in
   Toronto prints tomorrow's date.

## 2. Facts verified before designing

1. `simulate()` (`src/lib/loans/interest.ts`) walks **calendar months** from the anchor and charges
   one periodic rate on the balance as the month opens. Daily accrual exists only for `apr_daily`.
   Pinned values: $300,000 @5% → `apr_monthly` $1,250.00, `apr_semiannual` ≈ $1,237, `per_month`
   0.5% $1,500.00; $10,000 @5% `simple_on_principal` → $41.67; $20,000 @8% `apr_daily` → $131.51
   over 30 days. These stay pinned (A3).
2. `loan_anchors` already snapshots `interest_rate_bps` and `interest_rate_basis` per row (ruling R7
   of the interest spec). There is no rate history apart from that.
3. `recomputeBalance` starts from the newest anchor and applies the wall: movements dated on or
   before the anchor are zeroed. The stored `current_balance_cents` is interest-blind.
4. Scheduler: `NIGHTLY_CRON = '0 2 * * *'` runs `runNightlyTick` (backup + maintenance);
   `NOTIFY_TICK_CRON = '*/5 * * * *'` runs `runScheduledEvaluation`, which calls per-user daily-slot
   evaluators (`evaluateComingDue`, `evaluateStaleImport`, `evaluateSubscriptionCreep`,
   `evaluateSavingsDaily`) and tick evaluators (`evaluateAnomalies`).
5. `coming_due` has two sources: unpaid bill installments and item expiries. Nothing about loans
   except the loan's own end date. Nothing about detected recurring charges (`recurringCharges` in
   `src/lib/recurring.ts` returns `cadence`, `lastDate`, `typicalCents`, `tracked`).
6. Goals: `GoalPace` has `met`, `overdue`, `requiredMonthlyCents`, `avgMonthlyCents`,
   `projectedFinishMonth`. No notification event reads goals.
7. `itemLedger()` in `src/lib/loans.ts` is the **link list** (newest first) shown under "Linked
   transactions". It is not a ledger in the accounting sense and keeps its job (U1).
8. The notify outbox dedups on a key string; `comingDueBatchKey` carries item keys inside a batch
   key so a set is announced once. `NotificationEventDef` has `audience`, `trigger`
   (`daily_slot | weekly_slot | tick | immediate`), `defaultEnabled`, `householdEligible`.
9. Import CSV parsing (`src/lib/import/parse.ts`) detects `dateOrder` and offers
   `closingBalancesByDate`; header detection scores column names. Reusable for a statement CSV.
10. Guards in `tests/ops/loan-invariants.test.ts`: G1 (rate arithmetic only in `interest.ts` and the
    form boundary), G2 (engine pure: no DB, no clock, no direction literal), G3 (balance writers are
    the known five plus `setLoanAnchor`; interest never reaches a category, budget or transaction),
    G4 (no stale "display only" copy). P4: `loans.ts` never spells `'lent'`.

---

## 3. Defaults and the form (D1–D6)

**D1.** A rate cannot be saved without a basis. The select loses its "Not set" option when the rate
field is non-empty and defaults to `apr_monthly` ("Yearly rate, one twelfth charged each month").
Validation in `assertInterestBasisIsUsable` becomes: rate present ⇒ basis present.

**D2.** Existing loans with a rate and no basis are **not** assumed. Migration leaves them null. The
loan page shows a banner above the balance card: "This loan has a rate but no charging method. Pick
one to see interest." with a link to Edit. `listLoans` exposes `needsBasis: boolean` so the Loans card
and dashboard can show a small count.

**D3.** New loan form: the balance field becomes **"Balance as of"** with a date. Default date =
borrowed date when the balance field is empty or equals the original amount; otherwise today.
Submitting writes the loan's first anchor (`source: 'form'`, `asOfDate` = that date, rate and basis
snapshotted). This is the anchor v1.47.0 promised and never wrote.

**D4.** Edit form: the balance field is read-only once an anchor exists, with the text "Set by your
last statement of {date}. Reconcile to change it." Changing a balance by hand is what
reconciliation is for; two paths to the same number is how they disagree.

**D5.** "You set this on {date}" reads the newest anchor's `as_of_date`. `balance_updated_at` keeps
being written for MUST-11.8 but is no longer displayed as a date.

**D6.** Posting day (C1) is shown on the Edit form as "Interest posts on day __ of the month",
prefilled from the borrowed date, editable 1–31.

## 4. The posting cycle (C1–C4)

**C1.** A period runs from one posting day to the next. Posting day defaults to the borrowed date's
day-of-month; a day past the month's end clamps to month end (borrowed the 31st posts on Feb 28/29,
Apr 30, and so on). Stored in `warranty_items.posting_day` (1–31, nullable; null means "use the
borrowed date's day").

**C2.** The first period starts on the loan's **start point**: the newest anchor's `as_of_date`
(which, for a form-created loan, is the borrowed date by D3). No pro-rating of a first partial
period is needed when the start point is the borrowed date. When a statement anchor lands
mid-period, the period it lands in restarts from the anchor date and runs to the next posting day;
that one short period is pro-rated by days (A5).

**C3.** A period whose end is on or before today is **closed** and gets a posting row (P1). The
period containing today is **open**; its interest is "accrued so far" and never stored.

**C4.** Posting date = the period's end date. Nothing waits for 02:00: a period that ended yesterday
posts on the next call to `postDueInterest`, whichever caller gets there first (P4).

## 5. Accrual (A1–A8)

**A1.** Interest accrues **daily on the actual balance**. The balance on a day is the balance after
every movement dated that day (a payment counts from the day it lands).

**A2.** For the monthly-posting bases the period's charge is

    charge = periodicRate × averageDailyBalance(period)

where `averageDailyBalance = Σ(daily balances) / daysInPeriod`. Periodic rates:

| basis | periodic rate |
|---|---|
| `apr_monthly` | bps / 12 |
| `apr_semiannual` | (1 + bps/2)^(1/6) − 1 |
| `per_month` | bps |
| `simple_on_principal` | bps / 12, applied to the **original amount**, balance ignored |
| `none` | 0 — a $0.00 posting row is still written so the ledger reads like a statement |

**A3.** An unchanged balance therefore reproduces every pinned figure in §2.1 exactly.

**A4.** `apr_daily` keeps its daily walk with daily compounding; the period's posting is the sum of
the daily charges. Year = 365 (unchanged).

**A5.** Accrued so far in the open period = `periodicRate × Σ(daily balances so far) / daysInPeriod`
— the same formula, cut off at today. "So far" counts the days from `period_start` up to but not
including today (today is not over). A pro-rated short period (C2) is the same formula over its own
day count.

**A6.** Rounding: once per posting, to cents, using the existing `chargeCents` rounding. Daily figures
are kept in integer ppb-cents inside the engine and never rounded individually.

**A7.** Direction: the engine works in the loan's frame (a magnitude) exactly as today. `lent` loans
get the same ledger with the wording "interest earned" / "they paid" (U6). `loanSignedDelta` remains
the one place the direction lives.

**A8.** Worked example, pinned as a test. $10,000 at 10% `apr_monthly`, borrowed 2026-07-01, today
2026-09-18, no payments:

| date | row | interest | balance |
|---|---|---|---|
| 2026-07-01 | Opening | | 10,000.00 |
| 2026-08-01 | Interest posted (Jul 1 – Aug 1) | 83.33 | 10,083.33 |
| 2026-09-01 | Interest posted (Aug 1 – Sep 1) | 84.03 | 10,167.36 |
| 2026-09-18 | Accrued so far (17 of 30 days: Sep 1 through Sep 17) | 48.01 | owing today 10,215.37 |

Same loan, $5,000 paid 2026-07-15: first period ADB = (14 × 10,000 + 17 × 5,000) / 31 = 7,258.06;
posting on Aug 1 = **60.48**, balance 5,060.48.

## 6. Posted interest rows are facts (P1–P7)

**P1.** New table `loan_postings`:

| column | meaning |
|---|---|
| `id` | pk |
| `item_id` | fk `warranty_items`, cascade |
| `period_start`, `period_end` | ISO dates; `period_end` is the posting date |
| `opening_cents` | balance at `period_start` after that day's movements |
| `interest_cents` | the charge (A2/A4) |
| `payments_cents`, `advances_cents` | movements inside the period, magnitudes |
| `closing_cents` | opening + interest − payments + advances |
| `rate_bps`, `basis` | the rate in force for the period (R1) |
| `average_daily_balance_cents` | what the charge was computed on; shown on hover |
| `created_at`, `created_by_user_id` | null user = the scheduler |

Plus `kind` in `('posting', 'adjustment')` and a nullable `note`. Partial unique index on
(`item_id`, `period_end`) **where `kind = 'posting'`**; adjustments (K2) are not unique, several may
land on one day. Append-only: nothing updates or deletes a row (K3 reverses with a new row).

**P2.** `postDueInterest(itemId, today)` in `src/lib/loans.ts`: loads the facts, calls the pure engine
(§7) to find closed periods with no posting row, inserts them oldest first, then calls
`recomputeBalance`. Idempotent: a second call the same day inserts nothing.

**P3.** `postAllDueInterest(today)`: every loan with a basis. Runs inside `runNightlyTick` **before**
the backup so the backup contains the night's postings, and inside `runNotifyTick` at boot
(`atBoot: true`) so a machine that was off catches up within five minutes of starting. Both
call sites catch and log; a posting failure never blocks a backup.

**P4.** Also called synchronously on: loan create (D3), payment link/unlink (`assignTransactionToLoan`,
`unassignTransactionFromLoan`, `applyPaymentMatchers`, `reverseLoanLinksForTransactions`), rate
change (R2), reconcile (`setLoanAnchor`). So the owner's Test loan shows Aug 1 and Sep 1 the moment it
is saved.

**P5.** `current_balance_cents` becomes the **posted balance**: newest anchor → replay postings and
movements after it. `recomputeBalance` is the only writer, as now. Owing today (P6) is never stored.

**P6.** Three figures, named consistently everywhere: **Balance** (posted), **Accrued so far** (open
period, A5), **Owing today** = Balance + Accrued so far. Dashboard, net worth and Loans card use
Owing today (as `loansTotalOwedCents` already does).

**P7.** A statement anchor closes the open period at its own date (C2) and is compared against the
posted-and-accrued figure at that date; `app_balance_cents` and `difference_cents` on the anchor row
keep their meaning.

## 7. Corrections, never rewrites (K1–K5)

**K1.** A movement whose transaction date falls inside a **closed** period (after the newest anchor,
on or before the newest posting) does not reopen it. The engine recomputes the truth from the anchor
forward and compares it to the stored postings' closing balance.

**K2.** The difference is written as one **adjustment** row in `loan_postings` with
`period_start = period_end = today`, `interest_cents` = the interest delta (signed), and a `note`
column: "Payment of $X dated {txnDate} recorded after the {postingDate} posting." Multiple late
movements on one day fold into one adjustment. Ledger total after the adjustment equals the
recomputed truth to the cent.

**K3.** Undo of a late movement that already produced an adjustment: a second adjustment row reverses
it. Nothing is deleted; MUST-13.16 (one place deletes a transaction) is untouched.

**K4.** A movement dated on or before the newest **anchor** stays behind the wall and is zeroed, as
today: the statement is the truth for its own date. The ledger shows it greyed with "Before your
statement of {date}; not applied."

**K5.** A rate change with an effective date inside a closed period is handled the same way: the
interest delta for the affected closed periods becomes one adjustment row.

## 8. Rate history (R1–R3)

**R1.** New table `loan_rate_history` (`item_id`, `effective_from`, `rate_bps`, `basis`,
`created_at`, `created_by_user_id`). The engine picks the rate in force for each day. Migration
backfills one row per loan with a basis, `effective_from` = the newest anchor's date.

**R2.** Changing the rate or basis on the Edit form asks "Effective from" (default today). Saving
inserts a history row and calls `postDueInterest`. `warranty_items.interest_rate_bps` and
`interest_rate_basis` keep holding the **current** values so every existing reader stays correct.

**R3.** The anchor snapshot columns stay; they are what "the app estimated this period at X% and the
statement said Y" needs.

## 9. Ledger UI (U1–U8)

**U1.** New card **Ledger** on the loan page, above "Linked transactions", which keeps its job as the
link list.

**U2.** Rows, oldest first: Opening · Advance · Payment · Interest posted · Statement · Adjustment ·
Accrued so far (last, italic, never stored). Columns: Date · Description · Payment · Interest ·
Principal · Balance.

**U3.** A Payment row shows the payment in Payment, the accrued-to-that-day figure in Interest (grey,
"accrued"), and the Balance after it. The split of the period's payments into interest and principal
is stated on the **Interest posted** row's description: "Of $X paid this period, $Y covered interest."

**U4.** Header figures on the card: Balance · Accrued so far · Owing today · Interest this period ·
Interest paid to date · Principal paid to date · A year at this balance. Existing
`LoanInterestCard` is folded into this card; its month table goes.

**U5.** Toggle "By month" collapses to one row per posting period (opening, interest, payments,
closing). Default off.

**U6.** Wording by direction via `INTEREST_WORDING`: owed → "Interest posted", "You paid"; lent →
"Interest earned", "They paid".

**U7.** "Download CSV" on the card: the visible rows, with a BOM, same helper the Transactions export
uses. Print stylesheet hides everything but the table.

**U8.** Hover on an Interest posted row shows the rate, basis, average daily balance and day count
used, so a figure can be checked by hand.

## 10. Notifications (N1–N9)

New events in `NOTIFICATION_EVENTS`, all `audience: 'all'`, all `householdEligible: true` unless
noted. Wording is fixed here so the settings page and the message agree.

| id | label | trigger | default | when |
|---|---|---|---|---|
| `loan_interest_posted` | Interest was added to a loan | `tick` | on | after any posting; one message per tick listing every loan that posted (N2) |
| `loan_payment_missed` | No payment on a loan this period | `daily_slot` | on | posting day passed, no payment dated inside the period, basis set (N3) |
| `loan_reconcile_due` | Time to check a loan against its statement | `daily_slot` | off | newest anchor older than 2 months, loan has a basis; once a month (N4) |
| `loan_paid_off` | A loan is paid off | `immediate` | on | posted balance reaches 0 (N5) |
| `goal_reached` | You reached a savings goal | `tick` | on | `pace.met` flips to true; once per goal (N6) |
| `goal_off_pace` | A savings goal is behind pace | `daily_slot` | off | `requiredMonthlyCents > avgMonthlyCents × 1.25`, target date set; once a month per goal (N6) |

**N1.** `coming_due` gains a **third source**: detected recurring charges whose next expected date
(last date + cadence) falls inside the user's `coming_due_days` window and which are **not**
`tracked` (a tracked one is already a bill item and already covered). Line: "{Merchant} usually
charges about $X around {date}." Same batch key, same cap, same announced-once rule. Blurb updated.

**N2.** `loan_interest_posted` is raised by `postAllDueInterest` and by the synchronous callers in P4
when a posting was actually inserted. Key `loan:posted:{itemId}:{periodEnd}` inside a batch key, one
message: "Interest added: Car loan $84.03 (balance $10,167.36) · Mortgage $1,237.12 (…)". Recipient:
the item's `owner_user_id`, plus the household channel when eligible (same rule as `coming_due`).
Adjustment rows notify under the same event with "Adjusted" wording.

**N3.** `loan_payment_missed` evaluates in the daily slot: for each loan with a basis whose most
recent posting's period has no linked payment and whose posting day is past, one line. Owed:
"No payment was recorded on {name} for {period}." Lent: "{Name}: nothing received for {period}."
Key `loan:missed:{itemId}:{periodEnd}`. Interest-free loans with `none` are included (a personal
loan the owner lent is the point of this event).

**N4.** `loan_reconcile_due` reads the existing `stale` flag. Key `loan:stale:{itemId}:{YYYY-MM}`.

**N5.** `loan_paid_off` is raised from `recomputeBalance` when the posted balance goes from >0 to 0
and the open period's accrued is 0 or the basis is `none`. Key `loan:paidoff:{itemId}`. Never
re-raised unless the balance leaves 0 and returns.

**N6.** Goal events read `listGoals` for the goal's owner (or household when `ownerUserId` is null).
Keys `goal:met:{goalId}` and `goal:pace:{goalId}:{YYYY-MM}`.

**N7.** Every new evaluator lives in `src/lib/notify/evaluate/loans.ts` and `…/goals.ts`, registered
in `runScheduledEvaluation` in the per-user daily loop (slot events) and the tick section (tick
events), following `evaluateComingDue` for shape and MUST-6.13's cap.

**N8.** Settings → Notifications lists the six new events in a new group **Loans and goals**; the
existing `coming_due` blurb mentions recurring charges.

**N9.** Telegram and email renderers in `src/lib/notify/render.ts` get one template per new event.
No new channel.

## 11. Statement intake: CSV, and keeping the file (S1–S6)

**S1.** CSV upload on the reconcile form goes to the same route as PDF. The route sniffs the type;
for CSV it runs the import parser's header detection to find date, balance and (optional) interest
columns, takes the **chronologically last** row's balance and date, and returns them as candidates
with `prefilledFrom: 'csv'`. Confidence per column comes from the parser's own header score.

**S2.** When any of date or balance is undetected, or the person clicks "Wrong column?", the form
shows a **column picker**: the CSV's header row as three selects (Date · Balance · Interest, the last
optional), a five-row preview, and the resulting figures updating live. Nothing is saved until the
reconcile button.

**S3.** The confirmed mapping is stored per loan in `warranty_items.statement_csv_columns` (JSON:
`{date, balance, interest?}` header names) and used first next time. Wrong headers next month simply
fall back to detection then the picker.

**S4.** **Keep the statement.** Both PDF and CSV uploads show a checkbox "Keep this statement with the
loan", **checked by default** (owner's choice, 2026-09-18). When checked, the reconcile action stores
the file as a `warranty_receipts` row (existing sha256 path, `mime` gains `text/csv`) and sets
`loan_anchors.receipt_id`. When unchecked, the scratch copy is deleted as now.

**S5.** The anchor history on the loan page links "Statement" on rows that have a receipt; the
receipts card shows it under the normal receipt list with the badge "Statement".

**S6.** The route stays a reader (interest spec S1): it never writes an anchor or a receipt. Storage
happens in `reconcileLoanAction` after the person confirms, by re-uploading the file in the same
form post.

## 12. Reports (G1–G3)

**G1.** `debtOverTime` is rebuilt from ledger segments: for each month end, the sum over loans of
the posted balance at that date plus accrued (the interest spec §15 deferral). Loans without a basis
contribute the stored balance replayed from anchors, as today.

**G2.** A new series on the debt chart, "of which interest", = cumulative posted interest across
loans. Off by default behind the existing series toggle pattern.

**G3.** Loans card on the dashboard shows Owing today and, in the caption, "+$X interest this month
across N loans".

## 13. Migration 0026 (M1–M4)

**M1.** `create table loan_postings` (P1, with a `note` column and a `kind` check in
`('posting','adjustment')`), `create table loan_rate_history` (R1), `alter table warranty_items add
column posting_day integer check (posting_day is null or posting_day between 1 and 31)`, `alter table
warranty_items add column statement_csv_columns text`.

**M2.** Backfill `loan_rate_history` from every loan with a basis (R1).

**M3.** Backfill `loan_postings` is done **in code**, not SQL: the first `postAllDueInterest` after
upgrade (boot, P3) posts every closed period since each loan's newest anchor. A migration cannot run
the engine. A test asserts a fresh upgrade of a fixture DB produces the expected rows and that a loan
without a basis produces none.

**M4.** Loans with a basis will therefore show a **different balance after upgrade** — the posted
interest since their last statement. That is the point, and the release note says so in one line.
Loans without a basis do not move.

## 14. Deliberately deferred

Scanned statement OCR; parsing statement transactions out of a PDF; per-lender templates; a rate on
a `credit` account; 30/360 and 366-day years; voiding an anchor or posting row; extra-payment and
refinance what-ifs; per-payment splits on the Transactions page; interest on arrears for
`simple_on_principal`; cash-runway notification (owner declined for this release).

## 15. Tests and guards (T1–T6)

**T1.** Engine pinned examples: §5 A8 both tables; every §2.1 figure unchanged; 31st-clamp posting
days across Feb/Apr; a mid-period anchor's pro-rated short period; `apr_daily` still $131.51 over 30
days from a period start.

**T2.** `postDueInterest` idempotence; catch-up after three missed months inserts three rows oldest
first; a loan without a basis inserts nothing.

**T3.** Corrections: late payment inside a closed period yields one adjustment row and a ledger total
equal to a from-scratch recomputation; its undo yields a reversing row; a movement behind the anchor
wall stays zeroed.

**T4.** Guards, updated in `tests/ops/loan-invariants.test.ts`: **G1** allows rate arithmetic in
`src/lib/loans/*.ts` engine files (the new `ledger.ts` joins `interest.ts`); **G2** applies to
`ledger.ts` too (no DB, no clock, no direction literal); **G3**'s writer list gains nothing —
`postDueInterest` writes `loan_postings` and calls `recomputeBalance`, it never writes
`current_balance_cents` itself — and a new case asserts that; **G4** adds the sentence "Leave unset to
keep the rate for reference only." to its stale-copy list.

**T5.** Notifications: each new event has an evaluator test (fires once, dedups, respects the cap,
respects the pref), a renderer snapshot for both channels, and a settings-page test that the six
appear under "Loans and goals".

**T6.** Form: rate without basis is rejected; new loan writes a `form` anchor dated as chosen;
"You set this on" shows the anchor date; edit balance is read-only once an anchor exists.

## 16. What was built differently, and why

Three rulings were reversed by the code or the tests while this was implemented. Each is recorded
where it happened as well as here.

**D4 reversed.** The spec said a loan's balance field should go read-only once it had a statement,
so that Reconcile became the only way to move it. The existing suite showed that would remove a
documented capability: editing a loan and typing a balance already wrote a fresh anchor, and
fix-wave item 4 had gone to trouble to make "untouched" mean untouched. The stated reason -- two
paths to one number -- stops applying once the edit path writes a proper statement row, which is
what it now does. The field stays editable and records a statement like any other.

**apr_daily does not compound inside a period.** The spec said daily compounding. The v1.47.0 pin
($20,000 at 8% costs $131.51 over thirty days) says otherwise, and that figure is one a household
may already have checked against a statement. Unpaid interest still compounds at the posting date,
which is where a lender compounds it. The pin won.

**A short period is pro-rated by its CYCLE, not by itself.** The spec's formula divided by the
period's own day count, which would have charged a full month's interest for the twelve days
between a mid-month statement and the next posting day. It divides by the length of the cycle the
fragment belongs to instead.

**Two things the spec deferred, and one it did not.** CSV statements are stored only as figures, not
as files: `warranty_receipts` is wired to an OCR queue, a thumbnailer and a type sniffer that
between them know four formats, and teaching all three about CSV to keep a file nothing reads back
was not worth it. A PDF is kept, which is the case the request described. The engine also falls back
to `warranty_items`' own rate columns when a loan has a basis and an empty rate history -- without
it, a database restored from an older backup would silently stop charging interest.

## 16a. What v1.49.0 changed about this design

The whole-app review after v1.48.0 (`docs/reviews/2026-09-19-v1.48.0-review.md`) found five things
this spec had settled the wrong way, or had not settled at all. Each is now the rule.

**The wall is `period_start`, not `period_end` (A1/A2).** A statement supersedes every period that
BEGAN before it. Filtering on the period's END meant a correction dated today -- whose own period
began last month -- survived a statement dated last week and was counted a second time on top of it.
An adjustment's `period_start` now names the period it corrects rather than the day it was found,
and migration 0027 backfills the rows v1.48.0 wrote the other way.

**`loan_postings.payments_cents` is APPLIED cents.** The figure a period records is what actually
came off the balance, after the cap, not the raw size of the transactions. The two differ whenever a
payment exceeded what was owed at that moment, and the ledger card was already showing the applied
figure -- so the column was the thing that disagreed.

**One balance rule, one walk.** The truth walk, the stored replay and the row builder were three
implementations of "apply a payment, capped at what is owed". They disagreed by a cent or two, and
the difference was then written down as an interest adjustment: a loan could report $0.00 on its
card, $2.03 on its ledger, and announce itself paid off, all at once. They share one `walkPeriods`
now, and `recomputeBalance` interleaves payments and postings in one chronological pass rather than
adding every posted figure before the payments are seen.

**D4 stays reversed.** The decision recorded at §16 stands.

**The hero is Owing today, and the balance MetricCard is gone** for a loan that has a ledger (owner
ruling, 2026-09-19). v1.48.0 printed four balances for one loan across two cards; there is one
number that answers "what do I owe", and the parts sit under it as arithmetic.

**The page is "Loans & Coverage"** (owner ruling, 2026-09-19). The nav entry, the page title, the
back link, the dashboard card and the transactions row menu had five different names for one
destination, none of which contained the word "loan".

## 17. Open questions

- Should `loan_payment_missed` fire for a loan whose term has ended (payoff date in the past)? Plan
  assumes **no**: a finished term with a balance is already "overdue", a different message. Not built.
- Posting-day edit on a loan with postings: apply from the next period only. Plan assumes yes.
