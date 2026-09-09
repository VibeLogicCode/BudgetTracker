# Sending the spending summary on demand

Date: 2026-09-08
Status: approved, implemented

The weekly digest already existed and worked. What did not exist was any way to ask for it between
schedules. This adds one button, and is also the standing reference for how a manual send differs
from a scheduled one.

## 1. What it sends

**The same weekly digest**, via `evaluateWeeklyDigest`, not a new "spend right now" report. Two
reports that mostly agree is a maintenance trap and, worse, a household reading two different
numbers for the same week. The manual path is a parameter on the existing evaluator
(`ManualDigestSend`), never a second evaluator.

The window is the evaluator's own §10.2 window applied to *now* instead of to a scheduled slot:
`slotDate` is today in the household timezone, so the report covers the seven days ending yesterday.
Pressed on a Wednesday, it is last Wednesday to Tuesday — the same trailing week the scheduled digest
would have produced that day.

## 2. Where the parts live

| Concern | Location |
| --- | --- |
| Manual mode | `ManualDigestSend` + `evaluateWeeklyDigest` in `src/lib/notify/evaluate/digest.ts` |
| Routing opt-out | `skipHouseholdRouting` on `enqueue` in `src/lib/notify/outbox.ts` |
| Rate bucket | `checkManualDigest` in `src/lib/notify/ratelimit.ts` |
| Server action | `sendDigestNowAction` in `src/app/(app)/dashboard/actions.ts` |
| UI | `src/components/SendDigestNow.tsx`, mounted in the `PageHeader` actions row of `src/app/(app)/dashboard/page.tsx` |
| Tests | `tests/lib/notify/evaluate/digest-household.test.ts`, `tests/app/dashboard.test.tsx` |

## 3. The two things that make it work

Both are non-obvious, and each one silently breaks the feature if removed.

### 3.1 Dedup keys are slot-dated, so a manual send needs its own token

Every key the digest writes contains the slot date — `weeklyDigestKey(slotDate)` for the personal row,
`householdWeeklyDigestKey(mondayOfIsoWeek(slotDate))` for the family-channel row. A manual send in a
week whose scheduled digest has already gone out would collide with both and be discarded by
`notification_outbox_dedup_uq`. The person would get a button that does nothing, with no error.

So `ManualDigestSend.token` **replaces** the slot date in both keys. The action passes a
minute-precision stamp (`now.toISOString().slice(0, 16)`), which buys double-click idempotency for
free — a second press in the same minute writes nothing — while a genuine re-send minutes later still
goes out. That is also why a duplicate press reports success rather than an error: nothing failed, and
somebody pressing twice wanted one digest.

### 3.2 "Just me" must opt out of routing *inside `enqueue`*

`enqueue` decides household routing for itself, from `isHouseholdRouted(eventId, channel)`. It does
not consult whether the caller supplied a `household` body. On a routed channel it writes the
family-channel row — falling back to the **personal** subject and body if none was given — and
**suppresses the sender's own personal row** to make way for it.

So merely declining to build a household digest was not enough. The first cut of this change did
exactly that, and "Just me" then notified the family channel and *not* the person who pressed it —
the precise inverse of the button. `skipHouseholdRouting` skips that branch entirely: no family row on
any channel, and consequently no suppression of the sender's own copy.

It is the mirror of the existing `familyChannelOnly` (withhold the personal row, keep the household
one) and must not be confused with it. `familyChannelOnly` is set for a self-scoped *recipient* of a
household figure; this one is set by a person's explicit choice about one send, and never by a
scheduled evaluator — a scheduled digest must keep honouring the household's routing, or an admin's
setting would silently stop applying.

`includeHousehold` can only ever *remove* a household send, never add one. An unrouted household still
gets nothing, so this cannot become a way to push a message into a family channel nobody configured.

## 4. Guards

Order, matching every other action in the codebase: **origin → auth → validation → rate limit →
write**.

Validation runs *before* the limiter so a malformed press is free rather than costly.
The limiter runs *before* the evaluation because that evaluation is the expensive one on the page:
category breakdown, top merchants, budget progress, review count, and — for the household option — a
query per member.

`checkManualDigest`: **3 per user, 8 globally, per hour.** Tighter than the test-send bucket in what it
costs (a test send is one short message; this is the whole digest), looser in shape (nobody has reason
to press it four times in a row the way they do with Detect chat ID). The global cap exists for the
same reason the test send's does: Brevo's allowance and the bot are shared resources one enthusiastic
member can exhaust for everyone.

A **self-scoped member** may send their own summary but not address the household. Everywhere else in
the app they see only their own money (ruling R2); letting them notify the family channel here would
be the one screen that leaks out of that scope. The UI does not render the household option for them
at all — the action refuses it too, since that route is reachable directly, but a control that exists
only to say no explains less than its absence does.

## 5. The UI

A `RowDialog`, not a button that just sends. "Notify myself" and "notify everyone" are genuinely
different acts and the second puts a message in front of other people, so the choice is made
deliberately rather than discovered afterwards — RowDialog's own stated line for a page-level decision
with a consequence. "Safe" would be a reason for calmer copy inside the dialog, never for skipping it.

It lives in the dashboard header's actions row beside Add a transaction, not in Settings →
Notifications where the schedule is configured: this is a thing somebody wants to *do*, usually right
after looking at the numbers on this page. Settings is where you go once to pick a weekday.

The dialog closes on success only. A refusal keeps it open so its message is where the person is still
looking. The confirmation ("Summary sent to you and the household channel.") renders outside the
dialog, since the dialog is gone by then, and it names who got it because that was the question asked.

The action does **not** `revalidatePath('/dashboard')` — nothing the page renders changes, and a
revalidate would suggest otherwise.

## 6. Testing

`tests/lib/notify/evaluate/digest-household.test.ts` — chosen over `digest.test.ts` because the thing
most likely to be silently wrong is the dedup keys, and both are only visible together in that file's
fixtures:
- sends even when this week's scheduled digest already went out (with the no-op second *scheduled*
  evaluation asserted first, so the test cannot pass for a trivial reason)
- a double-press in the same minute collapses to one message; a later press sends again
- "just me" writes no family-channel row **and still delivers to the sender on every channel,
  telegram included** — asserted by channel name, so the suppression bug can fail it again
- "everyone" writes a family row on a key the week's scheduled one cannot collapse
- `includeHousehold` cannot conjure a send for an unrouted household

`tests/app/dashboard.test.tsx`:
- the control renders in the header
- the action reports which scope it sent to
- an unrecognised scope is refused *and consumes no rate-limit token*
- a self-scoped member is refused the household scope, keeps their own, and is never shown the option
- repeated presses are rate-limited with a retry time
- a cross-origin post is refused first
