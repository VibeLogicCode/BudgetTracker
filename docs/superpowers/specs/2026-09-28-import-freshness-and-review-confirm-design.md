# Import freshness on the summaries, a per-account import cadence, and confirming a whole review view

Date: 2026-09-28
Status: approved, not yet implemented

Three small things a household on manual CSV imports asked for after living with v1.51.0. They share
one release because two of them are about the same fact (when was each account last imported) and
the third is the other half of a flow that already exists.

## 1. The problem, in three parts

**1.1 A summary does not say what it is built on.** The weekly and monthly digests fire on a clock.
Whether anyone imported that week is a separate question, and the message never answers it — a
"Household spend: $1,234" line built on data last imported three weeks ago reads exactly like one
built yesterday.

**1.2 One staleness number for every account is wrong for most of them.** `stale_import` nags when
an account has gone `staleImportWeeks` (household-wide, default 3) with no import. A household with
ten accounts on different rhythms — a chequing account imported weekly, a card monthly, a savings
account whose statement comes once a year — cannot set that one number correctly for all of them.
Either the yearly account nags forty-nine weeks a year, or the weekly one is allowed to go stale for
a month before anyone hears.

**1.3 Reviewing what the rules did is one click per category.** The dashboard's "Rules categorized
these on import" card sends the person to the Transactions page grouped by category, where each
group has **These are all correct**. For an import that landed in ten categories, that is ten dialogs
to say "yes" ten times. There is no way to say it once for the whole view.

## 2. Decisions

### 2.1 Where the freshness line goes — and where it does not

**On the weekly and monthly digests only.** Not on every money notification.

The reasoning that decides it: an alert such as "Unusual charge" or "Budget 80%" fires *because* a
transaction just landed — its data is fresh by construction, and a date on top adds nothing. A
digest fires on a clock whether anyone imported or not, so it is the one message where "built on
what?" is a live question. The line goes where the question exists.

**One line, date only, first in the body:**

```
Last import 2026-09-27.

Household spend: $1,284.55
…
```

No account names. Which accounts are *behind* is the reminder's job (§2.2), not the digest's — a
summary that also lists laggards is two messages in one envelope. When the household has never
imported anything the line is omitted; the digest's own "No transactions were recorded" already says
it.

**Ruling R2 applies.** A self-scoped recipient's line is the newest import among accounts they can
see (the same `ownerScope` rule `listAccounts` uses — joint accounts are not theirs). The family
channel's copy, rendered through `HOUSEHOLD_VIEWER`, is household-wide.

**It is a render input, not an `enqueue` side effect.** `renderEvent` is pure and the digest inputs
are typed unions; adding a required `lastImportIso: string | null` to the weekly (both variants) and
monthly inputs makes every call site a compiler-checked edit, keeps the renderer testable as a pure
function, and leaves the outbox alone. The earlier idea of prepending inside `enqueue()` for every
`money`-group event is withdrawn along with the wider scope it served.

### 2.2 A per-account import cadence, on the existing reminder

**Not a new notification type.** `stale_import` already exists — batched weekly, names every quiet
account with its last import date, has its own on/off switch, and is default-off. A new event id
would mean a migration on `notification_prefs`, a new default, and a second switch a household has
to find, for the same idea. The existing event learns to read a per-account threshold instead.

**One nullable column on `accounts`:** `expected_import_weeks integer`. Hand-written migration 0028.

| Stored | Select label | Meaning |
|---|---|---|
| `NULL` | Household default | Use `staleImportWeeks` from Settings → Notifications, exactly as today |
| `0` | Never remind me | Excluded from the reminder entirely |
| `2` | Weekly | Remind after 2 weeks with no import |
| `3` | Every two weeks | Remind after 3 weeks |
| `5` | Monthly | Remind after 5 weeks |
| `53` | Yearly | Remind after 53 weeks |

The stored number is the **threshold in weeks**, the same semantics `staleImportWeeks` has always
had, so the evaluator carries one rule: `threshold = account value ?? household value; 0 means never;
stale when days since last import ≥ threshold × 7`. The labels are what a person means; the numbers
carry one week of slack beyond the cadence named, so a statement that arrives a few days late does
not produce a reminder. Both the label list and the mapping live in one pure module
(`src/lib/import/cadence.ts`) so the accounts page, the action and the evaluator cannot disagree.

