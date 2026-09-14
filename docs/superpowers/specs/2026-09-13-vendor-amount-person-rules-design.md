# Merchant rules that see the amount and set the person — design

**Date:** 2026-09-13
**Status:** Owner feature request (2026-09-13), two asks taken together. Rulings **P1–P19** below are
the PLANNER's; each names the code fact that forced it and each is reversible by the owner. Nothing
here is implemented; this document is the plan.
**Target release:** v1.37.0 (built on v1.36.1 — `package.json` reads `1.36.1`, so the next release
with a migration takes the minor bump exactly as v1.14.0 did for `0014`).
**Answers:** the owner's two requests, verbatim in the Problem section, and `docs/PENDING-FIXES.md`
item **R27a** in part (its *predicate* ships here; its *storage* does not — see the R27a section).
**Migration:** `drizzle/0024_rule_bounds_and_attribution.sql` — the only migration in this release.
Three `ALTER TABLE ... ADD COLUMN`s and one index drop-and-recreate on `merchant_rules`. No table
rebuild, no row rewritten. `drizzle/meta/_journal.json` gains `idx: 24` after `0023_summary_frequency`.

---

## Problem

The owner, verbatim:

1. *"insurance is with same company but different amount but imported categorizes the last setting
   i do so everything goes to home or auto. can i set in rule vendor + amount rule? they dont have to
   be automatic but something i create from kebab menu?"*
2. *"think about person too so its not just on vendor rule, even sets household, or individual
   person."*

What the code does today, and why each half of the ask is currently impossible rather than merely
missing:

**A rule sees the merchant text and nothing else.** `matchRule(normalizedMerchant, kind, rules)`
(`src/lib/categorize/rules.ts:275-292`) is a pure function of the merchant string; `patternMatches`
(`:172-177`) compares text under one of three match types. `EngineTxn` — the row shape the engine
categorizes — is `{ id, normalizedMerchant }` and no more (`src/lib/categorize/engine.ts:74-77`), and
`selectRowsByIds` never selects `amount_cents` (`:243-248`). Two policies from one insurer arrive as
the same normalized merchant, so the same rule fires for both.

**"The last setting I do" is exactly what the teach path writes.** Correcting a row in review mode
calls `confirmCategory` with `createRule: true` (`src/app/(app)/transactions/actions.ts:225-234`),
which upserts the **exact** rule for that merchant (`engine.ts:1011-1020`), and
`upsertRuleFromCorrection`'s `onConflictDoUpdate` overwrites `categoryId` on the existing row
(`rules.ts:489-497`). Every correction of either policy flips the single rule the merchant has, so
the next import files both policies under whichever was corrected last. That is the owner's report,
mechanically.

**Two rules for one merchant cannot coexist.** `merchant_rules_pattern_uq` is
`(pattern, match_type, rule_kind)` (`src/db/schema.ts:411`; created by `drizzle/0000_init.sql:144`
and never touched since — `0016_rule_hygiene.sql:52-58` and `0018_pack_origin_key.sql:17,32` only
refer to it). A second `exact` category rule on the same pattern is a UNIQUE violation, not a second
rule. So even if a rule could carry an amount, the table could not hold two of them.

**A rule cannot set the person.** `RuleKind` is `'category' | 'transfer' | 'rename' | 'not_transfer'`
(`rules.ts:40`). Attribution is decided once, at import, by `resolveAttribution` inside `commitImport`
(`src/lib/import/commit.ts:126-142`): the per-card map (`account_card_people`, `schema.ts:191-205`)
if the mapping names a card column, else the account owner (`:107`). The engine never writes
`attributed_user_id` (`engine.ts:316-325` sets category, source, confidence, transfer flag and
`updated_at` only). After import the only writer is the hand edit, `bulkSetAttribution`
(`src/lib/transactions.ts:1055-1063`).

**Not in scope.** No change to the Bayes classifier. No amount on transfer, rename or not_transfer
rules (ruling P5). No new `transactions` column (P9, P10). No pack format change (P13). No loan-rule
storage change — R27a's predicate is shared, its storage is its own item.

---

## Rulings

All nineteen are the planner's. **PLANNER rulings — owner may reverse.**

