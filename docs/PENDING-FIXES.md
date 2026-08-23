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
