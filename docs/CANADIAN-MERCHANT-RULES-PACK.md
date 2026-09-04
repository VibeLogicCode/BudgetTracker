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
  parking, single-purpose retail, a handful of pharmacy-only and fitness chains,
  streaming/software subscriptions, cinemas and ticketing, and NSF/service-charge descriptors.
  Every category rule was chosen because a stranger looking at the merchant name would agree with
  the category, not because it is the only plausible reading.
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
- **`word` is the default for a brand name; `contains` is the legacy.** `matchRule`
  (`src/lib/categorize/rules.ts`) does a plain substring check for `contains`, with no boundary of
  any kind: `IGA` as `contains` matches inside `MICHIGAN`, `MAXI` inside `MAXIMUM`, `ESSO` inside
  `PROFESSOR`/`ACCESSORY`, `STM` inside `SYSTEM`, and — the three defects `pack_version` 3 fixed —
  `METRO` inside `METROLINX`, `PRESTO` inside `PRESTON`, `SHELL` inside `SHELLEY`. The `word` match
  type compares whole tokens instead, so `IGA` matches `IGA MARCHE` and never `MICHIGAN`. Every
  brand added in `pack_version` 3 is `word` unless a reason below says otherwise; the 174 remaining
  `contains` rules are pre-`pack_version`-3 entries whose patterns are long enough that no
  collision has been found for them. The longer `contains` variants sitting alongside a few `word`
  rules (`FIDO MOBILE`, `F45 TRAINING`, `XBOX GAME PASS`, `MAXI & CIE`) are kept: they are partly
  redundant, but they also catch a glued spelling with no space, which `word` deliberately does not.
- **A `word` pattern covers the hyphenated and the spaced spelling at once.**
  `wordBoundaryTokens()` breaks on `-` as well as on a space, so one `word COUCHE-TARD` rule
  matches `COUCHE-TARD` and `COUCHE TARD` both. That is why this pack carries `PETRO-CANADA` *and*
  `PETRO CANADA` as two `contains` rules but ships `COUCHE-TARD`, `CO-OP GAS BAR`, `BUY-LOW FOODS`
  and `KITCHENER-WILMOT HYDRO` as one `word` rule each. Accents are the opposite story — see below.
- **Nine patterns are deliberately `exact`, and each pays for it in coverage.** `exact` means the
  whole normalized merchant text and nothing else. Two reasons for it, no others:
  - **the brand text is also a person's name** — `RONA` (Rona is a woman's given name, and this is
    a `rename` rule, the one kind whose false positive is visible on screen: `word RONA` would
    rename "E-TRANSFER SENT RONA ⟨surname⟩" to "Rona"), `IRVING` (a given name and a surname),
    `ADONIS` (a given name), and `PATRICK MORIN` (the Quebec hardware banner is literally a
    person's full name, and the same rename-visibility argument applies). No boundary rule can tell
    a store from a person; only not being broad can. `exact` still catches the ordinary statement
    line, because `normalizeMerchant('RONA #123 TORONTO ON')` is exactly `'RONA'`.
  - **the brand text is a three-letter agency acronym with no sourced suffix** — `RTC`, `STL`,
    `RTL`, `STS`, `EXO`. `TTC` and `STM` are `word` because the guard test can name the statement
    lines that promotion buys (`TTC MONTHLY PASS`, `STM OPUS RECHARGE`); for these five it cannot,
    and a three-letter token is the highest-collision-density pattern shape in the pack (`STL` is
    also a file format and a US city, `RTL` a hardware term and a broadcaster, `EXO` a common brand
    prefix). `exact` still reaches the fare-machine line, because a reference number and a trailing
    `CITY PROVINCE` are exactly what `normalizeMerchant` strips: `RTC 1234567 QUEBEC QC` normalizes
    to `RTC`. If a later release can source a real suffix for one of these, promoting it has to
    argue with `tests/ops/canadian-merchants-pack.test.ts`, which pins every one of the nine.
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
  *usually*, not *always*, the utility bill. They stay broad because that is what lets one pattern
  catch FortisBC/FortisAlberta/FortisOntario and ATCO Gas/ATCO Electric without a rule per
  subsidiary — but they stay broad in **different** ways, and the difference is instructive.
  `FORTIS` has to remain `contains`: FortisBC and FortisAlberta are single glued words, so a
  `word` rule would not match either of them. `ATCO`'s subsidiaries are spaced (ATCO Gas, ATCO
  Electric), so v1.25.0 promoted it from `contains` to `word` — it keeps every match it had and
  loses the `ATCOM`/`SCATCO` class of collision that made a 4-character `contains` pattern the
  pack's one documented exception. If either one ever misfires for your household, this is why —
  check its impact figure first.

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
  `normalizeMerchant()` **and the real `patternMatches()`** and are asserted NOT to match the
  pattern that used to catch them — structural correctness alone (parses, uppercase, no dangling
  category) says nothing about whether a rule fires on the wrong transaction, which is the failure
  this class of test exists to catch. As of v1.25.0 the guard calls the production matcher rather
  than its own two-line copy of it: a guard that reimplements what it guards can only prove the
  copy agrees with itself;
