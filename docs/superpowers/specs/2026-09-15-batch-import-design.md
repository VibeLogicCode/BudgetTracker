# Dropping many statements at once — design

**Date:** 2026-09-15
**Status:** Owner feature request (2026-09-15). Rulings **B1–B12** below are the planner's; each
names the code fact that forced it and each is reversible by the owner.
**Target release:** v1.44.0 (built on v1.43.0).
**Migration:** none. See B3 — the "you already imported this" signal the owner asked for turns out
to be computable from numbers the existing detector already produces, so no column is added.

---

## Problem

The owner, verbatim:

> *"import file is working really well. do you think we can add abiltiy to import multiple fdiles at
> once? or even drag and drop 5 files at once if its a zip it should inzip and import. icase onf the
> files is not supported it should handle it accodingy?"*

And the pain underneath it, verbatim:

> *"problem i have now is i download 10 files nd then 1 by 1 i g through it and sometimes i import
> same ile again. throughwing all together lets app handle the process"*

Today the import page takes exactly one file. `FileDrop`'s `rejectionFor`
(`src/components/FileDrop.tsx:33`) refuses a multi-file drop outright:

```ts
if (files.length > 1) return 'One file at a time, please — drop a single statement.';
```

and `ImportClient` holds one file's worth of scalar state — `stagingId`, `accountId`, `profileId`,
`mapping`, `preview`, `detection` (`src/app/(app)/import/import-client.tsx:220-242`). Ten downloads
is ten full passes through a three-step wizard, and nothing tells the household that file 7 is one
they already did in August until the preview appears — after the file has been picked, uploaded and
read.

## What is NOT changing

**B1. The detection logic is untouched.** The owner was explicit ("detection logic\*", twice).
`detectImportAccount` (`src/lib/import/detect-account.ts`) and `detectImportProfile`
(`src/lib/import/detect-profile.ts`) run per file exactly as they run now. This design only *reads*
the `confidence: 'certain' | 'likely' | 'none'` and the `reason` sentence they already return, and
routes on them. No new scoring, no new thresholds, no second opinion.

**B2. The commit path is untouched.** `commitImportFlow` (`src/lib/import/flow.ts`) runs once per
file, sequentially. Each file remains its own `imports` row with its own undo, exactly as today. A
failure on file 3 does not roll back files 1 and 2 — which is already how undo is scoped, so this is
the absence of a change rather than a decision.

**B3. No migration.** The first draft of this design added `imports.content_hash` so a re-import
could be recognised before any work was done. It is not needed: `AccountScore.matchedRows`
(`detect-account.ts:19`) is already how many of this file's rows the named account already holds,
and it is already computed for every candidate account on every detect call. When
`matchedRows === rows.length`, every row in the file is already in that account — the file is a
re-import, and the existing numbers say so.

This is strictly better than a content hash in one respect and never worse: it recognises a
re-download whose *bytes* differ (a fresh export timestamp, a reordered column) but whose contents
are already held. And if a genuinely new statement fully overlaps an account, it contains no new
rows, so flagging it costs the household nothing.

## The one detection change, and why auto-import forces it

**B4.** `lastAccountForFilename` (`detect-account.ts:153-164`) takes the single most recent `imports`
row matching the filename and returns its account with confidence `likely`. It does not check
whether *earlier* imports of that same filename went somewhere else. Its own comment already calls
the signal "weak on its own -- a bank that names every export accountactivity.csv defeats it".

