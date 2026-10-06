# An Insights page, and merchants the household marks as recurring

Date: 2026-10-05
Status: approved, not yet implemented
Release: v1.54.0

## 1. What was found

The moment this feature is for: a payment card is replaced, and the household needs the list of
merchants that bill that card so each one can be given the new number. A second, quieter need:
knowing whether something is charging an account on a rhythm that nobody set up on purpose.

What the app has today, and where it falls short of those two needs:

1. **"Recurring charges" exists but lives on Loans & Coverage** (`RecurringChargesCard`, rendered
   from `warranties-client.tsx`). Nobody looks under loans for "who bills my card".
2. **It groups by merchant only.** `RecurringChargeRow` carries merchant, cadence, counts, typical
   amount, last date and a `tracked` cover, but **no account**. The card-replacement question
   cannot be asked.
3. **It needs three charges** (`RECURRING_MIN_CHARGES = 3`, every gap inside the monthly or yearly
   band, newest within the band plus `RECURRING_STALE_GRACE_DAYS`). With two or three months of
   imported history most merchants have two charges, so the card is blank and looks broken. It is
   working as designed; it is useless for the first quarter.
4. **The household has no way to say "this merchant bills me"**. The only action is Track, which
   creates a full item with billing dates and reminders. That is right for a subscription worth
   following and too heavy for "put it on the list".
5. **"Needs a look"** (`NeedsALookCard`, `src/lib/insights.ts`) is the other insight surface. It
   sits on the Dashboard capped at `INSIGHTS_MAX_ROWS`, with no page that shows the rest.

## 2. Decisions

### 2.1 An Insights page

New route `/insights`, nav entry "Insights" in the `planning` group, placed directly after
Reports. It holds, top to bottom:

1. **Recurring charges** (sections 2.2 to 2.4), moved here from Loans & Coverage.
2. **Needs a look**, the full list rather than the Dashboard's capped one, with the same per-row
   dismiss that exists today.
3. Room for later tips. Nothing speculative is built now.

The Dashboard keeps `NeedsALookCard` as a summary and gains an "All insights" link to the page.
Loans & Coverage drops `RecurringChargesCard` and shows one line in its place linking to
`/insights` ("Recurring charges moved to Insights"). `recurringLoad` (the total of tracked
recurring items) is a different read model and stays where it is.

### 2.2 Marks are rules on the merchant, not flags on the row

Two new kinds on the existing rules table: `recurring` and `not_recurring`. They match the
normalised merchant exactly, the way `not_transfer` does (`matchRule(normalizedMerchant,
'not_transfer', ctx.rules)` in `categorize/engine.ts`). No column is added to `transactions`;
a recurring charge is a fact about the merchant, and a rule already is the app's way of recording
a fact about a merchant that outlives one row.

`drizzle/0000_init.sql` declares `rule_kind` as text with no CHECK, so widening the Drizzle enum
needs no migration. The planner must confirm this against any guard test that enumerates rule
kinds, and must decide what `merchant_rule_merges.dropped_rule_kind` (deliberately not widened in
the past) does when a merchant with a `recurring` rule is merged: the plan states the behaviour
and tests it.

