<!--
  HOW TO KEEP THIS FILE

  Every update session does two things, together, in the same change:
    1. bump "version" in package.json (that field is the single source of truth), and
    2. move the Unreleased notes below into a new dated section for that version.

  install/update.sh and install/update.ps1 both print package.json's version before and
  after an update, Settings -> About shows it next to this file's contents, and
  /api/health reports it — so a bump with no entry here is immediately visible as a gap.

  Format follows Keep a Changelog (https://keepachangelog.com/en/1.1.0/) and the version
  numbers follow Semantic Versioning. Keep the group headings to the standard set:
  Added, Changed, Deprecated, Removed, Fixed, Security. Leave the Unreleased section in
  place (empty is fine) so the next session has somewhere to write.
-->

# Changelog

All notable changes to Budget Tracker are recorded here.

## Unreleased

## [1.22.0] - 2026-08-31

No migration.

### Added

- **A Canadian merchant rules pack**, importable from Settings → Merchant rules. 190 rules: 174
  categorizations for merchants that sell one kind of thing — fuel, coffee, groceries, a phone
  plan, a hydro bill, a transit fare — and 16 name cleanups for the big retailers. Every category
  it names is one you already have, so importing creates nothing new. The multi-category stores get
  a tidier name and deliberately no category, because how a household splits a warehouse-club trip
  is not something a pack can know.
- **Rule packs can carry merchant renames.** Importing applies them to transactions you already
  have. Exporting them is off by default and shows you the exact text first — a rename is
  something you typed, and it often names a person.

### Changed

- **The rules export preview shows what a rename would say**, not just which merchant it matches,
  so nothing leaves without being read first.

## [1.21.0] - 2026-08-31

One migration (0016), which tidies merchant rules — see Fixed. It merges rules that differ only
in letter case, keeping the one with the most use and recording what it dropped.

### Added

- **Merchant rules have their own page**, at Settings → Merchant rules. Search, filter by kind,
  paging, and multi-select, because a list that grows every time you confirm a category is a
  dataset, not a setting. Deleting rename rules in bulk tells you how many *transactions* change,
  not how many rules.
- **A rule can be disabled instead of deleted**, and re-run over transactions you already have —
  per rule, or all of them at once. Both show what they will change before they change it, and
  neither can overwrite a category you set by hand.
- **Rules that do nothing are findable.** The page shows how many transactions each rule affects
  right now, and flags an exact rule that a broader one already covers.
- **Budgets picks a scope.** Pills at the top choose household or a person, so the page is one
  grid instead of one per person. The totals stay visible whichever you pick.
- **A loan whose balance drifted can be recomputed** from its own payments, from the loan's page.

### Changed

- **The cashflow chart is two charts.** Income and spend with net on one axis, cumulative saved
  below on its own — the old card carried five series on two axes with three of them the same
  colour. It no longer plots months from before you had any transactions, and no longer draws a
  target line when no target is set.

### Fixed

- **Lending money out is no longer counted as spending it.** It was the largest merchant, the
  whole uncategorized bar, and the reason income minus spend did not equal net. Money moving as
  loan principal converts cash into something owed rather than being consumed. Repaying a debt you
  owe is still spending — a car payment is a real monthly expense.
- **A loan's balance no longer depends on the order you linked its payments.** Linking a repayment
  before the payment that justified it silently discarded the difference, permanently and with no
  warning. Payments now replay in the order they actually happened.
- **A transaction assigned to a loan says so** — "Loan to …" or "Repayment from …" — and reverts
  if you unassign it.
- **A parent category's own spending has a row.** A category could show $628 while its
  sub-categories showed $183, with the difference counted but never displayed.
- **A category chip includes the category's children.** Clicking Health hid everything filed under
  Pharmacy while the Health budget counted it.
- **A split transaction appears when you filter by the category you split it into.** It counted
  toward that budget already; it just never showed in the list.
- **Renaming a merchant now groups it in Top merchants**, so one shop across five store numbers is
  one row. Previously the rule fixed the transactions list and nothing else.
- **A rule typed in lowercase is no longer silently dead.** Patterns are stored the way merchants
  are, so a rule matches what you meant.
- **Net worth stops claiming a figure it cannot support.** With account balances missing, neither
  the amount nor its sign is established, so it says it is partial and points at what to fill in.
  Money lent out now counts as an asset.
- **Spent, Money in and Net agree on the dashboard.** Spent counted only categorized transactions
  while Net counted everything, so the three tiles contradicted each other. Uncategorized spending
  is now called out separately, with a link to the review queue.
- **Cash runway explains itself.** It said there was no spending history on a page full of
  spending; it needs one complete month, and now says so.

## [1.20.0] - 2026-08-30

No migration. Nothing changed about what is stored.

### Added

- **The dashboard charts savings, not just income against spend.** The same chart the reports page
  draws, on the page you land on.
- **Needs review can attribute a transaction to a person**, without opening it on the transactions
  page first.

### Changed

- **One card renders a transaction everywhere it appears** — in the review queue and on a phone.
  There used to be two, which is why a split transaction showed a "Split · N parts" badge in one
  place and a bare category picker in the other, and why every control added to one had to be
  remembered into the other.
- **Every row editor is the same dialog.** Note, rename, assign to loan and apply-to-all used to
  open as panels wedged between two rows, shoving the rest of the table down the page, while split
  opened as a proper dialog over it. All five are now that dialog.
- **A transaction card is three lines instead of five.** The row menu moved up beside the amount —
  it used to sit after the controls and land alone on a trailing line holding nothing else — labels
  sit beside their fields rather than above, and the controls wrap on a narrow screen instead of
  stretching.
- **Creating something is behind a button, on every page that creates something.** Goal creation
  moved to its own page the way adding an item on Contracts & Coverage already worked, and the five
  Settings forms that were always open — add an account, add a type, new category, save rule, add a
  user — now fold away until asked for.
- **Search says what it searches.** The redundant label is gone, the placeholder names the fields it
  looks at, and the filter button sits on the same line at the same height.
- **Settings groups its categories the way Budgets does**, by parent, foldable.
- **One implementation each of the days-remaining pill, the empty state and the progress bar.** They
  had three, seven and two respectively. Nothing about them looks different; there is now one place
  to change each.
- **An empty state offers something to do.** Seven of them said only that there was nothing there.

### Fixed

- **A transaction assigned to a loan leaves the review queue.** It stayed, with no way to clear it
  short of marking it a transfer, which it is not.
- **A category chip keeps the filters you already set**, review included. It used to drop them.
- **Two buttons in a page header sit side by side** instead of stacked with dead space beside them.
- **A note is visible on the row that has one.** Adding a note left no trace, so the only way to
  find one was to open rows until it turned up. The indicator is also the way to open it again.
- **Labels stop colliding on a phone** on the budgets and transactions pages.

## [1.19.0] - 2026-08-30

No migration. Every page changed how it looks; nothing changed what it stores.

### Changed

- **The whole app is built from one set of components now.** One card, one progress bar, one pill,
  one list row, one section header, one icon set — so a budget, a goal, an account and a loan are
  the same object wherever you meet them, instead of each page having invented its own. Cards lost
  their drop shadow and tightened their padding, which is most of the empty space the app used to
  waste.
- **Budgets is a grid of cards at every size.** One card per category: how much is spent, how much
  was budgeted, a bar, and whether you are under or over. Open a card for its sub-categories, open a
  sub-category for the transactions behind it — the first time the app has shown *why* a category
  is over without leaving the page. Setting limits moves behind **Edit limits**, so the page reads
  cleanly and still fills in fast once a month. Goals now use the same card.
- **Transactions groups by day.** Each day gets a heading, with money in, money out and net for what
  you are looking at across the top. Categories became chips you tap instead of a dropdown — they
  wrap rather than scroll sideways, and picking one keeps every other filter you had set.
- **The review queue can be finished.** It shows `4 of 12 confirmed`, gives every guessed row a
  confirm button, and adds **Accept all suggestions** for when the categorizer got them all right.
  A row with no category cannot be confirmed.
- **Dashboard tiles say which way things moved** — `+2.4% vs last month`, coloured by whether that
  is good news, so a rise in spending is never green. Anything with a deadline shows the days left,
  amber inside a week.
- **Every page header lines up.** The month navigation and the person pills were centred under the
  title, and being different widths, neither edge matched. Both now share one edge.
- **Quick add is a button, not a card** — on the dashboard as well as on Transactions.
- **Settings → Accounts is a card per account.** Its table needed nine columns and a minimum width
  wider than the page, so it scrolled sideways on every screen. Contracts & Coverage keeps its
  table on purpose: it is sorted by what expires soonest, and that is a column you scan.

## [1.18.0] - 2026-08-30

No migration this time — 1.17.0 had one, this one changes nothing in the database.

### Changed

- **Budgets opens as a handful of groups, not forty rows.** Each parent category is now a group you
  can fold open: closed, its header still carries the limit, what has been spent, what is left and
  the bar, so folding hides the detail and never the answer. Everything starts closed, so the page
  has the same shape every visit, and a group that is over its limit says so while still closed.
  There is an Expand all in each section, and what you leave open is remembered in your own browser.
  Household and Personal do not fold — they are the two halves of the page.
- **A parent limit now says when its children have outgrown it.** Set Housing to $2,000 and let the
  categories under it add up to $2,400, and the group tells you: *Children add up to $2,400 — $400
  over Housing's limit*, with a button to raise Housing to $2,400 and one to undo. Nothing is
  refused. Blocking the edit would mean moving $200 from one child to another only works in one
  order, and lowering a parent below its children would have to be refused too — which makes a
  parent almost uneditable. The number was always allowed; now it is visible. A parent whose
  children add up to *less* than its limit is left alone, because that is an ordinary choice.
- **The month is stated once.** The header carried three copies of it — a label above the greeting,
  the month in the navigation, and a separate date box beside it, two of them clickable. Now the
  month in the navigation is the thing you click, and the arrows read *Jul* and *Sep* instead of
  *2026-07* and *2026-09*.
- **A month with nothing budgeted says so.** The Budgets header used to read *spent $0.00 of $0.00
  budgeted · $0.00 total spent*. It now says there are no budgets set for that month and points at
  what to do about it.

## [1.17.0] - 2026-08-30

**This release has a migration (0015).** It is additive — one new table, `savings_targets` — and
nothing existing is reshaped or rewritten. Back up first anyway if that is your habit; the update
scripts do it for you.

### Added

- **A monthly savings target.** Set it on Budgets, beside the month: either a **percent of what you
  earn** — which self-adjusts, so a thin month does not read as a failure — or a **fixed amount**.
  "Copy previous month" carries it forward with the budgets. Saving is measured as **income minus
  spending, with transfers excluded**, which is what the reports have always computed.
  Moving money into a savings account does not raise the figure and is not meant to: income minus
  spending already counts every dollar you did not spend, including the ones still sitting in
  chequing. A transfer relocates money; it does not create any. The dashboard tile still shows how
  much of the month you moved into savings, as information, because that is the question everyone
  asks first.
  If your savings account is one the app imports, this all works whether or not you flag the
  transfer — the two sides cancel. Flag it (row menu → *Mark as transfer*, once per description,
  and it learns the rule) when the money leaves for a bank the app does not know about, or the
  transfer reads as spending.
- **Three alerts for it**, in Settings → Notifications like every other: **you hit this month's
  target**, **on pace to miss it** (pro-rated, and never before the 7th — a three-day sample says
  nothing about a month), and **last month against target**, which carries the streak. A month with
  no target set sends nothing at all.
- **A savings line on Reports.** The cash-flow card keeps its income and spend bars and gains a net
  line, a running total of what you have kept across the range, and your target drawn across it as
  a dashed line. A month with no target simply has no segment. The summary adds "target met in 4 of
  6 months".
- **A cash runway tile** on the dashboard: liquid balances divided by your recent average monthly
  spend — "4.2 months covered" — with a caveat shown when an account has no balance on file.
- **Save an import mapping without importing first.** When a preview comes back wrong you can
  correct the mapping and now press **Save as a new profile** (on a built-in) or **Update
  <profile>** (on one of your own). The corrected profile is remembered for that account. This
  already happened silently on a successful import, which was no help at all for the case that
  matters — a file that reports nothing but errors can never be committed, so the one mapping you
  most need to keep was the one being thrown away. A built-in profile is never overwritten; saving
  one forks it.

### Changed

- **The dashboard follows a month.** Previous / next, or jump to any month or year. Budgets, the
  spent/earned/net tiles, top merchants and the savings tile all move with it; the twelve-month
  chart, net worth, goals, loans and the rest stay pinned to today and now say so. Safe to spend is
  hidden for a past month, where the question has no meaning.
- **Budgets and the dashboard share one month control**, instead of Budgets having a pair of bare
  links and the dashboard having nothing.

## [1.16.0] - 2026-08-30

No migration. Nothing in the database changes shape — the new Linked transactions card reads two
tables that already existed and are already indexed.

### Added

- **An item page now shows the transactions linked to it.** Open a loan, a warranty or a contract
  and there is a **Linked transactions** card listing every transaction applied to it: date,
  merchant, account, the amount, how much of it went to this item, and whether the link was made by
  a payment rule or by hand. Each row unlinks from its own menu. Until now the page told you
  "Payments linked: 2" and made you go and find them; a loan showing a $0.00 balance gave you no way
  to see what had cleared it.

### Changed

- **Phone cards read as a labelled list instead of a spec sheet.** The first line of every card was
  printing its own column name against the value — `CATEGORYHousing`, `DESCRIPTIONpayroll deposit` —
  because the headline cell rendered its label inline. The headline now shows the value alone; the
  remaining labels are quieter and sentence-cased; each row is separated by a hairline instead of a
  gap of dead space; a dropdown or a number input sits full width under its own label rather than
  hanging off the right edge; a progress bar spans the card; and the row menu is a bordered button
  instead of three grey dots floating in whitespace.
- **A date or an account name reads as a caption** under the merchant, rather than claiming a
  labelled row of its own. On Transactions the account is back on the phone — 1.15.0 hid it
  outright.
- **Quick add folds away on the dashboard too**, matching Transactions. Content is always visible;
  a form that creates something sits behind a button. The same now applies to the **Add rule** form
  on a loan's Payment matching card and the **Add receipt** picker — the rules and receipts you
  already have stay on the page, only the empty form folds.
- **The review queue is one column.** The page header and filters ran to the full width of a monitor
  while the cards below were capped, so the edges did not line up. Everything now shares one measure.
- **Contracts & Coverage stops scrolling sideways.** Its table asked for 85rem inside a 72rem page,
  so every desktop showed a horizontal scrollbar and hid the last two columns — at any window size,
  even with one row in the table. Vendor moves under the item name (it was empty on every loan and
  every contract), the remaining columns are sized to their content, and the page now uses the wide
  shell that Transactions and Reports already use.
- **"Purchase date" is no longer the wording for a loan.** The shared column reads **Started**, and
  the item's own page names it for what it is: *Purchased* for a warranty, *Lent on* or *Borrowed
  on* for a loan, *Starts* for a contract or a bill.
- **"Term unknown" is now "No end date."** It was never an error — it means no end date was
  recorded, which is the ordinary state of a loan between friends.
- **Empty optional fields stop rendering** on an item page. A loan was printing an em-dash for
  Vendor, Payoff date, Payment and Notes: four dead cells out of ten. The Edit card is still how you
  fill them in.

## [1.15.0] - 2026-08-29

No migration. Nothing in the database changes shape, and nothing about a laptop's layout changes
either — this release is about what the app looks like in a hand.

### Changed

- **Every table reads as a list of cards on a phone.** Below 640px a row stops being a row: the
  header strip disappears, each row becomes a card, and each value prints its own column name
  beside it. Transactions, Budgets, Warranties, Reports, the Settings managers, the dashboard and
  the import history all move at once. On a phone the transactions list used to show a checkbox, a
  date, an account name repeated on every line, and a description cut mid-word — with the amount
  and the category off-screen behind a sideways scroll. The amount now sits beside the merchant on
  the first line of the card, where it is the first thing you see.
  Two deliberate exceptions: the import wizard's column preview and the parsed-rows preview stay
  tables, because they exist to compare columns side by side and a stack destroys that.
- **Quick add folds away on Transactions.** It was roughly 600px of form standing between the top
  of the page and the first transaction. It is now a button that opens the form, closed by default,
  and it is not shown at all while the review filter is on — a triage queue has no business
  offering a create form. The home-screen "Add a transaction" shortcut still opens it directly.
  The dashboard's Quick add card is unchanged.
- **The filter block folds away on a phone** the same way, behind a `Filters` button that says how
  many are active, and opens itself when you arrive with a filter already set. At tablet width and
  up it is always visible, exactly as before.
- **The review queue keeps its cards at every width**, but they no longer stretch to the full width
  of a monitor with the amount marooned at the far right — the list is capped to a reading measure.
  A long merchant name can no longer push the amount onto a line of its own.

### Removed

- **The "uncategorized" badge on review cards.** Every card in a queue defined as "not categorized
  yet" carried it, so it said nothing about the card it was on. The guessed-category badge, which
  differs row to row, stays.

## [1.14.2] - 2026-08-29

No migration. Nothing in the database changes shape.

### Fixed

- **Note… and Assign to new loan… now work while reviewing.** Both menu items opened nothing on
  the review filter in 1.14.1: the editors they open were built into the table and the review list
  is not a table. They are now the same editor in both places.

### Changed

- **One "Assign to loan…" entry instead of one per loan.** Choosing it opens a short form with the
  household's loans listed, plus **New loan…** for one that does not exist yet — the same two paths
  as before, no longer eleven menu items on a row.
- **A transaction assigned to a loan says so on the row**, next to the transfer and renamed badges,
  so the assignment is visible without opening the menu.
- **"Apply to every transaction from this merchant" is available on any row**, not only while
  reviewing. Picking a category on a row still teaches the categorizer either way; this is the
  deliberate step that also writes a rule for future imports.
- **Category lists group children under their parent.** Parents are headings in the dropdown, on
  the phone picker too, and parent rows in Budgets and Settings → Categories carry a light tint —
  so a sub-category is no longer indistinguishable from the category above it.

## [1.14.1] - 2026-08-29

No migration. Nothing in the database changes shape.

### Changed

- **The review queue is a filter on Transactions now, not a second page.** `?review=1` on
  Transactions narrows the list to exactly what `/review` used to show — oldest first, uncategorized
  or an unconfirmed guess, transfers and split rows excluded — and renders it as a card list instead
  of the table. Every feature Transactions has gained since the queue was last touched (splits,
  notes, per-person attribution, loans, renaming) is automatically available while reviewing, because
  it is the same page. The **Review** entry in the menu keeps its label, its icon and its count
  badge; only where it points has changed. The old `/review` address still works — it redirects
  here — so a bookmark, the dashboard's "N transactions need review" callout and the link at the end
  of an import all keep working with no change on your part.
- **Accepting a guess or picking a category still teaches the categorizer while reviewing**, exactly
  as before: the merchant is remembered and future imports arrive already sorted. Outside the
  review filter, picking a category continues to tag only that one row, unchanged from how
  Transactions has always worked.

### Added

- **Every transaction row can be marked (or un-marked) a transfer from its own menu**, not only
  from the bulk toolbar or while reviewing. "Mark as transfer" and "Not a transfer" sit alongside
  Rename…, Note…, Split… and the loan actions on every row, and it learns the same exact rule the
  bulk control and the old review queue already did.

## [1.14.0] - 2026-08-28

**Before updating:** this release adds one column to one table (`warranty_items`). Nothing is
rebuilt and nothing is dropped, but take a backup first anyway: **Settings → Backups → Download
backup now**, or confirm last night's scheduled backup succeeded. Use that, not a file copy — the
database runs in WAL mode, so copying `budget.db` off the NAS while the container is running
silently leaves out your most recent changes; the app's own backup is a consistent snapshot.

**Stop the old container before starting the new one** rather than hot-swapping, so only one
process opens the database during the migration.

**The migration is all-or-nothing.** The one added column commits in a single transaction, so an
interrupted update leaves your v1.13.3 database exactly as it was — start the container again and
it will retry.

**To roll back:** restore the backup you took above, then run the v1.13.3 image.

### Added

- **A loan can now point either way.** Every loan kept its old meaning — a debt the household
  owes — and that stays the default, unchanged. A new **Direction** control on the loan form
  offers a second choice, **Lent out — they owe us**, for money you lent someone: money leaving
  the account now adds to what they owe you, and money coming back takes it off again.
- **A "Who owes us" card on the Dashboard**, listing anyone who owes the household money and
  hiding itself when nobody does. A member who only sees their own records sees it titled **Owed
  to you**, listing only their own loans.
- **A second line on the Reports debt chart**, plotting what the household has lent out
  separately from what it owes, with a legend once a lent loan has a balance.
- **Transactions → row menu → "Assign to new loan…"** creates the loan (name + direction) and
  assigns that row as its first entry, so lending to a friend never needs a detour through
  Warranties & bills.

### Changed

- **Money you have lent out no longer counts toward the household debt total or the debt side of
  net worth.** It stays out of the "What we owe" figure and out of net worth's debt line, because
  money owed to the household is not a debt the household owes. Someone whose
  net worth figure moves after this update is entitled to know why, and this is the one number
  this release changes without being asked.

### Fixed

- **Review page** — the per-row category select and the "apply to all matching + create rule"
  select now carry visible labels ("This transaction only" / "Every <merchant> — N transactions,
  plus future imports") and a hint; duplicated row titles collapse; child categories keep their
  indent in every dropdown.

## [1.13.3] - 2026-08-28

**Before updating:** no tables change; there is no migration. The app is identical to 1.13.2,
whose image was never published because its build failed on a timing-sensitive test.

### Changed

- **Test-only.** One AutoSave test asserted the status slot synchronously after waiting for the
  error message; under CI load the transition's pending flag had not yet cleared, so the build
  failed. The test now waits for the status like its siblings do. No application code changed.

## [1.13.2] - 2026-08-28

**Before updating:** no tables change in this release either; there is no migration. A backup is
optional and only matters as the way back to 1.13.1.

### Fixed

- **Settings → Categories lists each child under its own parent.** The admin table still drew
  categories in creation order and only indented the children, so a child added later (say
  *Kids → Education*, created after *Fees* and its children) appeared indented under the wrong
  parent at the bottom of the list. The table now uses the same grouping every category picker
  has used since 1.8.0: a parent, then its children, archived rows included. Display only —
  nothing about the categories themselves was wrong.

## [1.13.1] - 2026-08-28

**Before updating:** this release changes no tables at all — it is the smallest kind of update
this app has. You do not need a backup for the migration's sake because there is no migration;
take one anyway if it is easy, because it is the only way back to 1.13.0.

### Fixed

- **Settings → Updates tells you what it found.** Pressing **Check now** used to grey the button
  out, settle, and leave the card looking exactly as it did — you had to refresh the page to find
  out whether an update existed. It now updates in place, and when you are already on the newest
  version it says so instead of looking identical to a button that did nothing.
- **An admin can turn a person's sign-in off and back on.** Settings → Users has a new Sign-in
  column. Turning it off leaves the person in every attribution menu — their share of the spending
  still counts — signs them out of every existing session, and takes away their login. An admin's
  own sign-in cannot be turned off; make them a member first. A malformed request is refused
  outright rather than silently treated as "turn it off."
- **A bill shows its schedule on the Contracts & Coverage list.** A bill three weeks overdue used
  to read "Ongoing" on the one page most people navigate to. It now shows the next due date, or an
  overdue count, in the same column.
- **A bill's detail page stops showing three blanks.** Model, Serial number and Price are fields a
  bill can never hold, and the card rendered an em-dash for each of them above the installments.
  They are hidden now — unless the item actually has a value stored, in which case it stays on
  screen rather than being quietly dropped.
- **Warranty detail rows match the edit form's own fields.** Vendor is asked for on every kind's
  form, so it is now always listed on the detail page too — value or a placeholder, never dropped
  by kind the way Model and Serial number are. And a loan with no price typed in no longer shows an
  empty "Price" row sitting beside its own "Original amount" figure.
- **Two more tables hold their width before a long value breaks them.** The merchant-rules table
  in Settings → Rules and the Warranties & bills list were one long pattern or item name away from
  squeezing a button off the edge of the card. Both now reserve the space their columns need.
- **The dashboard's Coming-up card has a limit.** A household several bills behind got a wall of
  rows instead of a card, and an installment missed years ago counted exactly as much as one missed
  last week. It now shows the eight nearest with a "+N more due" link, points you at the Warranties
  & bills page instead of claiming nothing is due when everything unpaid is simply older than that,
  and stops counting anything more than 90 days overdue.
- **The Reports page's "Who spent it" card can actually show it has nothing to show.** The card's
  empty state existed but could never appear, because the underlying figures always included a
  zero placeholder row. It now recognises "every row is zero" as the same thing as "nothing to
  split" and shows the empty state instead of a lone unattributed zero.
- **Import refuses an account it cannot import into, at the preview, however the account id is
  written.** Choosing an asset account — a house, a TFSA — used to preview happily and only fail
  when you pressed commit; a stray "+" in front of the account id could also slip past the
  preview's own refusal. Both now agree with each other and with the final check.
- **An OFX or QFX file no longer shows a column-mapping editor.** Those files carry their own
  columns, so every control in that panel was ignored, and the warning about an unreadable date
  column was about dates that had parsed perfectly.

### Security

- **Re-flagging a transfer can no longer delete somebody else's rule.** Marking a transaction as a
  transfer (or un-marking it) tidies up the opposite rule for that merchant. That tidy-up ran with
  no ownership check at all, so a member could remove a rule an admin had set up. It now refuses
  the whole action and changes nothing, the same way every other rule edit already does.
- **A scheduled digest is skipped rather than sent household-wide.** If a person's account was
  deleted in the same window their weekly or monthly digest fired, that one message was built with
  a household-wide view — even for someone who is only supposed to see their own records. It is now
  not sent at all.
- **A child's Transactions, Dashboard and Goals pages no longer carry the household roster.** The
  names of everyone in the household were being sent to the browser to fill in attribution menus
  and an "Owner" picker that refused every choice but the child's own. Those controls, and the
  names behind them, are gone for that account now.
- **A stale-import notice is skipped, not sent household-wide, when the recipient is gone.** The
  same fix the weekly and monthly digests already got: if a person's account was deleted in the
  same window their stale-import check ran, it used to be treated as an ordinary household member
  instead of being skipped, which could have named an account they are no longer supposed to see.
  It is now not sent at all.

### Changed

- **Screen readers are told when an auto-saving field saved, and that announcement no longer talks
  over the control's own name.** A refused save was announced and a successful one was not, which
  was the wrong way round; the fix for that briefly made a checkbox's accessible name run together
  with the word "Saved" — the announcement now lives beside the control instead of inside its
  label.
- **Field hints stop being read as part of the field's name.** A hint under an input was being
  read as though it were the label, so "Original amount" was announced as "Original amount What you
  borrowed. Used for the payoff bar." every time.
- **Field hints are linked to their control via `aria-describedby` even without an explicit id.**
  Moving the hint out of the label (above) stopped it from being announced as part of the name, but
  the fields that never had an id to attach the description to were left with a hint that is
  visible but not announced as belonging to the control at all. They now generate their own id and
  are described the same way as every field that already had one.
- **Row menus on Transactions name their row unambiguously.** Two identical charges on the same
  statement produced two menu buttons a screen reader could not tell apart; the button now carries
  the row's date and amount too.
- **The Reports page stops describing things that are not on it.** For an account that only sees
  its own records, the page's own explanation used to promise an Export CSV button, a per-person
  split card, and a household net-worth figure that were correctly absent.

## [1.13.0] - 2026-08-27

**Before updating:** this release adds columns to four tables and creates one new table
(`audit_log`). Nothing is rebuilt and nothing is dropped, but take a backup first anyway:
**Settings → Backups → Download backup now**, or confirm last night's scheduled backup
succeeded. Use that, not a file copy — the database runs in WAL mode, so copying `budget.db`
off the NAS while the container is running silently leaves out your most recent changes; the
app's own backup is a consistent snapshot.

**Stop the old container before starting the new one** rather than hot-swapping, so only one
process opens the database during the migration.

**The migration is all-or-nothing.** Every statement and its bookkeeping row commit in a single
transaction, so an interrupted update leaves your v1.12.1 database exactly as it was — start the
container again and it will retry.

**To roll back:** restore the backup you took above, then run the v1.12.1 image.

### Added

- **A "just me" view for kids.** Settings → Users can set any member to **Only their own records**.
  That person then sees only transactions attributed to them, their own budgets, goals and items,
  and their own upcoming bills — no account balances, no net worth, and no household totals
  anywhere. Everyone else's screens are unchanged.
- **People without a login.** Settings → Users can add someone as a person only — no password,
  no sign-in. They appear in every "who was this for?" picker and can never be an admin.
- **A "Needs a look" card on the dashboard**, listing this month's unusual charges, duplicate
  charges and subscriptions that went up. The app has computed these since v1.10.0 and could
  only reach you by Telegram or email until now. The card hides itself when there is nothing to
  say.
- **Quick add.** A one-line form at the top of Transactions and on the dashboard, defaulting to
  the account you used last. The installed app's icon gains an "Add a transaction" shortcut.
- **Notes on a transaction.** "Note…" in the row menu opens a box under that row, and the search
  box now searches notes as well as descriptions.
- **Record payment** on an upcoming bill installment: one button writes the transaction and marks
  the installment paid, in one step.
- **RBC, BMO and CIBC import presets, and OFX/QFX files.** OFX carries the bank's own transaction
  id, so re-importing an overlapping statement matches exactly instead of by fingerprint. These
  three presets are built from each bank's published export layout, and
  have not yet been checked against a real file — tell us if one needs adjusting.
- **Savings and asset accounts.** An asset (a house, a TFSA, an RRSP) holds a balance you type in
  and counts toward net worth; it takes no transactions and no imports. Savings behaves like a
  chequing account but is left out of safe-to-spend.
- **A sinking-fund line on budgets.** Link a bill to a budget category and that row says what it
  is accumulating for: "Accumulating for Property tax — $900 of $1,800 by 2026-06-30".
- **An audit page** at Settings → Audit log, listing every deleted item, deleted receipt and
  undone import with who did it and when.

### Changed

- **Deleting an item or a receipt, and undoing an import, now require you to own it** (or to be an
  admin). Until now any signed-in member could delete anyone's records and nothing recorded who
  did it.
- **Opening another member's item by its address now shows "not found"** instead of the item.
- **Changing a merchant rule someone else created now tells you so** instead of silently
  overwriting it and recording you as its author. Admins can still change any rule.
- **"You haven't imported in a while" now names the account.** Importing one account no longer
  silences the alert for the four you have not touched.

### Fixed

- The people picker on Transactions listed deactivated members while the one on Budgets did not.
  Both now list every active person, whether or not they can sign in.
- **Confirming a two-factor code no longer turns MFA on before checking it.** Finishing setup used
  to enable two-factor and save recovery codes before the code you typed was verified, so a refused
  (wrong or replayed) code could still leave the account switched on with zero recovery codes. The
  code is now verified and consumed first; nothing is enabled or stored unless it checks out.

## [1.12.1] - 2026-08-27

**Before updating:** this release adds one new piece of information to each of two existing tables
and does not rebuild either of them, so it is a much smaller step than 1.12.0 was. Take a backup
anyway — **Settings → Backups → Download backup now**, or confirm last night's scheduled backup
succeeded — because a backup is the only way back to 1.12.0 if you want it.

### Fixed

- **Budgets set on sub-categories are counted again.** If you budget at the child level — Food ›
  Groceries $600, Food › Restaurants $200 — the household summary, the Dashboard tile and
  safe-to-spend all said you had budgeted $0.00. They now add up the limits you actually set. A
  category you archived keeps its limit visible for as long as it still carries spend, instead of
  quietly dropping the limit while the spend kept counting against its parent.
- **One payment can no longer pay a bill and a loan at the same time.** Assigning a transaction to a
  loan by hand now checks whether it has already marked a bill installment paid, and refuses. The
  automatic rules always checked; the manual button did not.
- **Un-marking a bill installment sticks.** The app used to forget that the transaction had ever been
  used, so the next time anything re-ran the matcher — even just picking the same category again —
  the installment was silently marked paid all over again. Removing an installment that has a payment
  recorded against it is refused too; un-mark it first.
- **A bill payment marks the right installment.** A matched payment now marks the installment whose
  due date is nearest the payment's own date, within 45 days, instead of always the oldest unpaid
  one. One missed mark used to shift the whole schedule by one, permanently. If the nearest-due
  installment has been deliberately un-marked, the matcher declines rather than marking a farther one.
- **Undoing an import no longer leaves the wrong balance behind.** Importing a statement into the
  wrong account and pressing Undo used to delete the transactions but keep the balance that statement
  had written, leaving the account anchored on another account's figure for ever. Undo now removes
  those balances too.
- **A bank's own balance outranks a typed one, as documented.** A balance read from a statement is no
  longer overwritten by a hand-typed correction for the same account and day. This rule was written
  down in three places and implemented in none.
- **A save that fails now says so.** If the app is busy — the nightly backup, a full disk — an
  auto-saving control used to stop spinning and go on showing a value the database never accepted. It
  now says "Could not save — the app may be busy. Try again." and puts the value back.
- **Emptying a budget box no longer deletes the budget.** Selecting the number to retype it and
  getting distracted used to clear that limit for every future month. An empty box is now treated as
  "no change", and there is a small **clear** button in the cell for when you really mean it.
- **Two people editing the same row.** Whoever's change lost used to go on seeing their own value,
  with a tick beside it, until they reloaded. Controls now follow the server.
- **Error and "not found" screens are the app's own.** A server-side failure or a stale bookmark to a
  deleted item used to show the framework's bare error page — no navigation, no theme, no way back.
  Both now render inside the app with a plain sentence, a **Try again** button and a link to the
  Dashboard.
- **Something happens on screen while Reports and Transactions load.** Both show a skeleton
  immediately instead of nothing at all.
- **Bigger tap targets, and the keyboard goes back where it was.** The row ⋯ button and its menu
  items are finger-sized on a phone, the row controls are taller, and choosing a menu item returns
  focus to the button you opened it from instead of dropping it at the top of the page.
- **Deactivate, Reset MFA, Remove and Unassign ask first.** Every other destructive action in the app
  already did.
- **The number pad opens for three more money fields:** adding a transaction, contributing to a goal,
  and a new goal's target amount.
- **Installed on an iPhone home screen, the app stays clear of the notch and the home indicator.**
- **A clean container stop closes the database.** Stopping or restarting the container used to exit
  the instant the signal arrived, without closing SQLite. And a migration that fails at boot now
  prints a framed message naming the problem and the rescue command, instead of a bare stack trace.
- **Picking a category on the Transactions page changes that row and nothing else.** It used to
  create or overwrite a household-wide rule for that merchant, and picking "Uncategorized" deleted
  one, with nothing on screen to say so. The Review page still teaches the categorizer — that is what
  it is for.
- **The New item page points at the Bill kind.** If you have no item type of kind Bill yet, it now
  says where to make one instead of leaving you to guess.

### Security

- **Changing your password signs out every other session.** A captured session cookie used to keep
  working for up to 30 more days after you changed the password because of it.
- **Turning off two-factor authentication asks for your password** and signs out every other session.
  Turning it off, and changing your password, now also send you a notification.
- **Sign-in rate limiting no longer trusts a header the client controls.** Unless `TRUST_PROXY` is
  on, `X-Real-IP` is ignored, and the address recorded on a session and shown in the "New sign-in"
  alert is validated and length-capped.
- **HSTS is sent when the connection really is HTTPS**, and the app warns in its log when it is
  behind an HTTPS proxy with `TRUST_PROXY` left off — the configuration where the session cookie
  silently is not marked Secure.
- **Bulk exports are blocked until a temporary password has been changed.** The transactions export,
  the tax-year export and the backup download now honour the same "finish setting your password" gate
  the pages do.
- **A two-factor code can only be used once.** It used to stay valid for its full ±30-second window
  and could be replayed.
- **`/api/health` no longer tells an unauthenticated caller the exact build version.** It still
  reports it on the 503 responses, where the question is "which build is broken?".
- **INSTALL.md now says plainly what a downloaded backup contains:** the complete household financial
  record plus every password hash. Store it encrypted.

## [1.12.0] - 2026-08-24

**Before updating:** this release rebuilds the `warranty_item_types` table to make room for the
new Bill kind — the first time a Budget Tracker migration has recreated a table holding data you
typed. Take a backup first: **Settings → Backups → Download backup now**, or confirm last
night's scheduled backup succeeded. Use that, not a file copy — the database runs in WAL mode, so
copying `budget.db` off the NAS while the container is running silently leaves out your most
recent changes; the app's own backup is a consistent snapshot.

**Stop the old container before starting the new one** rather than hot-swapping, so only one
process opens the database during the migration.

**The migration is all-or-nothing.** Every statement and its bookkeeping row commit in a single
transaction, so an interrupted update leaves your v1.11.0 database exactly as it was — start the
container again and it will retry.

**To roll back:** restore the backup you took above, then run the v1.11.0 image. A backup made
*by* v1.12.0 will be refused by v1.11.0 as newer (`npm run restore-backup -- --allow-newer`
overrides this on the disaster path only), which is why the backup must be taken *before* you
pull.

**If the app refuses to start** with `Database has N orphaned row(s) after migration`, it has
found a pre-existing broken reference that earlier versions never checked for. Restore your
backup and open an issue — do not delete the database.

### Added

- **Bills with due dates.** A property tax bill is not a monthly or an annual subscription — it
  arrives two to six times a year on dates a municipality picks, and no repeating cycle describes
  that. There is now a fifth kind of item, **Bill**, that carries a list of due dates and amounts
  you type in rather than a billing cycle. Make an item type of kind Bill under Settings → Item
  types, add the item, then enter each due date in the new **Installments** section on the item's
  own page.
- **Reminders before each due date, and a flag on anything that goes past.** Installments coming
  up appear on the Dashboard's **Coming up** card and in the "Something is coming due"
  notification you already have — no new switch to find and nothing new to turn on. An overdue
  installment stays visible until you mark it paid, and it reminds you once a month rather than
  every day.
- **Marking an installment paid.** Each row has a **Mark paid** button, and an **Unmark** if you
  press it by mistake. If you add a payment-matching rule to the bill — the same merchant rules
  loans already use — the transaction that pays it marks the next unpaid installment for you and
  records which transaction it was. The amount does not have to match to the cent: a tax bill
  arrives with penalties and rounding, so the payment is recorded and any difference is shown
  beside it rather than the match being refused.

### Changed

- **The page guides now start collapsed on every page.** The "What is this page for?" panel used
  to open itself on any page with nothing on it. It no longer does, anywhere: it opens when you
  click it and not before. An empty page already explains itself with the message and the button
  in the middle of it.
- **Payment-matching rules work on bills as well as loans.** A matched transaction marks an
  installment instead of moving a balance, and one transaction can still only ever be linked once
  — a loan and a bill whose rules both match the same merchant cannot both claim it.
- **Undoing an import now un-marks the installments that import paid.** Previously the link would
  have been dropped while the installment stayed marked paid by a transaction that no longer
  existed. Installments you marked by hand are never touched by an undo.

### Fixed

- **A bill's own dates and its schedule are kept apart.** Choosing Bill as an item's type hides
  the billing cycle, the product fields and the loan fields, which do not apply to it — and
  changing a type's kind away from Bill keeps every due date you typed rather than deleting them.
  They simply stop being read, and they come back if you change the kind back.

## [1.11.0] - 2026-08-24

### Changed

- **Editable cells now save themselves.** Choosing a category, a person, a budget limit, a
  cardholder, an item type or its kind, or renaming a category and marking it tax-relevant on
  Settings → Categories, used to mean picking a value and then clicking a Save button next to
  it. The value is now saved the moment you pick it — a tick appears beside the control — and
  a text box saves when you press Enter or click away, and only if you changed something.
  Nothing saves while you are still typing.
- **If a save is refused, nothing is silently lost.** The control goes back to its previous
  value and the reason appears in red beside it, instead of the change appearing to stick.
- **Row actions moved into a single ⋯ menu.** On Transactions, that menu holds Rename, Split,
  Create warranty and the loan assignments; on Settings → Accounts and Settings → Users it
  holds the buttons that used to sit side by side in the last column. Reset password opens a
  row beneath instead of living in the menu, so a half-typed password cannot be thrown away by
  a stray click.
- **The wide tables fit on a desktop again.** Transactions went from needing 76rem of width to
  68rem and Budgets from 60rem to 56rem, because the width was going to buttons rather than to
  data. A narrow screen still scrolls sideways, and no column has been narrowed to pay for it.
- **Actions that change more than one row still ask first.** "Apply to all N matching",
  "Mark as transfer", "Accept", and every deactivate, delete, archive and undo keep their own
  button. Only single-row, reversible edits save themselves.

### Fixed

- **The action controls at the end of a transactions row no longer get cut off.** They read
  "Cre…", "Spli…" and "Assign to l…" when the table was scrolled; the menu that replaced them
  is positioned against the window rather than inside the scrolling table, so it cannot be
  clipped — including on the last row of a long table.
- **The review page's apply-to-all row no longer widens the page past a phone viewport.**

## [1.10.3] - 2026-08-24

### Fixed

- **On a phone, 1.10.1 broke the transactions table badly.** Instead of the table scrolling
  sideways, its columns were squeezed until the description was one character wide, printing
  merchant names down the screen a letter per line. 1.10.1's notes promised narrow screens would
  scroll; they could not, because the table was never allowed to be wider than the screen in the
  first place. It is now, so a narrow screen scrolls and every column keeps its size. **This was a
  regression introduced in 1.10.1 — if you are on 1.10.1, update.**
- **The account column no longer cuts names to "Amex…".** 1.10.1 narrowed it and relied on hovering
  to reveal the rest, which is no use on a phone. It is wider now and shows the whole name.
- **Rows on the transactions page are shorter again.** The buttons at the end of each row were
  stacking three deep and making every row unnecessarily tall.

## [1.10.2] - 2026-08-24

### Fixed

- **The add form asked for things the chosen type does not have.** Picking Loan still showed
  Model, Serial number and Price — and Price sat directly above Original amount, so the form asked
  for the same fact twice and stored neither answer where a loan keeps it. Those three now appear
  only for a warranty, which is the only kind that describes a physical purchase. A subscription
  and a contract keep their billing pair; a loan keeps its original amount, rate and balance.
- **The submit button said "Save warranty" whatever you were saving.** It now names the kind you
  picked, so it cannot contradict the Type selector directly above it.

### Changed

- **An item's type is now fixed once it has been saved.** The type decides which fields the form
  offers, so changing it later left the old kind's values stranded in a record that no longer had
  anywhere to show them. The edit form displays the type instead of offering it, and the server
  refuses a change even if the request is crafted by hand. If you picked the wrong type, delete the
  item and add it again — and an item that already holds a value the new rules would hide keeps
  showing that field, so nothing you saved earlier can be erased by saving again.

## [1.10.1] - 2026-08-24

### Fixed

- **Tables cut off their last column and squashed the ones that mattered.** On Transactions the
  right-hand actions column was clipped at the edge of the card. On Budgets the limit column was
  squeezed so hard that "Roll over unspent" wrapped onto two lines, while the category column sat
  in empty space. One cause behind both: table columns were sized from their contents, so a long
  merchant or category name took the width it wanted and the dropdowns, inputs and buttons on the
  same row got whatever was left. Every dense table now states its column widths outright, so a
  control can no longer be starved by the text beside it. **No figure, total or balance changed —
  this is layout only.**
- The same fault was found and fixed on the **account list** in Settings (the balance sentence
  added in 1.8.0 pushed its buttons off the edge) and on the **import history** table (its Undo
  button sat behind a long filename). Four other tables were checked and left alone; two more were
  noted as close to the limit but not yet broken.
- **The import wizard's CSV preview trimmed long cells with no way to read them** — on the one
  screen whose entire job is deciding what each column contains. Hovering now shows the full value.
- **Transactions and Reports now use the width of a wide screen** instead of sitting between empty
  margins, so a long description has room on one or two lines rather than three. Pages meant for
  reading keep their narrower measure. On a small screen every table still scrolls sideways rather
  than hiding anything.

## [1.10.0] - 2026-08-23

Guidance, not arithmetic. **No financial calculation changed in this release** — no balance, no
budget, no total, no category is computed differently than it was in 1.9.0. Everything below is
about the app explaining itself. There is no database migration.

### Added

- **Help**, a new section in the sidebar and a link in the footer of every page. It has two parts:
  one suggested monthly routine, and a plain-language guide to every screen plus the features
  nothing on screen advertises — sharing packs, per-cardholder attribution on a joint card,
  retiring a bank mapping without deleting it, statement balances, receipt text search, optional
  bank sync, and backups. It ends with a short glossary. The page prints: use your browser's
  Print or Save as PDF and the sidebar, header and footer drop away, so the guide can be read on
  paper by anyone in the household who would rather not read it on a screen.
- **A getting-started card on the Dashboard** listing what is left to set up — add a bank account,
  then import your first statement — with a link straight to each. It reads the actual state of
  your data rather than remembering what you clicked, and it disappears for good once both are
  done, so there is no notice to dismiss. Members who cannot add accounts are not shown steps
  they cannot take.
- **Every screen explains itself while it is empty.** A short "What is this page for?" panel sits
  under the heading of all nine sections, open while that page has nothing to show and collapsed
  once it does — the explanation is there when you need it and out of the way when you do not.

### Fixed

- **Nineteen empty screens dead-ended onto nothing.** Every empty list, panel and report now
  offers the next step, and the offer matches the reason it is empty: create the first one, clear
  a filter that is hiding existing rows, import older statements when a chart needs more months,
  or open the setting that has not been configured yet. Two report panels were mislabelled as
  needing more history when they were really waiting on a setting — "no balances recorded" and
  "nothing marked tax-relevant" now point at the setting that fixes them instead of at Import,
  where nothing you did would have helped.
- **The README described sharing packs backwards.** It called a pack "a redacted slice of your
  data" to hand to an accountant. A pack contains no transaction, amount, balance, receipt or
  person: it carries your categories and the merchant rules the categorizer has learned, or your
  import column mappings. It is safe to give to anyone, and of no use to an accountant — for real
  figures, export a CSV from Reports. The old wording overstated what a pack reveals, which is the
  worse direction for a claim about privacy to be wrong in.
- The Dashboard no longer shows an admin the same "add your bank accounts" prompt twice, once as a
  banner and once as a setup step.

## [1.9.0] - 2026-08-23

### Changed

- Moved to Next.js 16 and React 19.2. Nothing about how you use the app changes. This is the
  web framework the app is built on, and staying current on it is what keeps security fixes
  available — the three advisories that could not be closed in 1.8.1 are closed by this upgrade,
  taking the project from twelve open advisories at the start of the day to six, none of which
  can be reached by a running install. Builds are also faster, since the new build system is now
  the default.
- The request filter that redirects you to the login page when your session has expired now runs
  on the same Node runtime as the rest of the app rather than a separate restricted one. Verified
  by hand against a real production build: pages redirect, API routes answer 401 instead of
  redirecting, the login and setup pages stay reachable, and the security headers still go out on
  every response.

### Security

- Closed the last three advisories that needed the framework upgrade to fix (`next`, and the
  `postcss` and `sharp` libraries it pulls in). The `sharp` one was the only one of the three with
  any path to a running install, since it is what resizes uploaded receipt photos.
- Stopped the release image from carrying files it never needed. The new build system copies more
  of the project into the shipped image than the old one did, which would have included this
  project's own test suite and internal working notes. Neither belongs in a published image, and
  both are now excluded before the image is built. Nothing was ever published — this was caught
  while preparing this release.

## [1.8.1] - 2026-08-23

### Changed

- Moved the build's type checker to TypeScript 6.0.3. Nothing about the running app changes —
  the type checker only inspects the code, it does not produce what ships — but it is the
  required stepping stone to TypeScript 7, whose speed gains this project will take once its
  ecosystem is ready. TypeScript 7.0 deliberately ships without a programmatic API until 7.1,
  which several tools here and in Next.js still depend on, so 6.0.3 is where this sits until
  then.

### Security

- Updated the database library and the scheduler to versions without published advisories
  (`drizzle-orm` 0.45.2, `node-cron` 4.6.0), taking the project from twelve open advisories to
  nine. Nothing about how the app behaves changes. The database one was the only advisory that
  touched how your data is queried; it was almost certainly not reachable here, since it
  concerns table and column names and this app never builds those from anything you type, but
  it is fixed rather than argued about. Of the nine that remain, five only affect the machine
  that builds the app and never reach a running install, and the rest are fixed by the Next.js
  upgrade in the next release.

## [1.8.0] - 2026-08-23

### Added

- **Your bank's own balance column now drives your account balances.** If a statement carries a
  running balance — TD's chequing export does, in its fifth column — map it once in the import
  mapping and every import records that balance for each statement date. The built-in TD
  Chequing/Debit mapping ships with it already set, so it just works. Nothing is inferred: these
  are the bank's own figures, per date.
- **Balances now stay current between imports.** An account's balance is worked out as the most
  recent recorded balance plus everything that has moved since, so it no longer sits frozen at
  whatever the last snapshot said. For a card whose export has no balance column, enter the
  statement balance once and the transactions carry it forward from there — a credit-card export
  is a complete ledger, so that arithmetic is exact rather than an estimate. Entering a fresh
  balance at any date re-anchors everything after it, so a number that has drifted corrects
  itself instead of staying wrong.
- **Statements are now checked against your own transactions.** Two consecutive statement
  balances should differ by exactly the transactions between them. When they do not, Settings ->
  Accounts says so and names the period, because that gap is usually a statement you never
  imported. It only reports — nothing is adjusted for you, and no filler transaction is invented.
- **Credit-card balances are entered as what you owe.** The field on a credit account now says
  "Amount currently owed" and stores it as a debt, instead of taking a signed number and trusting
  you to get the sign right.

### Fixed

- The dashboard's Coming up card contradicted itself, showing a total for the next 30 days above
  a sentence counting only what falls before month end — so a bill due next month made it read
  "$77.00" and "$0.00 of bills are still to come" at the same time. Both figures were right and
  both are worth having; the card now says which window each one covers.
- Category dropdowns listed parents and children in creation order, so a child could sit nowhere
  near its parent. Every category dropdown in the app now groups children under their parent, in
  the same order the Budgets page uses.
- The receipt scanner could load itself twice on a slow phone. If the first attempt took more
  than fifteen seconds, the next photo started a second copy of the image-processing engine
  alongside the first, doubling its memory use on exactly the device that was already struggling.

## [1.7.0] - 2026-08-23

### Added

- **A transaction can now be split across several categories.** One trip to a warehouse store
  is rarely one category, and until now the whole amount had to land in a single one. A row's
  Split action divides it into as many parts as you like, each with its own category and an
  optional note, and it will not save until the parts add up to the transaction exactly. Every
  budget, report and prediction then counts that transaction once, at its parts. A split row
  shows a badge instead of a category name, and Remove split puts it back. Two consequences
  worth knowing: a split transaction leaves the review queue, because you have already said
  where its money went, and the bulk Categorize and Mark transfer buttons skip split rows and
  tell you how many they skipped, since either one would contradict the split. Marking who
  spent it still works normally. CSV export writes one line per part, so a spreadsheet adds up
  to the same totals the app shows.
- **SimpleFIN accounts can sync on their own, every 6 hours, every 12 hours, daily or weekly.**
  Settings -> Connections now has an Automatic sync setting, off until you choose an interval.
  Everything the app tells you is only as current as its data, so this is the difference
  between reports that describe last month and reports that describe now. If a sync fails you
  get one notification that day, and no more. A day whose SimpleFIN request allowance is
  already spent is not treated as a failure and says nothing, since that is the service
  working as designed rather than something to fix.
- **Net worth over time, on Reports and as a dashboard figure.** Every sync now records each
  account's balance, and balances can also be typed in by hand for accounts that do not sync,
  in the same Update account form as everything else. The chart shows what you own, what you
  owe including loans, and the difference, month by month. Two deliberate honesty rules: no
  month is drawn before the first balance was recorded, so the line never invents history, and
  when accounts have no balance yet the card says how many, so a figure is never quietly
  incomplete. This history only accumulates going forward, so the chart is thin at first and
  becomes useful with a few months behind it.
- **A Coming up card showing what the month still owes.** Subscriptions and contracts with a
  billing cycle and amount now project their next due dates, with a total, alongside what the
  budgets have left. Surprises are what actually break a budget, and this is the part the app
  could see coming and was not saying. Bills anchored on the 31st behave correctly in short
  months.
- **Budgets can roll unspent money forward.** Insurance, property tax, car repairs and gifts do
  not fit a flat monthly limit, and every month one of them lands the budget reads as blown,
  which teaches everyone to ignore budgets. Any category can now carry its leftover forward
  from the month you switch it on. Only leftovers carry, never overspend, so one expensive
  month cannot borrow against the next, and the page shows the base limit and the carried
  amount separately so a limit never looks mysteriously larger than what you typed. Budget
  alerts respect the carry, so a category covered by its own leftovers stops warning you.
  Suggested budgets still work from the limit you typed, not the carried total.
- **Three more Reports cards.** Top merchants, which the dashboard had for the current month
  only, now answers the same question over any range. Year over year puts a month beside the
  month before it and the same month last year, which is the only fair way to read utilities,
  holidays and anything else seasonal. Cash flow adds income, spend and the share you kept, and
  says plainly when there was no income rather than printing a percentage of nothing.
- **Tax-relevant categories and a tax year report.** Mark categories as tax relevant in
  Settings -> Managers, and Reports will total a full year of them per person, with a CSV to
  download. One thing to watch: if you flag both a parent category and one of its children,
  the parent's figure already includes the child and the child also has its own row, so the
  rows overlap on purpose. The card says so, because adding up the column is exactly what
  someone does at tax time.
- **Each loan says roughly when it will be paid off.** Based on what has actually been paid
  over the last six complete months, not on the interest rate, which this app still only ever
  displays. The current month is left out because it is usually part way through and would
  understate the pace.
- **An optional monthly summary.** Off unless you turn it on. Early in each month it reports
  the month just finished: what came in and went out, how the budgets did, and the five
  merchants that took the most. It is built from the same figures the pages show, so it cannot
  disagree with them, and it means someone who never opens the app still knows where the
  household stands.
- **The app can be installed on a phone's home screen.** It gets its own icon and opens in its
  own window instead of a browser tab. There is no offline mode: this app lives on your
  network, and cached financial data that might be days stale would be worse than no data.

### Changed

- **One Update account form replaced three separate buttons on Settings -> Accounts.** Each row
  carried a rename box, an owner dropdown, a mapping dropdown and three nearly identical save
  buttons. It is now one form that saves the name, owner, mapping and balance together, plus
  Deactivate. Nothing was removed except the clutter.
- **The scheduler is now allowed to sync.** Until this release it deliberately never could, and
  that rule was enforced by a test. Automatic sync replaces it with a narrower rule: exactly
  one place in the code may start a sync, and only when you have turned the setting on.

### Fixed

Both of these predate this release. Everything else the review turned up was in code written
for this release and never reached a running install, so it is not listed here.

- **Editing a limit you had already set did not wake the budget alerts.** Budget alerts skip
  recomputing when nothing appears to have changed, and that judgement could not see an edit to
  an existing month's limit, only a brand new one. So lowering a limit you had already set left
  the alerts judging your spending against the old number until some unrelated transaction
  happened to land. Worse, re-typing the limit could not be used to force it either, which is
  the obvious thing to try.
- **A failed update check said nothing at all.** If the daily check for a new version failed
  before it started, it stopped silently. Nothing crashed, but unlike every other background
  job it wrote no log line, so there was nothing to explain why update checks had gone quiet.
  It now reports a failure the way the backup and notification jobs do.

## [1.6.0] - 2026-08-22

### Added

- **A joint card statement now attributes each row to the right person.** Before this
  release, every row from a shared account statement landed on whoever owned the account, so
  one person's budgets and reports quietly absorbed a partner's spending too. A mapping can
  now name the column that carries the cardholder (the card member's name or the card's own
  suffix both work), and on the import preview screen you assign each card number to a person
  once. From then on every row lands on the right person automatically. A card the mapping
  does not recognize, or one that was never assigned, falls back to the account owner exactly
  like before, and the message after committing an import tells you the split, for example
  "8 rows to Alex, 5 rows to Sam, 2 rows to the account owner (no card match)," so a
  wrong assignment is obvious right away.
- **Any import mapping, including a built-in bank preset, can now be deactivated.** The
  built-in presets still cannot be deleted, but there was no way to get a bank you do not use
  off the import picker at all. Settings -> Managers can now deactivate any mapping and
  reactivate it later. An account already pinned to a deactivated mapping keeps that pin. It
  just goes dormant until the mapping is turned back on, and everything resumes without you
  touching the account again, as long as you don't import into that account under a different
  mapping while the original is still deactivated. Do that, and the mapping you actually used
  becomes the new pin. Reactivating the original will not bring the old pin back; you would
  need to set it again yourself under Settings -> Accounts.
- **Settings -> Accounts now shows and sets each account's pinned import mapping.** The pin
  already existed, Budget Tracker has remembered the mapping you last used successfully for
  an account since it was first added, but nothing on screen showed what it was, and the only
  way to change it was to run a full import. The Accounts page now shows the pinned mapping by
  name, or "none," and lets you set or clear it directly.

### Fixed

- **An account pinned to a mapping that had since become unavailable left the import screen
  with no mapping actually selected.** The dropdown looked normal, but the pin it was silently
  keying off no longer matched anything offered, so an import could go out under the wrong
  mapping with no visible sign of it. The screen now treats that case exactly like an
  unpinned account and picks a real mapping to start from.

## [1.5.1] - 2026-08-22

### Fixed

- **Settings -> Managers was completely broken by the 1.5.0 update.** The page returned an
  error instead of loading, for every admin, the moment this app ran on a real server instead
  of under a test. One file behind that page breaks a rule the real server enforces that
  neither the test suite nor the build ever check: a file marked this way may only export
  async functions, and one export there was a plain list of route names instead of a function.
  The page works again, and a new automated check now reads every file carrying that rule and
  fails the moment anything besides an async function is exported from one, so this exact
  mistake cannot ship a second time.
- **One import mapping that could no longer be read used to take that same page down with it.**
  Settings -> Managers is also the only screen that can delete a mapping, so the page you
  needed to fix the problem was the page the problem broke. A mapping like that now still shows
  up in the list, clearly marked as unreadable, and can still be deleted instead of wrecking the
  whole page.

## [1.5.0] - 2026-08-22

### Changed

- **Receipts are read by a new engine.** Photographs of receipts, which is what most
  receipts are, come back with far more of the text intact: the vendor, the date and the
  total are found where they were being missed before. Nothing about uploading changes and
  nothing you have already saved is touched. If you want an old receipt read again, the
  Re-run OCR button on its item does exactly that.
- **A few machines cannot run the new engine.** Budget Tracker checks once, the first time
  it reads a receipt after this update, and goes back to the older engine if the check does
  not survive. Receipts still upload and are still read. Settings -> About says so, with the
  reason, when that happens. There is nothing to configure either way.

### Added

- **Your phone straightens the receipt before it uploads.** Take the photo the way you
  already do and the browser finds the paper, squares it up and crops the counter out. It
  shows you the before and after for four seconds and then sends the straightened one; a
  button sends the original instead. If any of that fails, the original uploads and you are
  not told about it, because there is nothing you would do differently. This has been proven
  against a stand-in for the browser's own image-processing step, not yet against a real
  phone in a real browser, so keep an eye on the first few receipts you scan after this
  update.
- **The image is larger.** It now carries the recognition models inside it, so an install
  with no internet works exactly the same as one with it, plus the scanner your browser
  downloads once and caches.
- **Every change now runs the full test suite before it can be released.** A push or a pull
  request runs the whole suite and the typechecker, and a release tag can no longer publish
  an image unless that suite passes. Until this release, every check this project had ever
  passed was one run by hand on one machine.

### Fixed

- The release workflow no longer claims the OCR assets are the same on every processor. They
  were, and now one of them is not.
- **CSV import figures out the date format for you, and says so when it cannot be sure.**
  A file re-saved on Windows, where `28 May 2026` became `26-May-26`, used to fail outright.
  The mapping screen now samples the date column itself and offers a one-click switch when it
  recognizes a different format than the one selected. When the same text could honestly
  mean two different dates depending on which side is the day, it warns you plainly instead
  of quietly picking one, on both the regular import screen and the new-bank setup wizard.
- **An import mapping can finally be deleted.** The built-in bank presets stay protected.
  Deleting any other mapping clears its references first: an account loses only a remembered
  default and a past import loses only the record of which mapping it used. Neither the
  account nor the import itself is touched, and the delete is no longer refused.
- **A new or renamed category shows up everywhere, not just on the managers page.** The
  dashboard, budgets, reports, transactions and review pages now all refresh when a category
  changes, so a new child category appears right away instead of after the page cache expires.
- **The new engine can be switched off by hand if it misbehaves.** One line in the
  container's environment settings and a restart send every receipt back through the older
  engine immediately, without waiting for the automatic check to run again.
- **A receipt that crashes the app no longer restarts it forever.** After a few failed
  attempts across restarts, that one receipt is marked unreadable instead of taking the
  whole app down every ten minutes.
- **Settings -> About now names the engine currently reading your receipts**, and says so
  plainly if receipts have stopped being read altogether rather than one failure at a time.
- **The scanner's before/after preview, and the plain receipt thumbnail next to it, now
  actually show a picture.** Both were silently blocked by this app's own browser security
  rules; receipts still uploaded and were still read, the image just never appeared. The
  thumbnail has been broken this way since the warranty feature first shipped, unnoticed
  because the rule that blocks it does not apply under the test tooling this app's suite
  runs in.

### Security

- **The two scanner files your browser downloads are now pinned by checksum**, the same
  integrity check the recognition models already had. A tampered or truncated copy fails the
  build instead of being served to every browser in the house.

## [1.4.0] - 2026-08-19

This release adds no migration, no table and no column, and it makes no outbound connection it
did not make before.

### Added

- **A suggested monthly budget for every category with enough history.** Budgets shows what
  the last six full months point at, and one button writes it. The number is the median of
  those months, nudged half way toward a rising or falling trend, adjusted for the same month
  last year once there is enough history to know what that month usually looks like, capped at
  three times the median and rounded up to the dollar. Suggestions appear once there are three
  full calendar months, and each one carries a confidence label you can see before you press.
- **Apply all suggestions**, per section, which fills in only the categories you have not set a
  limit for. Nothing you have typed is ever changed, and the message tells you how many were
  set and how many were skipped.
- **A pace projection from the seventh of the month.** Each category with a limit shows where
  the month is heading if the rest of it looks like the part already spent, in the same colour
  the progress bar uses when a budget is blown. It says out loud what it assumes.
- **A Category baselines card on Reports**, with each category's median, average, trend and
  suggested amount over the last six full calendar months. It deliberately does not follow the
  date filter above it, and the card says why.
- **Six new notifications**, off or on per person per channel in the toggle matrix you already
  have: a budget on pace to go over, an unusually large charge, a recurring charge that went
  up, a possible duplicate charge, and two start-of-month summaries. Like every notification
  before them, they send nothing to anybody who has not set up a channel.
- **Date-range presets.** Reports and Transactions get one picker with This month, Last month,
  Last 3 months, Last 6 months, Year to date, Last year and Custom. The range lives in the URL
  as a name rather than a pair of dates, so a phone in another timezone sees the same
  "This month" the server does, and the Export CSV link covers exactly what the page shows.

### Changed

- Transactions remembers the dates you filtered by when you reload the page. It still shows
  everything by default, because that is the page you open to find a charge from March.

## [1.3.1] - 2026-08-18

### Changed

- **The prebuilt-image compose file now drives Watchtower from the app instead of polling
  daily.** If you replace your compose file with the new one, updates are OFF until you turn
  them on: open Settings -> About and press "Enable update checks", once. Existing installs
  that keep their current compose keep their daily poll and carry on exactly as before; the
  app notices, and tells you how to move over. docs/INSTALL-SYNOLOGY.md has the three steps.

### Added

- **In-app update checks, off until you ask for them.** Settings -> About gains an Updates
  card. Switch it on and once a day the app asks GitHub whether a newer version of Budget
  Tracker has been published. That request carries the version you are running and nothing
  else: not your data, not your address, not how many people use this install. Until you
  press the button it makes no such request at all.
- **Small updates install themselves; a major version never does.** Bug-fix and feature
  releases are applied unattended through the Watchtower companion. A major version is parked
  behind a screen that shows that version's own release notes, a plain warning that your data
  is not touched, and a confirm button with the version number in its label. There is no
  setting that changes this.
- **A notification when an update is waiting**, for admins, on whichever channel they already
  use. It fires only when the app will not apply the update itself.
- **Loan money-tracking.** A loan item in Contracts & Coverage now carries what you borrowed,
  the interest rate (shown for reference, never used in a calculation), the balance still
  owed, and its regular payment. The form says "Payment" and "per month" for a loan, where a
  subscription says "Billing" and "/ month".
- **Payment matching.** Tell a loan what its payments look like on your statement and the
  balance goes down on its own as they land, with an opt-in pass over the last twelve months
  for the case where the balance you typed predates them. The payment still counts in your
  budget and in your reports, because it is money that left the household.
- **A Loans card on the dashboard** showing the total owed, a payoff bar and the next payment
  date, and a **Debt over time** line on the Reports page. The line breaks where a loan's
  history is unknown rather than inventing a number.

### Fixed

- **Telegram setup no longer forces you to have a chat ID before you can save a bot token.**
  Pasting a token and pressing Save used to be rejected outright if the chat ID field was
  still empty. It now saves the token on its own, tells you to press Detect chat ID (or type
  one in) and save again, and only refuses the save if Enabled is ticked with no chat ID set.
- The release workflow moves to actions/checkout@v5 and actions/setup-node@v5, clearing the
  Node 24 deprecation warnings.
- The Docker build no longer warns about the build-stage SECRET_KEY placeholder.
- Two notification tests were passing without exercising the rule they named, and a third
  asserted less than its title claimed. All three now prove what they say.
- An unreachable third relay check in the notifications test-send path is gone, and the one
  in the outbox that IS load-bearing now says so.

## [1.3.0] - 2026-08-17

### Added

- **Notifications.** A new Settings -> Notifications page tells the household about the
  things it would otherwise have to remember to check on: something coming due, a budget
  getting close or blown through, the nightly backup failing, a new sign-in, a restore
  finishing, or nothing imported in a while. Eight events in total, each switchable per
  person and per channel.
- **Two channels.** A personal Telegram bot per user, and a household SMTP relay with a
  personal destination address per user. Email setup has one-press presets for Brevo,
  SMTP2GO and Gmail, plus a Custom option for anything else.
- **Send test** on every channel, so nobody has to trust that setup worked and wait for
  the real thing to fire.
- **Built-in setup guides**, written for someone who has never touched SMTP or a Telegram
  bot before, one for Telegram and one per email preset, shown right beside the form they
  describe. A **Detect chat ID** button asks Telegram which conversations your bot has
  heard from and lists them by name, so nobody has to copy a numeric id out of a raw JSON
  page.
- **Per-person schedule and threshold controls**: the warning window before something
  comes due, the budget percentage that counts as close, the staleness period for "nothing
  imported lately", and the hour the daily and weekly messages go out. Daily and weekly
  sends catch up on a missed slot after downtime instead of silently skipping it.
- **Recent deliveries** on the same page, showing what was sent, on which channel, and the
  provider's own error text when a send failed.

### Security

- The SMTP password and every Telegram bot token are encrypted at rest under keys derived
  from `SECRET_KEY`, the same way the existing TOTP secrets and the SimpleFIN access URL
  already are. They are never sent back to the browser, never logged, and shown masked in
  the form after saving.
- **A new sign-in alert is on by default**, naming the time, IP address and browser, so a
  household notices a login it did not expect.
- **Dormant until configured.** With no channel set up, notifications make no outbound
  connection at all, and the only two destinations the feature can ever reach, once
  someone does configure it, are `api.telegram.org` and the SMTP server an admin typed in.

## [1.2.4] - 2026-08-17

### Fixed

- **Edit no longer opens below the item detail view.** On a Contracts & Coverage item's
  detail page, clicking Edit used to render the edit form BELOW the still-visible read-only
  view, so a scrolled-down member saw no change and assumed the click did nothing. The edit
  form now replaces the read-only view in place; Cancel edit (or a successful save) restores
  the view.
- **Success message now names the item's actual kind.** Saving an edit used to always say
  "Warranty updated.", even for a subscription, contract, or loan. The confirmation now reads
  "Subscription updated.", "Contract updated.", "Loan updated.", or "Warranty updated." to
  match the item's own type, reusing the existing per-kind noun matrix in
  `src/lib/warranty/constants.ts`. A handful of generic error strings in `actions.ts` that
  hard-coded "warranty" regardless of kind (e.g. "That warranty no longer exists.") were swept
  to the neutral "item" wording at the same time.

## [1.2.3] - 2026-08-17

### Added

- **Automatic updates for the prebuilt-image install.** `install/synology-compose-pull.yml`
  now ships a Watchtower companion service alongside `budget-tracker`. Watchtower polls GHCR
  once a day, pulls a newer `:latest` image when one is published, and recreates the
  container against it. You no longer need to re-pull manually or click Update in Container
  Manager. Database migrations already run automatically on boot, so the container can be
  replaced unattended without any extra step. Scoped to this app only via
  `com.centurylinklabs.watchtower.enable: "true"` on the budget-tracker service and
  `WATCHTOWER_LABEL_ENABLE` on watchtower, so the socket access it needs never reaches any
  other container on the host.
- **Billing cycle and amount for subscriptions and contracts.** The add/edit item form now
  shows a Billing cycle select (Monthly/Annual, defaulting to "Not set") and an amount field
  for items whose type is a subscription or contract, never for warranty or loan. The item
  detail page and the items list show the formatted amount and cycle (e.g. "$15.99 / month")
  wherever it is set. Enforced server-side by looking up the selected type's kind, matching
  every other kind-dependent rule in the tracker (migration `0005_billing_cycle.sql` adds the
  two nullable, CHECK-constrained columns to `warranty_items`).

### Changed

- Pinning `synology-compose-pull.yml` to a specific version tag now also means opting out of
  auto-updates: Watchtower only replaces a container when a newer image lands for the tag it
  is already running, so a pinned numeric tag is left alone. The compose file's comments and
  `docs/INSTALL-SYNOLOGY.md` now document this trade-off and how to remove the watchtower
  service entirely if you would rather it not run at all.
- `docs/INSTALL-SYNOLOGY.md`'s update instructions now lead with "nothing to do" for the
  default auto-updating install, keep the manual tag-edit path for pinned installs, and note
  that Container Manager's Image tab "Update" button does not work for GHCR images (Docker
  Hub only), which is why Watchtower exists in the compose file at all.

### Fixed

- Existing pre-1.2.3 installs of the prebuilt image had no update mechanism at all: Container
  Manager cannot detect GHCR updates and never re-pulls an already-present `:latest` tag, so
  those installs were effectively stuck on whatever image they first pulled. Documented the
  one-time YAML-replace step to adopt the new compose file and gain auto-updates.
- An open-ended item (the "no end date" / Lifetime checkbox) used to render its end date as a
  bare blank or em dash on the items list and detail page, indistinguishable from missing data.
  It now shows a proper per-kind word instead: "Lifetime" for a warranty or subscription,
  "Ongoing" for a contract, "Open-ended" for a loan. Open-ended items were already excluded
  from the dashboard's "Coming due" widget and every expiring-soon query; a regression test
  now pins that guarantee.
- Mobile menu now opens in view when scrolled (was rendering off-screen at page top).

## [1.2.2] - 2026-08-17

### Added

- **Contract and loan item kinds.** Item types now carry a `kind` (warranty, subscription,
  contract, or loan) alongside the existing subscription flag (kept, and derived from `kind`
  on every write). Loans and contracts reuse the exact same start-date/term/end-date fields as
  warranties and subscriptions; loans are dates and documents only, with no balance, payment
  schedule, or interest math (deliberate scope cut).
- **Kind-aware wording** throughout the tracker: the add/edit forms, the list, the detail page
  and the dashboard widget all show labels and verbs (start date / term / end date / "expires"
  vs. "cancel by" vs. "ends on" vs. "paid off by") that follow the item's own kind, and, on
  the add and edit forms, follow the **currently selected type live**, before saving.

### Changed

- **The warranty tracker is renamed "Contracts & Coverage"** in the navigation, the list page
  title and the add-item header. The rename reflects user feedback that the tracker had grown
  past warranties alone. Labels only: every route, action and field name is unchanged.
- Form labels changed to match the new kind matrix: "Warranty length" → "Warranty (months)",
  a subscription's "Period start" → "Start date", "Period length" → "Duration (months)", and
  the "Cancel by" label → "Cancel-by date" (detail page) / "Active through" (live badge).
  Deliberate, owner-approved wording changes. See the design spec §19.12 for the full list.
- Dashboard widget retitled "Warranties expiring soon" → **"Coming due"**.
- List page empty state retitled "No warranties yet" → "Nothing tracked yet", naming all four
  kinds.

## [1.2.1] - 2026-08-17

### Added

- **Zero-config SECRET_KEY.** A fresh install no longer needs one set at all: if `SECRET_KEY`
  is unset on first boot, the app generates a random key itself at `data/secret.key` and
  reuses it on every start after that. Setting `SECRET_KEY` yourself still works exactly as
  before and always takes precedence. This only removes the requirement, not the option.
- **Prebuilt multi-arch images on GHCR.** Tagging a release (`v*`) or running the new
  `Release image` workflow by hand builds and pushes `ghcr.io/vibelogiccode/budgettracker`
  for linux/amd64 and linux/arm64, tagged with both the version and `latest`. Paired with a
  new pull-only compose file, `install/synology-compose-pull.yml`, installing no longer
  requires a source checkout or a `docker build`. It is an Immich-style paste-and-go install
  on Synology, QNAP, Unraid, or any other Docker host.

### Changed

- `docker-compose.yml`, `install/synology-compose.yml` and `install/synology-compose-pull.yml`
  no longer require `SECRET_KEY` to be set before starting: the pull compose drops the
  placeholder line entirely, and the other two ship it commented out as an optional override.
  The install scripts (`install-linux.sh`, `install-windows.ps1`, `install-synology.sh`) are
  unchanged: they still generate a `.env` with its own `SECRET_KEY` up front, which remains
  best practice for a script-driven install and simply takes precedence over the generated
  file, same as any other explicitly-set `SECRET_KEY`.

## [1.2.0] - 2026-08-17

**Verify after updating:** restore a backup once via Settings → Backups → Restore: the app
will restart itself, be unreachable for about 30 seconds, and show the restore outcome on
Settings → Backups when it comes back. If your container runs without a restart policy
(docker-compose.yml ships restart: unless-stopped, so this is only relevant for a custom
setup), starting it back up by hand applies the restore the same way.

### Added

- **Restore from Settings.** Restoring a backup no longer requires stopping the container by
  hand: pick a backup on **Settings → Backups**, tick the confirm box and click **Restore and
  restart**. The archive is fully validated before anything is staged, then the app restarts
  itself and applies the restore on the way back up, before the database is opened. The page
  is unreachable for about 30 seconds, and refreshing it afterwards shows whether the restore
  succeeded. The previous database and (for a `.tar.gz` restore) the previous receipts folder
  are kept as timestamped safety copies and swept after 30 days, with the most recent of each
  always kept. If the container has no restart policy, nothing is lost: the request survives
  on disk and is applied the next time the app is started, by hand or otherwise. A backup made
  by a newer version of Budget Tracker than the one running is refused with an explanation.
- **A modern visual redesign**, light and dark, following your device's theme by default with
  a manual toggle in the header that remembers your choice. Every page (dashboard,
  transactions, import, review, budgets, goals, reports, warranties and every settings page)
  now shares one design system: a real navigation rail on desktop that collapses to a top bar
  and menu on phones, consistent cards, tables, buttons and empty states, and signed amounts
  coloured by sign. Accessibility pass included: clearer focus rings, labelled icon-only
  buttons, and form fields properly associated with their labels.

### Changed

- The `restore-backup` CLI gains `--allow-newer` to bypass the one-way migration guard for a
  genuine disaster-recovery case, and now takes its own timestamped safety copy of the
  database (and receipts, for an archive) before writing anything, with the same preflight
  validation the in-app restore uses.
- The README and INSTALL guides now lead with the Settings → Backups restore path, keeping the
  CLI procedure as the documented fallback for when the app will not start at all.

### Fixed

- Synology installs no longer assume `/volume1`: the installer roots at wherever the project
  checkout actually lives, so any-volume installs work correctly.
- An inherited Synology ACL on the data directory could leave the database unopenable
  (`SQLITE_CANTOPEN`) even with permissions showing `777`; the installer now removes the
  inherited ACL so the container can actually write to it.
- Existing Synology installs updating from the old absolute-path compose file: move your
  existing `data` folder into the project folder (or keep your old absolute-path `volumes:`
  line) before pasting in the new compose, otherwise the app boots empty against a fresh
  `./data`.

### Security

- Restoring a backup is admin-only and same-origin-checked, and restorable artifacts are
  limited to files already inside `data/backups` that match the backup naming pattern.
- A backup made by a newer version of Budget Tracker than the one running is refused (the
  `restore-backup` CLI's `--allow-newer` flag overrides this for disaster recovery).
- The Synology data directory is no longer created world-writable: the installer now sets
  `chmod 770` instead of `777`.

## [1.1.0] - 2026-08-16

### Added

- **Warranty tracker.** Record what you bought, who owns it, what it cost and how long it is
  covered: months, or a Lifetime tick for the things that never expire. A new Warranties
  page lists everything with an at-a-glance badge: active, expiring soon, expired, lifetime,
  or term unknown.
- **Item types**, admin-maintained under **Settings → Item types** (Laptop, Appliance and
  Subscription seeded), and **subscription tracking**: a subscription item reuses the same
  purchase-date/months fields as a period start and length, is labelled "cancel by" instead
  of "expires" throughout, and is covered by the same dashboard reminder before the period
  ends. A type still in use by an item cannot be deleted until those items are moved to
  another type.
- **Receipts as evidence.** Photograph a receipt with your phone (the Add form opens the rear
  camera directly) or attach a PDF. Files are stored on the data volume beside the database
  and are only ever served to a signed-in member.
- **Every word on the receipt is searchable.** Receipts are read by an OCR engine that runs
  entirely on the server with no internet connection, and the text is folded into a full-text
  index. Searching for a store name, a model number or a line item finds the item, and
  typing `metro` finds `MÉTRO`.
- **Suggest and confirm.** After a receipt is read, the purchase date, vendor and total are
  proposed in the form. Nothing is ever saved without you pressing Save, and a field you have
  already typed into is never overwritten.
- **Warranties expiring soon** on the dashboard: the next 60 days, top five, scoped by the
  person switcher, and hidden entirely when there is nothing to show.
- **Create warranty** from a transaction row, which fills in the date, the price and the
  vendor from the ledger entry and links the two.
- Forced password change on first login. A user created by an admin, or whose password an
  admin has reset, must choose their own password before any other page opens. Changing it
  signs them out everywhere else and keeps the browser they are using signed in.
- Goals can be un-archived: a "Show archived" toggle on the Goals page, with a Restore
  button on each archived goal.
- The import preview now reports how many rows the profile's skip rules dropped, so a
  mis-typed rule no longer looks like a short file.
- Settings gains an About panel showing the running version and this changelog, a version
  string in the page footer, and a `version` field on `/api/health`.

### Changed

- **Backups are now `.tar.gz` archives** containing the database *and* every receipt file,
  instead of a bare `.db` copy. Older `.db` backups from v1.0.0 are still listed, still
  counted against your retention setting, and still restore. Restoring one leaves your
  receipts folder completely untouched. A v1.1 archive cannot be restored by a v1.0.0
  install; downgrading has never been supported.
- Restoring is now driven by `npm run restore-backup`, which detects the artifact type by its
  contents rather than its file name, refuses anything it does not recognise, and moves an
  existing receipts folder aside rather than deleting it. It is still an offline procedure
  with the container stopped. There is deliberately no in-app restore button.
- Copying budgets from the previous month now includes archived categories, matching what
  the budgets page already shows for archived spend.
- A manually entered transaction runs the categorization engine even when a category was
  chosen, so a hand-typed card payment is recognised as a transfer and rename rules apply.
  The chosen category is always kept.
- Other members' personal budget sections render read-only for non-admins instead of
  offering limit inputs and a copy button that the server would refuse.
- The Budgets page shows one message banner instead of two, so a stale success can no
  longer sit next to a fresh error.

### Fixed

- CSV export now neutralises spreadsheet formula triggers (`=`, `+`, `-`, `@`, tab) in
  exported text, while leaving plain numbers (the whole Amount column) as numbers.
- Transaction search treats `%` and `_` literally instead of as SQL wildcards, so
  searching for "50%" no longer matches "5000".
- Busy guards on the import undo button and the bank-profile wizard upload prevent a
  double-click from repeating the request.
- `scripts/reset-admin-password.ts` refuses a database path that does not exist instead of
  silently creating an empty database and reporting that the account is missing.

### Security

- The receipt file route is session-authenticated with an Origin check, serves the stored
  content type rather than a sniffed one, and hands PDFs over as downloads instead of
  opening them inline: a same-origin inline PDF would run the viewer's JavaScript in this
  app's origin.
- Search input is escaped into full-text-search syntax as literal phrases, so a query
  containing a quote or the word `AND` returns results instead of an error.
- Uploaded files are accepted on their leading bytes only, never on their name or the type
  the browser claims, and are stored under server-generated names that can never contain a
  path.
- Backup archives now contain photographs of receipts. They remain unencrypted, exactly like
  the database: if you copy them off the NAS, use your backup tool's client-side encryption.
- An admin "reset MFA" now signs the target user out everywhere, matching what an admin
  password reset already did.

## [1.0.0] - 2026-08-16

Initial release: a self-hosted household budget tracker for a home NAS.

### Added

- **CSV import** with built-in Canadian bank presets (TD Chequing/Debit, TD Visa,
  Scotiabank Chequing/Debit, Amex Canada), a preview-and-confirm step with an editable
  column mapping, copy-on-write profile forking, encoding detection, a versioned duplicate
  hash that survives overlapping exports, per-import undo, and a wizard that builds a
  profile for any other bank from a sample file.
- **Learning categorizer**: merchant rules plus a naive-Bayes classifier that trains on
  confirmed corrections, transfer detection for card payments, merchant renames with
  `manual > rename > raw` precedence, and a review queue of everything uncategorized or
  auto-guessed.
- **Budgets**, household and per-person, with monthly limits that carry forward until
  changed, category rollup, refunds netting against spend, and copy-from-previous-month.
- **Goals** with contributions, trailing-average pace, required monthly amount against a
  target date, and archiving.
- **Accounts, transactions and reports**: manual entries, bulk categorize/attribute/
  transfer actions, per-person attribution on joint accounts, cashflow trend, category
  breakdown, month-over-month comparison, top merchants, and CSV export.
- **Authentication and security**: argon2id passwords, a first-run setup wizard, optional
  TOTP two-factor with QR enrollment and single-use recovery codes, admin MFA reset,
  server-side sessions with sliding expiry, two-layer login rate limiting, an
  Origin-verified CSRF check on every mutating request, and a strict nonce-based CSP.
- **Backups**: scheduled and on-demand `VACUUM INTO` snapshots with retention, download
  from the browser, and a documented restore procedure.
- **Sharing packs**: export and import privacy-preserving merchant-rule and import-profile
  packs.
- **SimpleFIN connector** (optional, dormant until configured): claim-once setup token, an
  encrypted access URL, manual sync with overlap windows, and the same undo path as CSV.
- **Installers and operations**: Linux, Windows and Synology install scripts, a
  manual-only update script with automatic rollback, a Docker image that runs non-root on
  a read-only root filesystem, a container healthcheck, and a password-reset rescue tool.
