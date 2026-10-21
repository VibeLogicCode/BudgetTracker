# "Always ask" merchants, and uncategorized spending on Budgets

Date: 2026-10-21
Status: approved, not yet implemented
Release: v1.56.0
Depends on: v1.55.4 (a fully split row no longer counts as uncategorized; archived categories are
never auto-assigned)

## 1. What was found

1. **Some merchants should never be filed automatically.** E-transfers are the clearest case: the
   same description goes to different people for different reasons, so whatever the app learns
   from one is wrong for the next. Three things can file one today:
   - a learned rule (confirming a category in review mode learns an exact rule for the
     normalised text; the masked code after the asterisks often repeats per recipient);
   - the Bayes guesser, which learns from tokens every e-transfer shares;
   - a `contains` rule written on the Rules page.
   There is no way to tell the app "never do this for these rows".
2. **Budgets hides uncategorized spending.** `src/lib/budgets.ts` skips every row whose category
   is null (around :208, :353, :582). A month with many rows still to categorize reads as a month
   well under budget. The household looks at Budgets, sees a comfortable picture, and does not
   realise part of the month is missing from it.

## 2. Decisions

### 2.1 "Always ask": a merchant rule kind

A new rule kind `always_ask` on the existing rules table, beside `not_transfer`, `recurring` and
`not_recurring` (v1.54.0 established that rule kinds need no migration because `rule_kind` has no
CHECK; the planner re-confirms). It supports `exact` and `contains` matching like a category rule.

**Engine.** In `categorizeTransaction` (src/lib/categorize/engine.ts), after transfer detection
and BEFORE the category rule and the Bayes guess: if an enabled `always_ask` rule matches the
normalised merchant, return no category (`source: 'none'`). Transfer detection still runs first:
an always-ask row that is a transfer stays a transfer.

**No learning.** For a row matched by an `always_ask` rule:
- confirming its category in review mode (`confirmCategory` with `createRule: true`,
  `createRulesFromRow`, and any other rule writer the planner finds) saves the category but writes
  no category rule;
- the Bayes model is never trained on it (exclude matching rows when the model is built, or at
  whatever point training reads confirmed rows).

**Where it is set.**
- Transactions row menu: **Always ask for rows like this**. It opens a small dialog with the
  pattern prefilled and editable. The prefill is the normalised merchant with a trailing masked
  code removed (for example `E-TRANSFER ***AB1` becomes `E-TRANSFER`), match type `contains`
  preselected, and a live count: "Matches N transactions". The planner defines the trailing-code
  rule from the existing normaliser and tests it on invented examples.
- Rules page (the existing rules manager): the kind is listed, labelled "Always ask", and can be
  deleted or disabled. Creating one there is allowed if the rules form can offer the kind cleanly;
  otherwise the row menu is the only way in, as with recurring marks.
- When the mark is saved, the dialog offers **Send N matching rows back to review**. It counts
  and resets ONLY rows whose categorisation source is `rule` or `bayes`; rows set by hand and split
  rows are never touched. Sending back clears the category so the rows reappear in the review
  queue's uncategorized tab.

**No default.** The app does not ship an always-ask rule for e-transfers: a monthly e-transfer to
the same landlord is exactly what a rule handles well.

### 2.2 Uncategorized spending on Budgets

**A first card, before every category card:** "Not categorized yet".
- Money: the total of uncategorized SPENDING in the page's month and scope, using the same
  `SPEND_ROW_WHERE` the rest of the page uses, and the same person scope. Uncategorized means
  category null AND no split parts (v1.55.4's definition, reused, not re-derived).
- Count: "N transactions".
- One action: **Categorize**, linking to the review queue's uncategorized tab filtered to this
  month (and person, when scoped). If the queue cannot filter by month, the link goes to
  Transactions filtered to uncategorized for this month; the planner picks the one that exists.
- No limit, no progress bar, no percentage, no "on pace".
- **It must read as needing attention, not as one more category.** Use the app's existing warning
  tone (the token family the "Needs you" pill and warning notices already use), in both light and
  dark themes:
  - a warning-tinted card background or a warning border, visibly different from the white
    category cards;
  - an attention icon in the card's icon slot (reuse an existing warning or alert glyph from
    src/components/ui/icons.tsx, or add one in the same style);
  - a small "Needs attention" label in the slot where category cards show their percentage pill.
  Colour is never the only signal: the icon and the label carry the meaning for anyone who cannot
  see the tint.
- **Self-hiding:** absent when there is nothing uncategorized, like the app's other attention cards.

**The header line.** The summary line ("Household — spent $X of $Y budgeted · $X total spent")
gains `· $Z not categorized yet` in the warning tone when Z is above zero, so the top figure is
honest without scrolling. "Total spent" includes Z if it currently means all spending; if it means
categorized spending only, the planner says which and keeps the words true.

**Nothing else changes.** Category limits, rollups, on-pace figures and suggestions are untouched.
Uncategorized money is shown beside them, not folded into any category.

### 2.3 Wording

Plain and factual: "Not categorized yet", "Needs attention", "Always ask", "Matches N
transactions", "Send N back to review". No blame, no exclamation marks.

## 3. Out of scope

Default always-ask rules; splitting always-ask rows automatically; changing Bayes beyond excluding
always-ask rows from training; uncategorized cards on the Dashboard (the Dashboard already has the
review queue's own signals); re-filing rows a RULE put in an archived category (a v1.55.4
follow-up for the owner).

## 4. Process

One Opus agent writes the plan after reading the code, then builds with Sonnet implementers, lean:
touched test files only while working, an Opus review after the engine and data tasks and one over
the whole branch before release, full gate once at release.