| # | Ruling |
|---|---|
| **P1** | **Amount bounds are a min/max range on the magnitude, stored as two nullable integer columns** `amount_min_cents`, `amount_max_cents`. Both NULL is "unbounded" — every existing row. One side NULL is open on that side, the same shape `RuleScope.from/to` already uses for dates (`engine.ts:353-358`). The match compares against `abs(transactions.amount_cents)`, so a refund of the premium files with the premium and follows the same person. Why a range and not a tolerance or exact cents: exact cents dies at the first renewal; a tolerance is a centre plus a percentage whose *effective* range is hidden from the rules table; a range is what a tolerance computes to, stores as two plain integers, and prints honestly in the Match column ("$125.00 – $155.00"). The kebab prefills a range *from* a tolerance (P14), so the person still thinks "about this much". |
| **P2** | **Bounds join the unique key, by expression index, under the same name.** `0024` drops `merchant_rules_pattern_uq` and recreates it as `(pattern, match_type, rule_kind, coalesce(amount_min_cents, -1), coalesce(amount_max_cents, -1))`. `coalesce` is load-bearing: SQLite treats NULLs as distinct in a UNIQUE index, so a plain five-column index would let two unbounded rules coexist and break every upsert. Same name, so `tests/db/schema.test.ts:48` keeps asserting it exists. **The drizzle `uniqueIndex(...)` declaration at `schema.ts:411` is removed** and the index becomes SQL-only, documented in the table's docblock — the precedent is `loan_matcher_rules_uq` (`schema.ts:1109-1113`: "a weaker index with the same name is worse than none, because a future drizzle-kit push could use it to replace the real one"). Additive: no rebuild, no row rewritten; every existing row has NULL bounds, coalesces to `-1`, and keeps the key it had. |
| **P3** | **`ruleKeyOf` stays byte-identical for unbounded rules.** `packs.ts:1217-1219` builds `pattern\|match_type\|rule_kind`, and `merchant_rules.pack_origin_key` stores that string (`schema.ts:379-409`); the pack update walk keys three maps on it (`src/lib/canadian-pack.ts:409-410, 421, 435`). If the key grew a fixed `\|min\|max` suffix, every stored origin would stop comparing equal and the next pack update would read every stamped rule as "edited by the household". So the suffix is appended **only when a bound is non-null**. Pinned by a test: `ruleKeyOf({pattern:'P', matchType:'exact', ruleKind:'category'})` equals the three-part string exactly. |
| **P4** | **Bounded beats unbounded, before length is even consulted.** `outranks` (`rules.ts:294-302`) ranks length → match type → lowest id. A bounded and an unbounded `exact` rule on one merchant tie on length and type, so today the *older* rule (lower id) — the owner's merchant-wide one — would win. The new first step: a bounded candidate outranks an unbounded incumbent. Between two bounded rules that both match, the **narrower range** wins (open side counts as unbounded width). Then the existing chain, unchanged. Why bounds outrank length: a bound is a second dimension of commitment — a person who wrote an amount described *this charge*, not the merchant's whole shelf — and a bounded rule only ever fires when the amount agrees, so when both match it described the row more completely. Every existing precedence test (`tests/lib/categorize/rules.test.ts:131-163, 324-365`) stays green: with NULL bounds on both sides the two new steps are no-ops. |
| **P5** | **Bounds are a `category` and `attribution` capability only.** `AMOUNT_BOUND_KINDS = ['category', 'attribution']` and `amountBoundsAllowedForKind(kind)`, enforced at the write choke point (`upsertRuleFromCorrection` throws, beside the `WORD_MATCH_KIND_ERROR` throw at `rules.ts:398-400`) and the read choke point (`matchRule` skips, beside the `matchTypeAllowedForKind` skip at `:284`) — the exact shape `WORD_MATCH_KINDS` already has (`:83-87`). A transfer rule is about one description; a rename is cosmetic and applies whatever the amount; a not_transfer is a veto. None of them has an amount to be about. |
| **P6** | **One amount predicate, in a client-safe module.** `amountWithinBounds(amountCents, minCents, maxCents)` and `defaultBoundsAround(amountCents)` live in a new `src/lib/categorize/amount-bounds.ts` with no `@/db` import (`tests/ops/client-bundle.test.ts` is the guard that keeps it so). `matchRule` calls it; the kebab dialog (a client component) calls it to prefill; and R27a's loan matcher will call it — see the R27a section. A guard test (`tests/ops/amount-bounds.test.ts`) asserts no other file under `src/` compares a transaction amount against `amountMinCents`/`amountMaxCents` directly, so the predicate cannot fork the way the display precedence once did (`src/lib/display-source.ts:7-19`). |
| **P7** | **The engine learns the amount at every attribution surface, and the per-merchant memo is widened only when it has to be.** `EngineTxn` gains `amountCents`; `selectRowsByIds` selects it; `categorizeTransaction` passes it to `matchRule`. `ruleAttributor`'s cache (`engine.ts:493-499`) rests on "attribution reads NOTHING but the merchant text" (`:487-491`), which a bounded rule falsifies. The key becomes `(merchant, amount)` **when `ctx.rules` contains any bounded rule**, computed once per context, else the merchant alone; `ruleImpactCounts`' three `group by normalized_merchant` queries (`:626-636, 644-648, 658-663`) add `amount_cents` to the grouping under the same condition; `ruleImpactIds` selects it (`:718`). A household with no bounded rule pays nothing new — the scan is byte-identical. Measured before merge, the `engine.ts:1684` way ("MEASURED, not asserted"). |
| **P8** | **The person is a new `RuleKind`, `'attribution'`, carrying one nullable column** `attributed_user_id integer REFERENCES users(id)` on `merchant_rules`. **Rejected:** a person column on category rows, so one rule sets both. A person-only rule would then be a category rule with `category_id` NULL — the R-02 defect `ruleOutcomeMissing` exists to refuse (`rules.ts:269-273`, `:423-429`) — and `findRedundantRules`' kind-specific "identical outcome" test (`:662-667`), the pack exporter's category handling and the rules table's outcome column would each have to learn a second outcome on one row. A kind is what this codebase already uses for "a different thing a rule can say" (`schema.ts:337`), and `merchant_rules_pattern_uq` includes `rule_kind`, so a category rule and an attribution rule on the same pattern already coexist (`tests/db/schema.test.ts:144-159`). The kebab dialog creates up to two rules and says so. |
| **P9** | **On an attribution rule, NULL `attributed_user_id` means "Household", unambiguously — and in the transactions table NULL already IS Household.** There is no third state to confuse it with: every person picker's blank option is Household (`transactions-client.tsx:1791, 1858`; `actions.ts:386-389, 406`), `reports.ts:26-27` reads NULL as the `'unattributed'` scope, and `UNATTRIBUTED_LABEL` (`reports.ts:636`) is the export's word for the same rows. So `ruleOutcomeMissing` returns `false` for this kind — the kind is the outcome when the column is null, exactly as it already says for `transfer`/`not_transfer` (`rules.ts:257-259`). An attribution rule "→ Household" writes NULL to the row; its value is that it **overrides the fallback chain** (card map, then account owner) that would otherwise put the row on somebody. No new `transactions` column. |
| **P10** | **Attribution rules apply at three deliberate points and never inside `runEngine`.** (a) At import commit, as the first step of `resolveAttribution` (`commit.ts:126-142`): **rule > card > owner** — for CSV and SimpleFIN alike, since `sync.ts:171` goes through `commitImport`. (b) The kebab's create-and-apply over the rows it names (P15). (c) The rules page's per-rule "Apply now" for this kind. Why not the engine: `ELIGIBLE` (`engine.ts:184-187`) protects a human *category* decision through `categorization_source`; `attributed_user_id` has no source column, so a re-run could not tell a hand-picked person from the owner fallback and would overwrite `bulkSetAttribution`'s work (`transactions.ts:1055-1063`). This is also the literal reading of "they dont have to be automatic". **Rejected for now, recorded as Q4:** `transactions.attribution_source` + a precedence module, the R24 shape — the right answer *if* re-runs must ever set a person. |
| **P11** | **Precedence of a rule-set person.** Against the per-card map at import: the rule wins (P10a), because a rule names a merchant and an amount and the card map names a whole account — the specific beats the general, R24's own argument (`display-source.ts:21-27`). Against a person set by hand *later*: the hand edit wins, because nothing automatic writes the column after insert (P10). The kebab pass and "Apply now" overwrite whatever the matching rows carry, hand-set included — the same thing `applyCategoryToMatching` already does to a `'manual'` category (`engine.ts:1299-1310` selects every non-transfer row whose category differs and never reads `categorization_source`) — and the dialog states the count before the click. |
| **P12** | **"Delete rule and clear from transactions" is refused for the attribution kind.** `ruleClearIds` returns `[]` and `clearRuleFromTransactions` writes nothing, exactly as for `not_transfer` (`engine.ts:791, 865`). For a category rule, clearing means *uncategorized* — a real "undecided" state `REVIEW_WHERE` picks back up (`:1370-1375`, `:815-823`). NULL attribution is not undecided; it is Household. And nothing records what the row carried before (the same schema fact `:815-818` states for categories). Delete-only, and the dialog says so, reusing the `not_transfer` wording's shape (`merchant-rules-client.tsx:586-594`). |
| **P13** | **Packs: attribution rules are excluded in both directions; bounded rules are excluded from export.** User ids are one install's own wiring — `packs.ts:101-107`'s `not_transfer` argument word for word — so `exportableRules` (`:518-528`) drops the kind and `IMPORTABLE_RULE_KINDS` (`:109`) does not gain it; an imported entry naming it is skipped and counted, the ruling-(a) path. A bounded rule's bounds are the household's own statement figures, so export drops bounded rows too (the rename opt-in's reasoning at `:86-93`). `packRuleSchema` (`:265-321`) gains no fields: a pack cannot say either thing. |
| **P14** | **One kebab item, one dialog, prefilled from the row.** Menu item **"Create a rule…"**, offered inside the existing `row.isTransfer ? null :` block with Split and Assign to loan (`transactions-client.tsx:1181-1206`), and not to a self-scoped viewer (a rule is household-wide; `applyToAllMatchingAction` already refuses them, `actions.ts:331`). The dialog (`RowDialog`, the shell every row editor uses, `:1233` ff.) is titled `Rule for "<normalized merchant>"` and shows: the merchant (read-only; kebab-authored rules are `exact`, as every per-row path is — `engine.ts:1014, 1230, 1245, 1318`); **Amount** — a checkbox "Only when the amount is about {formatCents(\|amount\|)}", on by default, with Min/Max money inputs prefilled by `defaultBoundsAround` (±10%, floor $1.00, whole dollars); **Category** — "Leave as is" or a category, prefilled with the row's; **Person** — "Leave as is", "Household", or a person from `people` (the page already passes `listAttributablePeople()`, `page.tsx:158-164`), prefilled with the row's. At least one of Category/Person must be chosen: *"Pick a category, a person, or both."* |
| **P15** | **Preview, then create.** The dialog's first button is **Preview**, a form action that returns a sentence and no write: *"N transactions from this merchant match (M inside this amount range). K would change category; J would change person."* The second, **Create rule(s) and apply to N**, posts to one action → one engine function `createRulesFromRow` (below). The rules page already does preview-then-act for a clear (`settings/merchant-rules/actions.ts:306-314`), and the existing apply-all dialog only shows its count in review mode because `matchingCounts` is computed at page render (`page.tsx:100-102`) — a bounded count needs the round trip. Result copy: *"Created 2 rules. Filed 7 transactions as Auto and set 7 to Sam."* |
| **P16** | **`createRulesFromRow` resolves both rule writes before any row write, and a refusal rolls back the first.** Ruling R4's invariant — ownership settled BEFORE any row is touched (`engine.ts:97-100`, `:1286-1289`) — now spans two upserts. The function runs inside one `db.transaction`; a second-rule refusal throws a sentinel that the outer catch turns into the `owned_by_another` result, so the first rule is rolled back too (the `RuleOwnedRefusal` shape `createManualTransaction` already uses, `transactions.ts:1036`). Rows: one select by `normalized_merchant` (`transactions_normalized_merchant_idx`, `schema.ts:263`), `is_transfer = 0`, and `abs(amount_cents) between` the bounds; then `confirmCategory({ createRule: false })` per row (the path `applyCategoryToMatching` reuses, `:1327-1338`) and one chunked `update ... set attributed_user_id` for the person. It **checks** `confirmCategory`'s `has_splits` refusal and reports the skipped count — `applyCategoryToMatching` discards that return today (`:1330-1337`) and so over-reports; the new function does not inherit that. Registered in `RULE_AUTHORING_PATHS` as `NAME_DECLARES_IT` ("the name contains *create* and *rules*, and takes a merchant, not a transaction id" — `tests/ops/rule-authoring-intent.test.ts:282-344`). |
| **P17** | **The import-time chain becomes one definition with a guard.** `resolveAttribution` moves out of its closure in `commit.ts:132-142` into a pure `src/lib/attribution.ts` — `resolveAttribution({ rule, card, owner })` returning `{ userId, source: 'rule' \| 'card' \| 'owner' }` — so the sentence "rule > card > owner at insert; a later hand edit wins because nothing automatic writes the column afterward" is written once. `commitImport` loads `listRules('attribution')` once per commit beside `cardMap` (`:114-118`), hoists `normalizeMerchant(row.rawDescription)` above the resolver call, and tallies rule matches into `attributionSummary` (`:81-88, 120-124`) so the sentence the household reads ("8 rows to Alex, 3 rows by rule, 2 to the account owner") stays true. The guard, `tests/ops/attribution-writers.test.ts`, enumerates every write of `attributedUserId` under `src/` with its reason — `commit.ts:210` (import, through the resolver), `transactions.ts:991` (manual add: the explicit pick, else owner), `transactions.ts:1055-1063` (the hand edit), and the new engine writer — in the shape of `tests/ops/display-source-writers.test.ts:60-81`. A fifth writer fails the file. (`installments.ts:420` passes an argument to `createManualTransaction`; it is not a column write and the scan does not see it.) |
| **P18** | **The teach path is unchanged in this release, and that is a stated gap, not an oversight.** `confirmCategory` upserts the *unbounded* exact rule (`engine.ts:1011-1020`). After a bounded rule exists, correcting a row inside its range through teach flips the merchant-wide rule and leaves the bounded rule winning with the old category on the next import. Recorded as **Q3** with a recommended default (teach targets the single bounded exact rule covering the row's amount, when exactly one does) and a contingent task T10. Shipping P4 without Q3 is safe — nothing the household has today gets worse — but the two rules can be made to disagree, so the help text says which one a correction edits. |
| **P19** | **The rules form learns bounds and the person, or editing a bounded rule there is a trap.** `saveRuleAction` upserts on `(pattern, match_type, rule_kind)` with no row id (`settings/merchant-rules/actions.ts:74-87`), so a form edit of a bounded row would write the *unbounded* row and leave the bounded one untouched, with "Rule saved." on screen. The form (`merchant-rules-client.tsx:86-99`, `:689-727`) gains two optional money inputs (category kind) and a person select (attribution kind); the action's zod object (`actions.ts:59-88`) gains the three fields; `planPackOriginCarry`/`applyPackOriginCarry` take the bounds through `ruleKeyOf` (P3). Match column prints the range; Kind badge says **Person**; outcome column prints the person's name or "Household" (`:989-997`). |

---

## Data model

### Migration `drizzle/0024_rule_bounds_and_attribution.sql`

Five statements, each separated by the journal's breakpoint marker (described, not quoted, in the
file's header — the `0014` convention). Header follows `0023_summary_frequency.sql`'s: the owner's
words, what the columns answer, and why every existing row is unchanged.

```sql
ALTER TABLE `merchant_rules` ADD `amount_min_cents` integer CHECK (`amount_min_cents` IS NULL OR `amount_min_cents` >= 0);
ALTER TABLE `merchant_rules` ADD `amount_max_cents` integer CHECK (`amount_max_cents` IS NULL OR `amount_max_cents` >= 0);
ALTER TABLE `merchant_rules` ADD `attributed_user_id` integer REFERENCES `users`(`id`);
DROP INDEX `merchant_rules_pattern_uq`;
CREATE UNIQUE INDEX `merchant_rules_pattern_uq` ON `merchant_rules` (
  `pattern`, `match_type`, `rule_kind`,
  coalesce(`amount_min_cents`, -1), coalesce(`amount_max_cents`, -1)
);
```

- The two inline CHECKs are forward-only and harmless for the reason `0014`'s header gives
  (`2026-08-28-loans-lent-direction-design.md`, ruling P2): the columns are new, every existing row
  takes NULL. `min <= max` spans two columns and is enforced in the app (zod on the form and the
  dialog; `upsertRuleFromCorrection` throws) — the same "SQL and again in zod" discipline
  `loan_matcher_rules`' three-character floor uses (`schema.ts:1115-1118`, `loans.ts:146`).
- The index recreate cannot fail on existing data: the new key is a superset of the old one.
- `rule_kind` needs no widening: `0000_init.sql:135` declares it `text DEFAULT 'category' NOT NULL`
  with no CHECK, so `'attribution'` is a TypeScript-level addition, exactly as `'word'` was for
  `match_type` (`rules.ts:23-26`). `merchant_rule_merges.dropped_rule_kind` (`schema.ts:454`) is
  not widened: nothing writes that table at runtime (`:439-442`).

### Schema mirror — `src/db/schema.ts`

Three columns declared last in `merchantRules`, after `packOriginKey`, under the
ALTER-TABLE-ADD-COLUMN convention the table already follows (`:352-353`, `:380-381`):

```ts
    /** v1.37.0, drizzle/0024. Both NULL = unbounded (every row before 0024). Compared against
     *  abs(transactions.amount_cents) by amountWithinBounds (src/lib/categorize/amount-bounds.ts),
     *  the ONE predicate. Allowed on AMOUNT_BOUND_KINDS only (rules.ts). */
    amountMinCents: integer('amount_min_cents'),
    amountMaxCents: integer('amount_max_cents'),
    /** v1.37.0, drizzle/0024. Set only on rule_kind = 'attribution'; NULL there means Household
     *  (planner ruling P9). NULL on every other kind. */
    attributedUserId: integer('attributed_user_id').references(() => users.id),
```

The `uniqueIndex('merchant_rules_pattern_uq')` declaration at `:411` is **deleted** and the table's
docblock gains the SQL-only inventory line, mirroring `:1107-1113`:

```
 * NOT represented here; SQL only:
 *   - merchant_rules_pattern_uq: (pattern, match_type, rule_kind, coalesce(amount_min_cents,-1),
 *     coalesce(amount_max_cents,-1)). Declaring the old three-column uniqueIndex here would be
 *     a WEAKER index with the same name -- the loan_matcher_rules_uq hazard, verbatim.
```

`ruleKind`'s enum (`:337`) and `RuleKind` (`rules.ts:40`) gain `'attribution'`. The compiler then
enumerates every place that must decide what the kind means: `KIND_LABEL`
(`merchant-rules-client.tsx:45`), `kindCounts` (`:517`), `saveRuleAction`'s zod enum
(`actions.ts:63`), `ALL_RULE_KINDS` in `tests/ops/rule-attribution-honesty.test.ts:69-74`, and
`findRedundantRules`' outcome ternary (`rules.ts:662-667`).

### `MerchantRuleRecord` and the write choke point — `src/lib/categorize/rules.ts`

`MerchantRuleRecord` (`:110-137`) gains `amountMinCents`, `amountMaxCents`, `attributedUserId`.
`upsertRuleFromCorrection` (`:349-512`):

- gains `amountMinCents?`, `amountMaxCents?`, `attributedUserId?` inputs; throws (programmer error,
  the `:380-400` argument) when bounds arrive on a kind outside `AMOUNT_BOUND_KINDS`, when
  `min > max`, or when `attributedUserId` arrives on any kind but `'attribution'`;
- **replaces `onConflictDoUpdate` with select-then-update-or-insert.** SQLite requires an
  `ON CONFLICT` target to name the unique index exactly, and drizzle's `target:` cannot spell the
  two `coalesce` expressions; the function already performs the `existing` select (`:445-456`) for
  ownership, so the branch is one `if`. The `set` object keeps R4's rule — `createdBy` absent
  (`:491`) — and adds nothing new to it: bounds are part of the *key*, so an update never changes
  them, and `attributedUserId` is the attribution kind's outcome, so it is set the way `categoryId` is.
- `exactRuleOwner` (`:330-347`), `deleteExactRule` (`:518-524`) and `deleteRenameRule`
  (`engine.ts:1659-1668`) add `amount_min_cents IS NULL AND amount_max_cents IS NULL` to their
  `where`: "the exact rule" a per-row path learns, owns or deletes is the **unbounded** one, and
  that is now a stated fact with a test rather than an accident of there being only one.

### The pure module — `src/lib/categorize/amount-bounds.ts`

No `@/db`, no clock. Importable by the kebab dialog, `rules.ts`, and later `loans.ts`.

```ts
/** Both null = unbounded. Compared against the MAGNITUDE, so a refund files with its charge. */
export function amountWithinBounds(amountCents: number, minCents: number | null, maxCents: number | null): boolean {
  const magnitude = Math.abs(amountCents);
  if (minCents !== null && magnitude < minCents) return false;
  if (maxCents !== null && magnitude > maxCents) return false;
  return true;
}

export function isBounded(rule: { amountMinCents: number | null; amountMaxCents: number | null }): boolean;

/** Width of a range for the P4 narrower-wins tie-break; an open side is Infinity. */
export function boundsWidth(rule): number;

/** ±10% of the magnitude, floor $1.00, rounded outward to whole dollars — the kebab's prefill. */
export function defaultBoundsAround(amountCents: number): { minCents: number; maxCents: number };
```

`matchRule` becomes `matchRule(normalizedMerchant, kind, rules, amountCents: number | null = null)`.
A bounded rule is skipped when `amountCents` is null — a rule that needs an amount cannot fire
without one, and no caller of a kind outside `AMOUNT_BOUND_KINDS` passes one. `patternMatches`
(`:172-177`) does not change: it is the text predicate the shipped-pack guard asserts against
(`tests/ops/canadian-merchants-pack.test.ts`) and must stay pure text.

---

## Matching and precedence

`outranks` (`rules.ts:294-302`) becomes a five-step chain; the last three are today's, untouched:

| Step | Rule | Why here |
|---|---|---|
| 1 | bounded beats unbounded | P4: the bound is a second dimension of commitment, and it only fires when the amount agrees |
| 2 | narrower `boundsWidth` wins | two ranges that both hold the amount: the tighter one described it better |
| 3 | longer pattern wins | unchanged (`:295-297`) |
| 4 | `exact > word > contains` | unchanged (`:298-300`) |
| 5 | lowest id | unchanged (`:301`) |

Worked, on the owner's case with invented figures. Rules: **R1** `exact ACME INSURANCE → Home`
(unbounded, id 3); **R2** `exact ACME INSURANCE [$125.00–$155.00] → Auto` (id 41).

| Transaction | R1 matches | R2 matches | Winner | Files as |
|---|---|---|---|---|
| ACME INSURANCE −$140.12 | yes | yes | R2 (step 1) | Auto |
| ACME INSURANCE −$89.40 | yes | no (below min) | R1 | Home |
| ACME INSURANCE +$140.12 (refund) | yes | yes (magnitude) | R2 | Auto |
| ACME INSURANCE −$161.00 (renewal, +15%) | yes | **no** (above max) | R1 | **Home — the silent fall-through, see Risks** |

`findRedundantRules` (`:649-676`) extends its coverage matrix (`:584-590`) by one axis: a narrow
rule is coverable only if `!isBounded(broad)` or (`isBounded(narrow)` and narrow's range lies inside
broad's). A bounded rule with the *same* outcome as the unbounded rule above it IS redundant (P4 makes
it win, but deleting it changes nothing) and is flagged; the owner's pair has different outcomes and
is never flagged. An unbounded rule is never "covered" by a bounded one.

**What happens to a rule whose bounds no longer match anything.** The rules page's **Affects** column
(`ruleImpactCounts`, `engine.ts:616-668`) reads 0 for it — that column exists precisely to tell
"matches nothing" from "works" (`:585-593`) — and P19 prints the range beside the 0, so the row
explains itself. Nothing disables it automatically: a rule that stopped matching at renewal is one
the household wants to *edit*, not lose. The unbounded rule catches the row meanwhile, which is the
one real risk below.

---

## Attribution as a rule outcome

**How it is decided today, in order** (`commit.ts:126-142`, doc at `:126-131`): no card column or
no map → account owner (`:107`, itself nullable — an account with no owner yields NULL); cell missing
or empty after `normalizeCardValue` → owner; value not in the map → owner; else the mapped person.
Written once at insert (`:210`). `createManualTransaction` writes the explicit pick, else the owner
(`transactions.ts:991`). `bulkSetAttribution` is the hand edit (`:1055-1063`). Loans never write it
(`loans.ts:33`). The engine never writes it.

**After this release**, in `src/lib/attribution.ts` (P17):

| Moment | Order | Overwrites a hand-set person? |
|---|---|---|
| import commit (CSV, SimpleFIN) | **rule** (merchant + amount) > card map > account owner > NULL | n/a — the row is new |
| kebab "Create rule(s) and apply to N" | the rule's person, over every matching non-transfer row | yes, and the preview says how many rows change |
| rules page "Apply now" (attribution kind) | same set as the kebab pass | yes, with the same preview |
| "Run rules" / re-run / "Apply now" on a category rule | never touches the column | — |
| hand edit, any time | wins, because nothing automatic runs after insert | — |

`attributedUserId` is nullable (`schema.ts:213`) and NULL already means Household (P9). So
"household" and "no attribution" are **one state with two labels** in this schema — 'Household' on
the row (`transactions-client.tsx:1791`), 'Household/unattributed' in the filter (`:1858`, `:3003`),
`'unattributed'` in the report scope (`reports.ts:26`) and the digest (`digest.ts:331`). An
attribution rule "→ Household" is therefore not a new value; it is an instruction to *stop the
fallback chain* from putting the row on the card's person or the account owner. If the owner wants
"explicitly household" to be distinguishable from "nobody said" — Q1 below — that is a `transactions`
change this plan deliberately does not make.

**Attribution surfaces for the new kind** (the four `rule-attribution-honesty.test.ts` names):
`candidateRowsFor('attribution')` (`engine.ts:739-747`) is `is_transfer = 0`; `attributedRuleId`
resolves through `matchRule(merchant, 'attribution', rules, amount)`; **Affects** and `ruleImpactIds`
count rows whose stored `attributed_user_id` differs from the rule's target (forward-looking, the
transfer kind's own definition at `:691-693`); `eligibleForRuleReapply` returns that same set (it
cannot reuse `eligibleForRerun`, whose `ELIGIBLE` is about categories); `ruleClearIds` returns `[]`
(P12). `ruleImpactIds` and `selectRowsByIds` select `attributed_user_id` and `amount_cents` to make
that answerable off a fetched row.

---

## Authoring from the kebab

**Menu** (`rowMenu`, `transactions-client.tsx:1127-1231`): one `RowMenuButton` **"Create a rule…"**
after "Assign to loan…" inside the `row.isTransfer ? null :` block, rendered for `!selfScoped`. The
existing apply-all items (`:1218-1228`) stay exactly as they are — they remain the plain
"every transaction from this merchant, one category" path, and their dialog is not widened.

**Dialog** (`ruleDialog()`, a sibling of `applyAllDialog` at `:1425-1477`, same `RowDialog` shell):

| Field | Control | Prefilled from the row |
|---|---|---|
| Merchant | read-only text | `row.normalizedMerchant` |
| Amount | checkbox "Only when the amount is about {formatCents(\|row.amountCents\|)}" + Min/Max money inputs | on; `defaultBoundsAround(row.amountCents)` |
| Category | select: "Leave as is" / categories (`categoryOptGroups`) | `row.categoryId` |
| Person | select: "Leave as is" / "Household" / `people` | `row.attributedUserId` (`''` → Household) |
| Preview | secondary button → `previewRowRuleAction` | — |
| Create | `SubmitButton` "Create rule(s) and apply to N" → `createRulesFromRowAction` | enabled after a preview |

Guards it passes legitimately: `tests/ops/row-controls.test.ts:35-49` — the form has two selects
and visible money inputs, so it is not the lone-select shape; `tests/ops/use-server-exports.test.ts`
— both new actions are `async function`s, helpers stay module-private; `tests/ops/table-layout.test.ts`
— no new column; the dialog is a `RowDialog`, not a row.

**Actions** (`transactions/actions.ts`): `previewRowRuleAction` and `createRulesFromRowAction`, both
refusing cross-origin and self-scoped viewers exactly as `applyToAllMatchingAction` (`:327-340`),
parsing the person through `attributedUserIdField` (`:386-389`) and the bounds through
`parseAmountToCents` (`src/lib/money.ts:11`). The create action calls **one** engine function and
maps its refusal through `guardedWriteError`.

**What confirmCategory's `createRule` flag has to do with this.** Nothing directly — the kebab path
never calls `confirmCategory` with `createRule: true`; the rules are written by `createRulesFromRow`
and the per-row confirms pass `createRule: false` (`engine.ts:1328-1334`'s reasoning). The intent
guard's DETECTOR 2 (`rule-authoring-intent.test.ts:351-374`) will insist the flag is spelled out at
every call, which it is.

---

## Retroactivity

| Event | Rows re-run | Mechanism |
|---|---|---|
| kebab create | the matching set (merchant, bounds, non-transfer), counted first | `createRulesFromRow` (P16) — one indexed select, per-row confirms, one chunked attribution update. No full-table pass. |
| next import | the inserted rows | category via `runEngine` (`flow.ts:165`, `sync.ts:235`) now amount-aware; person via `resolveAttribution` at commit (P10a) |
| "Run rules" / re-run | `ELIGIBLE` rows | bounded category rules fire like any other; attribution never (P10) |
| rules page "Apply now", category kind | `eligibleForRuleReapply` (`engine.ts:522-535`), now honest about bounds through P7 | unchanged path |
| rules page "Apply now", attribution kind | rows the rule would change | new branch; preview first |
| rename passes | untouched | `applyRenameRules` reads no amount and no person (`:1484-1563`) |

**R-10.** The v1.31.0 finding (`engine.ts:1672-1697`: many per-rule full-table rename passes,
measured 2.3x) is about *bulk* rule operations each paying a full scan. Nothing here adds a scan per
rule: the kebab pass is bounded by the merchant's own rows, and `ruleImpactCounts` remains the one
full-table read the rules page already pays per render, byte-identical while no bounded rule exists
(P7). Creating a rule from the kebab does not re-run the engine over anything it did not name.

---

## R27a — the same mechanism?

R27a (`docs/PENDING-FIXES.md:1804-1806`): *"a loan rule should be able to carry an expected amount,
matched within a tolerance … no migration if it reads the item's existing payment amount."* Today's
loan matcher is `txn.normalizedMerchant.includes(rule.merchantContains)` plus an optional account
(`loans.ts:692-696`), with "no amount check" (`PENDING-FIXES.md:1787-1790`).

**Same predicate, different storage — and only the predicate ships here.** `amountWithinBounds`
(P6) is the whole of "does this amount fall in that window". A merchant rule stores its window in two
columns; a loan rule would derive its window from `warranty_items.billing_amount_cents` and a
tolerance (`activeRules` already joins `warrantyItems`, `loans.ts:242-244`, and `LoanRule` carries
no amount, `:105-111`). So R27a becomes: add a tolerance to the loan-rule form, call
`amountWithinBounds(txn.amountCents, billing − tol, billing + tol)` inside the `rules.find` at
`:692`, and that is all. The `tests/ops/amount-bounds.test.ts` guard (P6) is what makes "the same
mechanism" a fact rather than a sentence: a second `>=`/`<=` comparison in `loans.ts` fails it.

**Not done in this release, deliberately.** R27a's storage question (a per-rule tolerance column
versus reading the item's amount) is its own ruling, and `loans.ts` is the one file this plan does
not open — the same lane discipline the loans spec kept (`2026-08-28-loans-lent-direction-design.md`,
P14). Q5 asks whether to pull it in.

---

## Guard strategy

| Guard | What it does today | What this plan does to it |
|---|---|---|
| `tests/db/schema.test.ts:33-72` `EXPECTED_INDEXES` | asserts `merchant_rules_pattern_uq` exists by name | **unchanged** — same name. `:144-159` (kinds coexist on one pattern) unchanged. |
| new `tests/db/migration-0024.test.ts` | — | three columns nullable no default; index SQL read from `sqlite_master` contains both `coalesce`; `(P, exact, category)` with bounds `[100,200]` and `[100,300]` coexist, identical bounds collide, two NULL-bound rows collide; journal `idx: 24` newest (the `migration-0023.test.ts:53-63` hand-over) |
| `tests/lib/categorize/rules.test.ts:131-163, 324-365` | length → type → id | **unchanged and must stay green.** New cases: bounded beats unbounded regardless of id; narrower beats wider; bounded rule skipped when no amount is passed; bounds refused on `transfer`/`rename`/`not_transfer` at both choke points; `findRedundantRules` matrix rows |
| `tests/ops/rule-attribution-honesty.test.ts:63-74` | `satisfies Record<RuleKind, true>` | **compile break** the moment `'attribution'` lands; `INEXACT_PAIRS` (`:82-86`) demands a `contains attribution` scenario (`reapply: true`, `clear: {attributes:false, why: P12}`). **New:** a bounded `exact` category scenario — `exact` is exempt there as "the degenerate case the shortcut got right by accident" (`:77-81`), and bounds make `exact` non-degenerate, so the exemption's own reasoning admits it |
| `tests/ops/rule-authoring-intent.test.ts:282-344` | exact set of engine paths | `createRulesFromRow` registered `NAME_DECLARES_IT` with a reason ≥ 80 chars; `commit.ts` calls `listRules`/`matchRule` (readers, not in `RULE_AUTHORING_HELPERS` `:103-108`) so no allow-list entry |
| `tests/ops/client-bundle.test.ts` | client files import no `@/db` | `amount-bounds.ts` must pass it |
| new `tests/ops/amount-bounds.test.ts` (P6) | — | one predicate; no other file compares an amount to `amountMinCents`/`amountMaxCents`; non-vacuity block reconstructs the offence |
| new `tests/ops/attribution-writers.test.ts` (P17) | — | every `attributedUserId` write under `src/` is enumerated with a reason |
| `tests/ops/row-controls.test.ts:35-49` | lone-select-plus-Save | dialog has two selects + visible inputs — exempt at `:63`/`:66` |
| `tests/ops/canadian-merchants-pack.test.ts` | pack collisions via `patternMatches` | untouched — `patternMatches` does not change |
| `tests/lib/categorize/engine.test.ts:378-385` | `applyCategoryToMatching` count | unchanged; new `createRulesFromRow` block beside it |
| `tests/app/help.test.tsx` | help paragraphs | one new assertion for the rules paragraph (T9) |
| `tests/ops/docker.test.ts` | version/CHANGELOG discipline | `1.37.0` block, migration note present (the v1.14.0 shape) |

---

## Tasks

Ranked in build order. Each names the test that fails first. Efforts are the planner's estimates for
one implementer with the suite green at the start.

| # | Task | Fails first | Effort |
|---|---|---|---|
| **T1** | Migration `0024` + journal + schema mirror (three columns, index declaration removed, docblock) + `MerchantRuleRecord`/`listRules` + `upsertRuleFromCorrection` select-then-write with the P5/`min<=max`/kind throws + unbounded-only `exactRuleOwner`/`deleteExactRule`/`deleteRenameRule` | `tests/db/migration-0024.test.ts` (columns absent; index SQL lacks `coalesce`; second bounded row throws UNIQUE) | 2.5 h |
| **T2** | `amount-bounds.ts` + `matchRule` amount parameter + `outranks` steps 1–2 + `AMOUNT_BOUND_KINDS` + `findRedundantRules` bounds axis + `ruleKeyOf` conditional suffix | `rules.test.ts`: "a bounded rule outranks the unbounded one whatever its id" (winner is the lower id today); `tests/lib/packs` `ruleKeyOf` three-part equality | 2 h |
| **T3** | Engine amount plumbing: `EngineTxn`, `selectRowsByIds`, `categorizeTransaction`, `ruleAttributor` conditional key, `ruleImpactCounts` conditional grouping, `ruleImpactIds` select; measure | `rule-attribution-honesty.test.ts` new bounded-exact scenario: Affects reads 0 while `runEngine` files the row | 2 h |
| **T4** | `'attribution'` kind end to end: `RuleKind`, `ruleOutcomeMissing`, `matchTypeAllowedForKind` (word refused, as for transfer), attribution surfaces (`candidateRowsFor`, `eligibleForRuleReapply`, `ruleClearIds []`, `clearRuleFromTransactions` refusal, "Apply now" branch), `KIND_LABEL`/`kindCounts`, packs exclusions both directions + bounded-export exclusion | `tsc --noEmit` on `rule-attribution-honesty.test.ts:69-74`; then its `INEXACT_PAIRS` equality for the missing scenario; `tests/lib/packs`: attribution row absent from `previewRulesPackExport` | 2.5 h |
| **T5** | `src/lib/attribution.ts` resolver + `commitImport` integration (rules loaded once, merchant hoisted, `attributionSummary` tally) + `tests/ops/attribution-writers.test.ts` | `tests/lib/import/commit.test.ts`: a row matching an attribution rule lands on the rule's person, not the card's | 2 h |
| **T6** | `createRulesFromRow` in `engine.ts` (two upserts before any row write, sentinel rollback, bounded select, per-row confirms with `has_splits` counted, chunked attribution update) + `RULE_AUTHORING_PATHS` entry | `rule-authoring-intent.test.ts:513-523` ("a new exported function reaches a rule-authoring helper") — then `engine.test.ts`: member refused on the second rule leaves zero rules and zero row writes | 2 h |
| **T7** | Kebab item, `ruleDialog`, `previewRowRuleAction`, `createRulesFromRowAction`, client tests (editor APPEARS in both table and card branches — the CB lesson, `PENDING-FIXES.md:1750-1760`) | `tests/app/transactions-client.test.tsx`: menu offers "Create a rule…" on a non-transfer row and the dialog shows Min/Max prefilled from the row's amount | 3 h |
| **T8** | Rules page: Match column range, Person badge/outcome, form fields + `saveRuleAction` fields, origin-carry through `ruleKeyOf`, not_transfer-style delete dialog wording for attribution | `tests/app/merchant-rules*.test.tsx`: saving an edit of a bounded rule keeps its bounds (today it writes the unbounded row) | 2.5 h |
| **T9** | Help paragraph (Rules section, after `help/content.tsx:211-217`'s rule sentences; says which rule a correction edits per P18), `CHANGELOG.md` `[1.37.0]` with the migration block, `package.json`, `docker.test.ts`, `PENDING-FIXES.md` entry naming this spec and updating R27a's status line | `tests/app/help.test.tsx`; `tests/ops/docker.test.ts` | 45 min |
| **T10** | *(contingent on Q3 = yes)* teach path targets the single bounded exact rule covering the row's amount | `engine.test.ts`: correcting a row inside a bounded rule's range updates that rule's category and leaves the unbounded rule alone | 1 h |

**Total: ~19 h without T10, ~20 h with it.** T1→T2→T3 are sequential (each widens a shape the next
reads). T4 and T5 are independent of each other after T2. T6 needs T4 and T5. T7 and T8 need T6 and
can run in parallel. T9 last.

---

## Risks, and what could break silently

1. **Renewal fall-through.** A premium that rises past `max` stops matching the bounded rule and
   the unbounded rule files it as the *other* policy, with no error. The bounded rule's Affects only
   drifts toward 0 over months. R27b-shaped mitigation (route a merchant that has bounded rules but
   matched only the unbounded one into review) is out of scope — **Q2**.
2. **Teach contradicts the bounded rule** (P18). Until Q3 is ruled, a correction inside a bounded
   range edits the merchant-wide rule; the bounded rule keeps winning on import with the old answer.
3. **A caller forgets the amount.** Any path that calls `matchRule` for a category without the
   amount makes every bounded rule invisible there — Affects 0 while imports file rows by it. The
   bounded-exact honesty scenario (T3) is the only thing standing between that and a repeat of R-01.
4. **The removed drizzle index declaration.** `drizzle-kit generate` would now propose recreating a
   three-column index. This repo hand-writes migrations, and `migration-0024.test.ts` reads the real
   index SQL from `sqlite_master`, so a regression is a red test, not a silent downgrade — but the
   docblock must say so, or the next reader "fixes" it.
5. **Two rules, one refusal.** A member owning neither rule: refused before any write (P16). A
   member owning one of the two: the other refuses and the first must roll back, or the household
   is left with half a statement. The sentinel-throw test in T6 is the guard.
6. **The import summary lies by omission** if rule matches are counted as fallbacks
   (`commit.ts:198-203` tallies `matchedName` or falls back). T5 adds the third tally.
7. **Packs.** Without P13, a household's export carries its premium amounts and user ids that mean
   nothing elsewhere. The export-preview test is the guard.
8. **`applyCategoryToMatching`'s over-count** (`engine.ts:1330-1337` ignores `has_splits`) is not
   fixed here — only not inherited. Left as is, and noted.
9. **Self-scoped viewers.** The row's person select is hidden for them (`transactions-client.tsx:1784`);
   the menu item must be too, or a self viewer reaches a household-wide write through the dialog. The
   action refuses regardless (P14), so the failure would be a confusing error, not a leak.
10. **NULL owner.** An account with no `ownerUserId` yields NULL attribution today (`commit.ts:107`).
    An attribution rule "→ Household" on such an account writes NULL to NULL — a no-op that the
    preview honestly reports as 0 rows changing. Not a defect; worth a sentence in the help text.

---

## Open questions for the owner

| # | Question | Planner's default if unanswered |
|---|---|---|
| **Q1** | "Sets household": do you mean the blank/Household state the person pickers already have (a row on nobody in particular), or a *distinct* "this is genuinely shared" that reports should tell apart from "nobody said"? The second needs a `transactions` change this plan does not make. | The first (P9). |
| **Q2** | When a bounded rule stops matching (a premium rises past its range) and the merchant-wide rule catches the row instead, should that row go to the review queue rather than being filed silently? | Not in this release; recorded beside R27b. |
| **Q3** | When you correct a row that a bounded rule already covers, should the correction update *that* rule (recommended), or keep updating the merchant-wide rule as today? | Yes — T10 ships. |
| **Q4** | Should "Run rules" ever set a person? Doing it safely needs an `attribution_source` column so a re-run never overwrites a person you set by hand. | No — the three deliberate points in P10 only. |
| **Q5** | R27a: put the tolerance on loan rules in this same release (opens `loans.ts`, ~1.5 h more), or keep it as its own item now that the predicate exists? | Its own item. |
| **Q6** | The prefill window: ±10% of the row's amount, floor $1, whole dollars — or a fixed ±$5? | ±10%. |
| **Q7** | At import, a rule's person beats the card map (a payment for Sam's policy charged to Alex's card lands on Sam). Confirm that is the order you want. | Rule wins (P11). |