- the promotions actually bought something — `IGA MARCHE`, `ESSO ON THE RUN`, `MAXI & CIE`,
  `TTC MONTHLY PASS`, `STM OPUS RECHARGE`, `YMCA OF GREATER TORONTO`, `ATCO GAS AND PIPELINES` and
  `A&W RESTAURANT` are each asserted to match a rule that `exact` could never have reached, so
  `word` cannot silently decay into a slower `exact`;
- the narrowings kept what they were for — `METRO PLUS`, `PRESTO FARE LOAD`, `SHELL CANADA` and
  nine other real statement lines are asserted to still match, each of them longer than its own
  pattern so `exact` could not have stood in either. Without this, "fix the false positive" and
  "delete the rule entirely" would pass the same tests;
- every one of the nine `exact` rules is asserted to be `exact`, to reach a realistic statement
  line, to miss the collision it exists to dodge, **and** that `word` would have fired on that
  collision — so the price of `exact` is stated in the test rather than assumed;
- **no rule fires on another rule's own pattern text**, whenever the two resolve to different
  outcomes (a different category, or a rename versus a category). This is the structural version of
  the `METRO`/`METROLINX` bug: both halves were in the file, and every other check above passed for
  three releases. Rules that mean the *same* thing are expected to overlap (`PETRO-CANADA` and
  `PETRO CANADA`; `word XBOX` under `contains XBOX GAME PASS`; an accented pattern beside its ASCII
  twin), so only a disagreeing pair is flagged. One pair is allow-listed, with its reason recorded
  next to it: `contains AMAZON` (rename-only, no category) sees `AMAZON PRIME` (Subscriptions), and
  the overlap is the design — `matchRule` gives the longer pattern the win on a real transaction,
  and dropping either rule is worse than keeping both. The check is itself tested against a
  deliberately colliding pair built inside the test, because a check that silently matched nothing
  would pass forever;
- every rule's match type is legal for its rule kind, so a `word` transfer rule cannot reach the
  table through the pack — the importer would skip it silently-but-countably rather than fail;
- accents behave as documented: `normalizeMerchant` preserves them and never folds them, the
  accented pattern does not reach the ASCII spelling or vice versa, and **every accented pattern
  has an unaccented sibling** of the same kind and outcome. That last one is structural, so a
  future edit cannot add the accented half alone and quietly cover nobody.

If a future edit to this pack ever breaks one of those guarantees, that test file is where it
will show up — run `npx vitest run tests/ops/canadian-merchants-pack.test.ts` after editing the
JSON. Every new pattern should be checked against `normalizeMerchant()`'s real output before it
ships, the same way the collisions above were found: a plausible-looking `contains` pattern can
still match a merchant nobody intended.

## Closed gap: the word-boundary match type (v1.25.0, backlog item 16)

This pack shipped in v1.22.0 with a recorded gap: `matchRule` had no `word` match type, only
`exact` and a plain substring `contains`, so a short acronym had to be demoted to `exact` to dodge
a collision — safe, but it meant never seeing an `IGA MARCHE` or `ESSO ON THE RUN` transaction at
all. v1.25.0 added the type and this pack (`pack_version` 2) uses it.

What counts as a word boundary is defined once, in `wordBoundaryTokens()`
(`src/lib/categorize/normalize.ts`), and the choice matters here specifically:

- **`'` and `&` stay INSIDE a token.** `normalizeMerchant()` preserves both, and they only ever
  occur inside a brand's own single word, so `LOWE'S` is one token — which is exactly why a rule
  whose pattern is `LOWE'S` matches it and a rule whose pattern is `LOWE` does not. A boundary
  that split `LOWE'S` into `LOWE` + `S` would hand the `FLOWERS` collision straight back.