**Where a mark is set.** On the Transactions page, next to the transfer controls: a row action
("Mark recurring" / "Not recurring", reflecting the merchant's current mark) following
`setRowTransferAction`, and a bulk action following `bulkTransferAction`. Setting one kind removes
the other for that merchant. Marks also appear wherever the existing rules manager lists rules by
kind; the planner checks that surface renders the new kinds sensibly (label and delete).

### 2.3 Two tiers on the Recurring charges card

| Tier | Membership | Row shows |
|---|---|---|
| **Known recurring** | merchant has a `recurring` rule, OR `tracked` is non-null (an item or a payment rule covers it) | merchant, "marked" or the detected cadence when there is one, typical amount if at least 2 charges, last charge, accounts, actions |
| **Looks recurring** | rhythm detected by `recurringCharges` AND not Known AND no `not_recurring` rule | merchant, cadence, typical amount, last charge, accounts, actions |

Actions per row: **Mark recurring** (Looks tier), **Not recurring** (Looks tier; stores the rule,
so the row stays gone), **Unmark** (Known tier when the membership is a `recurring` rule), and the
existing **Track**. A merchant with a `not_recurring` rule appears in neither tier; it is undone
from the Transactions row action or the rules manager.

A Known merchant with fewer than `RECURRING_MIN_CHARGES` charges still appears: the household's
word is the evidence. Its typical amount is the median of whatever charges exist, or an em dash
with one.

**Forming rhythms.** Below the Looks tier (or as its empty state), one sentence computed from
the ledger: merchants with exactly `RECURRING_MIN_CHARGES - 1` charges whose gaps sit in a band
and whose newest charge is fresh. "4 merchants have charged twice about a month apart. One more
charge and they appear here." Zero means the sentence is omitted and the existing empty state
stands. This is what tells a new household the card is alive.

### 2.4 Accounts on every row, and an account filter

Each row lists the accounts the merchant charged inside the detection window, newest first, by
account name. A merchant that bills two accounts shows both. An **Account** select above the card
(all accounts the viewer can see, plus "All accounts") filters both tiers to rows that include that
account. The filter is a URL search param, so the filtered page can be bookmarked or sent to the
other person in the household; it carries the same person scope every other link carries
(the rule `transactionsHref` already enforces). Nothing about the filter is stored.

Filtering Known recurring by the account whose card was replaced is the card-replacement list.

### 2.5 Wording

The rule written on `RecurringChargesCard` stands and extends to the Known tier: every string
describes what was measured or what the household said. "Known recurring" is "you marked it, or
you track it"; "Looks recurring" is "a rhythm, which is not a verdict". No "subscription",
"wasted", "forgotten" or "cancel" anywhere on the page.

### 2.6 Help and release notes

A Help section for Insights: what each tier means, how to mark and unmark, the account filter and
the card-replacement use, why a new ledger shows nothing for a few months and what the forming
sentence means. CHANGELOG 1.54.0 entry under Added.

## 3. Where the parts live

| Concern | Location |
|---|---|
| Page and nav | `src/app/(app)/insights/page.tsx` (new), `insights-client.tsx` (new), `src/components/app-shell/nav.ts` |
| Recurring read model | `src/lib/recurring.ts` (`RecurringChargeRow` gains `accounts`, a `known` discriminator and the mark source; a `formingRhythms` count), `src/lib/predict/anomalies.ts` only if the band helpers need exporting |
| Marks | `src/db/schema.ts` (enum), `src/lib/categorize/rules.ts` (write and clear helpers), `src/app/(app)/transactions/actions.ts` (row and bulk actions), `transactions-client.tsx` (controls) |
| Card | `src/components/warranty/RecurringChargesCard.tsx` moves to `src/components/insights/RecurringChargesCard.tsx` and gains tiers, accounts, actions, filter |
| Removed from | `src/app/(app)/warranties/page.tsx`, `warranties-client.tsx` |
| Dashboard link | `src/app/(app)/dashboard/page.tsx`, `src/components/NeedsALookCard.tsx` |
| Help, changelog | `src/app/(app)/help/content.tsx`, `CHANGELOG.md` |

## 4. Out of scope

A "card replaced" checklist with tick boxes (the filtered list is the checklist; ticks would need
storage); weekly or quarterly cadence detection; changing `RECURRING_MIN_CHARGES`; notifications
about recurring charges; a model that tells a subscription from a monthly shop.

## 5. Process

Opus orchestrates; Sonnet implements each task; one Opus review after the data-layer tasks
(read model, marks, actions) and one whole-branch review before release; otherwise the lean
rule: run only the touched test files while working, full suite once at the release gate.