Existing installs behave exactly as today until someone sets a cadence: every account is `NULL`.

**How the system tells "no import" from "no transactions":** it never looks at transactions.
`commitImport` writes the `imports` row *before* counting rows, so a CSV that yields nothing new
still stamps the account as checked; SimpleFIN syncs go through the same function. An account with
no activity that somebody still imports is fresh. An account nobody looks at is what the reminder
names. Accounts that have never had an import (cash, assets) are never named — the existing
inner-join rule ("not stale, it is new") is unchanged.

**The reminder's wording adapts.** With one quiet account the subject keeps its current shape,
using that account's own threshold. With several — which may now have different thresholds — the
subject says `N accounts are overdue for an import`. Body lines are unchanged.

**Settings → Notifications** relabels its existing field as the default for accounts without their
own cadence, and points at Settings → Accounts.

### 2.3 Confirming every group in the review view

A view-level **Confirm every group** on the grouped-by-category Transactions view. It confirms every
transaction the current filter matches — every group, every group page, not only what is rendered —
to the category it already has, and marks each `categorization_source = 'manual'` so a future rule
run leaves it alone. Exactly what ten presses of the per-group button would do, in one.

Rules it inherits, and one it adds:

- **Same single confirm path.** It loops `confirmCategory` like `bulkSetCategory` does, in one DB
  transaction, with the same whole-batch rollback on a rule somebody else owns. `createRules: false`,
  for the reason the per-group action gives: confirming is not new information.
- **The set is derived from the posted filter, never from ids.** Same design as the group actions and
  for the same reason: the count the dialog states must be the count the write honours.
- **Rows with no category are left alone and counted**, because there is nothing to confirm. Rows
  already marked by hand are left alone and not counted. Split rows are skipped and reported, as
  everywhere else.
- **It is offered on the grouped view only**, above the groups, and only when at least one group on
  the page has a category. The per-group buttons stay.

## 3. Where the parts live

| Concern | Location |
| --- | --- |
| Cadence labels ↔ stored weeks, threshold rule | `src/lib/import/cadence.ts` (new, pure) |
| Column | `drizzle/0028_account_import_cadence.sql`, `src/db/schema.ts` (`accounts.expectedImportWeeks`) |
| Account write | `setAccountImportCadence` in `src/lib/accounts.ts` |
| Account form | `updateAccountAction` (`cadence` field) in `src/app/(app)/settings/accounts/actions.ts`; select in `accounts-manager.tsx`; row mapping in `page.tsx` |
| Per-account reminder | `src/lib/notify/evaluate/stale.ts`; `StaleAccountLine.weeks` and the batch subject in `src/lib/notify/render.ts` |
| Freshness read | `latestImportIso(viewer)` in `src/lib/import/freshness.ts` (new; listed in `REQUIRE_VIEWER`) |
| Freshness line | `lastImportIso` on the weekly/monthly render inputs; `freshnessLine()` in `render.ts`; supplied by `evaluate/digest.ts` and `evaluate/monthly.ts` |
| Confirm the view | `bulkConfirmOwnCategory` in `src/lib/transactions.ts`; `bulkConfirmViewAction` in `transactions/actions.ts`; button + `view-confirm-dialog` in `transactions-client.tsx` |
| Settings copy | `settings/notifications/notifications-client.tsx` (relabel), `src/lib/notify/events.ts` (stale blurb) |

## 4. Out of scope, deliberately

- A freshness line on alerts (see §2.1).
- A "show N dismissed" or per-merchant anything on the review flow.
- A cadence other than the six above. Two weeks was judged the shortest useful step; SimpleFIN
  accounts are synced nightly and a silent sync failure surfaces through the household default long
  before a "daily" option would add anything.
- Any change to when the digests fire or what else they contain.

## 5. Release

v1.52.0 — a migration and a new setting are user-visible changes, not patches. The Windows quick
start entry already sitting under Unreleased ships in the same release.