- **Every other punctuation mark is a boundary.** `-`, `/`, `.`, `#`, `*` are joiners the bank puts
  *between* separate words (`PETRO-CANADA`, `KFC/TACO BELL`), so breaking on them is what makes a
  `word` rule useful rather than merely safe.
- **A multi-word pattern matches only as a consecutive run.** `REAL CANADIAN` matches
  `REAL CANADIAN SUPERSTORE`, not `CANADIAN TIRE REAL ESTATE`.
- **The pattern is never compiled into a regular expression.** It is free text somebody types, so
  `.`, `+`, `(` and `*` mean themselves, and `.*` matches nothing rather than everything.

`word` is available for `category` and `rename` rules only. It is the one match type a `transfer`
or `not_transfer` rule may not carry, and the reason is what those two kinds are *for* rather than
anything the engine needs — see `WORD_MATCH_KINDS` in `src/lib/categorize/rules.ts` for the full
argument. `exact` and `contains` are both available on every kind: a
`{"match_type": "contains", "rule_kind": "transfer"}` entry imports and fires as a substring match.

Until v1.31.0 this section claimed those two kinds were exact-match-only and that four functions in
`src/lib/categorize/engine.ts` relied on it to attribute rows by `normalized_merchant =
rule.pattern`. The claim was never enforced anywhere, and those four functions now simulate the
match instead (review finding R-01), so a `contains` transfer rule is counted, applied and cleared
on exactly the rows it really matches. This pack has never carried either kind, so nothing here is
affected either way.

### If you already installed v1 of this pack

Twelve rules changed nothing but their match type. Because a rule's identity includes its match
type (`merchant_rules_pattern_uq` is `(pattern, match_type, rule_kind)`), the update screen shows
each of those twelve as **one addition and one removal**, not as a change — `IGA` as a `word` rule
is genuinely a row your database does not have, sitting beside an `exact` row the new pack no
longer names. Both are listed together, and deleting the removals is offered as an unchecked box.

Either answer is safe. Leave the removals and the old `exact` rows stay as ordinary household
rules (their pack stamp is cleared) alongside the new `word` rules; both carry the same category,
and `matchRule` gives the `exact` row the bare merchant text and the `word` row every variation of
it, so the outcome is the pack's intent plus one redundant row per pattern. Tick the box and the
old rows go. `tests/lib/canadian-pack.test.ts` pins all of this.

## pack_version 3: the researched expansion (v1.25.0)

`pack_version` 3 takes the pack from 190 rules to **297** — 107 added, 3 changed — across seven
areas: gas, groceries, coffee, utilities, internet, transit and shopping.

### The method, and the thing it deliberately does not attempt

The obvious way to build merchant rules is to collect the **card billing descriptors** banks print.
That was not done, because there is no reliable public registry of Canadian billing descriptors.
The sites that claim to list them are crowd-sourced and uneven, and a rule built on a guessed
descriptor is a rule that fires on something nobody checked — the exact failure this pack's
governing principle exists to refuse.

What *is* verifiable is **who operates which banner**. Loblaw, Empire/Sobeys, Metro Inc., Pattison
Food Group, Couche-Tard, Parkland, Imperial Oil, Canadian Tire Corporation, TJX Canada, Metrolinx,
the provincial and territorial power utilities and the municipal transit agencies all publish the
brands they run. So the pack is built from **verified brand names plus a matcher that tolerates
descriptor variation**, and the second half is what makes the first half enough:
`normalizeMerchant()` has already uppercased the line and removed the channel prefix, the
`STORE`/`UNIT` marker, the `#nnn`, digit runs of five or more, reference tokens and the trailing
`CITY PROVINCE` before any rule sees it. What survives is the brand text. A `word` rule on the
brand token therefore does not need anyone to know what the bank prints.

