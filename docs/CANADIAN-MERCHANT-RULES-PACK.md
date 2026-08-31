# Canadian merchant rules pack

`packs/canadian-merchants.json` is a curated **merchant rules pack** — the same file format
Settings → Merchant rules already imports and exports (`src/lib/packs.ts`,
`RULES_PACK_FORMAT = 'budget-tracker-rules'`). It lives at the repo root in its own `packs/`
directory rather than under `src/` because it is data the app reads only through the ordinary
file-upload import flow, not code the app imports — the same reason `fixtures/` and
`real-statements/` sit outside `src/` too. Nothing about the import path special-cases it: it
goes through Settings → Merchant rules → Import exactly like a pack exported from another
household's install.

## What it does

- **Categorizes** unambiguous, single-purpose Canadian merchants — gas stations, coffee chains,
  fast food, grocery-only banners, telecom carriers, provincial/municipal utilities, transit and
  parking, a handful of pharmacy-only and fitness chains, streaming/software subscriptions,
  cinemas and ticketing, and NSF/service-charge descriptors. Every category rule was chosen
  because a stranger looking at the merchant name would agree with the category, not because it
  is the only plausible reading.
- **Cleans up merchant names, without asserting a category**, for the retailers a household
  genuinely splits spending across — Walmart, Costco, Canadian Tire, Amazon, the big hardware
  chains, and the drug-store banners that also sell groceries (Shoppers Drug Mart, Rexall,
  Pharmaprix, London Drugs, Jean Coutu). A rename rule cannot misfile a transaction, since it
  carries no category at all — it only turns `WALMART #4821 TORONTO ON` into `Walmart`. This is
  deliberate, not an oversight: see the "rename-only" reasoning in the merchant rules pack spec
  (Part 2 of the build brief) for why these specific merchants are excluded from categorization.

## What it does NOT assert

**Governing principle: a miss over a false positive.** A pattern that never fires just leaves a
transaction uncategorized — visible in the review queue, and self-correcting once you notice.
A pattern that fires on the WRONG merchant silently files money in the wrong category and shows
up only as a total that is quietly wrong. Every pattern choice in this pack, and every fix made
to it, is biased toward the miss.

- **It is not exhaustive.** It covers the major national and large regional Canadian brands as of
  2026 — not every corner store, not every independent restaurant, not every regional utility.
  Growing it is expected; nothing about the format or the import path needs to change to add more
  rules later.
- **It does not know your bank's exact wording.** Patterns are written against what
  `normalizeMerchant()` (`src/lib/categorize/normalize.ts`) outputs — uppercase, with channel
  prefixes, store numbers, and a trailing `CITY PROVINCE` already stripped — not against a raw
  statement line. If your bank abbreviates or reorders a merchant name in a way none of these
  patterns cover, the rule simply will not fire; it will not misfire.
