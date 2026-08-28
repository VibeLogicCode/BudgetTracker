# Pending work

Approved but not started, plus one item that has now shipped and is kept here only long enough
to record how it differed from the plan.

## 1. Split a transaction into parts — SHIPPED in v1.7.0

Raised 2026-08-22 as its own release, estimated 12 to 20 hours. The owner then chose to fold it
into v1.7.0 with everything else, and it shipped there. This section is kept because the design
that shipped is NOT the one sketched here, and anyone reading the old sketch would be misled.

**What was sketched:** the parent row becomes a container excluded from every sum, child
transaction rows carry the categories, children get a NULL `dedup_hash`.

**What shipped instead:** a separate `transaction_splits` table (migration 0009). The parent
transaction is untouched, and every category aggregate LEFT JOINs the split table and reads
`coalesce(split.category_id, transactions.category_id)` and `coalesce(split.amount_cents,
transactions.amount_cents)`. A transaction with no splits behaves exactly as before, byte for
byte, which is what let the conversion land without disturbing existing behaviour. No child
transaction rows exist, so there is nothing for dedup to collide with and nothing to exclude
from sums. The audit this file called "the part that is actually the work" was done as its own
task with its own review, as recommended.

**How the open seams were decided:**

- Per-split `attributed_user_id`: NOT built. Attribution stays whole-transaction, so both
  halves of a split land on the same person. The shared-restaurant case is therefore only half
  solved: the categories split, the person does not. Revisit if that matters in practice.
- Per-split transfer flags: NOT built. A transfer cannot be split at all, and a split
  transaction can no longer be flagged a transfer.
- Re-entering the review queue: a split transaction LEAVES the review queue, because the split
  is the answer the queue was asking for. Clearing the split puts it back.
- Editing after the fact: yes, the editor replaces all parts at once, and the sum-exactly
  invariant is re-checked on every save.
- Splitting a split: not applicable, since parts are not transactions.
- Loan matching: untouched and orthogonal, verified by review. A transaction can be both split
  and loan-linked with no interaction.
- Categorizer corpus: splits do NOT train it. A split describes one transaction, not a rule
  about that merchant.

**Worth knowing:** the review of this feature found six defects that a 3,500-test suite did not
see, five of them in the interaction between splits and code that already existed. If splits are
extended, review the interaction surface rather than the new code.

## 2. Category selects do not group children with their parents — SHIPPED in v1.8.0

Fixed 2026-08-23. `src/lib/category-order.ts` exports `categoryOptions()`, which flattens the
tree parent-then-children and is now the single source of select ordering. Kept below because two
things about the shipped fix differ from this write-up, and one new defect was found next door.

**The call-site count in this file was wrong.** It said four (review's two selects, the
transactions client, the managers client). `transactions-client.tsx` alone turned out to have
FIVE category-`<option>` blocks — filter bar, bulk-categorize toolbar, manual-entry form, split
editor, and the per-row select. All five are converted, plus review's two. Counting them by
reading the file rather than trusting this note is what caught it; the first pass converted only
the two that had been named, which briefly left one screen with two grouped selects and three
flat ones — worse than uniformly flat, since inconsistency inside one screen reads as a bug
rather than as a limitation.

**The helper lives in its own module, not in `src/lib/categories.ts` as this file suggested.**
`categories.ts` imports `@/db/client`, and every select call site is a `'use client'` file, so
exporting the helper from there would have pulled better-sqlite3 into the browser bundle and
broken `next build` while `tsc` and the whole suite stayed green — the exact v1.7.0 release
blocker. `category-order.ts` imports only the TYPE, which erases at compile time, and
`tests/ops/client-bundle.test.ts` enforces it.

It takes `CategoryLike = Pick<CategoryRecord, 'id'|'name'|'parentId'|'sortOrder'|'isArchived'>`
rather than the full record, so existing test fixtures that only ever set four of the nine fields
did not all have to grow five more.

**The archived-category interaction.** `categoryOptions()` excludes archived categories, which
collides with the per-row select's deliberate rule that an archived category must still render
(disabled, suffixed) so a row already carrying one keeps it selected instead of silently falling
back to "Uncategorized" and having an untouched Save clear a legitimate historical
categorization. Resolved by grouping the live options and appending the archived ones flat and
disabled after them.

**Indentation is ` `, written as an escape sequence, never as a raw byte.** `<option>`
collapses ordinary spaces, so the indent has to be a non-breaking space — but a raw U+00A0 in
source is invisible and the next person to normalize whitespace silently removes the indentation.
Both the implementer and the reviewer emitted raw bytes here by accident before catching it, so
if a select ever loses its indent, check the bytes first.

## 2a. Settings → Categories admin table has the same ordering defect

Found 2026-08-23 while converting the selects, not fixed, small.

`src/app/(app)/settings/managers/managers-client.tsx:168` renders the categories admin table from
raw `(sortOrder, id)` order and fakes nesting with a `paddingLeft` on each row. So it indents
rows that are not actually adjacent to their parent — the same underlying defect as the selects
had, in a table rather than a `<select>`.

It was listed as a call site in the original report, but it is not a select and `categoryOptions`
returns option data, so it was left alone rather than half-converted. The fix is the same helper:
drive the row order from `categoryOptions()` and take the indent from `opt.depth` instead of
computing it from `parentId`. Maybe 15 minutes.

**Reported** with a screenshot of the review screen's category select: the list ran
`... Kids, Fees, Fees > Bank Fees, Fees > Interest, Kids > Education`, so `Kids` and
`Kids > Education` were nowhere near each other.

**Verified cause. Nothing is wrong with the data, this is display ordering only.**
The review page feeds `listCategories()` straight into the select, and that returns a FLAT list
ordered by `sortOrder ASC, id ASC`. Parent and child adjacency is therefore incidental: the
seeded categories happen to sit together because they were created together, and a newly created
child gets a later id and lands at the end of the list.

**Owner ruling: order it the same way the Budgets page does.**

**This needs no new sort rule.** Budgets takes `listCategories()`, filters to top level, and
attaches each parent's children in that same order. That is exactly what the existing
`categoryTree()` helper already produces, because it preserves `listCategories()` order at both
levels. So the fix is to flatten `categoryTree()` — parent, then that parent's children — which
matches Budgets by construction rather than by re-implementing a rule that could later drift.

**Fix.** One exported helper in `src/lib/categories.ts` returning the flattened tree, then switch
every select call site to it so a future new category cannot reintroduce the bug on one screen
only. Grep for the call sites rather than trusting a line number; v1.7.0 moved several of them.
As of v1.7.0 they are the review client (two selects), the transactions client (its filter select
AND the per-part selects in the new split editor), and the managers client.

Worth a test asserting a child immediately follows its own parent, and that the order matches
what Budgets renders, so the two cannot diverge.

**About 30 to 40 minutes**, most of it in making every call site share the helper.

## 3. Nothing alerts when the balance pipeline quietly stops

**Owner declined the alert on 2026-08-23** ("leave this"). Not started, and not to be started
unasked. Recorded in full below because the reasoning still holds and because v1.8.0 narrowed
the exposure considerably without closing it.

**What v1.8.0 changed.** Balances are now resolved as newest-snapshot-plus-movement
(`src/lib/balance.ts`), and a statement's own balance column writes a `source='csv'` snapshot on
every import (`ImportMapping.balanceCol`). So for any account whose bank publishes a running
balance, a snapshot now lands every time a statement is imported, and the stale window shrinks
from "whenever SimpleFIN last worked" to "since the last import". Staleness also now keys on the
ANCHOR date rather than the resolved figure, so an account carrying an old anchor still reports
as stale even though the resolver returns a current-looking number.

**What is still exposed.** An account with no balance column and no SimpleFIN link — a credit
card whose export carries only charges — moves only when someone types a figure. Its resolved
balance stays arithmetically correct from the CSV, but a genuinely missed statement shifts every
balance after it with nothing to catch it. On accounts WITH a balance column, `reconcileAccount`
(v1.8.0) does catch it. On accounts without one, nothing does.

Deferred during the v1.7.0 review on 2026-08-23. The disclosure half was fixed; the alert half
was not.

**The problem.** A net worth figure is built from balance snapshots that carry forward. If an
account stops producing snapshots, the last one keeps being counted at full weight. v1.7.0 added
an `accountsStale` count and says so on both the dashboard tile and the Reports card, so the
figure is no longer presented as complete when it is not. But nothing actively tells anyone.

**Why the existing alert does not cover it.** `stale_import` keys off the `imports` table, and
`runSync` writes an import row even when the balance-snapshot write inside it fails. That failure
only reaches `console.error`. So transactions can keep importing normally, `stale_import` stays
quiet because imports are arriving, and the balance side can be broken for months with no signal
except a number on a page nobody is required to look at.

**Shape of the fix.** One more event on the existing registry, so no migration: raise it from the
daily slot when any active account's newest snapshot is older than the staleness threshold, keyed
per account per week so it nags at most weekly rather than daily. `STALE_SNAPSHOT_DAYS` in
`src/lib/networth.ts` is already the threshold and should be reused rather than duplicated.
Consider also making the snapshot-write failure inside `runSync` visible rather than only logged,
since that is the specific path that breaks silently.

**Small**, an hour or two, and it is the difference between an honest number and a number someone
notices is wrong six months later.

## 4. Receipt scanner: real-browser verification — CLOSED for desktop Chrome

The v1.5.0 ledger carried "STILL OWED: ANY real-browser verification of the scanner", because the
owner declined the offered Playwright check on 2026-08-22 and the scanner shipped verified only
against recording fakes at the `loadScanner` boundary.

**Owner exercised it in desktop Chrome on 2026-08-23 and reports it working.** That closes the
open-ended part of the item.

**Remaining untested: iOS Safari**, and it is untested for different reasons than Android Chrome
was. Three things differ there and none are exercised by any test in this repo: its own WASM
memory ceiling (the bundle compiles a ~9 MB inlined wasm, which is exactly the size class iOS
kills tabs over), its own file-picker behaviour, and HEIC photos straight off an iPhone camera
roll, which desktop Chrome never produces.

