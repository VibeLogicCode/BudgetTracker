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