Match types follow from that directly. **`pack_version` 3 adds no new `contains` rule at all** —
`contains` earns its place only where a brand is *glued* to a suffix so token matching cannot see it
(`FORTIS`, for FortisBC and FortisAlberta, remains the pack's one standing example), and no brand
added here is like that. 99 of the 107 additions are `word`; the other 8 are `exact`, each for a
reason named above (which takes the pack's `exact` count from one — `RONA` — to nine).

**The limits of that, stated plainly:**

- **A brand the pack names is not a descriptor the pack has seen.** If a bank abbreviates a banner
  (`CDN TIRE`, `SOBEYS URBAN FRESH`, a store's own trading name instead of the banner), the rule
  simply does not fire. It will not misfire.
- **Coverage is skewed to where the brand lists are.** Ontario and Quebec are covered best, because
  Ontario publishes a roster of every licensed electricity distributor and Quebec's grocery and
  hardware banners are documented by their owners. Small-municipality utilities and transit systems
  are a known gap, not an oversight — see "left out" below.
- **A banner may have closed since it was verified.** That is harmless: a rule for a retired banner
  never fires. Currency was therefore weighted far below ambiguity when deciding what to include.
- **Nothing here was inferred from any household's transactions.** No statement data of any kind
  went into this pack, in this revision or any earlier one.

Sources used, by area: Metro Inc.'s own banner page (`corpo.metro.ca/en/about-us/food.html`) and
Pattison Food Group's own banner page (`pattisonfoodgroup.com/retail-banners/`) were read directly;
Empire's family-of-grocers banner list (Sobeys Inc. fast facts, plus Empire's own sponsorship
releases naming all eight banners) and the Loblaw Companies 22-banner roster; Couche-Tard's brand
list and its own Circle K global-launch release; Parkland's Canadian retail brands
(`parkland.ca`); Imperial Oil's "Esso and Mobil stations" page; Irving Oil's retail-network
description; Canadian Tire Corporation's MD&A banner list; TJX Canada's own banner pages
(`tjx.com/businesses/canada/…`); Metrolinx's "About us" page naming its three operating divisions
(PRESTO, GO Transit, UP Express); the Ontario licensed-electricity-distributor roster (63 LDCs) and
Enova Power's merger record; the company records for Yukon Energy, Qulliq Energy Corporation,
Northwest Territories Power Corporation and Maritime Electric; the CPTDB Canadian transit-agency
index, the Financial Accountability Office of Ontario's transit report (which ranks Ontario's
agencies) and ATUQ's Quebec member list; reporting on independent-ISP ownership (TekSavvy,
Distributel, VMedia, oxio, Ebox) and Xplore Inc.'s rebrand from Xplornet; and each coffee chain's
own company record.

### Three collisions fixed in rules that had already shipped

All three are the same defect — a `contains` pattern of five or six characters, long enough to
clear the "no `contains` shorter than 5 characters" guard and still short enough to sit inside a
longer, unrelated word. All three are now `word`, which resolves each one **completely**, because
in every case the colliding text is a *single token*: `METROLINX`, `METROPOLITAN`, `PRESTON`,
`SHELLEY` and `SHELLFISH` are one word each, and a `word` rule compares whole tokens.

| Rule | Also matched | What it cost |
| --- | --- | --- |
| `METRO` → Groceries | `METROLINX`, `METROPOLITAN` | GO Transit fares filed as Groceries |
| `PRESTO` → Transit | `PRESTON` | a place name and a surname read as a fare card |
| `SHELL` → Gas | `SHELLEY`, `SHELLFISH` | an e-transfer to a person named Shelley filed as Gas |

None of the three needed `exact`, and `exact` would have been the wrong answer for all of them:
`exact METRO` would lose `METRO PLUS` (a real Metro Inc. banner), `exact PRESTO` would lose
`PRESTO FARE LOAD`, and `exact SHELL` would lose `SHELL CANADA`. The guard test asserts each rule
still reaches those lines, so narrowing the pattern cannot quietly become deleting it.

**One residual risk each, worth knowing about.** `word` fixes the substring class outright; it does
not and cannot fix a *different business whose name contains the same standalone word*. A merchant
literally called "Metro ⟨something⟩" that is not the grocer, or "Presto ⟨something⟩" that is not the
fare card, still matches. (Loblaw did once run a Quebec cash-and-carry banner called Presto; it was
folded into Wholesale Club in 2005, so that particular overlap is historical.) Both rules stay broad
because the banner names are real and common — check the rule's impact figure if a number looks
wrong.

### What was added, by category