**If no household member uses an iPhone, this item is closed outright** — that is the whole
condition, and it is written as a condition rather than as an open "untested" line so it does not
sit here forever collecting doubt. Android Chrome is no longer called out separately: the F5 fix
below removed the failure mode that made a slow phone dangerous.

## 5. Scanner "unavailable" message is unreachable in production

Found on 2026-08-23 while doing the F5 injection fix (v1.8.0), not fixed, small.

v1.8.0 added `SCANNER_UNAVAILABLE_MESSAGE` to `src/components/warranty/ReceiptUploader.tsx` so a
person whose scanner fails is told why their photo uploaded unscanned. It is wired into
`decide()`'s catch block — which is dead code in production, because `scanReceiptFile()` has its
own top-level try/catch that swallows everything and returns `{file}`. Only a test that mocks a
rejection reaches it.

**So the timeout case is still silent.** On a slow phone: the uploader says "Preparing the
scanner", 15 seconds pass, `SCANNER_LOAD_TIMEOUT_MS` fires, and the original photo uploads with no
explanation. Behaviour is correct (MUST-8.15 — a failure costs nothing but a plain upload) but
unexplained.

**Fix shape.** `ScanResult` needs to distinguish "the scanner could not load" from "the scanner
ran and found no paper". Both currently return `{file}`, and they must not share a message: no
paper found is a benign per-photo outcome and saying "scanning is unavailable" there would be
actively misleading. About 30 minutes. Deliberately left out of v1.8.0 as scope beyond the F5 fix
itself.

## 5a. Reconciliation is an N+1 that grows with statement history

Shipped that way in v1.8.0, deliberately, correctness unaffected. Recorded with the arithmetic so
it is a known cost rather than a surprise.

`reconcileAccount` (`src/lib/balance-reconcile.ts`) walks an account's `source='csv'` snapshots
and calls `movementBetween` once per consecutive PAIR, and
`src/app/(app)/settings/accounts/page.tsx` calls `reconcileAccount` once per account on every
load of Settings → Accounts.

**The growth.** TD's export carries a running balance on every transaction row, so importing it
writes a snapshot per statement DATE — roughly 20 a month. A year of one chequing account is
therefore ~250 snapshots, ~249 pairs, ~249 queries. Across five accounts with a year of history
that is well over a thousand queries per page load, and it grows linearly with history forever.
Each one is a prepared indexed lookup in the tens of microseconds, so the real cost today is tens
of milliseconds on an admin page — fine, but pure waste, and unbounded.

**Why it was not collapsed into one query.** The obvious fix is to fetch the account's
transactions once and bucket them per interval in JS. But that would give this module its own
transaction sum, and ruling R1 (raw `amount_cents`, no transfer filter, no splits join) is
deliberately implemented in exactly ONE file so `tests/ops/balance-invariants.test.ts`'s grep can
guard it. A second sum here is precisely the drift that guard exists to prevent.

**The fix that keeps R1 intact:** add a `movementByInterval(accountId, dates[])` to
`src/lib/balance.ts` returning a map of interval to movement, computed there in one query (or one
fetch-and-bucket) — so reconciliation gets two queries per account regardless of history and R1
still lives in one place. About 30 minutes.

**A cheaper alternative worth considering first, but it is a product decision, not a refactor:**
bound reconciliation to recent history — the last N pairs, or snapshots inside the last 12
months. That caps the work AND arguably improves the diagnostic, since a discrepancy from three
years ago that the owner has already decided to live with should probably stop being reported. It
needs a ruling on the window, so it was not chosen unilaterally.

## 5b. TypeScript 7 — retested 2026-08-23, still blocked, now by TWO things

Standing owner ruling: revisit when Next.js supports it. Retested during v1.8.0 and reverted the
same session. `typescript` stays pinned at `^5.9.3`. `src/types/css.d.ts` and the `baseUrl`
removal remain committed, so the eventual switch is still just a version bump.

Tested: `typescript@7.0.2` against the pinned `next@15.5.23`.

**Blocker 1 — the recorded one, still present.** `npx next build` fails immediately:

```
⨯ Failed to load next.config.ts
[TypeError: Cannot read properties of undefined (reading 'fileExists')]
```

Next 15's config loader reaches for a TypeScript JS API surface the Go compiler does not provide.
Unchanged from the previous attempt.

**Blocker 2 — new, and it is ours, not Next's.** `tests/ops/use-server-exports.test.ts` parses
`'use server'` files with the TypeScript compiler API — `ts.Node`, `ts.SyntaxKind`,
`ts.createSourceFile`, `ts.canHaveModifiers`, `ts.isArrowFunction` and more. Under TS 7 every one
of those resolves against `typescript/lib/version`, which exports none of them, so `tsc --noEmit`
reports around 15 errors in that one file. This did not show up in the earlier attempt because
that guard was added later, in v1.5.1, to catch the managers-page 500.

That test is load-bearing and must not be weakened to unblock a compiler upgrade. Rewriting it
without the compiler API means regex-matching exports, which is exactly the weaker check the AST
version was chosen over. The realistic options are to keep a TS 5.x install available to that one
test while `tsc` runs 7, or to wait until the API it needs is available.

**Next 16.3.2 is now published**, and is the likely unblock for blocker 1. It was deliberately NOT
tried here: a Next major upgrade is its own release with its own breaking-change surface, not a
45-minute dependency bump, and this item was time-boxed. Note that blocker 2 is independent of
Next entirely — a Next 16 upgrade would not clear it on its own.

## 5c. Dependency advisories — triaged 2026-08-23; 12 down to 6 across 1.8.1 and 1.9.0

`npm audit` reported 12 (6 moderate, 6 high) during the v1.8.0 image build. Triaged rather than
blanket-fixed, because EVERY suggested fix is a semver major — `npm audit fix --force` here means
migrating the ORM, the framework, the scheduler and the OCR runtime simultaneously and calling it
a security patch.

**Fixed in 1.8.1:**
- `drizzle-orm` 0.44.7 -> 0.45.2 (HIGH, SQL injection via improperly escaped SQL identifiers).
  The only advisory touching the data layer, so it was taken seriously — but note it was very
  likely NOT reachable here, and the reason is worth keeping: the flaw is in IDENTIFIER escaping
  (table/column names), and this codebase has no `sql.identifier()` and no `sql.raw()` anywhere.
  Every `sql` template interpolation is either a schema column defined in code
  (`${categories.name}`) or a parameterised value (`${floorIso}`). Upgraded anyway, because
  "unreachable today" is a property of current code, not of the dependency.
- `node-cron` 3.0.3 -> 4.6.0, clearing the `uuid` moderate (bounds check when a caller supplies
  its own buffer — node-cron never does).

**FIXED in 1.9.0 by the Next 16 upgrade, exactly as predicted — verified, 9 advisories down to 6:**
- `next` (HIGH, via postcss + sharp)
- `postcss` (HIGH, XSS and path traversal via attacker-controlled `sourceMappingURL`) — BUILD
  TIME only. postcss runs during `next build` and is not in the runtime image.
- `sharp` (HIGH, inherited libvips CVE-2026-33327/33328/35590/35591) — the one with a real
  runtime path, since sharp processes uploaded receipt photos. Mitigated by the uploader being a
  household member, not the public.

**DELIBERATELY NOT FIXED — the suggested fix is a DOWNGRADE:**
- `onnxruntime-node` (HIGH, via `adm-zip`: a crafted ZIP triggers a 4 GB allocation).
  `npm audit` names 1.21.1 as the fix while 1.27.0 is installed — six minor versions BACKWARD on
  the OCR runtime. That happens when every newer release still bundles the flagged `adm-zip`.
  The extraction path does not run in this app at all: OCR models are pre-vendored into
  `vendor/ocr-models/` at build time and nothing unzips at runtime. Re-check when onnxruntime-node
  ships a version that both fixes `adm-zip` and is newer than what is installed.

**Also unreachable, left alone:** `esbuild` / `@esbuild-kit/*` (MODERATE — the flaw is esbuild's
DEV SERVER accepting cross-origin requests; it arrives via `drizzle-kit` and no dev server runs
here).

## 5d. Next.js 16 — SHIPPED in v1.9.0

Shipped 2026-08-23 as its own minor release. Kept because the acceptance bar below was the point
of the exercise, and because ONE unexpected finding came out of it that a future upgrade must not
undo (the standalone-tracing change, below).

**What the migration actually cost:** far less than budgeted. `tsc` clean and the full suite green
(3695 passed / 244 files) on the first try after two mechanical changes — the `middleware`/`proxy`
rename and the React 19.2 bump. Every other Next 16 breaking change turned out not to apply:
`next lint` was unused, there are no parallel routes, no webpack config, no synchronous request
APIs left, and `images: { unoptimized: true }` bypasses all five `next/image` changes at once.

**The one that mattered: Turbopack changed how `output: 'standalone'` is traced.** Next 15 copied
only the files output-file-tracing identified. Turbopack copies the PROJECT TREE. A local build
put `.git` (25 MB), `docs/`, `tests/` and `.superpowers/` inside `.next/standalone/`, and the
Dockerfile does `COPY /app/.next/standalone ./` — so anything surviving `.dockerignore` lands in
the SHIPPED, PUBLIC image. `.git` and `docs/` were already excluded; `tests/` (3 MB) and
`.superpowers/` (5.8 MB of GITIGNORED internal working notes) were not. Both are now excluded, and
`tests/ops/docker.test.ts` guards BOTH directions — that the exclusions stay, and that nothing the
image genuinely needs gets over-excluded, since over-excluding fails at run time rather than build
time. Nothing was ever published.

**What was verified by hand, because a green suite is not evidence for this class of change** (the
v1.5.1 500 passed 3,000 tests): a real production build's standalone server was booted and probed.
`/api/health` 200 with db and dataDir ok; `/` dispatches to `/setup` on an empty database;
`/transactions`, `/reports`, `/settings/accounts`, `/review` all 307 to `/login` with no session;
`/api/reports/export` and `/api/backup/download` answer 401 rather than redirecting; the manifest
and icons stay public; CSP-with-nonce, `x-frame-options: DENY` and `nosniff` all present; the
scheduler registered all three cron jobs; no errors in the server log.

