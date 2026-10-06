# A page for recurring charges, a summary on Insights, and expected charges in Coming up

Date: 2026-10-06
Status: approved, not yet implemented
Release: v1.55.0
Builds on: 2026-10-05-insights-page-and-recurring-marks-design.md (v1.54.0)

## 1. What was found after v1.54.0 shipped

1. **The Recurring charges card will outgrow the Insights page.** A household typically has 15 to
   40 merchants on a rhythm. v1.54.0 caps Looks recurring at `RECURRING_MAX_ROWS = 12` and Known
   recurring not at all, so the card either truncates silently or pushes Needs a look off screen.
2. **The forming sentence counts merchants but lists none**, so a household with a short ledger
   (two months of statements, 11 merchants forming) sees a blank card with nothing to act on.
3. **The Transactions row menu offers both "Mark recurring" and "Not recurring"** whatever the
   merchant's state. The household expects a toggle, like the transfer control.
4. **The card-replacement case needs a "late" signal.** The app cannot see card numbers: an old
   and a new card on the same account import as the same account. What it can see is an expected
   charge that did not arrive. Today a Known merchant whose rhythm breaks drops off the list about
   45 days after its last charge, which hides exactly the merchant that failed to bill the new card.
5. **The bulk Mark recurring counts transfer rows**, so "Marked N merchants" overstates.
6. **Known recurring merchants are invisible on the Dashboard.** Coming up shows tracked bills
   only; a marked phone bill on autopay never appears there.

## 2. Decisions

### 2.1 The Insights card becomes a summary

The Recurring charges card on `/insights` stops listing rows. It shows, per tier:

| Tier | Line |
|---|---|
| Known recurring | `N merchants · about $X a month`, plus `· K late` when any are late, the late count linking to the page filtered to late rows |
| Looks recurring | `N to review` |
| Forming | `N one more charge from a rhythm` |

A button **See all recurring charges** links to `/insights/recurring`, carrying the person scope.
Tiers with zero are still shown with 0, so the household sees the card is alive. The account
filter moves off the card to the page.

**The monthly figure is Known only.** Looks includes once-a-month shops; adding them to a
recurring total would overstate fixed costs. Monthly equivalent: a monthly merchant counts its
typical (median) amount; a yearly one counts typical / 12. A Known merchant without a detected
cadence (one charge, or irregular gaps) is counted in N but not in $X. The line says "about"
because typical is a median.

### 2.2 The full page: `/insights/recurring`

A server page under the Insights route (no new nav entry; the Insights nav item stays active).
Laid out like Transactions: a table on wide screens, stacked rows (the existing `ListRow`
pattern) on a phone. One row per merchant, every tier, **no row cap**.

Columns: merchant; tier tag (Known, Looks, Forming); rhythm (monthly, yearly, or "marked" when
none detected); typical amount; monthly equivalent; last charge; next expected (§2.3); accounts;
tags (late, price went up); actions.

Controls (URL search params, nothing stored, person scope preserved as `transactionsHref` does):
- **Account**: options are the distinct accounts on the listed rows (v1.54.0 owner ruling 1
  stands), plus All accounts.
- **Show**: All, Known, Looks, Forming, Late.
- **Sort**: monthly amount (default, high to low), next expected (soonest first, late first),
  last charge (newest first), merchant (A to Z).

Row actions, by state:
- Looks or Forming: **Mark recurring**, **Not recurring**, and **Track** when not tracked.
- Known by a mark: **Unmark**, and **Track** when not tracked.
- Known by tracking only: **Mark recurring** (so it survives if tracking is removed) and a link to
  the item.

The forming merchants that v1.54.0 only counted are listed here as Forming rows.

### 2.3 Next expected, and "late"

For any merchant with a detected cadence band: `next expected = last charge + median gap`. A
**Known** merchant is **late** when today is past next expected by more than a grace of 7 days
(new constant `RECURRING_LATE_GRACE_DAYS`, beside the existing recurring constants). A late row
reads `expected Oct 12, nothing since`. Measured fact, no verdict.

**Known merchants never drop off.** A Known row (marked, or tracked) stays listed whether or not
its rhythm still holds; the late tag replaces the stale cut-off for them. Looks rows keep the
existing stale rule, since an unmarked rhythm that stopped is just history.

Late is computed only for Known rows: a Looks row that stops arriving simply leaves Looks.

### 2.4 Price went up

Rows whose merchant has a creep finding (the `creepVerdict` already run for Needs a look) carry
`up from $A to $B`. Reuse the existing computation; no new detection.

### 2.5 Transactions row menu: a toggle

- Merchant unmarked: **Mark recurring**.
- Merchant marked recurring: **Unmark recurring**.
- Merchant has a `not_recurring` rule: **Clear "not recurring"** (and no Mark item until cleared).

"Not recurring" is set from the Insights page only. The bulk bar keeps **Mark recurring** and
**skips transfer rows** before resolving merchants, so the count is the merchants actually marked.

### 2.6 Known recurring in the Dashboard's Coming up card

Coming up (`ComingUpCard`, fed by `UpcomingBill` rows from `src/lib/bills.ts`) gains **expected
recurring charges**:

- Source: Known merchants **by mark only**. A tracked merchant already appears through its
  item's bill rows; adding it again would double it.
- A row appears when its next expected date falls inside the card's existing 30-day lookahead,
  or when it is late within the existing overdue cutoff (`COMING_UP_OVERDUE_DAYS`).
- The row is tagged **Expected**, its amount reads `about $X`, and it has **no Record payment
  button** (it is not an installment). It links to `/insights/recurring` filtered to that account,
  or to the merchant's transactions.
- **Expected rows are excluded from every total**: the card header's total, the footer's "bills
  still to come" figure, and `safeToSpend`'s `billsDueCents`. A recurring charge is usually
  already inside a category budget; subtracting it again would double-count it. The card adds one
  line under the list when any expected rows are shown: `Expected charges are estimates from
  past charges and are not in the totals above.`
- Ordering and the `COMING_UP_ROW_LIMIT = 8` cap apply across both kinds; on the same date a bill
  sorts before an expected charge.
- The self-hiding rule stands: expected rows alone are enough to show the card.

### 2.7 Wording

The v1.54.0 rule stands for every new string: what was measured or what the household said. No
"subscription", "wasted", "forgotten", "cancel", and no "missed payment" (the app cannot know a
payment was missed, only that a charge has not arrived).

### 2.8 Help and release notes

Help: the Insights section gains the full page, late, next expected and price tags, and how to
use the account filter plus late after a card replacement. The Dashboard help gains the Expected
rows in Coming up and why they are not in the totals. CHANGELOG 1.55.0.

## 3. Out of scope

Telegram or digest alerts for late charges (deferred by the owner); weekly or quarterly cadence;
changing `RECURRING_MIN_CHARGES`; any change to safe-to-spend beyond keeping expected rows out of
it; editing a recurring estimate's amount.

## 4. Process

One Opus agent writes the plan from this spec after reading the code, then orchestrates the build
with Sonnet implementers, lean: touched test files only while working, an Opus review after the
data-layer tasks and one over the whole branch before release, full gate once at release.