**Gas (6).** `CIRCLE K` and `COUCHE-TARD` (Couche-Tard's Canadian banners — fuel plus convenience,
categorized as Gas on the same precedent that already puts Petro-Canada and Esso there even though
both sell snacks), `MOBIL` (Imperial Oil's second retail brand in Canada since 2017), `IRVING OIL`
and `IRVING`, `CO-OP GAS BAR`.

**Groceries (22).** Loblaw: `T&T SUPERMARKET`, `WHOLESALE CLUB`, `FRESHMART`. Empire/Sobeys:
`FOODLAND`, `RACHELLE-BÉRY`/`RACHELLE-BERY`, `BONICHOIX`. Metro Inc.: `SUPER C`, `ADONIS`,
`PREMIÈRE MOISSON`/`PREMIERE MOISSON`, `MARCHÉ RICHELIEU`/`MARCHE RICHELIEU`. Pattison Food Group:
`URBAN FARE`, `BUY-LOW FOODS`, `NESTERS MARKET`, `QUALITY FOODS`, `PRICESMART FOODS`,
`CHOICES MARKET`. Independent: `CALGARY CO-OP`, `BULK BARN`, `M&M FOOD MARKET`.

**Coffee (6).** `BALZAC'S`, `BRIDGEHEAD`, `GOOD EARTH COFFEEHOUSE`, `JJ BEAN`, `BLENZ`,
`AROMA ESPRESSO`. This is the smallest addition of the seven and that is the method working as
intended: several well-known café chains could not be established as current operating brands from
a source worth defending, so they were left out rather than guessed at.

**Utilities (24).** Twenty Ontario local distribution companies, drawn from the province's own
licensed-distributor roster and cut at roughly "serves a municipality of 50,000 or more":
`ALECTRA`, `ELEXICON`, `ENOVA POWER`, `KITCHENER-WILMOT HYDRO`, `WATERLOO NORTH HYDRO`,
`LONDON HYDRO`, `ENWIN`, `GRANDBRIDGE ENERGY`, `ENTEGRUS`, `GREATER SUDBURY HYDRO`,
`SYNERGY NORTH`, `OSHAWA PUC`, `BURLINGTON HYDRO`, `OAKVILLE HYDRO`, `MILTON HYDRO`,
`NIAGARA PENINSULA ENERGY`, `UTILITIES KINGSTON`, `KINGSTON HYDRO`, `NORTH BAY HYDRO`,
`BLUEWATER POWER`. Plus the four provincial/territorial utilities the pack was missing:
`MARITIME ELECTRIC`, `YUKON ENERGY`, `QULLIQ ENERGY`, `NORTHWEST TERRITORIES POWER`.
(`KITCHENER-WILMOT HYDRO` and `WATERLOO NORTH HYDRO` merged into Enova Power; all three ship,
because a legacy name on a legacy bill is exactly the harmless kind of miss.)

**Internet & Phone (10).** `TEKSAVVY`, `FIZZ`, `XPLORE`, `XPLORNET`, `DISTRIBUTEL`, `VMEDIA`,
`BEANFIELD`, `OXIO`, `EBOX`, and `VIDÉOTRON` — the accented spelling of a brand the pack already
carried only in ASCII.

**Transit (21).** `METROLINX`; Ontario municipal agencies `MIWAY`, `BRAMPTON TRANSIT`,
`YORK REGION TRANSIT`, `DURHAM REGION TRANSIT`, `GRAND RIVER TRANSIT`, `HAMILTON STREET RAILWAY`,
`LONDON TRANSIT`, `TRANSIT WINDSOR`; western and Atlantic agencies `CALGARY TRANSIT`,
`EDMONTON TRANSIT`, `WINNIPEG TRANSIT`, `SASKATOON TRANSIT`, `REGINA TRANSIT`, `BC TRANSIT`,
`HALIFAX TRANSIT`; and the five Quebec agencies as `exact` acronyms — `RTC`, `STL`, `RTL`, `STS`,
`EXO`.

**Shopping (16).** Canadian Tire Corporation banners `SPORTCHEK`/`SPORT CHEK`, `SPORTS EXPERTS`,
`HOCKEY EXPERTS`, `PRO HOCKEY LIFE`, `PARTY CITY`, and `MARK'S`/`L'ÉQUIPEUR`/`L'EQUIPEUR` under
Shopping › Clothing (the one category this revision adds to the pack's declared list; it already
existed in `SEED_CATEGORIES`, so importing still creates nothing). TJX Canada: `WINNERS`,
`HOMESENSE`, `MARSHALLS`. Single-purpose retail: `LEON'S`, `SLEEP COUNTRY`, `STRUCTUBE`,
`CHAPTERS`.

**Rename-only (2).** `CANAC` and `PATRICK MORIN` join the hardware chains the pack cleans up
without categorizing — the same treatment Home Depot, Rona, Lowe's and Home Hardware already get,
for the same reason: a household splits hardware spending across categories, so a rename that
cannot misfile anything is the honest rule.

### Accents: both spellings ship, and that is not optional

`normalizeMerchant()` uppercases and preserves the Latin-1 accented block (the `ALNUM` class in
`normalize.ts` exists for exactly this), and it does **not** fold `É` to `E`. So `BÉRY` and `BERY`
are two different tokens, an accented pattern reaches only accented text, and an ASCII pattern
reaches only ASCII text. Canadian banks print both. The pack's answer — already its practice for
`HYDRO-QUÉBEC` and `ÉNERGIR`, and now a tested rule — is to **ship both spellings of every accented
brand**, and the guard asserts structurally that no accented pattern is ever added without its
unaccented sibling. Note the asymmetry with punctuation: one `word` rule covers hyphen *and* space,
but never accented *and* unaccented.

### What was deliberately left out, and why

A smaller correct pack was the goal, so these were rejected rather than shipped:

- **`ON THE RUN`** (a real Parkland/Esso fuel-convenience brand) — `word ON THE RUN` is three
  common English words; "⟨anything⟩ on the run" is a plausible merchant name.
- **`UP EXPRESS`** (a real Metrolinx division) — measured against the live normalizer,
  `TUNE UP EXPRESS #4 BARRIE ON` tokenizes to `TUNE UP EXPRESS` and would have matched. UP Express
  fares are paid with PRESTO anyway, which the pack already covers.
- **`THE BRICK`** (a real Leon's Furniture banner) — matches any merchant beginning "The Brick …",
  a pub or a bakery included.
- **`INDIGO`** (Indigo Books & Music) — the pack already ships `INDIGO PARK` for the parking
  operator, and the two are different categories. This one was found *by* the cross-collision
  check, which is the argument for having it. `CHAPTERS` carries the bookseller instead.
- **`ATMOSPHERE`, `ROOTS`, `MICHAELS`, `SIMONS`, `GARAGE`, `DYNAMITE`, `VOILÀ`, `NEEDS`,
  `DOMINION`** — all real Canadian banners whose brand text is an ordinary word or a surname.
- **`SAQ`, `LCBO` and the provincial liquor retailers** — real, unambiguous, and there is no
  category in the seeded tree they belong to. Groceries would be wrong and Shopping › General
  would be a shrug.
- **`ENERCARE`, `RELIANCE HOME COMFORT`** — genuine monthly household bills, but home-services and
  equipment-rental billing rather than a metered utility.
- **Small-municipality utilities and transit systems** — the Ontario roster alone has 63 LDCs, and
  the tail is single-community distributors. Adding your own is one row on the merchant rules page.
- **Anything whose brand or operator could not be established from a source worth naming** —
  including several plausible ISPs and café chains. The pack would rather miss.

### If you already installed pack_version 1 or 2

**From `pack_version` 2**: 107 rules are genuinely new and appear as plain additions. Three rules
(`METRO`, `PRESTO`, `SHELL`) changed **only** their match type, and because a rule's identity
includes its match type (`merchant_rules_pattern_uq` is `(pattern, match_type, rule_kind)`) the
update screen shows each of those three as **one addition and one removal**, not as a change — the
same presentation the twelve `pack_version` 2 promotions had, and for the same reason.

**Here that presentation matters more than it did for the promotions**, and this is the one thing
worth reading twice. If you leave the removals in place (the default), the old `contains METRO`,
`contains PRESTO` and `contains SHELL` rows survive as ordinary household rules with their pack
stamp cleared — and *those are the rows carrying the collision*. `matchRule` picks the longest
matching pattern, which rescues some lines by accident and not others: on `METROLINX GO TRANSIT`
the new `word METROLINX` and the existing `contains GO TRANSIT` are both longer than `METRO`, so
that line lands on Transit regardless. But on `METROPOLITAN SUPPLY CO`, `PRESTON HARDWARE` or an
e-transfer naming Shelley, the surviving `contains` row is the *only* rule that matches anything at
all — so it wins, and the misfiling continues exactly as before. **To actually get the fix, tick
the box that deletes the removals.** For every other rule in this update, leaving the removals is
harmless; for these three it is the difference between reading about a fix and having one.

**From `pack_version` 1**: the same, plus everything in the section above about the twelve
match-type promotions — fifteen add/remove pairs in total, of which three (these) want the removal
deleted.