**Next owns `tsconfig.json` formatting now.** The build rewrote it — expanded the arrays, added
`.next/dev/types/**/*.ts` (dev output moved to `.next/dev`), and switched `jsx` from `preserve` to
`react-jsx`. Accepted rather than reverted: Next re-applies it on every build, so reverting only
manufactures permanent diff noise. `tsc` is clean and the suite is green with it.

**Pre-existing, found while probing, NOT fixed:** `/favicon.ico` returns 404 — the file has never
existed in this repo (`git log --all` on that path is empty) and the app serves `/icons/*`
instead. Browsers request it on every visit and get a 404. Harmless, and unrelated to Next 16.

**Why it earns its own release rather than riding along.** This is the one upgrade where this
repo's test suite is structurally weakest, and there is a scar to prove it: in v1.5.0 a `const`
exported from a `'use server'` file passed 3,000 tests and then 500'd in production, because
`next dev` and `next start` do not enforce what the standalone server does — only
`node .next/standalone/server.js` does. A Next MAJOR changes exactly that class of thing
(rendering, routing, server-action semantics), and 3,700 tests against mocked boundaries cannot
see it. `tests/ops/use-server-exports.test.ts` exists because of that incident.

**So the acceptance bar for 1.9.0 is higher than a green suite:** build the image, run the
standalone server, and load the real pages in a browser — at minimum dashboard, transactions,
review, settings/accounts, and one server action round-trip.

**Three payoffs:** clears the `next`/`postcss`/`sharp` advisories in 5c above; removes TypeScript
7's `next.config.ts` loader blocker in 5b; and gets off a framework major that will only get more
expensive to leave.

**DECIDED IN ADVANCE — the middleware/proxy runtime change, and the comment that must change with
it.** Renaming `src/middleware.ts` to `src/proxy.ts` is not just a rename: `proxy` runs on the
**Node runtime, not Edge, and that is not configurable**. Next 16 keeps `middleware` working for
anyone who needs Edge, but it is deprecated, so the rename is the forward path and this project
should take it.

The consequence that matters is a COMMENT, not code. `src/middleware.ts` currently says
"Middleware runs on the Edge runtime and MUST NOT import better-sqlite3". On Node that reason
becomes FALSE while the design it justifies is still right. A false reason is worse than no
comment: the next session reads it, notices the app is on Node, concludes the restriction is
obsolete, and adds a database call to a function that runs on EVERY request.

So: keep the middleware DB-free, and rewrite the justification to the real one — it is on the
hot path for every request, and per-request latency is the constraint. The Edge runtime was
never the reason to want it cheap, only the reason it was impossible to make it expensive.

Same applies to the sibling note in `src/instrumentation.ts` / `src/instrumentation-node.ts`,
which both explain themselves in terms of "Next's Edge-runtime compiler pass never has to resolve
better-sqlite3/node-cron". Re-read those two against whatever runtime they actually end up on
rather than assuming the rename left them true.

**Verification specific to this change** (beyond the general bar above): confirm an
unauthenticated request still redirects to /login, that the public prefixes list still lets
`/`, `/login`, `/setup` and the static paths through, and that the header the middleware sets for
the root layout to read still arrives — `src/app/layout.tsx` and
`src/components/theme/theme-script.tsx` both depend on it, and `tests/middleware.test.ts` plus
`tests/components/theme-script.test.tsx` will need their imports repointed. Eight files reference
middleware today; the rename is mechanical but the runtime move is not.

## 6. v1.5.0 image size anomaly — investigated 2026-08-23, main cause still open

Time-boxed investigation done in v1.8.0. **The leading hypothesis was confirmed as real and then
measured as far too small to matter, so the recommendation is now NOT to act on it.** Recorded in
full so nobody re-runs this.

**The anomaly.** From the GHCR registry API in compressed bytes: 1.4.0 amd64 377.6 / arm64
186.1 MB, 1.5.0 amd64 613.8 / arm64 230.5 MB. So +236.2 MB amd64 against a predicted +91 MB, and
the two arches diverging sharply for identical source on top of a pre-existing 2x baseline gap.

**Hypothesis: every image carries both Linux architectures' `onnxruntime-node` prebuilds.**
CONFIRMED — the `Dockerfile` says so itself at lines 21-23, stripping only `darwin` and `win32`
and leaving both Linux binaries in both images because dropping the non-target one "needs
TARGETARCH plumbing".

**Measured, and it does not explain the anomaly.** Actual uncompressed sizes under
`node_modules/onnxruntime-node/bin/napi-v6/`:

- `linux/x64` — 36.7 MB (`libonnxruntime.so.1` 36.3 + binding 0.4)
- `linux/arm64` — 19.5 MB (`libonnxruntime.so.1` 19.1 + binding 0.4)

So the amd64 image wastes 19.5 MB and the arm64 image wastes 36.7 MB, uncompressed — roughly 6 MB
and 12 MB once layer-compressed. **That is the wrong direction to explain anything**: the arm64
image carries nearly twice as much dead weight as amd64 while being less than half the size. The
Dockerfile comment's "20 to 37 MB" was an uncompressed figure and overstates the real payoff.