- **It does not import transfer or `not_transfer` rules**, because the format itself never carries
  them (`src/lib/packs.ts`'s controller ruling (a)) — those describe one household's own account
  wiring and mean nothing on a different install.
- **Short patterns are `exact`, not `contains`, on purpose.** `matchRule` (`src/lib/categorize/rules.ts`)
  does a plain substring check for `contains` — there is no word-boundary option (see the backlog
  item below). A short pattern like `IGA` as `contains` matches inside `MICHIGAN`; `MAXI` matches
  inside `MAXIMUM`; `ESSO` matches inside `PROFESSOR`/`ACCESSORY`; `RONA` matches inside `CORONA`.
  This pack ships those (`IGA`, `MAXI`, `ESSO`, `RONA`, `KFC`, `A&W`, `TTC`, `STM`, `F45`, `YMCA`,
  `XBOX`, `FIDO`) as `exact` instead, verified against `normalizeMerchant()`'s real output for a
  typical statement line (e.g. `normalizeMerchant('IGA #4021 MONTREAL QC')` really is exactly
  `'IGA'`). A longer, safe `contains` variant is added alongside a few of these (`FIDO MOBILE`,
  `F45 TRAINING`, `XBOX GAME PASS`, `MAXI & CIE`) to recover a real descriptor with a suffix
  without reintroducing the collision. **`ATCO` is the one deliberate exception** — see below.
- **Possessive brand names carry the apostrophe-S, not a truncated stem.** `normalizeMerchant()`
  does NOT strip apostrophes (verified: `normalizeMerchant("HARVEY'S #123 TORONTO ON")` is exactly
  `"HARVEY'S"`), so a stem like bare `HARVEY` is both unnecessary and dangerous where the stem
  alone is a real word: `HARVEY`, `MONTANA`, `KELSEY`, `DENNY`, `MCDONALD`, `WENDY`, `NANDO`,
  `LONGO`, and `DOMINO` are all real surnames, first names, or words that can appear in an
  ordinary e-transfer or an unrelated merchant name — `LOWE` is additionally a substring of
  `FLOWERS`. Every one of these patterns ships as the full brand name (`HARVEY'S`, `MONTANA'S`,
  `LOWE'S`, `MCDONALD'S`, ...) instead, which cannot match a plain name or word lacking the
  trailing `'S`. `TIM HORTONS`, `FORTINOS`, and the possessive-plural rename entries are safe
  as-is for the same reason: each already carries a trailing `S` a bare name mention would not.
- **`FORTIS` and `ATCO` are this pack's most likely miscategorisations, and they are kept anyway.**
  Both are diversified holding companies — Fortis Inc. owns non-utility assets, and ATCO also
  does structures and transportation — so a household bank descriptor carrying either word is
  *usually*, not *always*, the utility bill. They stay broad (and `ATCO`, at 4 characters, stays
  `contains` rather than `exact`) because that is what lets one pattern catch
  FortisBC/FortisAlberta/FortisOntario and ATCO Gas/ATCO Electric without a rule per subsidiary.
  If either one ever misfires for your household, this is why — check its impact figure first.

## How to verify it against YOUR statements

Import it once (Settings → Merchant rules → Import → choose `packs/canadian-merchants.json` →
Preview → Import), then use the merchant rules page's own **impact figures** — the "Affects"
column that shows how many of your transactions each rule actually touches — to find out which
patterns matched nothing. A rule with zero affected transactions is not necessarily wrong; it
usually just means that merchant's wording on your particular bank's statements does not match
this pack's pattern, or you have never shopped there. That is the intended way to discover a
gap: read the zero-impact rows, not the pack's source, and adjust or add a pattern to match your
own statement wording.

## Guard tests

`tests/ops/canadian-merchants-pack.test.ts` loads this exact file (not a copy, not a fixture) and
asserts:

- it parses as a valid rules pack and imports cleanly into a freshly seeded database with zero
  skipped entries;
- every category rule references a `(category_parent, category)` pair that actually exists in
  `SEED_CATEGORIES` (`src/db/seed.ts`) — nothing dangling, nothing silently created;
- every pattern is uppercase, and every `(pattern, match_type, rule_kind)` triple is unique;
- every rename entry carries a non-empty `rename_to`, and every category entry carries a
  category;
- importing it twice writes nothing the second time and creates no duplicate rows;
- an imported rename changes a matching transaction's display immediately (the same retroactive
  apply a hand-saved rename gets), and never touches a transaction a household member already
  renamed by hand;
- a set of known false-positive collisions (`FLOWERS BY THE PARK`, `MICHIGAN AVE SHOP`,
  `MAXIMUM FITNESS SUPPLY`, `PROFESSOR SUPPLY CO`, `CORONA IMPORTS`, and an e-transfer naming
  Harvey/Kelsey/Montana/Denny/McDonald/Wendy/Nando/Longo/Domino) run through the real
  `normalizeMerchant()` and are asserted NOT to match the pattern that used to catch them —
  structural correctness alone (parses, uppercase, no dangling category) says nothing about
  whether a rule fires on the wrong transaction, which is the failure this class of test exists
  to catch.

If a future edit to this pack ever breaks one of those guarantees, that test file is where it
will show up — run `npx vitest run tests/ops/canadian-merchants-pack.test.ts` after editing the
JSON. Every new pattern should be checked against `normalizeMerchant()`'s real output before it
ships, the same way the collisions above were found: a plausible-looking `contains` pattern can
still match a merchant nobody intended.

## Known gap: no word-boundary match type

See `docs/superpowers/plans/2026-08-30-v1.21.0-backlog.md` for the recorded gap this pack's
`exact`-match workarounds (above) are standing in for: `matchRule` has no `word` match type, only
`exact` and a plain substring `contains`. A `word` type would let a short pattern like `IGA` stay
broad without the collision risk, instead of the household never seeing an `IGA` transaction that
carries a suffix `contains` could safely have caught. Not implemented here — recorded as a future
item.