Today that weakness is contained: the household reads the sentence ("The last file called
accountactivity.csv was imported into Visa") and then reads a preview before committing. Under this
design a `likely` account can auto-import, and nobody is reading the sentence. So the branch is
tightened: if the filename's past imports disagree about the account, it returns `null` /
`'none'` and the file lands in "needs you" instead.

This is the only line of detection this design touches, and it exists solely because auto-import
removes the human who used to catch it. The owner may strike it, in which case `likely`-from-
filename must not auto-import at all.

## The four statuses

Every one is derived from an output that exists today.

| status | condition | derived from |
|---|---|---|
| `ready` | account `certain` or `likely`, profile `certain`, not a full re-import | both detectors |
| `already-imported` | `matchedRows === rows.length` and `rows.length > 0` | `AccountScore`, B3 |
| `needs-you` | account `none`, or profile `likely` / `none` | the detector's own `reason`, shown verbatim |
| `unsupported` | extension refused, too large, will not decode | `rejectionFor`, `ImportLimitError` |

**B5. Profile must be `certain`, not `likely`.** `detect-profile.ts:189` already writes, for
`likely`: *"read 47 of 52 rows. **Check the preview before you commit.**"* The codebase decided which
files need human eyes before this design existed; routing on it is reading an existing instruction,
not inventing a policy. `certain` is `cleanRate >= 0.95` (`detect-profile.ts:72`).

**B6. Account `likely` IS enough** (owner's choice, asked and answered 2026-09-15). The reasoning
that made it the right call: account `certain` requires row *overlap* (`detect-account.ts:63`), so a
clean discrete monthly statement with no overlap can never be `certain` by construction. Gating on
`certain` would leave the common case permanently amber and the feature would not help.

**B7. An OFX/QFX file has no profile and is still `ready`.** `detect-profile.ts:124-127` returns
`confidence: 'certain'` with a null profile for OFX, because the format names its own columns. The
gate reads the confidence, not the profile id, so this falls out without a special case.

## Flow

**B8. Detect all up front, then show one list.** Not a one-file-at-a-time queue — the owner rejected
that shape explicitly ("i liked what we decided up top of processing all and them showing rather
then 1 by 1").

1. Drop N files, or pick them. `POST /api/import/batch/detect` receives all of them.
2. Per file, server-side: stage it, run the existing detectors, classify. One row back per file.
3. One list renders: filename, detected account, detected mapping, row count, status, and the
   detector's reason where there is one to show.
4. **Import the ready ones** opens a combined confirmation first — every ready file with its row
   count and its duplicate count — and commits only after that is accepted (owner's choice: "Likely
   is enough, but show me first").
5. Any row, ready or not, can be clicked to open today's wizard on that already-staged file:
   preview, mapping editor, card-people, all unchanged.

**B9. One detection path, not two.** The body of the existing `/api/import/detect` route between
`writeStagedFile` and its `Response.json` is extracted verbatim into `detectStagedFile()` in the new
`src/lib/import/batch.ts`, and *both* routes call it. A second copy would drift from the first, and
the drift would be invisible until the two screens disagreed about the same file.

**B10. Unsupported files never fail the batch.** `rejectionFor` already produces a per-file sentence.
In multi mode the refused files are listed as `unsupported` with that sentence and the rest proceed —
the owner asked for exactly this ("icase onf the files is not supported it should handle it
accodingy").

## Zip (second phase)

**B11.** Expanded server-side, one level, never nested. Entries join the list as ordinary files
tagged with the zip they came from. Guards, all of which get adversarial tests before the reader is
written:

- reject any entry whose name contains `..`, is absolute, or contains a backslash (path traversal)
- cap the entry count
- cap the **uncompressed** total against `MAX_FILE_BYTES` (`parse.ts:7`, 5 MiB) — a zip bomb passes
  an upload-size check trivially, so the decompressed size is what must be bounded
- skip directory entries and `__MACOSX`
- a nested `.zip` inside the zip is listed as `unsupported`, not recursed

**B12. No zip dependency.** `tar` is in `dependencies` for backups; zip is a different container and
no zip library is present. The central-directory reader is hand-written over Node's built-in
`zlib.inflateRaw` — STORE and DEFLATE only, which covers every bank export. The trade is explicit: a
library would be fewer lines of ours, and one more package in a public self-hosted image.

## Pieces

| file | change |
|---|---|
| `src/components/FileDrop.tsx` | `multiple` prop; `rejectionFor` stops refusing >1 when it is set; `onFiles` beside `onFile` |
| `src/lib/import/batch.ts` | **new** — `detectStagedFile()` (extracted, B9) and `classify()` (the B5–B7 gate) |
| `src/lib/import/zip.ts` | **new**, phase 2 — the reader and its guards (B11, B12) |
| `src/app/api/import/batch/detect/route.ts` | **new** — N files, same three refusals as the existing route |
| `src/app/api/import/detect/route.ts` | calls `detectStagedFile()` instead of holding the body itself |
| `src/lib/import/detect-account.ts` | the filename-conflict tightening (B4) |
| `src/app/(app)/import/batch-client.tsx` | **new** — the list and the confirmation screen |
| `src/app/(app)/import/import-client.tsx` | can open on an already-staged file when a row is clicked |

## Testing

TDD throughout, RED verified before each implementation.

- `tests/lib/import/batch.test.ts` — the classification gate: each status from each detector
  combination; `already-imported` at exactly `matchedRows === rows.length` and not one row short;
  OFX reaching `ready` with a null profile (B7).
- `tests/lib/import/detect-account.test.ts` — extended for B4: agreeing history still returns
  `likely`, disagreeing history returns `none`.
- `tests/components/file-drop.test.tsx` — mixed good/bad multi drop, all-bad drop, and `multiple`
  unset still refusing two.
- `tests/app/import-batch.test.tsx` — the list renders a row per file; the confirm screen appears
  before any commit; a failure mid-batch leaves earlier files imported.
- `tests/lib/import/zip.test.ts` (phase 2) — traversal, bomb, nesting, empty archive, directories.
- An ops guard that the batch path calls `commitImportFlow` rather than reimplementing commit (B2).