**Recommendation reversed: leave the strip alone.** The original comment's judgment — not worth a
new failure mode — now has numbers behind it. And the strip would not be free to do safely:
`scripts/check-ocr-assets.mjs` currently requires only that `bin/napi-v6` exists and forbids
`darwin`/`win32`. It does NOT assert the target Linux binary is present, so a wrong `TARGETARCH`
mapping (Docker says `amd64`, onnxruntime's directory says `x64`) would pass `docker build` and
fail at runtime. Doing this properly means making that assertion arch-aware off `process.arch`
first. Not worth ~6 MB.

**What the real cause probably is: the measurement.** 613.8 MB compressed is not plausible for
this image. Accountable content, all uncompressed: onnxruntime after stripping ~75 MB,
`tesseract.js-core` 29.2, `pdfjs-dist` 35.6, `@img` ~25, `better-sqlite3` 11.7, `vendor/` 15.0,
`public/scanner/` 8.6, plus the Next standalone output and the `node:22-bookworm-slim` base. That
totals somewhere near 450 MB uncompressed, which compresses to roughly what the **arm64** number
already says. The amd64 figure looks like a manifest-walk artifact — buildx attaches provenance
and SBOM attestation manifests to a multi-arch index, and a naive walk can attribute those blobs
to one platform.

**So the next step is not an optimization, it is a re-measurement**: resolve each platform's
manifest by digest from the index and sum only that manifest's own layers, explicitly skipping
any attestation manifest (`vnd.docker.reference.type=attestation-manifest`). If the corrected
amd64 figure lands near arm64's, there is no anomaly and this item closes with nothing to fix.

**Do not read local `node_modules` sizes as image sizes.** A `npm ci` on this Windows machine
installs `@img/sharp-win32-x64` (18.3 MB) and `@img/sharp-wasm32` (8.6 MB); a Linux image build
installs the Linux platform packages instead. The `@img` figure above is an estimate, not a
measurement of the image.

---

## v1.10.0 leftovers (found by the onboarding work, deliberately not fixed mid-release)

**A. `personSpendSplit` has an unreachable empty state (~10 min).** In
`src/app/(app)/reports/reports-client.tsx` the "Nothing to split yet" `EmptyState` is gated on
`split.length === 0`, but `personSpendSplit` unconditionally pushes an "unattributed" row even at
zero, so the array is never empty. The empty state was given an action for consistency with the
guard, but the branch looks dead. Either the push is wrong or the empty state should go — read
`personSpendSplit` and decide which, rather than deleting the branch on the strength of this note.

**B. Guard 2 matches href prefixes (~15 min, only if a singular route is ever added).**
`tests/ops/onboarding-coverage.test.ts` guard 2 asserts each `NAV` href appears in the help
content as a substring. `/settings` currently matches six times because `/settings/accounts`,
`/settings/backups` and friends contain it. Harmless today. It would silently accept a future
`/report` or `/budget` route that is a strict prefix of an already-documented path — the guard
would pass while that route went undocumented, which is the one failure this guard exists to
prevent. Fix by matching the href as a whole path segment rather than a bare substring.

**C. Guard 3 searches every local module a page imports (~15 min).** For `/settings` that is four
files, so a stray `<PageGuide` in a sibling panel would satisfy the route even if the page itself
lost its own. Tightening it means naming which file counts, which is what ruling A7 forbids, so
the broad version shipped and the failure message prints the searched set. Revisit only if a false
pass actually happens.

**D. Budgets and Settings guide panels use a derived-but-approximate `empty` (no action needed).**
Neither page has an `EmptyState` to borrow a condition from. Budgets uses
`householdTotals.budgetedLimitCents === 0` — nobody has set a limit anywhere — which is the honest
equivalent. Settings passes `empty={false}` because an index of links renders identically on a
full and a virgin database. Recorded so a future reader does not mistake either for an oversight.

**E. `ocr-engine.test.ts` teardown could not delete its temp directory on Windows (FIXED in
v1.10.0).** Found during the v1.10.0 release run and unrelated to it. A full-suite run reported
`MUST-4.40: a session that never settles fails with the timeout message` as failing, but the
assertions passed: the throw came from the `afterEach` hook, `fs.rmSync(dataDir, {recursive,
force})` raising `EPERM` on a temp directory Windows still held a handle to, and vitest attributes
a hook throw to whichever test ran last. `force` covers a missing path, not an open handle, and
`releaseOcrEngine()` can return before the OS has actually let go.

Fixed with Node's own `maxRetries`/`retryDelay` (its answer to EPERM/EBUSY on Windows), and a
`try`/`catch` that warns instead of throwing, because removing a temp directory is cleanup and not
a test result. A persistent failure now prints the path and stays visible without turning a green
suite red.

**Worth remembering as a diagnosis, not just a fix:** the first read of this was "a timeout test is
wall-clock-flaky under load", which was wrong and would have led to raising a timeout that was
never the problem. The line number in the stack -- a teardown hook, not the test body -- was what
settled it. A named test in a vitest failure is not necessarily the code that threw.

**F. `[vitest-worker]: Timeout calling "onTaskUpdate"` makes a fully passing local suite exit 1
(~30 min, local only).** As of v1.10.0 the suite is 249 files / 3750 tests, and every local full
run reports all files passed, all tests passed, **and** one unhandled error, which sets exit 1. The
stack is entirely inside `node_modules/vitest/dist/chunks/rpc.*.js` -- not one application frame.
It is the worker missing its RPC deadline while reporting task updates, not a test result.

Two things point at the environment rather than the code: the working copy sits inside a
OneDrive-synced directory (the worker stack's file URLs carry the OneDrive folder prefix), and
OneDrive's filter driver stalls exactly this kind of many-small-writes load on Windows; and Linux
CI on the same commits does not report it. **Treat CI, not this machine, as the gate for suite
health.**

If it becomes worth fixing: raise the worker RPC timeout, or reduce reporter chatter by pinning a
`pool`/`maxWorkers` in `vitest.config.ts`. **Do not chase it as a product bug** -- and do not
"resolve" it by ignoring exit codes locally, because that would also hide a real failure.

---

## G. Receipt suggestions read the wrong amount and vendor (~2-3h, not started)

Reported 2026-08-24 after a real test on an Android phone in Chrome. **The engine is not the
problem and neither is the phone.** The failure is in `src/lib/warranty/suggest.ts` — 160 lines of
pure regex that run *after* the text is read. Everything expensive already works: vendored models,
detection, `REC_DROP_SCORE` filtering, and `assembleText`, which groups detection boxes into real
newline-separated lines by vertical overlap *specifically* so `suggest.ts` can work, and says so in
its docblock.

**Do the diagnostic first.** `select ocr_text from warranty_receipts order by id desc limit 1`.
Accurate text with wrong fields confirms the extractor and the plan below stands. Garbled text
means preprocessing instead, and item 4 of the earlier OCR notes (long-side caps) comes first.

### The amount

`suggestPriceCents` has two passes. Pass 1 takes the last currency number on the last line matching
`total|amount due|grand total|balance due`, excluding `subtotal`. **Pass 2, when pass 1 finds
nothing, takes the largest currency-formatted number anywhere in the text.**

Pass 2 is the likely culprit. On a real receipt the largest number is routinely not the total:
`CASH $100.00` / `CHANGE $52.68` against a `$47.32` total yields **$100.00**. A tip line, a card
slip printing `TOTAL SALE` twice, or a pre-discount `qty x price` all do the same. And pass 1 misses
on a single mangled character — `TOTAL` recognised as `T0TAL` or `IOTAL` — then falls silently
through to pass 2 with nothing telling the user a fallback happened.

1. **Delete the pass-2 fallback (~30 min).** Best value per minute here. Suggest *nothing* when the
   total line is not found. `MUST-8.1` already guarantees nothing auto-commits — the design is
   suggest-and-confirm — so a blank field the user fills beats a plausible wrong number they must
   first *notice* is wrong. **Confidently wrong is the worst output a suggester can produce**, and
   that is the whole argument for this change; do not reintroduce a "best guess" later.
2. **Exclude the payment lines (~1h).** Worth more than fuzzy-matching the word TOTAL: reject any
   candidate line matching `cash|change|tender|tendered|tip|gratuity|approved|payment|cash back`
   before considering it. Then add the fuzzy total variants (`O`/`0`, `I`/`1`, `total due`,
   `amount`, `montant`, `balance`) — bilingual Canadian receipts need `montant`.

### Visibility

3. **Show the OCR text beside the form (~1h).** Makes a wrong suggestion visibly wrong and
   correctable in one place, and makes the pipeline debuggable at all — there is currently no way
   for a user to see why a field came out wrong.

### The vendor — NOT covered by the above, and still open

`suggestVendor` returns the first of the first five lines with 3+ letters that does not match
`VENDOR_SKIP_RE` (`^receipt|invoice|order|tel|phone|fax|www.|https?:|digit`). That is "whatever is
printed at the top". A logo yields confident nonsense from PP-OCRv5; if the logo reads as nothing,
the street address is correctly skipped for starting with a digit and the **city line becomes the
vendor**. Nine anchored patterns against the many shapes a real receipt header takes.

Two candidate fixes, undecided:
- **Tappable OCR lines (~30 min on top of item 3).** Once the text is on screen, let the user tap a
  line to fill the vendor. Turns guessing into selection: always right, nothing to go stale.
- **Match against known merchants (~1-2h).** Fuzzy-match the OCR text against normalized merchants
  already learned from imported statements (`merchantRules`, `normalizeMerchant`). Better than any
  top-line heuristic, needs no new dependency, and improves as the categorizer learns.

### Is there a better OCR engine? No — not one that keeps the product's promise

PP-OCRv5 is at or near the top of open self-hosted OCR, and tesseract (the other engine the probe
can pick) is clearly worse on thermal receipts. The tier above costs the product:

- **Cloud document AI** (Google Document AI, Azure Document Intelligence, AWS Textract) returns
  structured receipt fields rather than raw text and would beat any regex here — but it breaks the
  zero-egress claim in the README's first paragraph, needs a key and a bill, and cannot work on a
  LAN-only install, which is a supported deployment.
- **Local structured extraction** (Donut, LayoutLM, a small vision-language model) keeps zero
  egress and is the genuine upgrade path, but means 1-4 GB of weights against today's small ONNX
  files, far more RAM than a Synology typically has, and tens of seconds to minutes per receipt on
  NAS-class CPU.

**The decisive argument against an engine swap is simpler than any of that:** a perfect recognizer
still returns `$100.00` for a receipt whose total is `$47.32` and which also prints `CASH $100.00`.
The defect is in the extractor, and no change of engine reaches it.

---

## H. Settings -> Updates needs a page refresh to show the result (~1h, not started)

Reported 2026-08-24. Press **Check now** in Settings -> Updates: the button greys out, then
settles, but whether an update is available only appears after refreshing the page.

**It is NOT a missing `revalidatePath`.** `checkForUpdateNowAction` already calls
`revalidatePath(UPDATE_PATH)`, and `UPDATE_PATH` is `'/settings'`, which is exactly where
`UpdatesCard` renders. That was the first guess and it is wrong.

**The leading hypothesis is how the actions are wired**, and `updates-client.tsx` is inconsistent
with itself in a way that points straight at it:

```ts
const [autoState,  saveAuto] = useActionState(setAutoApplyAction, initial);                     // direct
const [checkState, checkNow] = useActionState(async () => checkForUpdateNowAction(), initial);  // wrapped
```

`saveAuto` hands React the server action itself. `checkNow` -- and `enable`, `disable`, `apply`,
`dismiss` -- hand it an inline `async` closure defined inside a `'use client'` module, i.e. a
CLIENT function that calls the server action as an RPC. The router therefore never processes a
server-action response for those, so the server cache is invalidated while the client keeps the
props from the original render. And the availability UI is driven by `props.latestVersion` /
`props.severity`, not by the action's returned `message`, so nothing on screen moves.

The wrapping is not arbitrary: `useActionState` calls its action as `(prevState, formData)`, and
`checkForUpdateNowAction()` takes no parameters, so passing it directly is a type error. The closure
was the path of least resistance.

**Confirm before fixing -- there is a 30-second test.** If the hypothesis holds, **Save** on the
auto-apply checkbox updates the card without a refresh while **Check now** does not. If BOTH need a
refresh, the cause is elsewhere (look at `(app)/layout.tsx`'s `dynamic = 'force-dynamic'` and
whether `readUpdateState()` is reading a cached value) and this entry is wrong.

Two fixes, in preference order:

1. **Give the no-arg update actions the `(prevState, formData)` signature** and pass them directly,
   matching `setAutoApplyAction`. Fixes the cause rather than the symptom, and removes an
   inconsistency that will otherwise keep producing this bug in the next action someone adds.
   Applies to `enableUpdateChecksAction`, `disableUpdateChecksAction`, `checkForUpdateNowAction`,
   and the wrapped `applyUpdateAction` / `dismissUpdateAction` call sites.
2. **`router.refresh()` after a successful action.** Works regardless of which mechanism is at
   fault, but treats the symptom and leaves the inconsistency in place.

**Also worth fixing while in there:** pressing **Check now** when already on the newest version
returns `'You are on the newest published version.'` -- a message the user may never see for the
same reason. Whatever the fix, assert that the *returned message* renders, not just that the props
refresh, so the button says something even when nothing changed. A control that greys out and then
looks identical is indistinguishable from a control that did nothing.

---

## I. Tables that fit today only because the data happens to be short (~20 min each)

From the v1.10.1 audit. Every table in the app was checked against the ~1086px content width.
Four were broken and are fixed (transactions, budgets, settings→accounts, import history). Two
more were flagged as at-risk in that audit — not broken, but one long name away from it, because
a text column with no declared width takes what it wants and starves the controls beside it. The
other two originally listed here, `settings/users/users-manager.tsx` and
`settings/item-types/item-types-manager.tsx`, no longer describe the current markup: the
v1.11.0 row-controls redesign collapsed their side-by-side forms and buttons into a single
kebab menu (and, for item-types, an auto-saving name input), so the cells this item used to warn
about don't exist anymore. Fix each remaining one the same way when it bites: `TableWrap fixed`
plus a `<colgroup>`. Do not pre-emptively convert all of them; an unnecessary colgroup is a width
that has to be maintained.

- **`settings/managers/managers-client.tsx`** (merchant rules table) — ~926px today; a long
  monospace pattern beside a "Parent › Child" category label reaches ~1100px and squeezes the
  trailing delete button.
- **`warranties/warranties-client.tsx`** — ~1090px, already at the edge, but read-only: four
  `whitespace-nowrap` cells plus two badges. Its failure mode is a horizontal scrollbar, not a
  starved control, so it is the least urgent of the two.

Also noted and deliberately left alone: `reports/reports-client.tsx`'s month-over-month table grows
a column per month and will exceed any fixed width over a long range. It has no control to starve
and scrolling a matrix sideways is the intended way to read one.

## J. `Field` puts its hint inside the `<label>`, so hints become part of the accessible name (~30 min)

Found while writing the v1.10.2 tests. `src/components/ui/form.tsx`'s `Field` renders as a `<label>`
wrapper when no `htmlFor` is given, and the `hint` sits inside it — so the input's accessible name
becomes "Original amount What you borrowed. Used for the payoff bar." rather than "Original amount".
A screen reader reads the whole sentence as the field's name every time it lands there.

The fix is `aria-describedby`: give the hint an id and point the input at it, so the hint is
*described* rather than *named*. Requires the input to have an id, which is why `htmlFor` exists on
`Field` already — the `htmlFor` branch is the shape to extend.

Consequence to know about meanwhile: `getByLabelText('Original amount')` does not match those
fields, and a test has to use a regex. That is a symptom, not the bug — do not "fix" it by loosening
the tests.

**K. A second load-sensitive OCR test (~30 min).** `tests/lib/warranty/ocr/onnx/engine.test.ts`
> "runs no inference at all for a PDF" hit the 20s `testTimeout` in one full-suite run during the
v1.10.3 release and passed 7/7 in isolation immediately after. Same family as item E, different
file and a different mechanism: E was a Windows handle in teardown, this is a genuine wall-clock
timeout on a test that loads the PDF stack while 249 other files compete for the CPU.

The fix is not a bigger timeout — it is to stop the test doing real model/PDF loading work it does
not need in order to assert that NO inference ran. Assert on the session spy, with the heavy path
stubbed, so the test measures the code rather than the machine. **Two OCR tests have now flaked
this way; if a third appears, treat the suite's OCR integration layer as the problem rather than
each test.**

---

## v1.11.0 leftovers (found during the row-controls redesign fix wave, deliberately not fixed mid-release)

**L. Auto-save success is silent to assistive tech (~20 min).** `StatusSlot` in
`src/components/ui/AutoSave.tsx` renders the pending spinner and the "saved" tick with
`aria-hidden="true"`, on the reasoning that a purely visual tick beside a control someone is
looking at needs no announcement. That reasoning only covers sight: a screen-reader user who
changes an `AutoSaveSelect`, an `AutoSaveCheckbox` or commits an `AutoSaveTextInput` gets no
confirmation that anything happened at all, while a REFUSED save is announced (`ErrorLine` uses
`role="alert"`). The asymmetry is the bug — success and failure should both be observable, not
just failure. Fix shape: give the saved state a polite live region (`aria-live="polite"`,
distinct from the hidden decorative icon) so "Saved" is announced without interrupting whatever
the user does next; keep it terse so it doesn't turn into chatter on a control someone edits
repeatedly.

**M. Kebab accessible names collide for identical transaction descriptions (~15 min).** Each row's
`RowMenuButton` on `/transactions` derives its accessible name from the row's description (see
`transactions-client.tsx`'s per-row `RowMenu`), so two transactions with the same merchant text on
the same statement — a common case, e.g. two identical coffee-shop charges — produce two "⋯" buttons
with the same accessible name and nothing else to tell them apart for a screen-reader or
`getByRole` user. Sighted users disambiguate by row position/amount/date; neither is in the name.
Fix shape: append something that is unique per row without being noisy for the common case, e.g.
the row's date (or date + amount), the same way other rows in this app compose an accessible name
from more than one field when the primary one repeats.

## Owner requests after v1.11.0 (2026-08-24, not started)

**N. Page guides should start collapsed everywhere — SHIPPED in v1.12.0.** `PageGuide` lost its
`empty` prop entirely (ruling B1); every one of the nine call sites now renders a bare
`<PageGuide>` and the panel opens only when a reader clicks it.

**O. Contracts & Coverage: tax bills with due dates — SHIPPED in v1.12.0.** A fifth `ItemKind`,
`bill`, with an explicit `bill_installments` schedule instead of a cadence. See
`docs/superpowers/specs/2026-08-24-bills-with-due-dates-design.md`.

Owner wants to enter a property-tax bill with its due dates so the app reminds them. Today's
billing model on items is a cadence — `BILLING_CYCLE_LABELS` is Monthly / Annual only — and
property tax is installments on fixed, irregular dates (two to six a year depending on the
municipality), so no cadence expresses it and a "Tax" item type under the existing `contract` kind
would remind on the wrong days.

Recommended shape: a fifth `ItemKind`, `bill`, whose reminder data is an explicit schedule — a
child table of (item_id, due_date, amount_cents, paid_at NULL) rows — instead of billing_cycle /
billing_amount_cents. The Coming-up card and the notification events already read items, so
"due in N days" reminders and "overdue" surfacing come from wiring the schedule into those two
readers, not from new machinery. Marking an installment paid is the one new action (and the
natural home for the existing payment-matching rules: a matched transaction marks the installment
paid). `productFieldsAllowedForKind`, `billingAllowedForKind` and `loanFieldsAllowedForKind` in
`src/lib/warranty/constants.ts` each gain the new kind; the type-immutability rule (v1.10.2)
already covers it.

Cheaper alternative if the schedule is too much: add Quarterly / Semi-annual cadences and let the
owner create a "Property tax" item type of kind `contract`. Rejected for now because installment
dates are set by the municipality, not by a regular interval, and a reminder that fires on the
wrong day is worse than none.

## v1.12.0 leftovers (found during the final whole-branch review, deliberately not fixed mid-release)

**P. The Coming-up card has no row cap and, with `includeOverdue`, no lower date bound (~20
min).** `ComingUpCard` (`src/components/ComingUpCard.tsx`) renders every row `unpaidInstallments()`
returns for the window; unlike the notification evaluator, it has nothing resembling
`MAX_NEW_ROWS_PER_USER_PER_EVALUATION` to stop at. A household that falls far behind on a bill —
or several — gets a wall of rows instead of a card, and because `includeOverdue` carries no lower
bound either, an installment from years ago is exactly as eligible as one from last week. The
card's aria-label total folds all of them in, so the announced count is exactly as unbounded as
the visible list. Fix shape: cap the rendered rows (with a "+N more" affordance, the same shape
other cards in this app already use for overflow) and give overdue rows a lower bound of their
own — most-overdue-first with a cutoff, not literally everything ever missed.

**Q. The `/warranties` list row for a Bill shows "Ongoing" and nothing about its installments
(in-spec; ~30 min).** `warranties-client.tsx`'s row rendering has no bill-specific case, so a
Bill-kind item's row falls through to the same "Ongoing" status text a lifetime warranty gets —
correct per the design spec, which scoped the schedule UI to the item's own detail page, but it
means a bill that is three weeks overdue is silent on the one page most people actually navigate
to. Obvious v1.12.1 candidate: surface the earliest unpaid due date, or an overdue count, in the
row the same way the loan row already surfaces its balance.

**R. The bill detail header card renders Vendor / Model / Serial / Price as "—" rows for a kind
that cannot carry them (~15 min).** `warranty-detail-client.tsx`'s header card is shared across all
five kinds and shows every product field regardless of whether the current kind's gates
(`productFieldsAllowedForKind` et al. in `src/lib/warranty/constants.ts`) allow it to be set. For a
Bill, none of those fields can ever hold a value, so the card is four guaranteed em-dashes above
the Installments section. Fix shape: hide inapplicable fields via the same kind gates the add/edit
forms already use, on the display side too, instead of rendering an empty placeholder for a field
the kind was never allowed to fill in.

---

## v1.12.1 candidates from the 2026-08-27 fresh-eyes review (bugfix batch, all small)

**S. Sub-category budget limits are silently dropped from every household total.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md MON-1

What: A household that budgets at the child level (e.g. Food > Groceries $600, Food >
Restaurants $200) sees each child's limit correctly on `/budgets`, but the household summary,
the dashboard tile and safe-to-spend all report $0.00 budgeted — `budgetTotals()` iterates
top-level rows only and never descends into `row.children`. Archiving a child compounds it: its
spend keeps rolling into the parent while its limit disappears, so the parent looks over budget
for no visible reason.

Evidence: `src/lib/budgets.ts:471-488` (`budgetTotals` never touches `row.children`);
`src/lib/budgets.ts:449-458` (top-level-only rows handed to it).

Fix: Flatten rows before totaling (reuse `flattenBudgetRows` from
`src/lib/notify/evaluate/budget.ts`), deciding explicitly whether a parent's own limit supersedes
its children's or sums with them (recommended: supersede, since `spentCents` already includes the
children's). Render archived children with a limit or spend as read-only rows instead of dropping
them.

Effort: S · Proposed release: v1.12.1

**T. Manual loan assign ignores an existing bill-installment link.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md MON-2

What: The rule matcher enforces cross-table exclusivity between loans and bill installments
(`alreadyLinked()` unions both tables), but the manual "assign to loan" path never checks
`bill_installments` — a transaction already marking an installment paid can be hand-assigned to a
loan and decrement its balance by the same money, and the over-link warning is blind to it
because it only sums `loan_payments` links.

Evidence: `src/lib/loans.ts:540-575` (`assignTransactionToLoan`, no `bill_installments` query);
`src/app/(app)/transactions/actions.ts:284-289` (over-link warning sums `loan_payments` only).

Fix: Extract the union query behind `alreadyLinked` into an exported
`paymentLinksForTransaction(txnId)` and call it from `assignTransactionToLoan` — refuse with a
named error, or at minimum feed the bill leg into the existing over-link warning.

Effort: S · Proposed release: v1.12.1

**U. Transactions row category select creates/deletes household merchant rules on change.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md UX-2

What: On Transactions, picking a category from the row's auto-save select doesn't just tag that
row — it silently creates or overwrites a household-wide merchant rule and trains the Bayes
classifier; picking "Uncategorized" deletes that merchant's rule. Nothing on screen tells the
user this happened, since `AutoSave` only reads `result.error` and discards the action's
confirming sentence. Review page's teaching behavior is intentional and should stay as-is.

Evidence: `src/lib/categorize/engine.ts:321-330` (`upsertRuleFromCorrection` runs whenever
`createRule !== false`); `src/app/(app)/transactions/actions.ts:112` (caller passes no
`createRule`); `src/app/(app)/transactions/transactions-client.tsx:507-529` (the row select).

Fix: Pass `createRule: false` from the transactions row select so a row edit is genuinely
single-row and reversible — leave Review alone, since that screen is about teaching the
categorizer. Make `clearCategory`'s rule-deletion require a deliberate control rather than a
plain select change.

Effort: S · Proposed release: v1.12.1

**V. useAutoSave has no try/catch; a thrown action fails silently.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md UX-3

What: The hook awaits the server action but only handles a returned `{error}` — a thrown action
(SQLITE_BUSY during the nightly backup, a full disk, several library calls that throw by design)
fails invisibly: no message, no revert, the control keeps showing a value the database never
accepted.

Evidence: `src/components/ui/AutoSave.tsx:56-70` (no try/catch around the action call); throwing
callers include `src/app/(app)/transactions/actions.ts:112` (`confirmCategory`, throws at
`src/lib/categorize/engine.ts:284`) and `src/app/(app)/budgets/actions.ts:50,58,204`.

Fix: Wrap the await in try/catch inside `useAutoSave`, set `status: 'error'`, call
`hooks.onError()`, and show a generic "Could not save — the app may be busy. Try again."
sentence.

Effort: S · Proposed release: v1.12.1

**W. No error.tsx / not-found.tsx / global-error.tsx anywhere.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md UX-1

What: Any server-side failure (locked SQLite during backup, a bad row) or a stale bookmark to a
deleted item renders Next's bare default error/404 screen — unstyled, no navigation, no theme, no
way back — instead of the app's own chrome.

Evidence: no `error.tsx`, `not-found.tsx` or `global-error.tsx` anywhere under `src/app`;
`notFound()` is called from `src/app/(app)/warranties/[id]/page.tsx:19,21` and
`src/app/(app)/warranties/new/page.tsx:17` with nothing to catch it.

Fix: Add `src/app/(app)/error.tsx` (plain sentence, "Try again" `reset()` button, link to
/dashboard), `src/app/(app)/not-found.tsx` (same chrome, link back), and
`src/app/global-error.tsx` for the root-layout case.

Effort: S · Proposed release: v1.12.1

**X. Blanking a budget limit field wipes the limit for all future months.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md UX-4

What: The budget limit input commits on blur; an emptied value is not "no change" — it clears the
budget from that month forward via `clearBudget`. Someone who selects the number to retype it and
gets distracted has silently deleted a recurring limit, with only a tick as feedback.

Evidence: `src/app/(app)/budgets/actions.ts:49-53` (calls `clearBudget`); `src/lib/budgets.ts:101-103`
(upsert of `amountCents: null`); `src/app/(app)/budgets/budgets-client.tsx:104-118` (commits on
blur).

Fix: Treat an emptied field as a no-op in `AutoSaveTextInput` when the previous value was
non-empty; move "clear this budget" to an explicit small button in the cell instead.

Effort: S · Proposed release: v1.12.1

**Y. Three money inputs lack inputMode="decimal".**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md UX-9

What: "Add a transaction → Amount", "Contribution amount" and "New goal → Target amount" have no
`inputMode`, so phones show the full QWERTY keyboard instead of a number pad — exactly the fields
a kid logging cash or a relative dropping money into a goal touches. Every other amount field in
the app already sets it.

Evidence: `src/app/(app)/transactions/transactions-client.tsx:637`;
`src/app/(app)/goals/goals-client.tsx:110,184`.

Fix: Add `inputMode="decimal"` to all three fields.

Effort: S · Proposed release: v1.12.1

**Z. Password change does not revoke other sessions.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md SEC-3

What: `changePasswordAction` verifies the current password, calls `setUserPassword`, then
returns — it never destroys any other session. A captured session cookie (shared laptop, lent
phone) keeps working for up to 30 more days after the victim "fixes" it by changing their
password. Two sibling flows (forced first-login change, admin reset) already do this correctly.

Evidence: `src/app/(app)/settings/actions.ts:80-96` (no session call after `setUserPassword`);
contrast `src/app/(auth)/change-password/actions.ts:55-56` (`destroyOtherSessionsForUser`).

Fix: After `setUserPassword` at `src/app/(app)/settings/actions.ts:93`, read the session cookie
and call `destroyOtherSessionsForUser(user.id, token)` — the same lines
`change-password/actions.ts` already uses.

Effort: S · Proposed release: v1.12.1

**AA. Disabling TOTP requires no password re-auth.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md SEC-4

What: `disableTotpAction` takes no password, no current TOTP code, and no confirmation beyond the
button click. Anyone at an unlocked browser or holding a stolen session can strip the account's
second factor in one click, and the owner is never notified — there is no `mfa_disabled`
notification event.

Evidence: `src/app/(app)/settings/actions.ts:131-139` (entire action, no password check); contrast
`src/app/(app)/settings/users/actions.ts:96` (admin MFA reset calls `destroyAllSessionsForUser`).

Fix: Require the current password in `disableTotpAction` (mirror the `verifyPassword` block at
`settings/actions.ts:87-90`), then call `destroyOtherSessionsForUser`. Add `mfa_disabled` and
`password_changed` events to `src/lib/notify/events.ts` with `defaultEnabled: true`.

Effort: S · Proposed release: v1.12.1

**AB. Rate limiter trusts X-Real-IP without TRUST_PROXY.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md SEC-5

What: The login action substitutes the client-controlled `X-Real-IP` header for the socket
address and passes it as `clientIpFromHeaders`' "trusted" `socketIp` argument. With `TRUST_PROXY`
off (the default), an attacker who varies the header defeats the per-(username, IP) lockout layer
entirely, and the same forged value is rendered verbatim into the "New sign-in" alert.

Evidence: `src/app/(auth)/login/actions.ts:51` (passes `x-real-ip` as `socketIp`);
`src/lib/auth/ratelimit.ts:140-150` (returns `socketIp` unconditionally when `trustProxy` is
false).

Fix: Ignore `x-real-ip` in `ratelimit.ts:141` unless `env.trustProxy` is on (same treatment
`x-forwarded-for` already gets); have `login/actions.ts:51` pass `null` otherwise. Validate/truncate
the value before it reaches `sessions.ip` or `renderEvent`.

Effort: S · Proposed release: v1.12.1

**AC. Session cookie Secure flag only under TRUST_PROXY.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md SEC-7

What: The login/setup actions pass a literal `'http:'` as the protocol, so the only path to a
Secure cookie is `TRUST_PROXY=1` plus a matching `X-Forwarded-Proto`. An app behind an HTTPS
reverse proxy with `TRUST_PROXY` left at its default `0` gets a 30-day session cookie sent over
any plain-HTTP request to the same host, with nothing detecting the mismatch and no HSTS header
to close the gap browser-side.

Evidence: `src/app/(auth)/login/actions.ts:83-92` (calls `shouldUseSecureCookie('http:', ...)`);
`src/lib/auth/security-headers.ts:37-48` (no `Strict-Transport-Security`).

Fix: Detect the mismatch (`TRUST_PROXY` off but an incoming request carries
`X-Forwarded-Proto: https`) and log a loud warning / admin banner. Emit HSTS only when the
resolved connection is HTTPS.

Effort: S · Proposed release: v1.12.1

**AD. Forced-password-change gate misses report export routes.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md SEC-9

What: The forced-password-change gate lives in the app layout and deliberately exempts `/api/*`
routes. But `/api/reports/export` and `/api/reports/tax-export` are `/api/*` routes that stream
the entire household ledger — so an account still holding an admin-typed temporary password can
pull everything before ever choosing its own password.

Evidence: `src/app/(app)/layout.tsx:10-22` (gate is page-layer only, `/api/*` exempt by design);
`src/app/api/reports/export/route.ts:21-22,55` (session check only, then full export).

Fix: Add a `mustChangePassword` check to the two report-export routes and to
`/api/backup/download`, returning 403 with a "finish setting your password first" message.

Effort: S · Proposed release: v1.12.1

**AE. undoImport leaves balance snapshots behind.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md MON-5

What: `commitImport` writes a `source='csv'` balance snapshot per statement date; `undoImport`
carefully reverses Bayes training, loan links and bill `paid_at`, but never touches
`account_balance_snapshots` — there is no delete path for that table anywhere in `src/`. Undoing
an import into the wrong account leaves that account permanently anchored on the wrong bank's
balance, silently swinging net worth.

Evidence: `src/lib/import/commit.ts:257-259` (snapshot write inside commit);
`src/lib/import/commit.ts:390-435` (`undoImport`, no snapshot handling); `src/lib/balance.ts:117-171`
(stale snapshot stays authoritative forever).

Fix: Record which import wrote each snapshot (an `import_id` column, or capture the
`(account_id, date)` set in `CommitResult`) and delete exactly those rows in `undoImport`, inside
the same transaction. Short of that, add an admin "delete this snapshot" control on Settings →
Accounts.

Effort: S · Proposed release: v1.12.1

## v1.13.0 candidates from the 2026-08-27 fresh-eyes review (privacy model — owner ruled 2026-08-27)

**Owner ruling (2026-08-27): one family per instance.** Every household runs its own container with
its own database; friends and extended family are on their own instances already. Multi-tenancy is
out of scope permanently — do not add a household/tenant id to the schema. Consequences: SEC-1 /
PROD-1 shrink from "friends see everything" (Critical) to "kids see the adults' money" (Medium);
the remaining v1.13.0 work is the `users.visibility = 'self'` flag for kid accounts, the
ownership checks on `/warranties/[id]` and the receipts route, AG's ownership-or-admin gate on
destructive actions, and one INSTALL.md paragraph stating the one-family-per-instance model.

**AF. No per-user data boundary (SEC-1 + PROD-1 combined).**
Status: OPEN, RE-SCOPED by owner ruling above (Critical → Medium; fix option (b) only) — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md SEC-1, PROD-1

What: There is no per-user data boundary anywhere except budgets' write scope and the
notification tables. Any signed-in person — including friends and extended family with their own
logins — can read every transaction, every warranty/loan/subscription/bill (including by guessing
`/warranties/<id>`), every receipt image, every goal contribution, the whole ledger via CSV
export, and every other member's personal budget on one `/budgets` page load. This is documented
design intent for a two-adult household ("owner_user_id is ATTRIBUTION, not access control") and
is the wrong design for the stated population of friends and extended family with their own
logins.

Evidence: `src/app/(app)/warranties/actions.ts:69-76` (explicit design statement);
`src/lib/transactions.ts:166-168` (`getTransaction` has no filter);
`src/app/(app)/warranties/[id]/page.tsx:17-21` (no ownership comparison).

Fix: Owner ruling needed between two options — (a) one household per container for friends
(documented in INSTALL.md, zero code), or (b) a `users.visibility` `'self'` flag for kids, adding
an owner predicate to roughly six list helpers (transactions, accounts, goals, loans, warranty
items, reports) plus the `/warranties/[id]` page and the receipts route ownership check.
Whichever path, add a `tests/ops/` invariant guard (style of `balance-invariants.test.ts`)
asserting every exported `get*`/`list*` in those modules takes a viewer id, plus a route-level
test that user B's session gets 404 from another user's receipt.

Effort: L · Proposed release: v1.13.0

**AG. Destructive actions unscoped and no audit log.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md SEC-2

What: Deletion is as unscoped as reading, and there is no audit table in the schema. Any member
can delete any warranty/loan/subscription item and its receipts, delete any individual receipt
file, and undo any import (deleting every transaction it introduced plus training/links) — and
because no row records the actor, nobody can tell afterward which account did it.

Evidence: `src/app/(app)/warranties/actions.ts:411-433` (`deleteWarrantyAction`, no owner check);
`src/app/api/import/undo/route.ts:18-29` (only `userFromRequest` + `importExists` before
`undoImport`).

Fix: Gate destructive operations behind ownership-or-admin, reusing `canActOnOwner()` from
`src/app/(app)/goals/actions.ts:27-29`, in `warranties/actions.ts` delete/deleteReceipt and
`api/import/undo/route.ts`. Add a minimal append-only `audit_log(id, at, userId, action, entity,
entityId)` written by the delete paths and `undoImport`, surfaced on an admin page.

Effort: M · Proposed release: v1.13.0

**AH. Members can silently overwrite admin-only merchant rules.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md SEC-6

What: Rule management at `/settings/managers` is admin-only, but four member-level actions
(rename-for-all, fix-category-apply-to-all, mark-transfer) write the same `merchant_rules` table
through the back door, and the upsert overwrites an existing rule's category, rename text and
`createdBy` on conflict — so a member can silently rewrite an admin's rule and the row then claims
the member authored it, with no way for that member to undo it.

Evidence: `src/app/(app)/settings/managers/actions.ts:122-125,173-176` (admin-only management);
`src/lib/categorize/rules.ts:85-88` (`.onConflictDoUpdate` overwrites `createdBy`).

Fix: Either let members read `/settings/managers`' rule list read-only, or (smaller, do
regardless) preserve `createdBy` on conflict and add a `lastModifiedBy` column so overwrites are
attributable.

Effort: S · Proposed release: v1.13.0

**AI. A person cannot exist without a login (attribution-only users).**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md PROD-8

What: Attribution pickers are built from `listUsers()`, so tracking spending on/by someone — a
young child, a relative living with the household, a housemate who doesn't want an account —
requires creating a real login and a temporary password for them, carrying `mustChangePassword`
on an account nobody will sign into. And every login created for a real person immediately gets
full read of everything (AF above).

Evidence: `src/app/(app)/transactions/page.tsx:69`, `src/app/(app)/budgets/page.tsx:72` (both
build pickers from `listUsers()`); `src/db/schema.ts:19,22` (only `role` and `isActive`, no
`canSignIn` notion).

Fix: Allow a user row with logins disabled — a `canSignIn` boolean, or treat `isActive = false`
users as still selectable for attribution while `attemptLogin` continues to refuse them. Resolve
the existing inconsistency where `budgets/page.tsx:72` filters to active users but
`transactions/page.tsx:69` does not.

Effort: S · Proposed release: v1.13.0

## v1.14.0 candidates from the 2026-08-27 fresh-eyes review (household features)

**AJ. Anomaly/duplicate/price-creep insights computed but never shown on screen.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md PROD-2

What: Unusual-charge detection, duplicate-charge detection and subscription price-creep are all
implemented and tested but reachable only via a Telegram or email notification — a member with no
channel configured never learns Netflix went up or a restaurant charged twice.

Evidence: `src/lib/predict/anomalies.ts` (`unusualVerdict`, `creepVerdict`, `findDuplicates`,
`hasEnoughHouseholdHistory`); only importer is `src/lib/notify/evaluate/anomalies.ts:10` — no
page or component under `src/app/` imports it.

Fix: A self-hiding "Needs a look" card on the dashboard (same pattern as `LoansCard`/
`ComingUpCard`) listing this month's unusual charges, duplicate pairs and crept subscriptions,
each row linking to the transaction. Purely a read-only card over functions that already exist
and are tested.

Effort: S · Proposed release: v1.14.0

**AK. Quick-add transaction.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md PROD-4

What: With no bank sync, hand entry is the main loop for cash and e-transfers, but the only way
in is scrolling past the filter bar, bulk toolbar and every table row to a seven-field form at
the very bottom of `/transactions`. Nothing remembers the last account or category, and the PWA
manifest declares no `shortcuts`.

Evidence: `src/app/(app)/transactions/transactions-client.tsx:617-666` (form position/fields);
`src/app/manifest.ts` (no `shortcuts` entry).

Fix: A manifest `shortcuts` entry ("Add a transaction" → `/transactions#add`), an "Add" button in
the page header that scrolls to and focuses the form, and defaulting the account/category selects
to the user's last pick.

Effort: S · Proposed release: v1.14.0

**AL. saveNoteAction dead code; notes promised in help but unreachable; thin search.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md PROD-6

What: The help page tells users a transaction's note is editable, but there is no note UI
anywhere — `saveNoteAction` has exactly one occurrence in the repo (its own definition), manual
entry hard-codes `notes: null`, and notes export to CSV always empty. Transaction search is
`LIKE` over description/merchant only, not notes or amount, unlike the warranty side's proper
FTS5 index.

Evidence: `src/app/(app)/transactions/actions.ts:169-190` (`saveNoteAction`, no call sites);
`src/app/(app)/help/content.tsx:161-168` (help page claims it's editable);
`src/lib/transactions.ts:126-137` (search scope).

Fix: Add "Note…" to the row menu wired to the existing action, add a note field to manual entry,
include notes in the search `OR` clause.

Effort: S · Proposed release: v1.14.0

**AM. Stale-import alert per account.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md PROD-10

What: The stale-import alert looks at the single most recent import across the whole household,
so importing one account silences the alert for every other account, even one untouched since
February — exactly backwards for a household on manual CSV across five accounts.

Evidence: `src/lib/notify/evaluate/stale.ts:24-30` (one query, no `accountId` grouping; dedup key
is week-only).

Fix: Group the query by `accountId` over active CSV-managed accounts, compare each account's
newest import against `staleImportWeeks`, and extend the dedup key to carry the account id. No
migration needed.

Effort: S · Proposed release: v1.14.0

**AN. Bridge from due bill installment to a recorded transaction.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md PROD-3

What: The app knows rent, the property-tax installment and the insurance renewal are coming, and
will remind someone, but when the money actually moves the household must wait for the statement
or retype it by hand — and for e-transfers or the cash account, the statement never arrives at
all. There is no recurring/scheduled transaction feature.

Evidence: `src/lib/bills.ts:81-146` (reminders only, no auto-create); repo-wide search for
recurring/scheduled-transaction creation returns nothing.

Fix: Not a scheduler — a "Record this payment" button on the Coming-up card and bill detail page
that opens manual entry pre-filled with the bill's amount/date/description/category, and on save
marks the installment paid and links the transaction (`bill_installments.paidTxnId` already
exists for this).

Effort: M · Proposed release: v1.14.0

**AO. OFX/QFX import and more Canadian bank presets.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md PROD-5

What: Only four bank presets exist (TD Chequing, TD Visa, Scotiabank Chequing, Amex Canada) — RBC
(the largest bank in the country), BMO, CIBC, Tangerine, Simplii, EQ and Desjardins have none. The
app also accepts only `.csv`, one file at a time.

Evidence: `src/lib/import/presets.ts:7-142` (four `BUILTIN_PRESETS`); repo-wide search for
`ofx|qfx|qif` returns nothing.

Fix: Cheap: add RBC/BMO/CIBC/Tangerine preset objects (validated against a real scrubbed export
each). Higher value: an OFX/QFX reader — OFX's bank-assigned `FITID` would make dedup exact
instead of hash-heuristic, and `transactions.externalId` / `transactions_external_id_uq` already
exist for SimpleFIN and would take OFX rows with no migration.

Effort: M · Proposed release: v1.14.0

**AP. Savings and asset account types for net worth.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md PROD-9

What: An account can only be chequing, credit or cash, so net worth is chequing plus cash minus
credit/loans — the two largest numbers on a Canadian household's balance sheet (registered
accounts, the house) can't be entered at all.

Evidence: `src/db/schema.ts:85` (`type` enum, three values); `src/lib/networth.ts:217-250`
(`netWorthOverTime`).

Fix: Add `savings` and `asset` account types, with `asset` accounts excluded from import and
spend reporting, carrying only a manually-typed balance updated periodically. An enum widen, a
migration, and a filter on the import account picker.

Effort: M · Proposed release: v1.14.0

**AQ. Sinking fund for irregular annual bills via rollover.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md PROD-11

What: Budgets and bills are two separate systems that never meet — `safeToSpend` reports
`budgetedRemainingCents`, `projectedSpendCents` and `billsDueCents` as three separate numbers, and
a budget row has no idea an installment is coming, so the month the $1,800 tax bill lands, the
budget simply blows.

Evidence: `src/lib/bills.ts:164-185` (three figures, never combined); `src/lib/budgets.ts:352-383`
(`effectiveBudget`'s rollover carry, the closest existing thing to a sinking fund).

Fix: A read-side join between `bill_installments` and the budget row showing the required monthly
set-aside beside the limit ("$1,800 due 30 Jun — set aside $150/month, $900 carried so far"). No
new storage; rollover is already 80% of an envelope.

Effort: M · Proposed release: v1.14.0

**AR. Kids' own lane (self scope + goals + attribution).**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md PROD-7

What: Nothing in the app is built for a child — no allowance, no chore money, no view-only role,
no "what's mine" home screen. A per-child savings goal already works but every other child and
friend can see it (PROD-1/AF above).

Evidence: repo-wide search for allowance/chore/kid features returns no feature code;
`src/lib/goals.ts:217-228` (goals list unfiltered).

Fix: Do not build an allowance subsystem — the primitives already exist (a per-child cash account
via `getOrCreateCashAccount`, a goal owned by that child, manual entries). What's missing is the
view: with the `visibility: 'self'` flag from AF above, a child signing in lands on a dashboard
scoped to themselves.

Effort: M · Proposed release: v1.14.0

**AS. Per-user full data export and user deletion.**
Status: OPEN — from 2026-08-27 fresh-eyes review; see docs/reviews/2026-08-27-fresh-eyes-review.md PROD-12

What: The only complete export is the admin's whole-database tar.gz (everyone's data, in a format
only this app reads); CSV exports cover transactions and the tax year only. Users are
deactivate-only — there is no delete, and no way to remove or hand over one person's data if they
leave.

Evidence: `src/app/api/backup/download/route.ts:26-45`; `src/lib/auth/users.ts:185` ("Deactivate,
never delete"); `src/app/(app)/settings/users/actions.ts` (no delete action).

Fix: (a) a "download everything" JSON export, one file per table, admin-only, reusing existing
query helpers. (b) a per-user offboarding action: export that user's rows, reassign or delete
their owned rows, then deactivate. Note PROD-1/AF's container-per-household recommendation
removes most of the urgency for friends specifically.

Effort: M · Proposed release: v1.14.0

## Later / minor, from the 2026-08-27 fresh-eyes review

One item each, kept brief. Status for all: OPEN — from 2026-08-27 fresh-eyes review; see
docs/reviews/2026-08-27-fresh-eyes-review.md at the id named in each title.

**Owner re-scope (2026-08-27):** "no harm in completing them" — every item in this section moves
into v1.12.1 alongside S–AE, so v1.12.1 is now S–AE plus AT, AU, AV, AW, AX, AY, AZ, BA, BB, BC, BD,
BE, BF, BG (26 items). Two rulings taken with it:

- **BD (MON-7) — installment selection ruling:** a rule-matched bill payment marks the unpaid
  installment whose `due_date` is nearest the transaction date when that distance is ≤ 45 days;
  otherwise fall back to the earliest unpaid installment (today's behaviour). No amount check.
- **AT (UX-5) — timing ruling:** fix inside v1.12.1, not later. v1.12.1 already opens
  `AutoSave.tsx` for V (try/catch); one review covers both. Shape: remount the control when the
  server value changes (React `key` derived from the server value at each call site, or an
  effect that resyncs state when the `defaultValue` prop changes).

AS (per-user export/delete) is DROPPED: it existed for "a friend leaves the shared instance", and
the one-family-per-instance ruling removed that case.

**AT. UX-5 — concurrent edits: the loser's screen keeps showing their own stale value.** Auto-save
controls seed state from props once and never resync, so when two people edit the same row the
server takes the last write but the loser's browser goes on showing their own value indefinitely.
Evidence: `src/components/ui/AutoSave.tsx:128,181,280` (no `useEffect` resync). Fix: resync the
control when the server's value changes — a `key` per call site including the server value, or a
`useEffect` that resyncs when `defaultValue` changes and nothing is pending/focused. Effort: M.

**AU. UX-6 — single-tap destructive actions with no confirmation.** Deactivate, Reset MFA, Remove
(bill installment) and Unassign (loan) all fire on one tap, unlike every other destructive action
in the app, which confirms first. Evidence: `src/app/(app)/settings/users/users-manager.tsx:108-117`;
`src/app/(app)/warranties/[id]/warranty-detail-client.tsx:520-525`. Fix: follow the backups
inline-confirm pattern for the account-level actions, a plain `confirm()` for Remove/Unassign.
Effort: S.

**AV. UX-7 — touch targets under 44px throughout the row controls.** The kebab trigger is 32px,
menu items ~26px tall, auto-save controls are `text-xs` with 4px padding — exactly where the
destructive actions (AU) and rule-writing select (U) live. Evidence:
`src/components/ui/RowMenu.tsx:162,47-48`; `src/components/ui/AutoSave.tsx:30`. Fix: `h-11 w-11`
trigger and `py-2.5` menu items below `sm:`; bump auto-save controls to `py-2 text-sm`. Effort: S.

**AW. UX-8 — kebab actions drop keyboard focus to the page body.** Escape returns focus to the
kebab button, but choosing a menu item does not — focus lands on `document.body` with no
announcement. Evidence: `src/components/ui/RowMenu.tsx:153,122-126` (`refocus` only true on the
Escape path). Fix: pass `close: () => close(true)` in the provider so the trigger is refocused on
every close path. Effort: S.

**AX. UX-10 — nothing happens on screen while a slow page loads.** No `loading.tsx` anywhere and
every page is `force-dynamic`, so Reports shows no spinner or skeleton until the whole payload
arrives. Evidence: no `loading.tsx` under `src/app`; `src/app/(app)/reports/page.tsx:22`
(`force-dynamic`). Fix: add `loading.tsx` to `(app)/reports` and `(app)/transactions`; narrow the
whole-page `revalidatePath` calls that re-render every row on each auto-save. Effort: M.

**AY. UX-11 — no safe-area insets on an installed iPhone home-screen app.** The manifest declares
standalone display, but nothing accounts for the safe area, so the sticky header sits under the
status bar and the footer under the home indicator. Evidence: `src/app/manifest.ts:24`; `grep -rn
"safe-area|env(safe" src/` returns nothing. Fix: add `viewportFit: 'cover'` and
`env(safe-area-inset-top/bottom)` padding to header/footer. Effort: S.

**AZ. UX-12 — shutdown kills in-flight writes; a migration failure is a silent crash loop.** The
SIGTERM handler exits immediately without closing the HTTP server or SQLite handle, and a boot
failure's only record is a `docker logs` line. Evidence: `src/instrumentation-node.ts:95-106`
(`process.exit(0)`, no `closeDb()`). Fix: call `closeDb()` in the signal handler with a short
grace period; log a framed, unmissable message naming the migration on a boot failure. Effort: M.

**BA. MON-3 — un-marking a bill installment does not stick.** `unmarkInstallmentPaid` clears
`paid_at`/`paid_txn_id`, but that column is also the matcher's only "already used" record, so the
transaction becomes a fresh matcher candidate again and gets silently re-marked. Evidence:
`src/lib/warranty/installments.ts:226-234`; `src/lib/loans.ts:322-341` (`alreadyLinked` keyed on
`paid_txn_id`). Fix: record the suppression instead of erasing it — a nullable `unlinked_at` or a
small `payment_match_exclusions(txn_id)` table. Effort: M.

**BB. MON-4 — balance-snapshot source authority (ruling R3) documented but not implemented.**
Three docblocks state snapshots should rank `simplefin > csv > manual`, but
`recordBalanceSnapshot`'s `onConflictDoUpdate` is unconditional last-writer-wins. Evidence:
`src/lib/networth.ts:63-84,41-47`. Fix: implement the rank in the `ON CONFLICT` clause, or remove
the R3 claim from all three docblocks and state "last write wins" honestly. Effort: S.

**BC. MON-6 — runEngine's in-memory eligibility filter silently drops the splits guard.** The
`ELIGIBLE` SQL predicate correctly excludes split transactions, but `runEngine(txnIds)` re-derives
eligibility in JS and drops the splits half — latent today, but the next call site added anywhere
inherits the hole. Evidence: `src/lib/categorize/engine.ts:102-115,168`. Fix: have
`selectRowsByIds` carry the splits check so one predicate serves both paths. Effort: S.

**BD. MON-7 — a bill payment marks the earliest unpaid installment regardless of amount or date.**
`markEarliestUnpaid` never compares the transaction's amount or date — deliberate, but one missed
mark permanently offsets the whole schedule by one. Evidence: `src/lib/loans.ts:355-375`. Fix:
prefer the installment whose `due_date` is nearest the transaction's own date within a window
(~±45 days) before falling back to earliest-unpaid. Effort: M.

**BE. SEC-8 — backup archive is the whole ledger plus password hashes, minus the credential key.**
`/api/backup/download` snapshots `budget.db` plus every receipt — every password hash and
encrypted credential ciphertext — but not `secret.key`, so a stolen backup yields everything
except the notification/bank credentials. Evidence: `src/lib/backup/archive.ts:99-141`;
`src/lib/env.ts:93-137`. Fix: document in INSTALL.md that a downloaded backup is the complete
financial record plus password hashes and must be stored encrypted. Effort: S.

**BF. SEC-10 — a TOTP code stays valid for its full ±30s window and can be replayed.**
`verifyTotp` runs with `window: 1` (~90s validity) and nothing records a code as spent, so a
code observed in that window can be reused. Evidence: `src/lib/auth/totp.ts:22,71-79`. Fix:
record the last accepted TOTP counter per user (`users.totpLastCounter`) and reject any code at
or before it. Effort: S.

**BG. SEC-11 — /api/health tells an unauthenticated caller the exact build version.** The
healthcheck is correctly public, but returns `version` on every 200 response. Evidence:
`src/app/api/health/route.ts:62`. Fix: drop `version` from the 200 response, keep it only on 503
responses where its stated purpose actually applies. Effort: S.

**BH. Bill kind undiscoverable: nothing seeds or hints at a Bill item type.**
Status: OPEN — owner report 2026-08-27, first use of v1.12.0. Proposed release: v1.12.1.

What: v1.12.0 added the `bill` kind but seeds no item type of that kind, and `/warranties/new`
offers only existing types. An owner looking for "Bill" on the New item page finds nothing and has
no pointer to Settings → Item types. Same gap exists for every kind, but Bill is the one a new
release advertised.

Evidence: `drizzle/0011_bill_installments.sql:116` copies existing types only, no INSERT of a
seed row; `src/app/(app)/warranties/new/new-warranty-client.tsx` renders the type select from
the caller's list with no empty-kind hint.

Fix: On `/warranties/new`, when no active item type of kind `bill` exists, render a one-line hint
under the type select: "Tracking a bill with due dates? First add an item type with kind Bill
under Settings → Item types." (admins get the link; members get the sentence). Do NOT seed a row
into a user-managed table. Add the same sentence to the Contracts & coverage page guide and the
help page's Bills section. Test: render with a type list lacking `bill` → hint present; with one
→ absent. Effort: S.
