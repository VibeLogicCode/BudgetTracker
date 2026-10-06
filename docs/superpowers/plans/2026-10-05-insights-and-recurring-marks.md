# An Insights page, and merchants the household marks as recurring — Implementation Plan (v1.54.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A household whose card was replaced opens **Insights**, picks that card under **Account**, and reads the full list of merchants that bill it — the ones they marked or track (**Known recurring**) and the ones the dates show (**Looks recurring**) — and can mark, unmark or dismiss a merchant from there or from any Transactions row. The full **Needs a look** list lives on the same page.

**Architecture:** No migration and no new column. A mark is a merchant rule of one of two new kinds, `recurring` and `not_recurring` (`merchant_rules.rule_kind` has no CHECK). The read model `recurringCharges` (src/lib/recurring.ts) still stores nothing: it reads one 1200-day slice, now with the account of each charge, resolves marks through `matchRule`, and returns two tiers plus a per-band count of rhythms one charge short. The card moves from Loans & Coverage to a new `/insights` route; marks are written by two new server actions in `transactions/actions.ts`, used by the Transactions row menu, its bulk bar and the Insights card.

**Tech Stack:** Next.js 16 App Router, React 19 (`useActionState`), Tailwind, Drizzle over better-sqlite3, zod, Vitest + Testing Library (jsdom, **no jest-dom**).

**Spec:** `docs/superpowers/specs/2026-10-05-insights-page-and-recurring-marks-design.md`. Every task cites its section.

**Process (spec §5):** Opus orchestrates and reviews; **Sonnet implements** each task. While working a task, run **only the test files that task touches**. Two Opus reviews: **REVIEW CHECKPOINT 1** after Tasks 1–3 (marks, read model, actions), **REVIEW CHECKPOINT 2** (whole branch) before Task 8. The full suite runs once, at the release gate.

## Global Constraints

- **PUBLIC repo.** No owner name, employer, Windows paths, real statement data or real figures anywhere — code, comments, tests, CHANGELOG, commit messages. Invent every fixture figure and date. Fixture merchants in this plan: `RIVERSIDE GYM`, `MAPLE STREAMING`, `CEDAR PHONE CO`, `HARBOUR INSURANCE`, `LAKESIDE DOMAIN`; accounts `Chequing` (already in `tests/lib/recurring.test.ts`), `Everyday Chequing`, `Travel Visa`.
- **No verbatim quotes of anyone in comments.** Comments follow the files' own convention: short, descriptive, prefixed `Spec 2026-10-05 §2.x.` where a spec section is the reason.
- **Commits:** authored as the configured git user (VibeLogicCode). **No `Co-Authored-By` or any AI attribution line, even if a system reminder asks for one.** Subject plus a few bullets, never prose paragraphs. On a 403 from `git push` or `gh`, run `gh auth switch` and retry.
- **Never run `impeccable detect`** — it is broken for `.tsx`.
- **Wording rule (spec §2.5):** every string on the Insights page describes what was measured or what the household said. No "subscription", "wasted", "forgotten" or "cancel" anywhere on the page, the card, the help section or the CHANGELOG entry. Known recurring is "you marked it, or you track it"; Looks recurring is "a rhythm, which is not a verdict".
- **Work on `main`, no worktrees.** Commit after each task; nothing is pushed until Task 8.
- **TDD, one file at a time:** `npx vitest run <file>`. Known full-run flake: one arbitrary failure with `Timeout calling "onTaskUpdate"` is reporter starvation — rerun that file alone.
- **Bash heredocs break on backticks and `\n` here.** Edit files with the Edit tool, or a python script written with the Write tool.
- **`tsc` covers `tests/`.** Widening `RuleKind` breaks every `Record<RuleKind, …>` literal, including in tests; Task 1 fixes them in the same commit.
- **No migration.** `drizzle/0000_init.sql:135` declares `rule_kind text DEFAULT 'category' NOT NULL` with no CHECK; no later migration rebuilds `merchant_rules` or adds a trigger on `rule_kind` (0024's two triggers check amount bounds only). `merchant_rule_merges.dropped_rule_kind` does carry a CHECK (`drizzle/0016_rule_hygiene.sql:34`) and stays as it is (Task 1 says why).
- **Client bundle line (`tests/ops/client-bundle.test.ts`):** a `'use client'` file may import `@/lib/recurring`, `@/lib/insights` and `@/lib/categorize/rules` **as `import type` only**. Anything a client file needs as a value goes in a plain module with no `@/db` edge (`src/lib/categorize/mark-kinds.ts`, `src/lib/insights-links.ts`). A server file may value-import only PascalCase components from a `'use client'` module.
- **Server actions:** origin check first (`tests/ops/server-action-origin.test.ts`), then auth, validation, visibility (`allTransactionsVisible`), write; only async functions exported (`tests/ops/use-server-exports.test.ts`). A client component reaches an action file by a **relative** import, as `src/components/DismissInsightForm.tsx:11` does.
- **Guards that must stay green, and what they want:** `tests/ops/rule-authoring-intent.test.ts` (only argued files call a rule-authoring helper), `tests/ops/rule-attribution-honesty.test.ts` (every accepted `(match type, kind)` pair has a scenario; `ALL_RULE_KINDS satisfies Record<RuleKind, true>`), `tests/ops/visibility-invariants.test.ts`, `tests/ops/onboarding-coverage.test.ts` (every NAV href documented in help as a whole path segment, every NAV route renders `<PageGuide`, every `<EmptyState` has `action=` or a 30+ character `noAction=`), `tests/ops/transactions-href.test.ts` (build `/transactions?` links with `transactionsHref` only), `tests/ops/th-scope.test.ts` (`scope="col"`), `tests/ops/table-layout.test.ts` (every `<td>` in a responsive `TableWrap` file has `data-label`), `tests/ops/title-only-info.test.ts` (no `title` on `<td>`/`<th>`), `tests/ops/button-vocabulary.test.ts` (`buttonClass`, never `className="btn …"`), `tests/ops/row-controls.test.ts` (a form under `src/app` with one `<select>`, only hidden inputs and a submit button is refused — the account filter therefore lives in `src/components/insights/`).

## Review Focus

Inputs the spec implies that are most likely to bite a household; each names the test that pins it.

1. **A card replaced mid-history.** A merchant whose newest charge already landed on the new card but whose older charges were on the replaced one must still be listed when the replaced card is chosen. Task 2, `'keeps a row whose older charges were on the chosen account'`.
2. **A member marking a merchant whose opposite mark an admin wrote** must get one sentence and no write — and in the bulk bar, no write for any merchant in the selection. Task 1 (`'refuses a member who would remove somebody else's opposite mark, and writes nothing'`, `'rolls back every merchant when the mark itself belongs to somebody else'`) and Task 3 (`'a refusal over one merchant writes nothing for the others'`).
3. **A self-scoped member on Insights** must see only their own charges whatever `?person=` says, and an `?account=` they cannot see reads as All accounts. Task 7, `'a self viewer sees only their own charges, whatever ?person= says'` and `'ignores an account the viewer cannot see'`.
4. **Not recurring is a round trip.** It removes the merchant from both tiers and from the forming count; the Transactions row menu then offers the way back. Task 2 (`'drops a not_recurring merchant from both tiers and from the forming count'`) and Task 4 (`'offers Mark recurring and a way back from Not recurring'`).
5. **A merchant marked after a single charge** must render — `Marked`, `1 charge`, an em dash for the typical amount — with no crash on a null cadence or typical amount. Task 2 (`'lists a merchant the household marked under Known, after a single charge'`) and Task 5 (`'shows Marked and an em dash for a merchant marked after one charge'`).

## Decisions this plan makes where the code and the spec meet

1. **`merchant_rule_merges` has no runtime writer.** Its only writer is the one-time INSERT in `drizzle/0016_rule_hygiene.sql`; nothing under `src/` merges merchants or rules. So nothing happens to a mark "on a merged merchant": no code path records one. The collision 0016 merged (two spellings of one pattern) cannot recur because `upsertRuleFromCorrection` uppercases every pattern. Task 1 pins both facts.
2. **Marks are exact by default, not exact-only** — the `not_transfer` precedent (`src/lib/categorize/rules.ts:34-40`). `matchTypeAllowedForKind` accepts `contains` on the new kinds, so the honesty guard needs attribution scenarios and the engine needs mark branches (Task 1).
3. **`RECURRING_MAX_ROWS` (12) applies to Looks recurring only, after the account filter.** Known recurring is uncapped: it is the card-replacement list and must be complete.
4. **The card's old copy contradicts the spec** ("A rhythm is not a subscription", "Nothing on this card is saved anywhere", and a docblock saying nothing about the feature is stored). The copy and docblocks are rewritten (Tasks 2 and 5).
5. **Known = a `recurring` mark, or a detected rhythm that something covers.** `tracked` has only ever been resolved for detected rows; an item whose name resembles a merchant with no rhythm does not make it Known.
6. **The forming sentence is per band.** The spec's example says "about a month apart"; a two-charge yearly rhythm is counted too and named as such.
7. **Loans & Coverage drops the card in Task 2**, not with the page, because the read model's new shape no longer fits the old card.
8. **Rules manager:** marks get labels and chips; **Apply now** and **Edit** are hidden for them (the form has no option for these kinds and would turn a mark into another kind on save); Delete and Disable work. The form and `saveRuleAction`'s enum are unchanged — marks are made on Transactions and Insights.
9. **Pack export would have shipped marks** (`exportableRules` returns true for any kind it does not name). Excluded in both directions, like `not_transfer`.
10. **Account options are `listAccounts({}, viewer)`** filtered by `acceptsTransactions` — spec-literal. For a self viewer that excludes a joint account even though their rows can name it (as `TransactionRow.accountName` already does).

---

## File map

| Area | Files |
|---|---|
| Marks | `src/db/schema.ts`, `src/lib/categorize/mark-kinds.ts` (new), `src/lib/categorize/rules.ts`, `src/lib/categorize/engine.ts`, `src/lib/packs.ts` |
| Rules manager | `src/app/(app)/settings/merchant-rules/page.tsx`, `merchant-rules-client.tsx` |
| Read model | `src/lib/predict/anomalies.ts`, `src/lib/recurring.ts` |
| Actions | `src/lib/transactions.ts`, `src/app/(app)/transactions/actions.ts` |
| Transactions UI | `src/app/(app)/transactions/page.tsx`, `transactions-client.tsx` |
| Card | `src/components/insights/RecurringChargesCard.tsx` (moved from `src/components/warranty/`), `src/components/insights/RecurringMarkForm.tsx` (new) |
| Needs a look | `src/lib/insights.ts`, `src/lib/insights-links.ts` (new), `src/components/NeedsALookCard.tsx`, `src/app/(app)/dashboard/page.tsx`, `src/app/(app)/dashboard/actions.ts` |
| Page | `src/app/(app)/insights/page.tsx`, `insights-client.tsx`, `loading.tsx` (all new), `src/components/app-shell/nav.ts`, `src/components/icons.tsx`, `scripts/smoke-routes.mjs` |
| Removed from | `src/app/(app)/warranties/page.tsx`, `warranties-client.tsx` |
| Help, release | `src/app/(app)/help/content.tsx`, `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json` |
| Guards touched | `tests/ops/rule-attribution-honesty.test.ts`, `tests/ops/rule-authoring-intent.test.ts`, `tests/ops/visibility-invariants.test.ts`, `tests/ops/docker.test.ts` |

---

### Task 1: Marks are merchant rules (spec §2.2)

**Files:**
- Create: `src/lib/categorize/mark-kinds.ts`
- Modify: `src/db/schema.ts:344-354` (the `ruleKind` enum and its docblock)
- Modify: `src/lib/categorize/rules.ts` (`RuleKind` at :41, new exports appended at the end of the file)
- Modify: `src/lib/categorize/engine.ts` (`eligibleForRuleReapply` :602, `ruleImpactCounts` :749, `candidateRowsFor` :946, `ruleClearIds` :997, `clearRuleFromTransactions` :1083, the `./rules` import at :12)
- Modify: `src/lib/packs.ts` (`exportableRules` :526)
- Modify: `src/app/(app)/settings/merchant-rules/page.tsx:18,64`, `merchant-rules-client.tsx` (`KIND_LABEL` :71, `deleteRuleDialog` :632, `PageGuide` :878, kind chips :923-926, row menu :1110-1138)
- Test: `tests/lib/categorize/rules.test.ts`, `tests/ops/rule-attribution-honesty.test.ts`, `tests/ops/rule-authoring-intent.test.ts`, `tests/lib/packs.test.ts`, `tests/db/schema.test.ts`, `tests/app/merchant-rules-client.test.tsx`

**Interfaces:**
- Produces (`src/lib/categorize/mark-kinds.ts`, no imports, client-safe): `type RecurringMark = 'recurring' | 'not_recurring'`; `RECURRING_MARK_KINDS: readonly RecurringMark[]`; `isRecurringMarkKind(kind: string): kind is RecurringMark`.
- Produces (`src/lib/categorize/rules.ts`, server-only): `RuleKind` gains `'recurring' | 'not_recurring'`; re-exports the three names above; `listRecurringMarkRules(): MerchantRuleRecord[]`; `recurringMarkFor(normalizedMerchant: string, rules: MerchantRuleRecord[]): RecurringMark | null`; `type RecurringMarkResult = { ok: true; merchants: number } | { ok: false; reason: 'owned_by_another'; ownerName: string }`; `setRecurringMarks(input: { merchants: readonly string[]; mark: RecurringMark | null; userId: number; actorRole: 'admin' | 'member'; at?: Date }): RecurringMarkResult`.

- [ ] **Step 1: Write the failing lib tests**

In `tests/lib/categorize/rules.test.ts`, add `listRecurringMarkRules`, `recurringMarkFor`, `setRecurringMarks`, `isRecurringMarkKind`, `RECURRING_MARK_KINDS` to the existing `@/lib/categorize/rules` import, then append:

```ts
/** Spec 2026-10-05 §2.2. A mark is a fact about a merchant, written as a rule of one of two kinds. */
describe('recurring marks', () => {
  const setupMarks = () => {
    current = createSeededTestDb();
    const admin = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
    const member = insertTestUser(current.db, { name: 'Bob', username: 'bob', role: 'member' });
    return { admin, member };
  };

  // Also the write side of the merge question: two spellings make ONE rule, so the collision
  // drizzle/0016 merged can never arise for a mark.
  it('writes one exact rule per merchant, uppercased like every other pattern', () => {
    const { admin } = setupMarks();
    expect(
      setRecurringMarks({ merchants: ['Riverside Gym', 'RIVERSIDE GYM'], mark: 'recurring', userId: admin, actorRole: 'admin' }),
    ).toEqual({ ok: true, merchants: 1 });
    expect(listRules('recurring').map((rule) => [rule.pattern, rule.matchType])).toEqual([['RIVERSIDE GYM', 'exact']]);
  });

  it('setting one kind takes the other off the merchant', () => {
    const { admin } = setupMarks();
    setRecurringMarks({ merchants: ['RIVERSIDE GYM'], mark: 'recurring', userId: admin, actorRole: 'admin' });
    setRecurringMarks({ merchants: ['RIVERSIDE GYM'], mark: 'not_recurring', userId: admin, actorRole: 'admin' });
    expect(listRules('recurring')).toEqual([]);
    expect(listRules('not_recurring').map((rule) => rule.pattern)).toEqual(['RIVERSIDE GYM']);
  });

  it('null takes either mark off', () => {
    const { admin } = setupMarks();
    setRecurringMarks({ merchants: ['RIVERSIDE GYM'], mark: 'not_recurring', userId: admin, actorRole: 'admin' });
    expect(setRecurringMarks({ merchants: ['RIVERSIDE GYM'], mark: null, userId: admin, actorRole: 'admin' })).toEqual({ ok: true, merchants: 1 });
    expect(listRecurringMarkRules()).toEqual([]);
  });

  /** Review Focus 2. Resolved before anything is written, the setTransferFlag order (item BJ). */
  it("refuses a member who would remove somebody else's opposite mark, and writes nothing", () => {
    const { admin, member } = setupMarks();
    setRecurringMarks({ merchants: ['CEDAR PHONE CO'], mark: 'not_recurring', userId: admin, actorRole: 'admin' });
    expect(
      setRecurringMarks({ merchants: ['RIVERSIDE GYM', 'CEDAR PHONE CO'], mark: 'recurring', userId: member, actorRole: 'member' }),
    ).toEqual({ ok: false, reason: 'owned_by_another', ownerName: 'Alice' });
    expect(listRules('recurring')).toEqual([]);
    expect(listRules('not_recurring').map((rule) => rule.pattern)).toEqual(['CEDAR PHONE CO']);
  });

  /** Review Focus 2, the other half: the mark's own rule belongs to somebody else. */
  it('rolls back every merchant when the mark itself belongs to somebody else', () => {
    const { admin, member } = setupMarks();
    setRecurringMarks({ merchants: ['CEDAR PHONE CO'], mark: 'recurring', userId: admin, actorRole: 'admin' });
    expect(
      setRecurringMarks({ merchants: ['RIVERSIDE GYM', 'CEDAR PHONE CO'], mark: 'recurring', userId: member, actorRole: 'member' }),
    ).toEqual({ ok: false, reason: 'owned_by_another', ownerName: 'Alice' });
    expect(listRules('recurring').map((rule) => rule.pattern)).toEqual(['CEDAR PHONE CO']);
  });

  it('lets an admin write over anyone', () => {
    const { admin, member } = setupMarks();
    setRecurringMarks({ merchants: ['CEDAR PHONE CO'], mark: 'not_recurring', userId: member, actorRole: 'member' });
    expect(setRecurringMarks({ merchants: ['CEDAR PHONE CO'], mark: 'recurring', userId: admin, actorRole: 'admin' })).toEqual({ ok: true, merchants: 1 });
    expect(listRules('not_recurring')).toEqual([]);
  });

  it('reads the mark through matchRule: exact or contains, never a disabled rule', () => {
    const { admin } = setupMarks();
    setRecurringMarks({ merchants: ['RIVERSIDE GYM'], mark: 'recurring', userId: admin, actorRole: 'admin' });
    upsertRuleFromCorrection({ pattern: 'HARBOUR', matchType: 'contains', ruleKind: 'not_recurring', categoryId: null, createdBy: admin, actorRole: 'admin' });
    const rules = listRecurringMarkRules();
    expect(recurringMarkFor('RIVERSIDE GYM', rules)).toBe('recurring');
    expect(recurringMarkFor('HARBOUR INSURANCE', rules)).toBe('not_recurring');
    expect(recurringMarkFor('CEDAR PHONE CO', rules)).toBeNull();
    setRuleDisabledFlag(listRules('recurring')[0]!.id, true);
    expect(recurringMarkFor('RIVERSIDE GYM', listRecurringMarkRules())).toBeNull();
  });

  it('names the two kinds in one place', () => {
    expect(RECURRING_MARK_KINDS).toEqual(['recurring', 'not_recurring']);
    expect(isRecurringMarkKind('recurring')).toBe(true);
    expect(isRecurringMarkKind('not_transfer')).toBe(false);
  });
});
```

Fails before / passes after: none of these exports exist until Step 5 adds them to `mark-kinds.ts` and `rules.ts`.

In `tests/lib/packs.test.ts`, after `'never exports not_transfer rules, even with the transfer toggle on (controller ruling a)'`, add:

```ts
  /** Spec 2026-10-05 §2.2. A mark is one household's word about its own merchants -- the not_transfer argument. */
  it('never exports a recurring mark of either kind, whatever the toggles say', () => {
    const { userId } = setup();
    upsertRuleFromCorrection({ pattern: 'RIVERSIDE GYM', matchType: 'exact', ruleKind: 'recurring', categoryId: null, createdBy: userId, actorRole: 'admin' });
    upsertRuleFromCorrection({ pattern: 'CEDAR PHONE CO', matchType: 'exact', ruleKind: 'not_recurring', categoryId: null, createdBy: userId, actorRole: 'admin' });
    const pack = exportRulesPack({ includeTransferRules: true, includeRenameRules: true });
    expect(pack.rules.some((r) => r.pattern === 'RIVERSIDE GYM' || r.pattern === 'CEDAR PHONE CO')).toBe(false);
    expect(
      previewRulesPackExport({ includeTransferRules: true, includeRenameRules: true }).some(
        (r) => r.ruleKind === 'recurring' || r.ruleKind === 'not_recurring',
      ),
    ).toBe(false);
  });
```

Fails before / passes after: `exportableRules`' final `return … : true` exports any kind it does not name; Step 6 excludes marks.

After `'skips a not_transfer rule entry in an incoming pack gracefully'`, add the import half (a **pin**: passes before and after, because `IMPORTABLE_RULE_KINDS` already omits the kinds; it guards the import half of the same rule):

```ts
  it('skips a recurring mark in an incoming pack rather than installing it', () => {
    setup();
    const pack = { ...exportRulesPack(), rules: [{ pattern: 'RIVERSIDE GYM', match_type: 'exact', rule_kind: 'recurring', category: null }] };
    expect(previewRulesPackImport(pack).skippedRules).toBe(1);
    expect(importRulesPack(pack).rulesSkipped).toBe(1);
    expect(listRules('recurring')).toHaveLength(0);
  });
```

In `tests/db/schema.test.ts`, after `'defaults disabled_at to NULL, and records a merge in merchant_rule_merges …'`, add two **pins** (both pass before and after; they record why no migration is needed and why the merge table stays narrow):

```ts
  /**
   * Spec 2026-10-05 §2.2. rule_kind has no CHECK, so the two mark kinds need no migration.
   * merchant_rule_merges.dropped_rule_kind does have one, and only drizzle/0016's one-time INSERT
   * writes that table, so it never has to hold a mark.
   */
  it('takes a recurring mark in merchant_rules, and keeps merchant_rule_merges to the kinds 0016 could merge', () => {
    current = createTestDb();
    const { sqlite } = current;
    sqlite
      .prepare(
        "insert into merchant_rules (id, pattern, match_type, rule_kind, category_id, hit_count, created_at) values (1, 'RIVERSIDE GYM', 'exact', 'recurring', null, 0, '2026-10-01T00:00:00.000Z')",
      )
      .run();
    expect(() =>
      sqlite
        .prepare(
          "insert into merchant_rule_merges (kept_rule_id, dropped_pattern, dropped_match_type, dropped_rule_kind, dropped_hit_count, dropped_created_at, merged_at) values (1, 'riverside gym', 'exact', 'recurring', 0, '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('nothing under src/ writes merchant_rule_merges at runtime', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const source = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
          if (/\bmerchantRuleMerges\b|merchant_rule_merges/.test(source)) offenders.push(path.relative(process.cwd(), full).replace(/\\/g, '/'));
        }
      }
    };
    walk(path.join(process.cwd(), 'src'));
    // The declaration is the one mention allowed: a writer here would need dropped_rule_kind widened.
    expect(offenders).toEqual(['src/db/schema.ts']);
  });
```

- [ ] **Step 2: Write the failing guard scenarios**

In `tests/ops/rule-attribution-honesty.test.ts`, add `recurring: true,` and `not_recurring: true,` to the `ALL_RULE_KINDS` object, and append two entries to `SCENARIOS` after `'rename'`:

```ts
  [
    'recurring',
    {
      build: () => {
        const { userId, add } = fixture();
        const txnId = add('RIVERSIDE GYM DOWNTOWN');
        const rule = upsertRuleFromCorrection({
          pattern: 'RIVERSIDE GYM', matchType: 'contains', ruleKind: 'recurring',
          categoryId: null, createdBy: userId, actorRole: 'admin',
        });
        if (!rule.ok) throw new Error('unexpected refusal');
        return { ruleId: rule.ruleId, txnId, merchant: 'RIVERSIDE GYM DOWNTOWN' };
      },
      reapply: {
        attributes: false,
        why:
          'A recurring mark changes nothing on a transaction -- it decides which Insights list a ' +
          'merchant appears on, read fresh on every render -- so "Apply now" has nothing to apply. ' +
          'eligibleForRuleReapply returns [] for this kind before attribution is reached.',
      },
      clear: {
        attributes: false,
        why:
          'Nothing on a row carries a mark, so there is nothing to take back off it: ruleClearIds ' +
          'returns [] and clearRuleFromTransactions writes nothing. Deleting the rule is the whole ' +
          'undo, and the attribution surfaces above still have to be right.',
      },
      // Never read: the clear-path check skips a scenario whose clear is exempt.
      residue: () => 0,
    },
  ],
  [
    'not_recurring',
    {
      build: () => {
        const { userId, add } = fixture();
        const txnId = add('HARBOUR INSURANCE CO');
        const rule = upsertRuleFromCorrection({
          pattern: 'HARBOUR', matchType: 'contains', ruleKind: 'not_recurring',
          categoryId: null, createdBy: userId, actorRole: 'admin',
        });
        if (!rule.ok) throw new Error('unexpected refusal');
        return { ruleId: rule.ruleId, txnId, merchant: 'HARBOUR INSURANCE CO' };
      },
      reapply: {
        attributes: false,
        why:
          'A not-recurring mark changes nothing on a transaction either -- it keeps a merchant off ' +
          'both Insights lists, read fresh on every render -- so "Apply now" has nothing to apply. ' +
          'eligibleForRuleReapply returns [] for this kind before attribution is reached.',
      },
      clear: {
        attributes: false,
        why:
          'Nothing on a row carries a mark, so there is nothing to take back off it: ruleClearIds ' +
          'returns [] and clearRuleFromTransactions writes nothing. Deleting the rule is the whole ' +
          'undo, and the attribution surfaces above still have to be right.',
      },
      residue: () => 0,
    },
  ],
```

Fails before / passes after: with no mark branch, `ruleImpactCounts` reports `affects: 0` and `previewRuleReapply` reports `eligible: 1` (the default candidate set plus `matchRule` attribute the uncategorized row); Step 7 adds the branch and makes reapply inert.

In `tests/ops/rule-authoring-intent.test.ts`, add `'setRecurringMarks'` to `RULE_AUTHORING_HELPERS` (`:103`) with a one-line comment: `// Spec 2026-10-05 §2.2: writes and deletes the two mark kinds for a list of merchants.` This passes in Task 1 (only `rules.ts`, allow-listed, mentions it); Task 3 is where it goes red.

- [ ] **Step 3: Write the failing rules-manager tests**

In `tests/app/merchant-rules-client.test.tsx`, add `recurring: 0, not_recurring: 0` to **every** `kindCounts` object literal (16 of them, `grep -n "kindCounts:" tests/app/merchant-rules-client.test.tsx`) so the file type-checks. Then append:

```ts
/** Spec 2026-10-05 §2.2. Marks are listed with the other rules, by kind, and can be deleted. */
describe('MerchantRulesClient — recurring marks', () => {
  it('gives each mark kind its own chip with a count', () => {
    render(
      <MerchantRulesClient
        {...baseProps({ kindCounts: { category: 1, transfer: 0, rename: 0, not_transfer: 0, attribution: 0, recurring: 2, not_recurring: 1 } })}
      />,
    );
    expect(screen.getByText('Recurring (2)').closest('a')!.getAttribute('href')).toContain('kind=recurring');
    expect(screen.getByText('Not recurring (1)').closest('a')!.getAttribute('href')).toContain('kind=not_recurring');
  });

  it('labels a mark row and offers neither Apply now nor Edit -- a mark changes no transaction', () => {
    render(<MerchantRulesClient {...baseProps({ rows: [rule({ pattern: 'RIVERSIDE GYM', ruleKind: 'recurring', categoryId: null })], impactCounts: { 1: 4 } })} />);
    expect(screen.getByText('Recurring')).toBeTruthy();
    openRowMenu('Actions for RIVERSIDE GYM');
    expect(screen.queryByRole('menuitem', { name: /apply now/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Delete rule' })).toBeTruthy();
  });

  it('says what deleting a mark does', () => {
    render(<MerchantRulesClient {...baseProps({ rows: [rule({ pattern: 'RIVERSIDE GYM', ruleKind: 'not_recurring', categoryId: null })] })} />);
    openRowMenu('Actions for RIVERSIDE GYM');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete rule' }));
    expect(screen.getByRole('dialog').textContent).toContain('A recurring mark changes no transaction.');
  });
});
```

Fails before / passes after: no chips, no `KIND_LABEL` entry, and Apply now / Edit render for every non-rename kind until Step 8.

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run tests/lib/categorize/rules.test.ts tests/lib/packs.test.ts tests/db/schema.test.ts tests/ops/rule-attribution-honesty.test.ts tests/app/merchant-rules-client.test.tsx`
Expected: rules — `setRecurringMarks is not a function` (TypeError) on every new case; packs — `expected true to be false` on the export case; schema — both pins PASS; honesty — `a contains recurring rule is attributed …` fails with `{ kind: 'recurring', affects: 0 }` vs `affects: 1`; rules client — `Unable to find an element with the text: Recurring (2)` and an Apply now menuitem found.

- [ ] **Step 5: The kinds and the helpers**

Create `src/lib/categorize/mark-kinds.ts`:

```ts
/**
 * Spec 2026-10-05 §2.2. The two recurring-mark rule kinds, in a module with no imports so a client
 * component can ask "is this a mark" without pulling @/db into its bundle. rules.ts re-exports all
 * three, and server code imports them from there.
 */
export type RecurringMark = 'recurring' | 'not_recurring';

export const RECURRING_MARK_KINDS: readonly RecurringMark[] = ['recurring', 'not_recurring'];

export function isRecurringMarkKind(kind: string): kind is RecurringMark {
  return (RECURRING_MARK_KINDS as readonly string[]).includes(kind);
}
```

In `src/db/schema.ts`, widen the enum and extend the docblock above it with one paragraph:

```ts
    /*
     * … (existing text) …
     * 'recurring' and 'not_recurring' are spec 2026-10-05 §2.2, widened the same way and for the
     * same reason: no CHECK, so no migration.
     */
    ruleKind: text('rule_kind', { enum: ['category', 'transfer', 'rename', 'not_transfer', 'attribution', 'recurring', 'not_recurring'] })
```

Leave `droppedRuleKind` (`:504`) exactly as it is.

In `src/lib/categorize/rules.ts`:
1. Widen `export type RuleKind = 'category' | 'transfer' | 'rename' | 'not_transfer' | 'attribution' | 'recurring' | 'not_recurring';` and add to its docblock: `'recurring' / 'not_recurring' (spec 2026-10-05 §2.2) are the household's word about a merchant on Insights. Neither has an outcome (ruleOutcomeMissing stays false), neither changes a transaction, and setRecurringMarks only writes exact ones -- exact by default, not exact-only, like not_transfer.`
2. Below the import block, add:

```ts
import { isRecurringMarkKind, RECURRING_MARK_KINDS, type RecurringMark } from './mark-kinds';

export { isRecurringMarkKind, RECURRING_MARK_KINDS, type RecurringMark };
```

3. Append at the end of the file:

```ts
/** Spec 2026-10-05 §2.2. Every rule of either mark kind, disabled ones included -- matchRule skips those. */
export function listRecurringMarkRules(): MerchantRuleRecord[] {
  return [...listRules('recurring'), ...listRules('not_recurring')];
}

/**
 * The mark a merchant carries, resolved through matchRule like every other kind. setRecurringMarks
 * keeps the two exclusive; if a hand-written rule makes both match, matchRule's own ranking decides.
 */
export function recurringMarkFor(normalizedMerchant: string, rules: MerchantRuleRecord[]): RecurringMark | null {
  const yes = matchRule(normalizedMerchant, 'recurring', rules);
  const no = matchRule(normalizedMerchant, 'not_recurring', rules);
  if (yes === null) return no === null ? null : 'not_recurring';
  if (no === null) return 'recurring';
  return outranks(yes, no) ? 'recurring' : 'not_recurring';
}

export type RecurringMarkResult =
  | { ok: true; merchants: number }
  | { ok: false; reason: 'owned_by_another'; ownerName: string };

/** Thrown only inside setRecurringMarks' transaction, to unwind it; never escapes this file. */
class MarkRefusal extends Error {
  constructor(readonly ownerName: string) {
    super('owned_by_another');
  }
}

function oppositeMark(mark: RecurringMark): RecurringMark {
  return mark === 'recurring' ? 'not_recurring' : 'recurring';
}

/**
 * Spec 2026-10-05 §2.2. Marks each merchant (exact rules only), or with `mark: null` takes either
 * mark off. Setting one kind deletes the other for that merchant. Ownership of every rule this
 * would delete is settled before anything is written (the setTransferFlag order, item BJ), and the
 * writes share one transaction, so a refusal over one merchant leaves every merchant as it was.
 */
export function setRecurringMarks(input: {
  merchants: readonly string[];
  mark: RecurringMark | null;
  userId: number;
  actorRole: 'admin' | 'member';
  at?: Date;
}): RecurringMarkResult {
  const merchants = [...new Set(input.merchants.map((merchant) => merchant.trim().toUpperCase()).filter((merchant) => merchant.length > 0))];
  const removed: readonly RecurringMark[] = input.mark === null ? RECURRING_MARK_KINDS : [oppositeMark(input.mark)];
  if (input.actorRole !== 'admin') {
    for (const merchant of merchants) {
      for (const kind of removed) {
        const owner = exactRuleOwner(merchant, kind);
        if (owner !== null && owner.createdBy !== null && owner.createdBy !== input.userId) {
          return { ok: false, reason: 'owned_by_another', ownerName: owner.ownerName };
        }
      }
    }
  }
  try {
    getDb().transaction(() => {
      for (const merchant of merchants) {
        if (input.mark !== null) {
          const written = upsertRuleFromCorrection({
            pattern: merchant,
            matchType: 'exact',
            ruleKind: input.mark,
            categoryId: null,
            createdBy: input.userId,
            actorRole: input.actorRole,
            at: input.at,
          });
          if (!written.ok) throw new MarkRefusal(written.ownerName);
        }
        for (const kind of removed) deleteExactRule(merchant, kind);
      }
    });
  } catch (error) {
    if (error instanceof MarkRefusal) return { ok: false, reason: 'owned_by_another', ownerName: error.ownerName };
    throw error;
  }
  return { ok: true, merchants: merchants.length };
}
```

`outranks`, `exactRuleOwner`, `upsertRuleFromCorrection`, `deleteExactRule` are all already in this file.

- [ ] **Step 6: Packs never export a mark**

In `src/lib/packs.ts` `exportableRules`, after the `attribution` line add:

```ts
    // Spec 2026-10-05 §2.2. A mark is this household's word about its own merchants -- the
    // not_transfer argument again. Import already skips it (IMPORTABLE_RULE_KINDS omits it).
    if (isRecurringMarkKind(rule.ruleKind)) return false;
```

and import `isRecurringMarkKind` from `@/lib/categorize/rules`.

- [ ] **Step 7: The engine treats a mark as inert, and counts what it speaks about**

In `src/lib/categorize/engine.ts`, add `isRecurringMarkKind` and `RECURRING_MARK_KINDS` to the `./rules` import, then:

1. `candidateRowsFor` — first line of the body:
```ts
  // Spec 2026-10-05 §2.2: a mark speaks about a merchant's charges, and a transfer is never one.
  if (isRecurringMarkKind(kind)) return eq(transactions.isTransfer, false);
```
2. `eligibleForRuleReapply` — change the first line to:
```ts
  // A mark changes nothing on a row (spec 2026-10-05 §2.2), so like a rename there is nothing to apply.
  if (rule.ruleKind === 'rename' || isRecurringMarkKind(rule.ruleKind)) return [];
```
3. `ruleImpactCounts` — before the `// rename:` block:
```ts
  // Spec 2026-10-05 §2.2: a mark's "Affects" is the charges it speaks about -- the candidate rows
  // of every merchant it resolves. Skipped when the household has no mark, like attribution above.
  if (ctx.rules.some((rule) => isRecurringMarkKind(rule.ruleKind))) {
    const marked = db
      .select({ normalizedMerchant: transactions.normalizedMerchant, c: sql<number>`count(*)` })
      .from(transactions)
      .where(candidateRowsFor('recurring'))
      .groupBy(transactions.normalizedMerchant)
      .all();
    for (const kind of RECURRING_MARK_KINDS) {
      const attributed = ruleAttributor(kind, ctx);
      for (const row of marked) bump(attributed(row.normalizedMerchant, null), row.c);
    }
  }
```
4. `ruleClearIds` — after the `attribution` line: `if (isRecurringMarkKind(rule.ruleKind)) return [];` with the comment `// Spec 2026-10-05 §2.2: nothing on a row carries a mark. Delete-only.`
5. `clearRuleFromTransactions` — after the `attribution` guard: `if (isRecurringMarkKind(rule.ruleKind)) return { rowsCleared: 0 };` with the same comment.

Do not touch `attributedRuleId`: for these kinds it already falls through to `matchRule`, which is right.

- [ ] **Step 8: The rules manager lists marks sensibly**

In `src/app/(app)/settings/merchant-rules/page.tsx`: `KINDS` gains `'recurring', 'not_recurring'`; the `kindCounts` initialiser gains `recurring: 0, not_recurring: 0`.

In `merchant-rules-client.tsx` (a `'use client'` file — import `isRecurringMarkKind` from `@/lib/categorize/mark-kinds`, never from `rules.ts`):
1. `KIND_LABEL` gains `recurring: 'Recurring', not_recurring: 'Not recurring',` with the comment `// Spec 2026-10-05 §2.2: set from Transactions and Insights, not from the form below.`
2. After the `not_transfer` chip: `{kindChip(KIND_LABEL.recurring, 'recurring', kindCounts.recurring)}` and `{kindChip(KIND_LABEL.not_recurring, 'not_recurring', kindCounts.not_recurring)}`.
3. Row menu: wrap the `Edit` `RowMenuButton` in `{isRecurringMarkKind(rule.ruleKind) ? null : (…)}` (the form offers no option for these kinds and would save the row as another kind), and change the Apply now condition to `rule.ruleKind !== 'rename' && !isRecurringMarkKind(rule.ruleKind) && !disabled`.
4. `deleteRuleDialog`: beside `isOverride`, add `const isMark = isRecurringMarkKind(deletingRule.ruleKind);` and render, after the override paragraph:
```tsx
        {isMark ? (
          <p className="text-sm text-ink">
            A recurring mark changes no transaction. Deleting it only changes which list on Insights the merchant appears on.
          </p>
        ) : null}
```
5. `PageGuide`, end of the first paragraph: `A <strong className="font-semibold text-ink">recurring</strong> or <strong className="font-semibold text-ink">not recurring</strong> rule is a mark set from Transactions or Insights; it changes no transaction.`

- [ ] **Step 9: Run the tests and the type check**

Run: `npx vitest run tests/lib/categorize/rules.test.ts tests/lib/packs.test.ts tests/db/schema.test.ts tests/ops/rule-attribution-honesty.test.ts tests/ops/rule-authoring-intent.test.ts tests/app/merchant-rules-client.test.tsx tests/lib/categorize/engine.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: no errors (every `Record<RuleKind, …>` now has both keys).

- [ ] **Step 10: Commit**

```bash
git add src/lib/categorize/mark-kinds.ts src/db/schema.ts src/lib/categorize/rules.ts src/lib/categorize/engine.ts src/lib/packs.ts "src/app/(app)/settings/merchant-rules/page.tsx" "src/app/(app)/settings/merchant-rules/merchant-rules-client.tsx" tests/lib/categorize/rules.test.ts tests/lib/packs.test.ts tests/db/schema.test.ts tests/ops/rule-attribution-honesty.test.ts tests/ops/rule-authoring-intent.test.ts tests/app/merchant-rules-client.test.tsx
git commit -m "feat(rules): recurring marks are merchant rules

- recurring / not_recurring kinds; no migration (rule_kind has no CHECK)
- setRecurringMarks writes exact rules; one kind clears the other
- Affects counts a mark's charges; Apply now and clear stay inert
- never exported in a pack; chips and labels on Merchant rules"
```

**Review focus:**
- `setRecurringMarks` settles ownership of every rule it would delete before the transaction opens, and a same-kind refusal inside the loop rolls back the merchants before it.
- No client file value-imports `@/lib/categorize/rules`; the rules manager uses `mark-kinds.ts`.
- The honesty guard's two `why` strings are true of the code (reapply and clear both return empty for the kinds).
- `merchant_rule_merges` is untouched, and the schema pins say why.

---

### Task 2: The read model: two tiers, accounts, forming rhythms, and the filter (spec §2.3, §2.4)

**Files:**
- Modify: `src/lib/predict/anomalies.ts` (`recurringVerdict` :184; new `chargesAsOf`, `formingRhythm`)
- Modify: `src/lib/recurring.ts` (header docblock :12-40, row types :45-69, `readCharges` :103, `recurringCharges` :224)
- Move: `git mv src/components/warranty/RecurringChargesCard.tsx src/components/insights/RecurringChargesCard.tsx`, keeping only `recordedBillingSentence`
- Modify: `src/app/(app)/warranties/page.tsx` (drop the `recurringCharges` call), `src/app/(app)/warranties/warranties-client.tsx` (drop the card, add the moved line)
- Test: `tests/lib/predict/anomalies.test.ts`, `tests/lib/recurring.test.ts`, `tests/app/warranties-client.test.tsx`

**Interfaces:**
- Consumes: `setRecurringMarks`, `listRecurringMarkRules`, `recurringMarkFor` (Task 1).
- Produces (`anomalies.ts`, pure): `chargesAsOf<T extends SpendRow>(charges: readonly T[], today: string): T[]`; `formingRhythm(input: { charges: SpendRow[]; today: string }): RecurringCadence | null`.
- Produces (`recurring.ts`):
  - `interface RecurringAccount { id: number; name: string }`
  - `type RecurringTier = 'known' | 'looks'`; `type RecurringKnownBy = 'mark' | 'tracked'`
  - `RecurringChargeRow` = `{ merchant; tier: RecurringTier; knownBy: RecurringKnownBy | null; cadence: RecurringCadence | null; chargeCount; typicalCents: number | null; lastAmountCents; lastDate; transactionId; tracked: RecurringCover | null; accounts: RecurringAccount[] }`
  - `interface RecurringCharges { known: RecurringChargeRow[]; looks: RecurringChargeRow[]; forming: Record<RecurringCadence, number> }`
  - `recurringCharges(input: { today: string; ownerUserId: number | null; viewer: Viewer; accountId: number | null }): RecurringCharges` — Known sorted by merchant, uncapped; Looks by typical amount descending then merchant, capped at `RECURRING_MAX_ROWS` after the filter.
- Produces: `recordedBillingSentence` now exported from `@/components/insights/RecurringChargesCard`.

- [ ] **Step 1: Write the failing pure tests**

In `tests/lib/predict/anomalies.test.ts`, add `formingRhythm` to the `@/lib/predict/anomalies` import and append:

```ts
/** Spec 2026-10-05 §2.3: a rhythm one charge short, counted so a new ledger's card is not blank. */
describe('formingRhythm: one charge short of a rhythm', () => {
  const two = (gap: number, endsDaysAgo = 3): SpendRow[] => [
    row({ id: 1, date: addDaysIso(TODAY, -endsDaysAgo - gap), amountCents: -1649 }),
    row({ id: 2, date: addDaysIso(TODAY, -endsDaysAgo), amountCents: -1649 }),
  ];

  it('names the band for two charges a band apart, the newest recent', () => {
    expect(formingRhythm({ charges: two(30), today: TODAY })).toBe('monthly');
    expect(formingRhythm({ charges: two(365, 6), today: TODAY })).toBe('yearly');
  });

  it('is null for one charge, and for three -- three is a verdict, not a forming rhythm', () => {
    expect(formingRhythm({ charges: two(30).slice(1), today: TODAY })).toBeNull();
    const three = [...two(30), row({ id: 3, date: addDaysIso(TODAY, -63), amountCents: -1649 })];
    expect(formingRhythm({ charges: three, today: TODAY })).toBeNull();
  });

  it('is null when the gap sits in no band', () => {
    expect(formingRhythm({ charges: two(60), today: TODAY })).toBeNull();
  });

  it('is null once the newest charge is past the band allowance', () => {
    const grace = CREEP_MONTHLY_GAP_MAX_DAYS + RECURRING_STALE_GRACE_DAYS;
    expect(formingRhythm({ charges: two(30, grace), today: TODAY })).toBe('monthly');
    expect(formingRhythm({ charges: two(30, grace + 1), today: TODAY })).toBeNull();
  });

  it('counts charges only: a refund and a future-dated row are neither', () => {
    expect(formingRhythm({ charges: [...two(30), row({ id: 9, date: addDaysIso(TODAY, -1), amountCents: 1649 })], today: TODAY })).toBe('monthly');
    expect(formingRhythm({ charges: [...two(30), row({ id: 8, date: addDaysIso(TODAY, 20), amountCents: -1649 })], today: TODAY })).toBe('monthly');
  });
});
```

Fails before / passes after: `formingRhythm` does not exist until Step 4.

- [ ] **Step 2: Rewrite and extend the read-model tests**

In `tests/lib/recurring.test.ts`:

1. Imports: add `listRules, setRecurringMarks, setRuleDisabledFlag` from `@/lib/categorize/rules`; change the recurring import to `import { RECURRING_MAX_ROWS, recurringCharges, recurringLoad, type RecurringCharges } from '@/lib/recurring';`.
2. `Ctx` gains `visaId: number;`, an optional `accountId?: number` on both `cadence` and `spend` inputs, and `mark(merchant: string, mark: 'recurring' | 'not_recurring' | null): void;`. In `setup()`: `const visaId = createAccount({ name: 'Travel Visa', type: 'credit', ownerUserId: adultId });`; the inner `spend` uses `accountId: input.accountId ?? accountId`; `cadence` passes `accountId: input.accountId` through; return `visaId` and
```ts
    mark: (merchant, mark) => {
      const result = setRecurringMarks({ merchants: [merchant], mark, userId: adultId, actorRole: 'admin' });
      if (!result.ok) throw new Error('unexpected refusal');
    },
```
3. Below `selfOnly`, add:
```ts
const rowsOf = (result: RecurringCharges) => [...result.known, ...result.looks];
const read = (ctx: Ctx, over: Partial<Parameters<typeof recurringCharges>[0]> = {}) =>
  recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null, ...over });
```
4. **Every existing call** `recurringCharges({ … })` gains `accountId: null`, and every assertion that treated the result as an array wraps it in `rowsOf(…)` (`rowsOf(…)[0].tracked`, `rowsOf(…).map(…)`, `expect(rowsOf(…)).toEqual([])`).
5. Replace the expectation in `'names the merchant, the cadence, the last charge and how many charges it read'` with:
```ts
    const result = recurringCharges({ today: TODAY, ownerUserId: null, viewer: household(ctx.adultId), accountId: null });
    expect(result.known).toEqual([]);
    expect(result.looks).toEqual([
      {
        merchant: 'NETFLIX',
        tier: 'looks',
        knownBy: null,
        cadence: 'monthly',
        chargeCount: 13,
        typicalCents: 1649,
        lastAmountCents: 1649,
        lastDate: addDaysIso(TODAY, -3),
        // What Track prefills from: the NEWEST charge, not the first one found.
        transactionId: ids[ids.length - 1],
        tracked: null,
        accounts: [{ id: ctx.accountId, name: 'Chequing' }],
      },
    ]);
```
6. Replace `'puts what nobody has recorded first, then the biggest charge'` with:
```ts
  it('puts a recorded rhythm under Known, and the rest under Looks by the biggest charge', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'SMALL THING', cents: 500 });
    ctx.cadence({ merchant: 'BIG THING', cents: 9900 });
    ctx.cadence({ merchant: 'RECORDED THING', cents: 20000 });
    ctx.item({ name: 'Recorded Thing', typeId: ctx.itemType('Subscription', 'subscription') });
    const result = read(ctx);
    expect(result.known.map((row) => [row.merchant, row.knownBy])).toEqual([['RECORDED THING', 'tracked']]);
    expect(result.looks.map((row) => row.merchant)).toEqual(['BIG THING', 'SMALL THING']);
  });
```
7. In `'caps the list, …'`, assert `read(ctx).looks` has length `RECURRING_MAX_ROWS` and `read(ctx).known` is `[]`.
8. Append three describe blocks:

```ts
/** Spec 2026-10-05 §2.3. Known is what the household said; Looks is what the dates show. */
describe('recurringCharges: two tiers', () => {
  /** Review Focus 5. */
  it('lists a merchant the household marked under Known, after a single charge', async () => {
    const ctx = await setup();
    const id = ctx.spend({ merchant: 'RIVERSIDE GYM', date: addDaysIso(TODAY, -4), cents: -4500 });
    ctx.mark('RIVERSIDE GYM', 'recurring');
    expect(read(ctx).known).toEqual([
      {
        merchant: 'RIVERSIDE GYM',
        tier: 'known',
        knownBy: 'mark',
        cadence: null,
        chargeCount: 1,
        // One charge has no "usually"; the card prints an em dash.
        typicalCents: null,
        lastAmountCents: 4500,
        lastDate: addDaysIso(TODAY, -4),
        transactionId: id,
        tracked: null,
        accounts: [{ id: ctx.accountId, name: 'Chequing' }],
      },
    ]);
  });

  it('gives a marked merchant with two charges the median of both', async () => {
    const ctx = await setup();
    ctx.spend({ merchant: 'RIVERSIDE GYM', date: addDaysIso(TODAY, -34), cents: -4000 });
    ctx.spend({ merchant: 'RIVERSIDE GYM', date: addDaysIso(TODAY, -4), cents: -5000 });
    ctx.mark('RIVERSIDE GYM', 'recurring');
    expect(read(ctx).known[0]).toMatchObject({ chargeCount: 2, typicalCents: 4500, cadence: null });
  });

  it('keeps the detected cadence on a marked merchant that also has a rhythm', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'MAPLE STREAMING', cents: 1349 });
    ctx.mark('MAPLE STREAMING', 'recurring');
    const result = read(ctx);
    expect(result.known.map((row) => [row.merchant, row.knownBy, row.cadence])).toEqual([['MAPLE STREAMING', 'mark', 'monthly']]);
    expect(result.looks).toEqual([]);
  });

  /** Review Focus 4. */
  it('drops a not_recurring merchant from both tiers and from the forming count', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'CEDAR PHONE CO', cents: 6200 });
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 2, cents: 13400 });
    ctx.mark('CEDAR PHONE CO', 'not_recurring');
    ctx.mark('HARBOUR INSURANCE', 'not_recurring');
    expect(read(ctx)).toEqual({ known: [], looks: [], forming: { monthly: 0, yearly: 0 } });
    ctx.mark('CEDAR PHONE CO', null);
    expect(read(ctx).looks.map((row) => row.merchant)).toEqual(['CEDAR PHONE CO']);
  });

  it('ignores a disabled mark', async () => {
    const ctx = await setup();
    ctx.spend({ merchant: 'RIVERSIDE GYM', date: addDaysIso(TODAY, -4), cents: -4500 });
    ctx.mark('RIVERSIDE GYM', 'recurring');
    setRuleDisabledFlag(listRules('recurring')[0]!.id, true);
    expect(read(ctx).known).toEqual([]);
  });

  it('a mark is household-wide, but a self viewer sees Known rows only for their own charges', async () => {
    const ctx = await setup();
    ctx.spend({ merchant: 'RIVERSIDE GYM', date: addDaysIso(TODAY, -4), cents: -4500, person: ctx.adultId });
    ctx.mark('RIVERSIDE GYM', 'recurring');
    expect(read(ctx, { viewer: selfOnly(ctx.childId) }).known).toEqual([]);
  });

  it('lists Known by merchant name, so a long list reads like a checklist', async () => {
    const ctx = await setup();
    ctx.spend({ merchant: 'ZED CO', date: addDaysIso(TODAY, -4), cents: -9900 });
    ctx.spend({ merchant: 'ALPHA CO', date: addDaysIso(TODAY, -5), cents: -100 });
    ctx.mark('ZED CO', 'recurring');
    ctx.mark('ALPHA CO', 'recurring');
    expect(read(ctx).known.map((row) => row.merchant)).toEqual(['ALPHA CO', 'ZED CO']);
  });
});

/** Spec 2026-10-05 §2.4. The accounts a merchant charged, and the filter that makes the card-replacement list. */
describe('recurringCharges: accounts and the account filter', () => {
  const movedCard = (ctx: Ctx) => {
    // Three charges on Chequing, then the newest on Travel Visa -- still 30 days apart.
    ctx.cadence({ merchant: 'MAPLE STREAMING', count: 3, endsDaysAgo: 33, cents: 1349 });
    ctx.spend({ merchant: 'MAPLE STREAMING', date: addDaysIso(TODAY, -3), cents: -1349, accountId: ctx.visaId });
  };

  it('names every account the merchant charged, newest charge first', async () => {
    const ctx = await setup();
    movedCard(ctx);
    expect(read(ctx).looks[0]!.accounts).toEqual([
      { id: ctx.visaId, name: 'Travel Visa' },
      { id: ctx.accountId, name: 'Chequing' },
    ]);
  });

  /** Review Focus 1. */
  it('keeps a row whose older charges were on the chosen account', async () => {
    const ctx = await setup();
    movedCard(ctx);
    expect(read(ctx, { accountId: ctx.accountId }).looks.map((row) => row.merchant)).toEqual(['MAPLE STREAMING']);
  });

  it('keeps only rows that charged the chosen account, in both tiers', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'CEDAR PHONE CO', cents: 6200 });
    ctx.spend({ merchant: 'RIVERSIDE GYM', date: addDaysIso(TODAY, -4), cents: -4500, accountId: ctx.visaId });
    ctx.mark('RIVERSIDE GYM', 'recurring');
    const visa = read(ctx, { accountId: ctx.visaId });
    expect(visa.known.map((row) => row.merchant)).toEqual(['RIVERSIDE GYM']);
    expect(visa.looks).toEqual([]);
  });

  it('applies the Looks cap after the filter, so other accounts never crowd a filtered list out', async () => {
    const ctx = await setup();
    for (let n = 0; n < RECURRING_MAX_ROWS + 2; n += 1) {
      ctx.cadence({ merchant: `BIG SHOP ${String(n).padStart(2, '0')}`, count: 4, cents: 50000 + n });
    }
    // The smallest charges, so a cap taken BEFORE the filter would cut both.
    ctx.cadence({ merchant: 'TINY ONE', count: 4, cents: 100, accountId: ctx.visaId });
    ctx.cadence({ merchant: 'TINY TWO', count: 4, cents: 101, accountId: ctx.visaId });
    expect(read(ctx, { accountId: ctx.visaId }).looks.map((row) => row.merchant)).toEqual(['TINY TWO', 'TINY ONE']);
  });
});

/** Spec 2026-10-05 §2.3, forming rhythms: what tells a new household the card is alive. */
describe('recurringCharges: rhythms one charge short', () => {
  it('counts merchants with two charges a band apart, the newest recent, per band, and lists none of them', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 2, cents: 13400 });
    ctx.cadence({ merchant: 'CEDAR PHONE CO', count: 2, cents: 6200 });
    ctx.cadence({ merchant: 'LAKESIDE DOMAIN', count: 2, gapDays: 365, endsDaysAgo: 6, cents: 2400 });
    expect(read(ctx)).toEqual({ known: [], looks: [], forming: { monthly: 2, yearly: 1 } });
  });

  it('does not count a merchant whose second charge is stale or off-band', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 2, endsDaysAgo: 200, cents: 13400 });
    ctx.cadence({ merchant: 'CEDAR PHONE CO', count: 2, gapDays: 60, cents: 6200 });
    expect(read(ctx).forming).toEqual({ monthly: 0, yearly: 0 });
  });

  it('does not count a merchant marked recurring: it is already Known', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 2, cents: 13400 });
    ctx.mark('HARBOUR INSURANCE', 'recurring');
    const result = read(ctx);
    expect(result.forming).toEqual({ monthly: 0, yearly: 0 });
    expect(result.known.map((row) => row.merchant)).toEqual(['HARBOUR INSURANCE']);
  });

  it('counts only merchants that charged the chosen account', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 2, cents: 13400 });
    ctx.cadence({ merchant: 'CEDAR PHONE CO', count: 2, cents: 6200, accountId: ctx.visaId });
    expect(read(ctx, { accountId: ctx.visaId }).forming).toEqual({ monthly: 1, yearly: 0 });
  });
});
```

Fails before / passes after: `recurringCharges` returns an array, ignores marks and accounts, and has no `forming`; Step 5 returns the new shape.

- [ ] **Step 3: Rewrite the Loans & Coverage test for the card's departure**

In `tests/app/warranties-client.test.tsx`: delete the `import type { RecurringChargeRow }` line, the `charge()` helper and the whole `describe('Recurring charges card (F-05)', …)` block (its intent moves to Task 5's card test). In `renderList`, delete the `recurring={[]}` and `recurringPerson={null}` props. Keep `describe('the recorded-billing header line (F-05)', …)` unchanged. Append:

```ts
/** Spec 2026-10-05 §2.1. The rhythm list moved to Insights; one line says where. */
describe('Recurring charges moved to Insights', () => {
  it('says where the card went, with a link, and renders no rhythm list', () => {
    const { container } = renderList(result([]));
    expect(container.textContent).toContain('Recurring charges moved to Insights');
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Insights');
    expect(link?.getAttribute('href')).toBe('/insights');
    expect(container.textContent).not.toContain('No merchant is charging on a regular rhythm yet');
  });
});
```

Fails before / passes after: the page still renders the card and no such line until Step 6.

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run tests/lib/predict/anomalies.test.ts tests/lib/recurring.test.ts tests/app/warranties-client.test.tsx`
Expected: anomalies — `formingRhythm is not a function`; recurring — every rewritten test fails (`Cannot read properties of undefined (reading 'map')` on `.known`/`.looks`, or the row lacking `tier`/`accounts`); warranties — `expected … to contain 'Recurring charges moved to Insights'`.

- [ ] **Step 5: Implement the read model**

In `src/lib/predict/anomalies.ts`:
1. Above `recurringVerdict`, add:
```ts
/**
 * The charges a verdict reads: money out, dated today or earlier, oldest first. One definition for
 * recurringVerdict, formingRhythm and the Insights read model's marked rows (src/lib/recurring.ts),
 * so a row and a verdict never count different charges.
 */
export function chargesAsOf<T extends SpendRow>(charges: readonly T[], today: string): T[] {
  return charges
    .filter((charge) => charge.amountCents < 0 && charge.date <= today)
    .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
}
```
2. In `recurringVerdict`, replace the `const charges = [...input.charges].filter(…).sort(…)` statement with `const charges = chargesAsOf(input.charges, input.today);`, keeping its comment above it.
3. Below `recurringVerdict`, add:
```ts
/**
 * Spec 2026-10-05 §2.3, forming rhythms. One charge short of what recurringVerdict needs: exactly
 * RECURRING_MIN_CHARGES - 1 charges, every gap in one band, the newest inside that band's
 * allowance. Returns the band. A count's input only; nothing lists these merchants by name.
 */
export function formingRhythm(input: { charges: SpendRow[]; today: string }): RecurringCadence | null {
  const charges = chargesAsOf(input.charges, input.today);
  if (charges.length !== RECURRING_MIN_CHARGES - 1) return null;
  const gaps: number[] = [];
  for (let index = 1; index < charges.length; index += 1) {
    gaps.push(daysBetweenIso(charges[index - 1].date, charges[index].date));
  }
  const cadence = gaps.length === 0 ? null : recurringBand(gaps[0]);
  if (cadence === null || !gaps.every((gap) => recurringBand(gap) === cadence)) return null;
  const latest = charges[charges.length - 1];
  if (daysBetweenIso(latest.date, input.today) > bandMaxDays(cadence) + RECURRING_STALE_GRACE_DAYS) return null;
  return cadence;
}
```
`recurringBand` and `bandMaxDays` stay module-private; nothing outside this file needs them.

In `src/lib/recurring.ts`:
1. Imports: add `accounts` to the `@/db/schema` import; add `import { listRecurringMarkRules, recurringMarkFor } from '@/lib/categorize/rules';`; change the anomalies import to `import { chargesAsOf, formingRhythm, recurringVerdict, type RecurringCadence, type SpendRow } from '@/lib/predict/anomalies';`; add `import { medianCents } from '@/lib/predict/stats';`.
2. Header docblock: replace the `NOTHING IS STORED` paragraph's first sentence with `THE DETECTOR'S VERDICT IS STORED NOWHERE.` and add one paragraph: `Spec 2026-10-05 §2.2: what IS stored is the household's word about a merchant -- a 'recurring' or 'not_recurring' merchant rule -- and this module only reads it. Known recurring is that word, or a recorded item that covers a detected rhythm; Looks recurring is a detected rhythm and nothing more.` In `RECURRING_MAX_ROWS`' comment add: `Applies to Looks recurring only, after the account filter; Known recurring is the card-replacement list and is never cut short.`
3. Replace the `RecurringChargeRow` interface with:
```ts
/** Spec 2026-10-05 §2.4. An account a merchant charged, by the name the household gave it. */
export interface RecurringAccount {
  id: number;
  name: string;
}

/** Spec §2.3. 'known': the household marked it, or a record covers it. 'looks': a rhythm only. */
export type RecurringTier = 'known' | 'looks';
export type RecurringKnownBy = 'mark' | 'tracked';

export interface RecurringChargeRow {
  /** `transactions.normalized_merchant`, i.e. uppercase, exactly as the ledger groups it. */
  merchant: string;
  tier: RecurringTier;
  /** Why a Known row is known; null on a Looks row. A mark wins over a cover: only a mark can be undone from the card. */
  knownBy: RecurringKnownBy | null;
  /** The detected rhythm, or null for a marked merchant whose charges have none. */
  cadence: RecurringCadence | null;
  chargeCount: number;
  /** Median charge magnitude; null with a single charge, where there is no "usually" to state. */
  typicalCents: number | null;
  lastAmountCents: number;
  lastDate: string;
  /** The newest charge. The Track link prefills from it, and the mark buttons post it. */
  transactionId: number;
  tracked: RecurringCover | null;
  /** Spec §2.4. Every account the merchant charged inside the window, newest charge first. */
  accounts: RecurringAccount[];
}

export interface RecurringCharges {
  /** Sorted by merchant, never capped: this is the card-replacement list. */
  known: RecurringChargeRow[];
  /** Biggest typical charge first, capped at RECURRING_MAX_ROWS after the account filter. */
  looks: RecurringChargeRow[];
  /** Spec §2.3, forming rhythms: merchants one charge short of a rhythm, per band. Counted, never listed. */
  forming: Record<RecurringCadence, number>;
}
```
4. `readCharges`: introduce `interface ChargeRow extends SpendRow { accountId: number }`, return `ChargeRow[]`, and select `accountId: transactions.accountId` with the comment `// Spec 2026-10-05 §2.4: which account each charge landed on, read in the same scan.`
5. Below `readCharges`, add:
```ts
/** Account names in one read of a table that holds a handful of rows. Only ever printed beside a charge the viewer can already see. */
function accountNames(): Map<number, string> {
  return new Map(getDb().select({ id: accounts.id, name: accounts.name }).from(accounts).all().map((row) => [row.id, row.name]));
}

/** One entry per account, newest charge first. `charges` is oldest first (chargesAsOf). */
function accountsNewestFirst(charges: ChargeRow[], names: Map<number, string>): RecurringAccount[] {
  const seen = new Set<number>();
  const out: RecurringAccount[] = [];
  for (const charge of [...charges].reverse()) {
    if (seen.has(charge.accountId)) continue;
    seen.add(charge.accountId);
    out.push({ id: charge.accountId, name: names.get(charge.accountId) ?? '' });
  }
  return out;
}
```
6. Replace `recurringCharges` (keep its ruling-R2 scope resolution and update its docblock to describe the two tiers, the forming count and the filter):
```ts
export function recurringCharges(input: {
  today: string;
  ownerUserId: number | null;
  viewer: Viewer;
  /** Spec 2026-10-05 §2.4. Keep only merchants that charged this account; null is every account. */
  accountId: number | null;
}): RecurringCharges {
  const scope = resolveScope(input.viewer, input.ownerUserId);
  const slice = readCharges(addDaysIso(input.today, -RECURRING_LOOKBACK_DAYS), scope);

  const byMerchant = new Map<string, ChargeRow[]>();
  for (const row of slice) {
    const bucket = byMerchant.get(row.merchant);
    if (bucket) bucket.push(row);
    else byMerchant.set(row.merchant, [row]);
  }

  const marks = listRecurringMarkRules();
  const names = accountNames();
  const charged = (charges: ChargeRow[]) => input.accountId === null || charges.some((charge) => charge.accountId === input.accountId);
  const forming: Record<RecurringCadence, number> = { monthly: 0, yearly: 0 };
  const rows: RecurringChargeRow[] = [];

  for (const [merchant, all] of byMerchant) {
    const mark = recurringMarkFor(merchant, marks);
    // Spec §2.3: a not_recurring merchant is on neither list, and is not forming either.
    if (mark === 'not_recurring') continue;
    const charges = chargesAsOf(all, input.today);
    if (charges.length === 0) continue;
    const verdict = recurringVerdict({ charges, today: input.today });
    if (verdict === null && mark === null) {
      const band = formingRhythm({ charges, today: input.today });
      if (band !== null && charged(charges)) forming[band] += 1;
      continue;
    }
    if (!charged(charges)) continue;
    const latest = charges[charges.length - 1];
    rows.push({
      merchant,
      tier: mark === 'recurring' ? 'known' : 'looks',
      knownBy: mark === 'recurring' ? 'mark' : null,
      cadence: verdict?.cadence ?? null,
      chargeCount: charges.length,
      typicalCents: charges.length > 1 ? medianCents(charges.map((charge) => Math.abs(charge.amountCents))) : null,
      lastAmountCents: Math.abs(latest.amountCents),
      lastDate: latest.date,
      transactionId: latest.id,
      tracked: null,
      accounts: accountsNewestFirst(charges, names),
    });
  }

  // Resolved only for the merchants that made a list, as before. A cover makes a Looks row Known.
  if (rows.length > 0) {
    const covering = needles(input.today, scope);
    for (const row of rows) {
      const hit = covering.find((needle) => covers(needle, row.merchant));
      row.tracked = hit === undefined ? null : { kind: hit.kind, itemId: hit.itemId, itemName: hit.itemName };
      if (row.tier === 'looks' && row.tracked !== null) {
        row.tier = 'known';
        row.knownBy = 'tracked';
      }
    }
  }

  const byName = (a: RecurringChargeRow, b: RecurringChargeRow) => (a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0);
  const known = rows.filter((row) => row.tier === 'known').sort(byName);
  const looks = rows
    .filter((row) => row.tier === 'looks')
    .sort((a, b) => (b.typicalCents ?? 0) - (a.typicalCents ?? 0) || byName(a, b));
  return { known, looks: looks.slice(0, RECURRING_MAX_ROWS), forming };
}
```

`tests/ops/visibility-invariants.test.ts` still finds `viewer: Viewer` in the signature; no change there.

- [ ] **Step 6: Loans & Coverage drops the card**

`git mv src/components/warranty/RecurringChargesCard.tsx src/components/insights/RecurringChargesCard.tsx`. In the moved file delete the `RecurringChargesCard` component, its docblock and every import except `formatCents`; keep `recordedBillingSentence` and its docblock (change "the card above" to "the Recurring charges card on Insights"). Task 5 writes the new card into this file.

In `src/app/(app)/warranties/page.tsx`: import only `recurringLoad` from `@/lib/recurring`; delete the `recurringCharges` call and the `recurring`/`recurringPerson` props; rewrite the F-05 comment to: `F-05: recurringLoad totals the billing amounts somebody typed into items (the header line). What the ledger shows arriving on a rhythm moved to Insights (spec 2026-10-05 §2.1).`

In `src/app/(app)/warranties/warranties-client.tsx`: import `recordedBillingSentence` from `@/components/insights/RecurringChargesCard`; change the type import to `import type { RecurringLoad } from '@/lib/recurring';`; delete the `recurring` and `recurringPerson` props and their types; in the header-line comment change "the Recurring charges card below" to "the Recurring charges card on Insights"; replace the `<RecurringChargesCard … />` block and its comment with:

```tsx
      {/* Spec 2026-10-05 §2.1: the rhythm list lives on Insights now. One line, where it used to be. */}
      <p className="text-sm text-muted">
        Recurring charges moved to{' '}
        <Link href="/insights" className="font-medium text-accent-text underline underline-offset-2">
          Insights
        </Link>
        .
      </p>
```

- [ ] **Step 7: Run the tests and the type check**

Run: `npx vitest run tests/lib/predict/anomalies.test.ts tests/lib/recurring.test.ts tests/app/warranties-client.test.tsx tests/ops/visibility-invariants.test.ts tests/ops/client-bundle.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit` — expected no errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/predict/anomalies.ts src/lib/recurring.ts src/components/insights/RecurringChargesCard.tsx src/components/warranty/RecurringChargesCard.tsx "src/app/(app)/warranties/page.tsx" "src/app/(app)/warranties/warranties-client.tsx" tests/lib/predict/anomalies.test.ts tests/lib/recurring.test.ts tests/app/warranties-client.test.tsx
git commit -m "feat(recurring): two tiers, accounts and forming rhythms

- Known: marked, or a covered rhythm; Looks: a rhythm only
- every row names the accounts charged, newest first; account filter
- forming count per band for merchants one charge short
- Loans & Coverage points to Insights instead of showing the card"
```

**Review focus:**
- Known is never capped; the cap and the filter are applied in that order (filter first).
- `chargesAsOf` is the one filter for refunds and future rows: the verdict, the forming count and a marked row all count the same charges.
- `accountNames()` emits a name only for an account that appears in the viewer's own scoped charges.
- The rewritten recurring.ts docblock no longer claims nothing is stored, and says what is.

---

### Task 3: Mark actions, row and bulk (spec §2.2)

**Files:**
- Modify: `src/lib/transactions.ts` (new `merchantsOfTransactions`, beside `transactionOwners` :947)
- Modify: `src/app/(app)/transactions/actions.ts` (imports :24-59; new actions after `bulkTransferAction` :441-461)
- Modify: `tests/ops/rule-authoring-intent.test.ts` (`ALLOWED_AUTHORS` :395), `tests/ops/visibility-invariants.test.ts` (`EXEMPT`, and the floor at :258)
- Test: `tests/app/transactions-actions.test.ts`

**Interfaces:**
- Consumes: `setRecurringMarks`, `type RecurringMark` (Task 1).
- Produces: `merchantsOfTransactions(ids: number[]): string[]` (distinct, sorted; no viewer — callers run `allTransactionsVisible` first).
- Produces: `setRecurringMarkAction(_prev: ActionState, formData: FormData): Promise<ActionState>` — fields `transactionId`, `mark` ∈ `'recurring' | 'not_recurring' | 'clear'`. `bulkRecurringMarkAction(_prev: ActionState, formData: FormData): Promise<ActionState>` — fields `ids` (comma list), `mark`. Both revalidate `/transactions` and `/insights`.

- [ ] **Step 1: Write the failing action tests**

In `tests/app/transactions-actions.test.ts`, add `bulkRecurringMarkAction` and `setRecurringMarkAction` to the actions import, add `import { revalidatePath } from 'next/cache';` below the `vi.mock('next/cache', …)` block, and append:

```ts
/** Spec 2026-10-05 §2.2. The row menu's mark, mirroring setRowTransferAction's guards. */
describe('setRecurringMarkAction', () => {
  it('marks the row merchant recurring with one exact rule, and says so', async () => {
    const { addTxn } = setup();
    const id = addTxn('RIVERSIDE GYM', -4500);
    expect(await setRecurringMarkAction({}, formData({ transactionId: String(id), mark: 'recurring' }))).toEqual({
      message: 'RIVERSIDE GYM is marked recurring.',
    });
    expect(listRules('recurring').map((rule) => [rule.pattern, rule.matchType])).toEqual([['RIVERSIDE GYM', 'exact']]);
  });

  it('Not recurring replaces a recurring mark rather than sitting beside it', async () => {
    const { addTxn } = setup();
    const id = addTxn('RIVERSIDE GYM', -4500);
    await setRecurringMarkAction({}, formData({ transactionId: String(id), mark: 'recurring' }));
    expect(await setRecurringMarkAction({}, formData({ transactionId: String(id), mark: 'not_recurring' }))).toEqual({
      message: 'RIVERSIDE GYM will not be listed as recurring.',
    });
    expect(listRules('recurring')).toEqual([]);
    expect(listRules('not_recurring').map((rule) => rule.pattern)).toEqual(['RIVERSIDE GYM']);
  });

  it('clear takes either mark off', async () => {
    const { addTxn } = setup();
    const id = addTxn('RIVERSIDE GYM', -4500);
    await setRecurringMarkAction({}, formData({ transactionId: String(id), mark: 'not_recurring' }));
    expect(await setRecurringMarkAction({}, formData({ transactionId: String(id), mark: 'clear' }))).toEqual({
      message: 'RIVERSIDE GYM is no longer marked.',
    });
    expect(listRules('not_recurring')).toEqual([]);
  });

  it('revalidates Transactions and Insights', async () => {
    const { addTxn } = setup();
    const id = addTxn('RIVERSIDE GYM', -4500);
    vi.mocked(revalidatePath).mockClear();
    await setRecurringMarkAction({}, formData({ transactionId: String(id), mark: 'recurring' }));
    expect(vi.mocked(revalidatePath).mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(['/transactions', '/insights']));
  });

  it('refuses a mark it does not know, and writes nothing', async () => {
    const { addTxn } = setup();
    const id = addTxn('RIVERSIDE GYM', -4500);
    expect(await setRecurringMarkAction({}, formData({ transactionId: String(id), mark: 'maybe' }))).toEqual({ error: 'Invalid request.' });
    expect(listRules('recurring')).toEqual([]);
  });

  it('checks the origin before anything else', async () => {
    setup();
    sameOrigin.value = false;
    expect((await setRecurringMarkAction({}, formData({ transactionId: '1', mark: 'recurring' }))).error).toBe(CROSS_ORIGIN_ERROR);
  });

  it('refuses a self-scoped viewer a row that is not theirs, and writes nothing', async () => {
    const { addTxn } = setup();
    const id = addTxn('RIVERSIDE GYM', -4500);
    currentUser = { ...currentUser, role: 'member', visibility: 'self' };
    expect((await setRecurringMarkAction({}, formData({ transactionId: String(id), mark: 'recurring' }))).error).toBe(NOT_YOURS_ERROR);
    expect(listRules('recurring')).toEqual([]);
  });

  it('surfaces the rule-ownership refusal and writes nothing', async () => {
    const { db, addTxn } = setup();
    const bob = insertTestUser(db, { name: 'Bob', username: 'bob', role: 'member' });
    upsertRuleFromCorrection({ pattern: 'RIVERSIDE GYM', matchType: 'exact', ruleKind: 'not_recurring', categoryId: null, createdBy: bob, actorRole: 'member' });
    const id = addTxn('RIVERSIDE GYM', -4500);
    currentUser = { ...currentUser, role: 'member' };
    expect((await setRecurringMarkAction({}, formData({ transactionId: String(id), mark: 'recurring' }))).error).toBe(ruleOwnedError('Bob'));
    expect(listRules('recurring')).toEqual([]);
    expect(listRules('not_recurring')).toHaveLength(1);
  });
});

/** Spec 2026-10-05 §2.2. The bulk bar's mark, mirroring bulkTransferAction. */
describe('bulkRecurringMarkAction', () => {
  it('marks each distinct merchant in the selection once', async () => {
    const { addTxn } = setup();
    const a = addTxn('RIVERSIDE GYM', -4500);
    const b = addTxn('RIVERSIDE GYM', -4600);
    const c = addTxn('CEDAR PHONE CO', -6200);
    expect(await bulkRecurringMarkAction({}, formData({ ids: `${a},${b},${c}`, mark: 'recurring' }))).toEqual({
      message: 'Marked 2 merchants as recurring.',
    });
    expect(listRules('recurring').map((rule) => rule.pattern).sort()).toEqual(['CEDAR PHONE CO', 'RIVERSIDE GYM']);
  });

  it('refuses an empty selection', async () => {
    setup();
    expect(await bulkRecurringMarkAction({}, formData({ ids: '', mark: 'recurring' }))).toEqual({ error: 'Invalid request.' });
  });

  it('refuses the whole batch when any row is not the viewer own, and writes nothing', async () => {
    const { db, accountId, userId, addTxn } = setup();
    const own = db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, attributed_user_id, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'RIVERSIDE GYM', 'RIVERSIDE GYM', -4500, ${userId}, ${userId}, ${nowIso()}, ${nowIso()})
      returning id`).id;
    const theirs = addTxn('CEDAR PHONE CO', -6200);
    currentUser = { ...currentUser, role: 'member', visibility: 'self' };
    expect((await bulkRecurringMarkAction({}, formData({ ids: `${own},${theirs}`, mark: 'recurring' }))).error).toBe(NOT_YOURS_ERROR);
    expect(listRules('recurring')).toEqual([]);
  });

  /** Review Focus 2. */
  it('a refusal over one merchant writes nothing for the others', async () => {
    const { db, addTxn } = setup();
    const bob = insertTestUser(db, { name: 'Bob', username: 'bob', role: 'member' });
    upsertRuleFromCorrection({ pattern: 'CEDAR PHONE CO', matchType: 'exact', ruleKind: 'not_recurring', categoryId: null, createdBy: bob, actorRole: 'member' });
    const a = addTxn('RIVERSIDE GYM', -4500);
    const b = addTxn('CEDAR PHONE CO', -6200);
    currentUser = { ...currentUser, role: 'member' };
    expect((await bulkRecurringMarkAction({}, formData({ ids: `${a},${b}`, mark: 'recurring' }))).error).toBe(ruleOwnedError('Bob'));
    expect(listRules('recurring')).toEqual([]);
  });
});
```

Fails before / passes after: neither action exists until Step 3.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/app/transactions-actions.test.ts`
Expected: every new case fails with `setRecurringMarkAction is not a function` / `bulkRecurringMarkAction is not a function`.

- [ ] **Step 3: Implement**

In `src/lib/transactions.ts`, below `transactionOwners`:

```ts
/**
 * Spec 2026-10-05 §2.2. The distinct merchants behind these rows, for a mark that is a fact about
 * the merchant rather than the row. Like transactionOwners it takes no viewer: both callers
 * (transactions/actions.ts) run allTransactionsVisible over the same ids first.
 */
export function merchantsOfTransactions(ids: number[]): string[] {
  if (ids.length === 0) return [];
  return getDb()
    .selectDistinct({ merchant: transactions.normalizedMerchant })
    .from(transactions)
    .where(inArray(transactions.id, ids))
    .orderBy(asc(transactions.normalizedMerchant))
    .all()
    .map((row) => row.merchant);
}
```

(Add `asc` to the drizzle import if the file does not already have it.)

In `src/app/(app)/transactions/actions.ts`: add `merchantsOfTransactions` to the `@/lib/transactions` import, and change the rules import to `import { ruleOwnedError, AMOUNT_BOUND_ORDER_ERROR, setRecurringMarks, type RecurringMark } from '@/lib/categorize/rules';`. After `bulkTransferAction`, add:

```ts
const recurringMarkField = z.enum(['recurring', 'not_recurring', 'clear']);
type RecurringMarkChoice = z.infer<typeof recurringMarkField>;

function markOf(choice: RecurringMarkChoice): RecurringMark | null {
  return choice === 'clear' ? null : choice;
}

/**
 * Spec 2026-10-05 §2.2. The row menu's "Mark recurring" / "Not recurring" and the Insights card's
 * buttons, which post the merchant's newest charge. Same visibility model as setRowTransferAction:
 * a self viewer may mark a merchant from their own rows. The mark is a merchant rule, so
 * setRecurringMarks' ownership refusal applies on top; nothing on the row itself changes.
 */
export async function setRecurringMarkAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const parsed = z
    .object({ transactionId: z.coerce.number().int().positive(), mark: recurringMarkField })
    .safeParse({ transactionId: formData.get('transactionId'), mark: formData.get('mark') });
  if (!parsed.success) return { error: 'Invalid request.' };
  if (!allTransactionsVisible([parsed.data.transactionId], user)) return { error: NOT_YOURS_ERROR };
  const merchants = merchantsOfTransactions([parsed.data.transactionId]);
  const result = setRecurringMarks({ merchants, mark: markOf(parsed.data.mark), userId: user.id, actorRole: user.role });
  if (!result.ok) return { error: ruleOwnedError(result.ownerName) };
  revalidatePath('/transactions');
  revalidatePath('/insights');
  const merchant = merchants[0] ?? 'This merchant';
  if (parsed.data.mark === 'recurring') return { message: `${merchant} is marked recurring.` };
  if (parsed.data.mark === 'not_recurring') return { message: `${merchant} will not be listed as recurring.` };
  return { message: `${merchant} is no longer marked.` };
}

/** Spec 2026-10-05 §2.2. The bulk bar's "Mark recurring": every distinct merchant in the selection, all or nothing. */
export async function bulkRecurringMarkAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const ids = idList.parse(String(formData.get('ids') ?? ''));
  const mark = recurringMarkField.safeParse(formData.get('mark'));
  if (ids.length === 0 || !mark.success) return { error: 'Invalid request.' };
  // Ruling R2 fix round 2: every id must resolve through the viewer, or nothing is written.
  if (!allTransactionsVisible(ids, user)) return { error: NOT_YOURS_ERROR };
  const merchants = merchantsOfTransactions(ids);
  const result = setRecurringMarks({ merchants, mark: markOf(mark.data), userId: user.id, actorRole: user.role });
  if (!result.ok) return { error: ruleOwnedError(result.ownerName) };
  revalidatePath('/transactions');
  revalidatePath('/insights');
  const noun = result.merchants === 1 ? 'merchant' : 'merchants';
  if (mark.data === 'recurring') return { message: `Marked ${result.merchants} ${noun} as recurring.` };
  if (mark.data === 'not_recurring') return { message: `Marked ${result.merchants} ${noun} as not recurring.` };
  return { message: `Cleared the mark on ${result.merchants} ${noun}.` };
}
```

- [ ] **Step 4: Run the action tests, then watch the authoring guard go red**

Run: `npx vitest run tests/app/transactions-actions.test.ts` — expected PASS.
Run: `npx vitest run tests/ops/rule-authoring-intent.test.ts`
Expected: FAIL in `'no file outside the allow-list calls a rule-authoring helper'` with `["src/app/(app)/transactions/actions.ts"]` — the file now calls `setRecurringMarks`.

- [ ] **Step 5: Argue the new author, and list the new resolver**

In `tests/ops/rule-authoring-intent.test.ts` `ALLOWED_AUTHORS`, add:

```ts
    [
      'src/app/(app)/transactions/actions.ts',
      'Spec 2026-10-05 §2.2. setRecurringMarkAction and bulkRecurringMarkAction reach setRecurringMarks ' +
        'only. "Mark recurring" and "Not recurring" are statements about a MERCHANT -- the control names the ' +
        'mark and nothing else, and no category, flag or link on the row changes.',
    ],
```

In `tests/ops/visibility-invariants.test.ts` `EXEMPT`, add (a **pin**: the list is named, not scanned, so this records the reason rather than turning anything red):

```ts
  {
    file: 'src/lib/transactions.ts',
    fn: 'merchantsOfTransactions',
    why: 'not a read-model: returns the distinct normalized merchants of rows its only callers (setRecurringMarkAction and bulkRecurringMarkAction, spec 2026-10-05) have already passed through allTransactionsVisible -- the same shape and the same pre-check as transactionOwners above.',
  },
```

and raise the floor test to `toBeGreaterThanOrEqual(41)` (33 + 8, the actual count), with a comment line: `// Spec 2026-10-05: raised from 34 to 41, the actual count with merchantsOfTransactions added.`

- [ ] **Step 6: Run the guards**

Run: `npx vitest run tests/ops/rule-authoring-intent.test.ts tests/ops/visibility-invariants.test.ts tests/ops/server-action-origin.test.ts tests/ops/use-server-exports.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/transactions.ts "src/app/(app)/transactions/actions.ts" tests/app/transactions-actions.test.ts tests/ops/rule-authoring-intent.test.ts tests/ops/visibility-invariants.test.ts
git commit -m "feat(transactions): mark a merchant recurring from a row or a selection

- setRecurringMarkAction / bulkRecurringMarkAction, setRowTransferAction's guards
- one rule per distinct merchant; a refusal writes nothing
- revalidates Transactions and Insights"
```

**Review focus:**
- Guard order in both actions: origin, auth, validation, `allTransactionsVisible`, write.
- The bulk action writes per distinct merchant inside `setRecurringMarks`' one transaction.
- The new `ALLOWED_AUTHORS` reason is true: nothing else in the file reaches the new helper.

---

> **REVIEW CHECKPOINT 1 (Opus).** Review Tasks 1–3 together: the mark kinds and their guard updates, the read model's tiers/accounts/forming/filter, and the two actions. Run `npx tsc --noEmit` and the touched test files. Fix before Task 4.

---

### Task 4: Transactions row menu and bulk bar (spec §2.2)

**Files:**
- Modify: `src/app/(app)/transactions/page.tsx` (new `recurringMarks` prop, beside `renameRules` :121)
- Modify: `src/app/(app)/transactions/transactions-client.tsx` (actions import :60-84; props :463-492; `useActionState` hooks :651, :692; notice/error chains :980-1002; `rowMenu` :1333-1338; `bulkActions` :2348-2356)
- Test: `tests/app/transactions-client.test.tsx`, `tests/app/transactions-page.test.tsx`

**Interfaces:**
- Consumes: `setRecurringMarkAction`, `bulkRecurringMarkAction` (Task 3); `listRecurringMarkRules`, `recurringMarkFor` (Task 1); `type RecurringMark` from `@/lib/categorize/mark-kinds`.
- Produces: `TransactionsClient` prop `recurringMarks?: Record<string, RecurringMark>` (keyed by `normalizedMerchant`, default `{}`).

- [ ] **Step 1: Keep the client test's action mock complete**

In `tests/app/transactions-client.test.tsx`, add to the `vi.mock('@/app/(app)/transactions/actions', …)` factory:

```ts
  // Spec 2026-10-05 §2.2: the row and bulk recurring marks.
  setRecurringMarkAction: vi.fn(async () => ({})),
  bulkRecurringMarkAction: vi.fn(async () => ({})),
```

Without these, every test in the file fails once the client imports the two actions (vitest refuses a missing export on a factory mock).

- [ ] **Step 2: Write the failing client tests**

Append to `tests/app/transactions-client.test.tsx`:

```ts
/** Spec 2026-10-05 §2.2. Beside the transfer toggle, reflecting the merchant's current mark. */
describe('TransactionsClient — the recurring mark', () => {
  const base = { accounts: [], categories: [], people: [], today: '2026-03-02' };

  it('offers Mark recurring and Not recurring for a merchant with no mark', () => {
    render(<TransactionsClient page={pageWithRow()} {...base} />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.getByRole('menuitem', { name: 'Mark recurring' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Not recurring' })).toBeTruthy();
  });

  it('offers only Unmark recurring once the merchant is marked', () => {
    render(<TransactionsClient page={pageWithRow()} {...base} recurringMarks={{ 'TIM HORTONS': 'recurring' }} />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.getByRole('menuitem', { name: 'Unmark recurring' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Mark recurring' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Not recurring' })).toBeNull();
  });

  /** Review Focus 4. */
  it('offers Mark recurring and a way back from Not recurring', () => {
    render(<TransactionsClient page={pageWithRow()} {...base} recurringMarks={{ 'TIM HORTONS': 'not_recurring' }} />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.getByRole('menuitem', { name: 'Mark recurring' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Clear “not recurring”' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Not recurring' })).toBeNull();
  });

  it('offers no mark on a transfer row -- Insights reads charges, and a transfer is never one', () => {
    render(<TransactionsClient page={pageWithRow({ isTransfer: true })} {...base} />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.queryByRole('menuitem', { name: /recurring/i })).toBeNull();
  });

  it('posts the row id and the mark', async () => {
    const { setRecurringMarkAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(setRecurringMarkAction).mockClear();
    render(<TransactionsClient page={pageWithRow()} {...base} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark recurring' }));
    await waitFor(() => expect(setRecurringMarkAction).toHaveBeenCalled());
    const formData = vi.mocked(setRecurringMarkAction).mock.calls[0]?.[1] as FormData;
    expect([formData.get('transactionId'), formData.get('mark')]).toEqual(['1', 'recurring']);
  });

  it('marks every selected row from the bulk bar', async () => {
    const { bulkRecurringMarkAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(bulkRecurringMarkAction).mockClear();
    render(<TransactionsClient page={pageWithRow()} {...base} />);
    fireEvent.click(rowScope().getByLabelText('Select transaction 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Mark recurring' }));
    await waitFor(() => expect(bulkRecurringMarkAction).toHaveBeenCalled());
    const formData = vi.mocked(bulkRecurringMarkAction).mock.calls[0]?.[1] as FormData;
    expect([formData.get('ids'), formData.get('mark')]).toEqual(['1', 'recurring']);
  });
});
```

(`useActionState` passes `(prevState, formData)` to the action, so the form data is argument index 1.)

Fails before / passes after: the row menu and bulk bar have no recurring items until Step 4.

Append to `tests/app/transactions-page.test.tsx` (add `import { setRecurringMarks } from '@/lib/categorize/rules';` to its imports):

```ts
/** Spec 2026-10-05 §2.2. The page tells each row the mark its merchant carries. */
describe('TransactionsPage: the recurring mark rides with the row', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('offers Unmark recurring on a row whose merchant is marked', async () => {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    const accountId = insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    t.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'RIVERSIDE GYM', 'RIVERSIDE GYM', -4500, ${admin}, ${nowIso()}, ${nowIso()})`);
    setRecurringMarks({ merchants: ['RIVERSIDE GYM'], mark: 'recurring', userId: admin, actorRole: 'admin' });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };

    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    const { container } = render(await TransactionsPage({ searchParams: Promise.resolve({}) }));
    fireEvent.click(within(container.querySelector('table') as HTMLElement).getByRole('button', { name: /^Actions for RIVERSIDE GYM/ }));
    expect(screen.getByRole('menuitem', { name: 'Unmark recurring' })).toBeTruthy();
  });
});
```

Fails before / passes after: the page passes no marks, so the menu shows Mark recurring, until Step 4.

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/app/transactions-client.test.tsx tests/app/transactions-page.test.tsx`
Expected: the new cases fail with `Unable to find an accessible element with the role "menuitem" and name "Mark recurring"` (and `… "Unmark recurring"` on the page test); every pre-existing case still passes.

- [ ] **Step 4: Implement**

In `src/app/(app)/transactions/page.tsx`: import `listRecurringMarkRules, recurringMarkFor` alongside `listRules` from `@/lib/categorize/rules`, add `import type { RecurringMark } from '@/lib/categorize/mark-kinds';`, and after the `renameRules` block add:

```ts
  /**
   * Spec 2026-10-05 §2.2. The recurring mark each merchant on this page carries, so the row menu
   * offers the opposite. Keyed by merchant, not row id: a mark is a fact about the merchant.
   */
  const recurringMarks: Record<string, RecurringMark> = {};
  {
    const marks = listRecurringMarkRules();
    if (marks.length > 0) {
      for (const row of page.rows) {
        const mark = recurringMarkFor(row.normalizedMerchant, marks);
        if (mark !== null) recurringMarks[row.normalizedMerchant] = mark;
      }
    }
  }
```

and pass `recurringMarks={recurringMarks}` to `<TransactionsClient>`.

In `transactions-client.tsx`:
1. Add `bulkRecurringMarkAction` and `setRecurringMarkAction` to the `./actions` import; add `import type { RecurringMark } from '@/lib/categorize/mark-kinds';`.
2. Props: destructure `recurringMarks = {}` and type it `recurringMarks?: Record<string, RecurringMark>;` with the comment `/** Spec 2026-10-05 §2.2: the mark each merchant on this page carries, keyed by normalizedMerchant (page.tsx). */`
3. Beside `rowTransferState`: `const [rowRecurringState, rowRecurringAction] = useActionState(setRecurringMarkAction, initial);`. Beside `bulkTfrState`: `const [bulkRecurringState, bulkRecurringFormAction] = useActionState(bulkRecurringMarkAction, initial);`.
4. In the `notice` chain append `?? bulkRecurringState.message` after `bulkTfrState.message`, and `?? rowRecurringState.message` after `rowTransferState.message`; the same two in the `error` chain.
5. Inside the component, above `rowMenu`, add:
```tsx
  /**
   * Spec 2026-10-05 §2.2. The merchant's recurring mark, beside the transfer toggle. Unmarked: Mark
   * recurring and Not recurring. Marked: Unmark. Not recurring: Mark recurring, or clear it.
   */
  function recurringMenuItems(row: TransactionRow) {
    const mark = recurringMarks[row.normalizedMerchant] ?? null;
    const fields = (choice: 'recurring' | 'not_recurring' | 'clear') => ({ transactionId: String(row.id), mark: choice });
    if (mark === 'recurring') {
      return <RowMenuForm action={rowRecurringAction} fields={fields('clear')}>Unmark recurring</RowMenuForm>;
    }
    return (
      <>
        <RowMenuForm action={rowRecurringAction} fields={fields('recurring')}>Mark recurring</RowMenuForm>
        {mark === 'not_recurring' ? (
          <RowMenuForm action={rowRecurringAction} fields={fields('clear')}>{'Clear “not recurring”'}</RowMenuForm>
        ) : (
          <RowMenuForm action={rowRecurringAction} fields={fields('not_recurring')}>Not recurring</RowMenuForm>
        )}
      </>
    );
  }
```
6. In `rowMenu`, directly after the transfer `RowMenuForm`:
```tsx
        {/* Spec 2026-10-05 §2.2. Not on a transfer: Insights reads charges, and a transfer is never one. */}
        {row.isTransfer ? null : recurringMenuItems(row)}
```
7. In `bulkActions`, after the `transfer` entry:
```tsx
    {
      key: 'recurring',
      node: (
        <form action={bulkRecurringFormAction} className="flex items-center gap-2">
          <input type="hidden" name="ids" value={selected.join(',')} />
          <input type="hidden" name="mark" value="recurring" />
          <SubmitButton variant="secondary">Mark recurring</SubmitButton>
        </form>
      ),
    },
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/app/transactions-client.test.tsx tests/app/transactions-page.test.tsx tests/ops/client-bundle.test.ts tests/ops/row-controls.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/transactions/page.tsx" "src/app/(app)/transactions/transactions-client.tsx" tests/app/transactions-client.test.tsx tests/app/transactions-page.test.tsx
git commit -m "feat(transactions): Mark recurring in the row menu and the bulk bar

- row menu offers the opposite of the merchant's current mark
- a way back from Not recurring; nothing on a transfer row
- bulk Mark recurring beside Mark transfer"
```

**Review focus:**
- The client imports `RecurringMark` as a type from `mark-kinds.ts` only; no value import from `rules.ts`.
- The two new states join both banner chains, so a refusal is visible.

---

### Task 5: The Recurring charges card (spec §2.3–§2.5)

**Files:**
- Create: `src/components/insights/RecurringMarkForm.tsx`
- Modify: `src/components/insights/RecurringChargesCard.tsx` (add the card beside `recordedBillingSentence`)
- Test: `tests/components/recurring-charges-card.test.tsx` (new)

**Interfaces:**
- Consumes: `RecurringCharges`, `RecurringChargeRow`, `RecurringAccount` (Task 2, type-only); `setRecurringMarkAction` (Task 3, relative import).
- Produces: `RecurringMarkForm({ transactionId: number; mark: 'recurring' | 'not_recurring' | 'clear'; label: string; ariaLabel: string })` (`'use client'`); `RecurringChargesCard({ result: RecurringCharges; person: number | null; accounts: RecurringAccount[]; accountId: number | null })`; `formingSentence(forming: Record<RecurringCadence, number>): string | null`.

- [ ] **Step 1: Write the failing card tests**

Create `tests/components/recurring-charges-card.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { formingSentence, RecurringChargesCard } from '@/components/insights/RecurringChargesCard';
import type { RecurringAccount, RecurringChargeRow, RecurringCharges } from '@/lib/recurring';

afterEach(cleanup);

/**
 * Spec 2026-10-05 §2.3–§2.5. Half of these assertions are about what the card must NOT say: cadence
 * detection cannot tell a monthly shop from a bill, so every string states a measurement or the
 * household's own word.
 */
const CHEQUING: RecurringAccount = { id: 1, name: 'Everyday Chequing' };
const VISA: RecurringAccount = { id: 2, name: 'Travel Visa' };
const NONE = { monthly: 0, yearly: 0 };

function row(over: Partial<RecurringChargeRow> = {}): RecurringChargeRow {
  return {
    merchant: 'MAPLE STREAMING',
    tier: 'looks',
    knownBy: null,
    cadence: 'monthly',
    chargeCount: 7,
    typicalCents: 1349,
    lastAmountCents: 1399,
    lastDate: '2026-09-28',
    transactionId: 501,
    tracked: null,
    accounts: [VISA],
    ...over,
  };
}

function renderCard(result: Partial<RecurringCharges> = {}, over: { person?: number | null; accountId?: number | null } = {}) {
  return render(
    <RecurringChargesCard
      result={{ known: [], looks: [], forming: NONE, ...result }}
      person={over.person ?? null}
      accounts={[CHEQUING, VISA]}
      accountId={over.accountId ?? null}
    />,
  );
}

const marked = row({ merchant: 'RIVERSIDE GYM', tier: 'known', knownBy: 'mark', cadence: null, chargeCount: 1, typicalCents: null, transactionId: 610, accounts: [CHEQUING] });

describe('RecurringChargesCard', () => {
  it('puts each tier under its own heading, saying what it means', () => {
    const { container } = renderCard({ known: [marked], looks: [row()] });
    expect(screen.getByRole('heading', { name: 'Known recurring' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Looks recurring' })).toBeTruthy();
    expect(container.textContent).toContain('You marked it, or you track it.');
    expect(container.textContent).toContain('A rhythm, which is not a verdict');
  });

  /** Review Focus 5. */
  it('shows Marked and an em dash for a merchant marked after one charge', () => {
    renderCard({ known: [marked] });
    expect(screen.getByText('Marked')).toBeTruthy();
    expect(screen.getByText('1 charge · usually —')).toBeTruthy();
  });

  it('lists every account a merchant charged, newest first', () => {
    renderCard({ looks: [row({ accounts: [VISA, CHEQUING] })] });
    expect(screen.getByText('Travel Visa, Everyday Chequing')).toBeTruthy();
  });

  it('offers Mark recurring and Not recurring on a Looks row, posting its newest charge', () => {
    const { container } = renderCard({ looks: [row()] });
    expect(screen.getByRole('button', { name: 'Mark MAPLE STREAMING as recurring' }).textContent).toBe('Mark recurring');
    expect(screen.getByRole('button', { name: /Mark MAPLE STREAMING as not recurring/ }).textContent).toBe('Not recurring');
    const posted = [...container.querySelectorAll('form')].map((form) => [
      form.querySelector<HTMLInputElement>('input[name="transactionId"]')?.value,
      form.querySelector<HTMLInputElement>('input[name="mark"]')?.value,
    ]);
    expect(posted).toEqual(expect.arrayContaining([['501', 'recurring'], ['501', 'not_recurring']]));
  });

  it('offers Unmark only on a row the household marked', () => {
    renderCard({ known: [marked, row({ merchant: 'CEDAR PHONE CO', tier: 'known', knownBy: 'tracked', tracked: { kind: 'item', itemId: 12, itemName: 'Cedar phone plan' } })] });
    expect(screen.getByRole('button', { name: 'Unmark RIVERSIDE GYM' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unmark CEDAR PHONE CO' })).toBeNull();
  });

  it('offers Track where nothing covers the merchant, through the one prefill path', () => {
    const { container } = renderCard({ known: [marked] });
    const track = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Track');
    expect(track?.getAttribute('href')).toBe('/warranties/new?transactionId=610');
  });

  it('names the record that covers a tracked merchant, and offers no Track on it', () => {
    const { container } = renderCard({ known: [row({ tier: 'known', knownBy: 'tracked', tracked: { kind: 'item', itemId: 12, itemName: 'Maple plan' } })] });
    const badge = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Maple plan');
    expect(badge?.getAttribute('href')).toBe('/warranties/12');
    expect([...container.querySelectorAll('a')].some((a) => a.textContent === 'Track')).toBe(false);
  });

  it('drills into the merchant rows through transactionsHref, carrying the person scope', () => {
    const { container } = renderCard({ looks: [row()] }, { person: 7 });
    const href = [...container.querySelectorAll('a')].find((a) => a.textContent === 'MAPLE STREAMING')?.getAttribute('href') ?? '';
    const params = new URLSearchParams(href.slice('/transactions?'.length));
    expect([href.startsWith('/transactions?'), params.get('q'), params.get('person')]).toEqual([true, 'MAPLE STREAMING', '7']);
  });

  it('counts merchants one charge short, per band, and says nothing at zero', () => {
    expect(formingSentence(NONE)).toBeNull();
    expect(formingSentence({ monthly: 1, yearly: 0 })).toBe('1 merchant has charged twice about a month apart. One more charge and it appears here.');
    expect(formingSentence({ monthly: 4, yearly: 0 })).toBe('4 merchants have charged twice about a month apart. One more charge and they appear here.');
    expect(formingSentence({ monthly: 0, yearly: 1 })).toBe('1 merchant has charged twice about a year apart. One more charge and it appears here.');
    expect(formingSentence({ monthly: 4, yearly: 1 })).toBe('4 merchants have charged twice about a month apart, and 1 about a year apart. One more charge and they appear here.');
  });

  it('puts the forming sentence where an empty Looks list would be', () => {
    const { container } = renderCard({ known: [marked], forming: { monthly: 4, yearly: 0 } });
    expect(container.textContent).toContain('4 merchants have charged twice about a month apart.');
    expect(container.textContent).not.toContain('No merchant is charging on a regular rhythm yet');
  });

  it('with nothing listed and nothing forming, says nothing has a rhythm yet', () => {
    const { container } = renderCard();
    expect(container.textContent).toContain('No merchant is charging on a regular rhythm yet');
  });

  it('filters through a plain GET form that keeps the person scope', () => {
    const { container } = renderCard({ looks: [row()] }, { person: 7, accountId: 2 });
    const form = container.querySelector('form[method="get"]') as HTMLFormElement;
    expect(form.getAttribute('action')).toBe('/insights');
    expect(form.querySelector<HTMLInputElement>('input[name="person"]')?.value).toBe('7');
    const select = screen.getByLabelText('Account') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['All accounts', 'Everyday Chequing', 'Travel Visa']);
    expect(select.value).toBe('2');
  });

  it('says so by name when the chosen account has nothing on either list', () => {
    const { container } = renderCard({}, { accountId: 2 });
    expect(container.textContent).toContain('Nothing on either list charged Travel Visa.');
  });

  it('never says subscription, wasted, forgotten or cancel', () => {
    for (const result of [{}, { known: [marked], looks: [row()], forming: { monthly: 2, yearly: 1 } }]) {
      const { container } = renderCard(result);
      expect(container.textContent).not.toMatch(/subscription|wasted|forgotten|cancel/i);
      cleanup();
    }
  });
});
```

Fails before / passes after: after Task 2 the module exports only `recordedBillingSentence`; `RecurringChargesCard` and `formingSentence` arrive in Step 3.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/components/recurring-charges-card.test.tsx`
Expected: FAIL — `Element type is invalid … got: undefined` for every render, and `formingSentence is not a function`.

- [ ] **Step 3: The mark button**

Create `src/components/insights/RecurringMarkForm.tsx`:

```tsx
'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
// RELATIVE, like DismissInsightForm.tsx: the client-bundle guard walks only @/ value imports, and
// cannot tell a 'use server' file from an ordinary module.
import { setRecurringMarkAction, type ActionState } from '../../app/(app)/transactions/actions';

const initial: ActionState = {};

/**
 * Spec 2026-10-05 §2.3. One mark button on the Recurring charges card. It posts the merchant's
 * newest charge, so the action checks that row against the viewer the way the row menu's does.
 */
export function RecurringMarkForm({
  transactionId,
  mark,
  label,
  ariaLabel,
}: {
  transactionId: number;
  mark: 'recurring' | 'not_recurring' | 'clear';
  label: string;
  ariaLabel: string;
}) {
  const [state, dispatch] = useActionState(setRecurringMarkAction, initial);
  return (
    <form action={dispatch} className="flex flex-col items-start gap-1">
      <input type="hidden" name="transactionId" value={String(transactionId)} />
      <input type="hidden" name="mark" value={mark} />
      <SubmitButton variant="secondary" size="sm" ariaLabel={ariaLabel}>
        {label}
      </SubmitButton>
      <FormError message={state.error} />
    </form>
  );
}
```

- [ ] **Step 4: The card**

In `src/components/insights/RecurringChargesCard.tsx` (no directive; it renders inside the `'use client'` Insights tree and holds no state itself), add above `recordedBillingSentence`:

```tsx
import Link from 'next/link';
import { RecurringMarkForm } from '@/components/insights/RecurringMarkForm';
import { buttonClass } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, selectClass } from '@/components/ui/form';
import { Money } from '@/components/ui/Money';
import { TableWrap } from '@/components/ui/Table';
import { formatCents } from '@/lib/money';
import type { RecurringCadence } from '@/lib/predict/anomalies';
// Type-only, so @/lib/recurring (which imports @/db) never becomes a bundle edge --
// tests/ops/client-bundle.test.ts draws exactly that line.
import type { RecurringAccount, RecurringChargeRow, RecurringCharges } from '@/lib/recurring';
// Every /transactions link in this app is built here (F-01).
import { transactionsHref } from '@/lib/transaction-links';

/**
 * Spec 2026-10-05 §2.3–§2.5. "Recurring charges" on Insights, in two tiers. Known recurring is the
 * household's word (a mark, or a recorded item covering a detected rhythm); Looks recurring is a
 * rhythm and nothing more.
 *
 * THE WORDING IS STILL THE FEATURE. Cadence detection cannot tell a once-a-month shop from a bill
 * that varies, so every string states what was measured or what the household said, and none says
 * "subscription", "wasted", "forgotten" or "cancel".
 *
 * What is saved: the household's marks, as merchant rules (Mark recurring, Not recurring, Unmark).
 * What is not: the detector's verdict, which is read fresh on every render.
 */
const CADENCE_LABEL: Record<RecurringCadence, string> = { monthly: 'Monthly', yearly: 'Yearly' };

/** Spec §2.3, forming rhythms. One sentence from the per-band count; null at zero, so the empty state stands. */
export function formingSentence(forming: Record<RecurringCadence, number>): string | null {
  const total = forming.monthly + forming.yearly;
  if (total === 0) return null;
  const merchants = (count: number) => `${count} ${count === 1 ? 'merchant has' : 'merchants have'}`;
  const bands =
    forming.monthly > 0 && forming.yearly > 0
      ? `${merchants(forming.monthly)} charged twice about a month apart, and ${forming.yearly} about a year apart.`
      : `${merchants(total)} charged twice about a ${forming.monthly > 0 ? 'month' : 'year'} apart.`;
  return `${bands} One more charge and ${total === 1 ? 'it appears' : 'they appear'} here.`;
}

/**
 * Spec §2.4. A plain GET form, so the choice is part of the address and can be bookmarked or sent.
 * It lives here rather than in src/app because tests/ops/row-controls.test.ts refuses a lone select
 * with a submit button there, and this is a filter, not a row control.
 */
function AccountFilter({ accounts, accountId, person }: { accounts: RecurringAccount[]; accountId: number | null; person: number | null }) {
  return (
    <form method="get" action="/insights" className="flex flex-wrap items-end gap-2">
      {person === null ? null : <input type="hidden" name="person" value={String(person)} />}
      <Field label="Account">
        <select name="account" defaultValue={accountId === null ? '' : String(accountId)} className={selectClass}>
          <option value="">All accounts</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </Field>
      <button type="submit" className={buttonClass('secondary', 'sm', 'min-h-11 sm:min-h-0')}>
        Show
      </button>
    </form>
  );
}

function ChargeRowView({ row, person }: { row: RecurringChargeRow; person: number | null }) {
  return (
    <tr>
      <td className="cell-stack-headline" data-label="Merchant">
        <Link
          href={transactionsHref({ range: null, person }, { kind: 'merchant', merchant: row.merchant })}
          className="font-medium text-ink hover:text-accent-text"
        >
          {row.merchant}
        </Link>
        {/* How many charges, and what the charge usually is: how a reader judges the row. */}
        <div className="cell-stack-meta text-xs text-subtle">
          {row.chargeCount} {row.chargeCount === 1 ? 'charge' : 'charges'} · usually{' '}
          {row.typicalCents === null ? '—' : formatCents(row.typicalCents)}
        </div>
      </td>
      <td data-label="Rhythm">
        <span className="badge badge--slate">{row.cadence === null ? 'Marked' : CADENCE_LABEL[row.cadence]}</span>
      </td>
      <td className="text-right cell-stack-amount" data-label="Last charge">
        <Money cents={row.lastAmountCents} plain />
      </td>
      <td className="tabnum whitespace-nowrap text-muted" data-label="Last seen">{row.lastDate}</td>
      <td className="text-muted" data-label="Accounts">{row.accounts.map((account) => account.name).join(', ')}</td>
      <td data-label="Recorded">
        {row.tracked === null ? (
          <Link href={`/warranties/new?transactionId=${row.transactionId}`} className={buttonClass('secondary', 'sm', 'min-h-11 sm:min-h-0')}>
            Track
          </Link>
        ) : (
          /* NAMES the record: an item-name match is a resemblance and can be wrong (covers, recurring.ts). */
          <Link
            href={`/warranties/${row.tracked.itemId}`}
            className="badge badge--green hover:underline"
            title={
              row.tracked.kind === 'rule'
                ? `A payment-matching rule on "${row.tracked.itemName}" matches this merchant.`
                : `Recorded as the item "${row.tracked.itemName}".`
            }
          >
            {row.tracked.itemName}
          </Link>
        )}
      </td>
      <td data-label="Mark">
        <div className="flex flex-wrap items-start gap-2">
          {row.tier === 'looks' ? (
            <>
              <RecurringMarkForm transactionId={row.transactionId} mark="recurring" label="Mark recurring" ariaLabel={`Mark ${row.merchant} as recurring`} />
              <RecurringMarkForm
                transactionId={row.transactionId}
                mark="not_recurring"
                label="Not recurring"
                ariaLabel={`Mark ${row.merchant} as not recurring and take it off this list`}
              />
            </>
          ) : row.knownBy === 'mark' ? (
            <RecurringMarkForm transactionId={row.transactionId} mark="clear" label="Unmark" ariaLabel={`Unmark ${row.merchant}`} />
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function Tier({ title, note, rows, person, empty }: { title: string; note: string; rows: RecurringChargeRow[]; person: number | null; empty: string }) {
  return (
    <section className="border-t border-line">
      <div className="px-4 pt-4 sm:px-5">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="text-xs text-subtle">{note}</p>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted sm:px-5">{empty}</p>
      ) : (
        <TableWrap bare responsive>
          <thead>
            <tr>
              <th scope="col">Merchant</th>
              <th scope="col">Rhythm</th>
              <th scope="col" className="text-right">Last charge</th>
              <th scope="col">Last seen</th>
              <th scope="col">Accounts</th>
              <th scope="col">Recorded</th>
              <th scope="col">Mark</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ChargeRowView key={row.merchant} row={row} person={person} />
            ))}
          </tbody>
        </TableWrap>
      )}
    </section>
  );
}

export function RecurringChargesCard({
  result,
  person,
  accounts,
  accountId,
}: {
  result: RecurringCharges;
  /** The person scope the rows were built with, passed into every link and the filter form. */
  person: number | null;
  /** The Account select's options: the accounts the viewer can see. */
  accounts: RecurringAccount[];
  accountId: number | null;
}) {
  const sentence = formingSentence(result.forming);
  const listed = result.known.length + result.looks.length;
  const chosen = accountId === null ? null : (accounts.find((account) => account.id === accountId) ?? null);
  return (
    <Card>
      <CardHeader
        title="Recurring charges"
        description="Merchants that bill on a rhythm, read from about three years of the ledger. Known recurring is what you said; Looks recurring is what the dates show. Mark recurring and Not recurring are saved as rules on the merchant, and Track records one as an item."
        action={<AccountFilter accounts={accounts} accountId={accountId} person={person} />}
      />
      <CardBody padded={false}>
        {listed === 0 && chosen !== null ? (
          <p className="px-4 pb-4 text-sm text-muted sm:px-5 sm:pb-5">
            Nothing on either list charged {chosen.name}.{sentence === null ? '' : ` ${sentence}`}
          </p>
        ) : listed === 0 && sentence === null ? (
          <div className="px-4 pb-4 sm:px-5 sm:pb-5">
            <EmptyState
              size="compact"
              title="No merchant is charging on a regular rhythm yet"
              noAction="Nothing to do: this card reads the ledger, so it fills in on its own once a merchant has charged three times a month or a year apart."
            >
              Once a merchant has charged three times about a month (or a year) apart, it appears here. Importing more
              history is what makes a rhythm visible.
            </EmptyState>
          </div>
        ) : (
          <>
            <Tier
              title="Known recurring"
              note="You marked it, or you track it."
              rows={result.known}
              person={person}
              empty="Nothing marked yet. Mark a merchant recurring from Looks recurring below, or from its row menu on Transactions."
            />
            <Tier
              title="Looks recurring"
              note="A rhythm, which is not a verdict: a once-a-month shop and a monthly bill make the same dates."
              rows={result.looks}
              person={person}
              empty={sentence ?? 'Nothing else is charging on a regular rhythm.'}
            />
            {result.looks.length > 0 && sentence !== null ? (
              <p className="border-t border-line px-4 py-3 text-sm text-muted sm:px-5">{sentence}</p>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}
```

Keep `formatCents` as the one import `recordedBillingSentence` already uses (now shared).

- [ ] **Step 5: Run the tests and the guards**

Run: `npx vitest run tests/components/recurring-charges-card.test.tsx tests/ops/client-bundle.test.ts tests/ops/th-scope.test.ts tests/ops/table-layout.test.ts tests/ops/title-only-info.test.ts tests/ops/button-vocabulary.test.ts tests/ops/onboarding-coverage.test.ts tests/ops/transactions-href.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/insights/RecurringMarkForm.tsx src/components/insights/RecurringChargesCard.tsx tests/components/recurring-charges-card.test.tsx
git commit -m "feat(insights): the Recurring charges card in two tiers

- Known recurring and Looks recurring, each saying what it means
- accounts on every row; Account filter as a plain GET form
- Mark recurring, Not recurring, Unmark and Track per row
- forming sentence per band; no verdict words anywhere"
```

**Review focus:**
- Every string on the card passes the wording rule; the old "not a subscription" and "nothing is saved" lines are gone.
- The filter form carries `person` and nothing else hidden; `action="/insights"`.
- Track appears on every uncovered row, Known included; Unmark only where `knownBy === 'mark'`.

---

### Task 6: Needs a look, in full and from both pages (spec §2.1, §2.4)

**Files:**
- Create: `src/lib/insights-links.ts`
- Modify: `src/lib/insights.ts` (`householdInsights` :94-181)
- Modify: `src/components/NeedsALookCard.tsx` (props :37, `CardHeader` :41)
- Modify: `src/app/(app)/dashboard/page.tsx` (import; `<NeedsALookCard>` :690)
- Modify: `src/app/(app)/dashboard/actions.ts` (`dismissInsightAction` :89-104)
- Test: `tests/lib/insights-links.test.ts` (new), `tests/lib/insight-dismissals.test.ts`, `tests/components/needs-a-look.test.tsx`, `tests/app/dashboard.test.tsx`

**Interfaces:**
- Produces (`src/lib/insights-links.ts`, no imports, client-safe): `interface InsightsLinkScope { person: number | null; account: number | null }`; `insightsHref(scope: InsightsLinkScope): string`; `readInsightsParams(params: Record<string, string | string[] | undefined>): InsightsLinkScope`.
- Produces: `householdInsights(input: { today: string; viewer: Viewer; limit?: number | null })` — omitted means `INSIGHTS_MAX_ROWS`, `null` means every finding.
- Produces: `NeedsALookCard({ rows, allHref }: { rows: InsightRow[]; allHref?: string })`.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/insights-links.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { insightsHref, readInsightsParams } from '@/lib/insights-links';

/** Spec 2026-10-05 §2.4. The /insights link and its reader, round-tripped so they cannot drift. */
describe('insightsHref and readInsightsParams', () => {
  const paramsOf = (href: string) => Object.fromEntries(new URL(href, 'http://nas.local').searchParams);

  it('round-trips every shape through its reader', () => {
    for (const scope of [
      { person: null, account: null },
      { person: 7, account: null },
      { person: null, account: 3 },
      { person: 7, account: 3 },
    ]) {
      const href = insightsHref(scope);
      expect(href.startsWith('/insights')).toBe(true);
      expect(readInsightsParams(paramsOf(href))).toEqual(scope);
    }
  });

  it('writes no querystring for the whole household on every account', () => {
    expect(insightsHref({ person: null, account: null })).toBe('/insights');
  });

  it('reads an empty or malformed value as no filter, and the first of a repeated key', () => {
    expect(readInsightsParams({ person: '', account: 'visa' })).toEqual({ person: null, account: null });
    expect(readInsightsParams({ account: ['3', '9'] })).toEqual({ person: null, account: 3 });
  });
});
```

Fails before / passes after: the module does not exist until Step 3.

In `tests/lib/insight-dismissals.test.ts`, inside `describe('dismissing one finding', …)`, append:

```ts
  /** Spec 2026-10-05 §2.1: the Insights page shows the whole list the Dashboard caps. */
  it('returns every finding with limit: null, still without the cleared ones', async () => {
    await seed();
    withHistory();
    for (let n = 1; n <= 20; n += 1) {
      spend('2026-08-20', `SHOP ${n}`, 6500);
      spend('2026-08-20', `SHOP ${n}`, 6500);
    }
    const all = householdInsights({ today: TODAY, viewer: adult(), limit: null });
    expect(all.length).toBeGreaterThan(INSIGHTS_MAX_ROWS);
    dismissInsight({ key: all[0]!.key, on: TODAY });
    const after = householdInsights({ today: TODAY, viewer: adult(), limit: null });
    expect(after).toHaveLength(all.length - 1);
    expect(householdInsights({ today: TODAY, viewer: adult() })).toHaveLength(INSIGHTS_MAX_ROWS);
  });
```

Fails before / passes after: `limit` is ignored and the list is always cut at 8, until Step 3.

In `tests/components/needs-a-look.test.tsx`, append:

```ts
  /** Spec 2026-10-05 §2.1: the Dashboard's card links to the full list on Insights. */
  it('links to every insight when the page passes allHref', () => {
    render(<NeedsALookCard rows={[row()]} allHref="/insights?person=7" />);
    expect(screen.getByRole('link', { name: 'All insights' }).getAttribute('href')).toBe('/insights?person=7');
  });
```

Fails before / passes after: the card ignores the prop until Step 3. (The existing `getByRole('link')` cases render without `allHref`, so they still find one link.)

In `tests/app/dashboard.test.tsx`: add `addDaysIso` to the `@/lib/dates` import and `import { revalidatePath } from 'next/cache';` after the `vi.mock('next/cache', …)` block. In `'clears a finding about the viewer own charge'`, call `vi.mocked(revalidatePath).mockClear();` before invoking the action and add at the end:

```ts
    // Spec 2026-10-05 §2.1: the same finding is on Insights too.
    expect(vi.mocked(revalidatePath).mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(['/dashboard', '/insights']));
```

Fails before / passes after: the action revalidates only `/dashboard` until Step 3. Then append a describe block:

```ts
/** Spec 2026-10-05 §2.1. The Dashboard keeps its short Needs a look, and links to the rest. */
describe('DashboardPage — Needs a look links to Insights', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('links the card to every insight, carrying the person pill', async () => {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const accountId = createAccount({ name: 'Everyday Chequing', type: 'chequing', ownerUserId: adult.id });
    const today = todayIso();
    const spend = (date: string, description: string, cents: number) =>
      createManualTransaction({ accountId, date, description, amountCents: -cents, categoryId: null, attributedUserId: adult.id, userId: adult.id, actorRole: 'admin' });
    // History first, or there is no baseline and the card hides itself.
    spend(addDaysIso(today, -90), 'CEDAR PHONE CO', 6200);
    spend(today, 'HARBOUR INSURANCE', 13400);
    spend(today, 'HARBOUR INSURANCE', 13400);
    currentUser.value = { id: adult.id, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };

    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({ person: String(adult.id) }) }));
    expect(screen.getByRole('link', { name: 'All insights' }).getAttribute('href')).toBe(`/insights?person=${adult.id}`);
  });
});
```

Fails before / passes after: the Dashboard renders no such link until Step 3.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/lib/insights-links.test.ts tests/lib/insight-dismissals.test.ts tests/components/needs-a-look.test.tsx tests/app/dashboard.test.tsx`
Expected: `Failed to resolve import "@/lib/insights-links"`; `expected 8 to be greater than 8`; `Unable to find an accessible element with the role "link" and name "All insights"` (twice); the dismiss case's `arrayContaining` fails on `'/insights'`.

- [ ] **Step 3: Implement**

Create `src/lib/insights-links.ts`:

```ts
/**
 * Spec 2026-10-05 §2.4. The one builder of an /insights link and the one reader of its params. A
 * link that drops `person` answers a different question than the figure it came from -- the rule
 * transactionsHref (src/lib/transaction-links.ts) enforces for /transactions. No imports, so a
 * client component and a server page can both use it (tests/ops/client-bundle.test.ts).
 */
export interface InsightsLinkScope {
  /** The person scope, a user id; null is the whole household. A self viewer's own scope still wins server-side. */
  person: number | null;
  /** The Account filter; null is every account. */
  account: number | null;
}

export function insightsHref(scope: InsightsLinkScope): string {
  const params = new URLSearchParams();
  if (scope.person !== null) params.set('person', String(scope.person));
  if (scope.account !== null) params.set('account', String(scope.account));
  const query = params.toString();
  return query === '' ? '/insights' : `/insights?${query}`;
}

/** Digits or nothing, the way the Dashboard reads ?person=: a malformed value is no filter, never an error. */
export function readInsightsParams(params: Record<string, string | string[] | undefined>): InsightsLinkScope {
  const one = (key: string): string => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) ?? '';
  };
  const id = (raw: string): number | null => (/^\d+$/.test(raw) ? Number(raw) : null);
  return { person: id(one('person')), account: id(one('account')) };
}
```

In `src/lib/insights.ts`, `householdInsights`' input gains:

```ts
  /**
   * Spec 2026-10-05 §2.1. How many rows: INSIGHTS_MAX_ROWS when omitted (the Dashboard card),
   * null for every finding (the Insights page).
   */
  limit?: number | null;
```

and the last line becomes:

```ts
  const kept = rows.filter((row) => !dismissed.has(row.key));
  const limit = input.limit === undefined ? INSIGHTS_MAX_ROWS : input.limit;
  return limit === null ? kept : kept.slice(0, limit);
```

Update the function's one-line docblock (`Newest-first, up to INSIGHTS_MAX_ROWS` → `Newest-first, up to \`limit\` rows`).

In `src/components/NeedsALookCard.tsx`, the signature becomes:

```tsx
export function NeedsALookCard({
  rows,
  /** Spec 2026-10-05 §2.1: the Dashboard's link to the full list on Insights. Insights itself passes none. */
  allHref,
}: {
  rows: InsightRow[];
  allHref?: string;
}) {
```

and the `CardHeader` gains:

```tsx
        action={
          allHref === undefined ? undefined : (
            <Link href={allHref} className="text-sm font-medium text-accent-text">
              All insights
            </Link>
          )
        }
```

In `src/app/(app)/dashboard/page.tsx`: `import { insightsHref } from '@/lib/insights-links';` and render

```tsx
          <NeedsALookCard
            rows={insights}
            // Spec 2026-10-05 §2.1. Carries the person pill, as every other link on this page does.
            allHref={insightsHref({ person: selfScoped ? null : scopeUserId, account: null })}
          />
```

In `src/app/(app)/dashboard/actions.ts` `dismissInsightAction`, after `revalidatePath('/dashboard');` add `revalidatePath('/insights'); // Spec 2026-10-05 §2.1: the full list lives there.`

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/lib/insights-links.test.ts tests/lib/insight-dismissals.test.ts tests/lib/insights.test.ts tests/components/needs-a-look.test.tsx tests/app/dashboard.test.tsx tests/ops/client-bundle.test.ts tests/ops/visibility-invariants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/insights-links.ts src/lib/insights.ts src/components/NeedsALookCard.tsx "src/app/(app)/dashboard/page.tsx" "src/app/(app)/dashboard/actions.ts" tests/lib/insights-links.test.ts tests/lib/insight-dismissals.test.ts tests/components/needs-a-look.test.tsx tests/app/dashboard.test.tsx
git commit -m "feat(insights): Needs a look in full, linked from the Dashboard

- householdInsights takes a limit; null is every finding
- All insights link on the Dashboard card, carrying the person pill
- That's fine revalidates both pages
- insightsHref / readInsightsParams, round-tripped"
```

**Review focus:**
- Omitting `limit` keeps today's Dashboard behaviour byte-for-byte.
- `insightsHref` is the only place an `/insights?` querystring is built.

---

### Task 7: The Insights route, the nav entry and the help section (spec §2.1, §2.4, §2.6)

**Files:**
- Create: `src/app/(app)/insights/page.tsx`, `src/app/(app)/insights/insights-client.tsx`, `src/app/(app)/insights/loading.tsx`
- Modify: `src/components/icons.tsx` (new `InsightsIcon` in the Navigation block, after `ReportsIcon` :115)
- Modify: `src/components/app-shell/nav.ts` (`NAV` :62-89 and its docblock :47-61)
- Modify: `src/app/(app)/help/content.tsx` (new section after `reports` :519; the header docblock :25-27; Settings `Where` :550; one Dashboard sentence :149)
- Modify: `README.md` (feature list :180), `scripts/smoke-routes.mjs` (`DEFAULT_PAGES` :29-36)
- Test: `tests/app/insights-page.test.tsx` (new), `tests/components/nav.test.ts`, `tests/app/help.test.tsx`, `tests/app/loading-skeletons.test.tsx`

**Interfaces:**
- Consumes: `recurringCharges` (Task 2), `RecurringChargesCard` (Task 5), `householdInsights` with `limit`, `NeedsALookCard`, `readInsightsParams`, `insightsHref` (Task 6).
- Produces: `InsightsClient({ recurring: RecurringCharges; findings: InsightRow[]; accounts: RecurringAccount[]; accountId: number | null; person: number | null; personName: string | null })` (`'use client'`); default-exported `InsightsPage` and `InsightsLoading`; `InsightsIcon(props: IconProps)`.

- [ ] **Step 1: Write the failing tests**

In `tests/components/nav.test.ts`: in `'a self viewer loses Import, Review and Settings and keeps the rest'` the list becomes `'/dashboard', '/transactions', '/budgets', '/goals', '/warranties', '/reports', '/insights', '/help'`; in `'puts the planning surfaces under the second label, in NAV order'` it becomes `'/budgets', '/goals', '/warranties', '/reports', '/insights'`.
Fails before / passes after: NAV has no `/insights` until Step 3.

In `tests/app/help.test.tsx`: add `'/insights': 'insights',` to `SECTION_FOR_HREF` (and change "nine"/"tenth" in its comment to "ten"/"eleventh"), then append:

```ts
/** Spec 2026-10-05 §2.6. The Insights section: tiers, marks, the account filter, and a new ledger. */
describe('the help page explains Insights', () => {
  it('names both tiers, the marks, the account filter and the forming count', () => {
    const text = textOf(section('insights').body);
    for (const needle of ['Known recurring', 'Looks recurring', 'Mark recurring', 'Not recurring', 'Unmark', 'Account', 'replaced', 'One more charge']) {
      expect(text, needle).toContain(needle);
    }
  });

  it('obeys the wording rule', () => {
    expect(textOf(section('insights').body)).not.toMatch(/subscription|wasted|forgotten|cancel/i);
  });
});
```

Fails before / passes after: `no help section with id "insights"` until Step 4.

In `tests/app/loading-skeletons.test.tsx`: `import InsightsLoading from '@/app/(app)/insights/loading';` and add

```ts
  it('Insights announces itself and draws placeholder bars', () => {
    const { container } = render(<InsightsLoading />);
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
```

Fails before / passes after: the module does not exist until Step 3.

Create `tests/app/insights-page.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import { setRecurringMarks } from '@/lib/categorize/rules';
import { addDaysIso, todayIso } from '@/lib/dates';
import { INSIGHTS_MAX_ROWS } from '@/lib/insights';
import { createManualTransaction } from '@/lib/transactions';
import { createTestDb, type TestDb } from '../helpers/db';

/**
 * Spec 2026-10-05 §2.1–§2.4. The real page against a real database. Dates are relative to today
 * because the page reads the clock; a rhythm is days apart, so no month boundary is involved.
 */
const currentUser = vi.hoisted(() => ({
  value: { id: 0, name: '', username: '', role: 'admin' as 'admin' | 'member', visibility: 'household' as 'household' | 'self' },
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: async () => currentUser.value }));

afterEach(cleanup);

describe('InsightsPage', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const today = todayIso();

  async function seed() {
    t = createTestDb();
    const adult = await createUser({ name: 'Alex', username: 'alex', password: 'correct horse battery', role: 'admin' });
    const child = await createUser({ name: 'Robin', username: 'robin', password: 'correct horse battery', role: 'member' });
    const chequing = createAccount({ name: 'Everyday Chequing', type: 'chequing', ownerUserId: adult.id });
    const visa = createAccount({ name: 'Travel Visa', type: 'credit', ownerUserId: adult.id });
    const spend = (input: { merchant: string; daysAgo: number; cents: number; person: number; accountId?: number }) =>
      createManualTransaction({
        accountId: input.accountId ?? chequing,
        date: addDaysIso(today, -input.daysAgo),
        description: input.merchant,
        amountCents: -input.cents,
        categoryId: null,
        attributedUserId: input.person,
        userId: adult.id,
        actorRole: 'admin',
      });
    const monthly = (merchant: string, person: number, accountId?: number) => {
      for (const daysAgo of [63, 33, 3]) spend({ merchant, daysAgo, cents: 1349, person, accountId });
    };
    return { adult: adult.id, child: child.id, chequing, visa, spend, monthly };
  }

  async function renderPage(searchParams: Record<string, string> = {}) {
    const { default: InsightsPage } = await import('@/app/(app)/insights/page');
    return render(await InsightsPage({ searchParams: Promise.resolve(searchParams) }));
  }

  it('renders the guide, both tiers and a marked merchant under Known recurring', async () => {
    const s = await seed();
    s.monthly('MAPLE STREAMING', s.adult);
    s.spend({ merchant: 'RIVERSIDE GYM', daysAgo: 4, cents: 4500, person: s.adult });
    setRecurringMarks({ merchants: ['RIVERSIDE GYM'], mark: 'recurring', userId: s.adult, actorRole: 'admin' });
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const { container } = await renderPage();
    expect(container.textContent).toContain('What is this page for?');
    expect(screen.getByRole('heading', { name: 'Known recurring' })).toBeTruthy();
    expect(container.textContent).toContain('RIVERSIDE GYM');
    expect(container.textContent).toContain('MAPLE STREAMING');
  });

  /** Review Focus 3. */
  it('a self viewer sees only their own charges, whatever ?person= says', async () => {
    const s = await seed();
    s.monthly('MAPLE STREAMING', s.adult);
    s.monthly('CEDAR PHONE CO', s.child);
    currentUser.value = { id: s.child, name: 'Robin', username: 'robin', role: 'member', visibility: 'self' };
    const { container } = await renderPage({ person: String(s.adult) });
    expect(container.textContent).toContain('CEDAR PHONE CO');
    expect(container.textContent).not.toContain('MAPLE STREAMING');
  });

  it('filters to the account in ?account= and keeps the choice selected', async () => {
    const s = await seed();
    s.monthly('MAPLE STREAMING', s.adult);
    s.monthly('HARBOUR INSURANCE', s.adult, s.visa);
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const { container } = await renderPage({ account: String(s.visa) });
    expect(container.textContent).toContain('HARBOUR INSURANCE');
    expect(container.textContent).not.toContain('MAPLE STREAMING');
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe(String(s.visa));
  });

  /** Review Focus 3. */
  it('ignores an account the viewer cannot see', async () => {
    const s = await seed();
    s.monthly('CEDAR PHONE CO', s.child);
    currentUser.value = { id: s.child, name: 'Robin', username: 'robin', role: 'member', visibility: 'self' };
    const { container } = await renderPage({ account: String(s.visa) });
    expect(container.textContent).toContain('CEDAR PHONE CO');
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('');
  });

  it('says whose charges a household viewer is looking at, with the way back', async () => {
    const s = await seed();
    s.monthly('CEDAR PHONE CO', s.child);
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const { container } = await renderPage({ person: String(s.child) });
    expect(container.textContent).toMatch(/Recurring charges here are Robin/);
    expect(screen.getByRole('link', { name: 'Show the whole household' }).getAttribute('href')).toBe('/insights');
  });

  it('shows every Needs a look finding, past the Dashboard cap', async () => {
    const s = await seed();
    s.spend({ merchant: 'LAKESIDE DOMAIN', daysAgo: 90, cents: 2400, person: s.adult });
    for (let n = 1; n <= INSIGHTS_MAX_ROWS + 2; n += 1) {
      s.spend({ merchant: `SHOP ${n}`, daysAgo: 1, cents: 6500, person: s.adult });
      s.spend({ merchant: `SHOP ${n}`, daysAgo: 1, cents: 6500, person: s.adult });
    }
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    await renderPage();
    expect(screen.getAllByRole('button', { name: /as fine and take it off this card/ })).toHaveLength(INSIGHTS_MAX_ROWS + 2);
  });
});
```

Fails before / passes after: `@/app/(app)/insights/page` does not exist until Step 3.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/components/nav.test.ts tests/app/help.test.tsx tests/app/loading-skeletons.test.tsx tests/app/insights-page.test.tsx`
Expected: nav — array mismatch missing `'/insights'`; help — `no help section with id "insights"`; loading and page — `Failed to resolve import "@/app/(app)/insights/…"`.

- [ ] **Step 3: The route, the icon and the nav entry**

`src/components/icons.tsx`, after `ReportsIcon`:

```tsx
export function InsightsIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3Z" />
    </Glyph>
  );
}
```

`src/components/app-shell/nav.ts`: import `InsightsIcon`; after the Reports entry add `{ href: '/insights', label: 'Insights', Icon: InsightsIcon, group: 'planning' },` with the comment `// Spec 2026-10-05 §2.1: what the ledger shows arriving on a rhythm, and the charges that stand out.`; in the `NAV` docblock change "Ten entries, and only the first nine are a sequence" to "Eleven entries, and only the first ten are a sequence".

`src/app/(app)/insights/loading.tsx` (no `notFound()` anywhere under `/insights`, so `tests/ops/loading-boundaries.test.ts` stays green):

```tsx
import { Card, CardBody } from '@/components/ui/Card';

/** Spec 2026-10-05 §2.1. The recurring read model scans about three years of charges; a skeleton says the page is coming. */
export default function InsightsLoading() {
  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <p role="status" className="sr-only">
        Loading insights…
      </p>
      {[0, 1].map((card) => (
        <Card key={card}>
          <CardBody className="flex flex-col gap-3 py-8">
            <span className="h-4 w-40 motion-keep animate-pulse rounded bg-surface-2" />
            <span className="h-32 w-full motion-keep animate-pulse rounded bg-surface-2" />
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
```

`src/app/(app)/insights/insights-client.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { NeedsALookCard } from '@/components/NeedsALookCard';
import { RecurringChargesCard } from '@/components/insights/RecurringChargesCard';
import { Card, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import type { InsightRow } from '@/lib/insights';
import { insightsHref } from '@/lib/insights-links';
import type { RecurringAccount, RecurringCharges } from '@/lib/recurring';

/**
 * Spec 2026-10-05 §2.1. Recurring charges, then the full Needs a look list. Plain data in, nothing
 * fetched here; page.tsx resolved the scope and the filter.
 */
export function InsightsClient({
  recurring,
  findings,
  accounts,
  accountId,
  person,
  personName,
}: {
  recurring: RecurringCharges;
  findings: InsightRow[];
  accounts: RecurringAccount[];
  accountId: number | null;
  person: number | null;
  /** Set only when a household viewer narrowed the page to one person, so the narrowing is stated. */
  personName: string | null;
}) {
  return (
    <div data-page-width="wide" className="flex flex-col gap-4 sm:gap-5">
      <PageHeader title="Insights" description="What the ledger shows arriving on a rhythm, and the charges that stand out." />

      <PageGuide>
        <p>
          Two lists, both worked out from your own transactions. <strong className="font-semibold text-ink">Recurring charges</strong>{' '}
          lists the merchants that bill you on a rhythm and the accounts they charge. Pick a card under{' '}
          <strong className="font-semibold text-ink">Account</strong> to see everything that bills it — the list to work
          through when a card is replaced.
        </p>
        <p>
          <strong className="font-semibold text-ink">Known recurring</strong> is what you said: a merchant you marked, or one an
          item on Loans &amp; Coverage covers. <strong className="font-semibold text-ink">Looks recurring</strong> is what the
          dates show, and a rhythm is not a verdict. A new ledger shows little here for its first few months, because a
          rhythm takes three charges.
        </p>
        <p>
          <strong className="font-semibold text-ink">Needs a look</strong> is every charge that stands out, not just the few the
          Dashboard shows.
        </p>
      </PageGuide>

      {personName === null ? null : (
        <Notice tone="info">
          Recurring charges here are {personName}&rsquo;s.{' '}
          <Link href={insightsHref({ person: null, account: accountId })} className="font-medium text-accent-text underline underline-offset-2">
            Show the whole household
          </Link>
        </Notice>
      )}

      <RecurringChargesCard result={recurring} person={person} accounts={accounts} accountId={accountId} />

      {findings.length === 0 ? (
        <Card>
          <CardHeader
            title="Needs a look"
            description="Nothing stands out right now. Unusually large, doubled and raised charges show here once there is about two months of history to compare against."
          />
        </Card>
      ) : (
        <NeedsALookCard rows={findings} />
      )}
    </div>
  );
}
```

`src/app/(app)/insights/page.tsx`:

```tsx
import { acceptsTransactions, listAccounts } from '@/lib/accounts';
import { requireUser } from '@/lib/auth/session';
import { findUserById } from '@/lib/auth/users';
import { isSelfScoped, ownerScope } from '@/lib/auth/viewer';
import { todayIso } from '@/lib/dates';
import { householdInsights } from '@/lib/insights';
import { readInsightsParams } from '@/lib/insights-links';
import { recurringCharges } from '@/lib/recurring';
import { InsightsClient } from './insights-client';

export const dynamic = 'force-dynamic';

/**
 * Spec 2026-10-05 §2.1, §2.4. Two read models, nothing stored. The person scope follows ruling R2's
 * S-01 order -- a self viewer's own scope wins over whatever ?person= asks -- and the Account
 * filter accepts only an account the viewer can see; anything else reads as every account.
 */
export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireUser();
  const asked = readInsightsParams(await searchParams);
  const today = todayIso();
  const person = ownerScope(viewer) ?? asked.person;
  const accounts = listAccounts({}, viewer)
    .filter((account) => acceptsTransactions(account.type))
    .map((account) => ({ id: account.id, name: account.name }));
  const accountId = asked.account !== null && accounts.some((account) => account.id === asked.account) ? asked.account : null;
  const recurring = recurringCharges({ today, ownerUserId: person, viewer, accountId });
  // The full list: the Dashboard's card is the capped summary of this one.
  const findings = householdInsights({ today, viewer, limit: null });
  const personName = isSelfScoped(viewer) || person === null ? null : (findUserById(person)?.name ?? null);
  return (
    <InsightsClient
      recurring={recurring}
      findings={findings}
      accounts={accounts}
      accountId={accountId}
      person={person}
      personName={personName}
    />
  );
}
```

`scripts/smoke-routes.mjs`: add `'/insights',` after `'/reports',` in `DEFAULT_PAGES`, and change the comment's `28 page routes` to `29 page routes`.

- [ ] **Step 4: The help section and the README line**

In `src/app/(app)/help/content.tsx`, insert after the `reports` section:

```tsx
  {
    id: 'insights',
    title: 'Insights',
    body: (
      <>
        <Where path="/insights">under Planning in the menu, after Reports —</Where>
        <P>
          Two lists the app works out from your own transactions. <B>Recurring charges</B> lists the merchants that bill
          you on a rhythm, and <B>Needs a look</B> lists every charge that stands out — the same findings the Dashboard
          shows a few of, all of them here, each with its own <B>That&rsquo;s fine</B>.
        </P>
        <P>
          <B>Known recurring</B> is what you have said: a merchant you marked, or one that an item or a payment rule on
          Loans &amp; Coverage already covers. A merchant you marked stays on the list after a single charge, because
          your word is the evidence. <B>Looks recurring</B> is what the dates show: three or more charges about a month
          or a year apart, the newest one recent. A rhythm is a measurement, not a verdict — a once-a-month shop makes
          the same dates as a bill.
        </P>
        <P>
          <B>Mark recurring</B> moves a merchant from Looks recurring to Known recurring; <B>Not recurring</B> takes it off
          both lists and keeps it off. Both are on the card and in each row&rsquo;s menu on Transactions, and{' '}
          <B>Mark recurring</B> is in the bar that appears when you select rows. <B>Unmark</B> undoes a mark. A merchant
          marked Not recurring comes back from its row menu on Transactions; an admin also sees every mark under{' '}
          <B>Settings → Merchant rules</B>.
        </P>
        <P>
          Every row names the accounts the merchant charged. When a card is <B>replaced</B>, pick it under{' '}
          <B>Account</B>: Known recurring then lists every merchant that needs the new number. The choice is part of
          the page address, so the filtered list can be bookmarked or sent to someone else in the household.
        </P>
        <P>
          A new ledger shows little here for its first few months, because a rhythm takes three charges. Until then the
          card counts the merchants that have charged twice about a month or a year apart. One more charge and they
          appear on the list.
        </P>
      </>
    ),
  },
```

Also in that file: the header docblock's "greps this file for those nine literals: ship a tenth section" becomes "ten literals: ship an eleventh section"; the Settings `Where` changes `ninth in the menu` to `tenth in the menu`; and the Dashboard section's Needs a look paragraph gains, before its last sentence: `<B>All insights</B> opens the whole list on Insights.`

In `README.md`, after item 7 (Reports) add:

```markdown
8. **Insights**, the merchants that bill you on a rhythm and the accounts they charge, filterable by
   card, plus every charge that stands out.
```

- [ ] **Step 5: Run the tests and the guards**

Run: `npx vitest run tests/components/nav.test.ts tests/components/AppShell.test.tsx tests/app/help.test.tsx tests/app/loading-skeletons.test.tsx tests/app/insights-page.test.tsx tests/ops/onboarding-coverage.test.ts tests/ops/client-bundle.test.ts tests/ops/loading-boundaries.test.ts tests/ops/visibility-invariants.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/insights/page.tsx" "src/app/(app)/insights/insights-client.tsx" "src/app/(app)/insights/loading.tsx" src/components/icons.tsx src/components/app-shell/nav.ts "src/app/(app)/help/content.tsx" README.md scripts/smoke-routes.mjs tests/app/insights-page.test.tsx tests/components/nav.test.ts tests/app/help.test.tsx tests/app/loading-skeletons.test.tsx
git commit -m "feat(insights): the Insights page

- /insights after Reports: Recurring charges and the full Needs a look
- person scope per ruling R2; Account filter limited to visible accounts
- help section, README line, smoke route"
```

**Review focus:**
- `page.tsx` value-imports nothing but `InsightsClient` from the client module; helpers come from `insights-links.ts`.
- A household viewer narrowed by `?person=` is told so on the page.
- The help section passes the wording rule and documents `/insights` as a whole path segment.

---

> **REVIEW CHECKPOINT 2 (Opus, whole branch).** Review Tasks 1–7 against the spec end to end, including the wording rule on every new string, the guard updates, and the Review Focus list above. Run `npx tsc --noEmit`. Fix before Task 8.

---

### Task 8: Release v1.54.0

**Files:**
- Modify: `tests/ops/docker.test.ts` (`'MUST-7.1: the 1.53.1 release'` :477-491 and every `toBe('1.53.1')`), `CHANGELOG.md`, `package.json`, `package-lock.json`

- [ ] **Step 1: Update the release guard first**

Replace `it('MUST-7.1: the 1.53.1 release', …)` with:

```ts
  it('MUST-7.1: the 1.54.0 release', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).toBe('1.54.0');
    const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };
    expect(lock.version).toBe('1.54.0');
    expect(lock.packages[''].version).toBe('1.54.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.54\.0\] - \d{4}-\d{2}-\d{2}$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.54.0]'));
    expect(changelog.indexOf('## [1.54.0]')).toBeLessThan(changelog.indexOf('## [1.53.1]'));
    const current = changelog.slice(changelog.indexOf('## [1.54.0]'), changelog.indexOf('## [1.53.1]'));
    expect(current).toMatch(/Insights/);
    expect(current).toMatch(/Known recurring/);
    expect(current).toMatch(/Mark recurring/);
    expect(current).not.toMatch(/subscription|wasted|forgotten|cancel/i);
  });

  it('MUST-7.1: the 1.53.1 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.53\.1\] - 2026-10-01$/m);
    expect(changelog.indexOf('## [1.53.1]')).toBeLessThan(changelog.indexOf('## [1.53.0]'));
    const current = changelog.slice(changelog.indexOf('## [1.53.1]'), changelog.indexOf('## [1.53.0]'));
    expect(current).toMatch(/Take a photo/);
    expect(current).toMatch(/Choose a file/);
    expect(current).toMatch(/Other figures/);
  });
```

Then change every remaining `toBe('1.53.1')` to `toBe('1.54.0')`. Check: `grep -c "toBe('1.53.1')" tests/ops/docker.test.ts` → `0`; `grep -c "toBe('1.54.0')" tests/ops/docker.test.ts` → `24`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ops/docker.test.ts`
Expected: FAIL — `expected '1.53.1' to be '1.54.0'` across the version pins, and no `## [1.54.0]` heading.

- [ ] **Step 3: Write the changelog and bump the version**

`CHANGELOG.md`, under a fresh empty `## Unreleased` (replace `YYYY-MM-DD` with the output of `date +%F`):

```markdown
## [1.54.0] - YYYY-MM-DD

### Added

- **An Insights page**, under Planning after Reports. It holds **Recurring charges**, moved here from
  Loans & Coverage, and the whole **Needs a look** list; the Dashboard keeps its short version and
  links to the rest with **All insights**.
- **Known recurring and Looks recurring.** Recurring charges is now two lists: merchants you marked
  or already track, and merchants whose charges show a monthly or yearly rhythm. A merchant you
  marked stays on the list after a single charge. Each row names the accounts the merchant charged.
- **Mark recurring and Not recurring**, on the Insights card and in each Transactions row menu, with
  **Mark recurring** in the bulk bar too. A mark is saved as a rule on the merchant; **Unmark** takes
  it off, and an admin sees every mark under Settings → Merchant rules.
- **An Account filter on Recurring charges.** Pick a card to list every merchant that charged it —
  the list to work through when a card is replaced. The choice is part of the page address.
- While a ledger is new, the card counts the merchants that have charged twice about a month or a
  year apart, so an empty list says what it is waiting for.

### Changed

- Loans & Coverage no longer shows Recurring charges; one line points to Insights.
```

`package.json` and `package-lock.json` (both `"version"` fields near the top of the lock file): `1.53.1` → `1.54.0`.

Run: `npx vitest run tests/ops/docker.test.ts` — expected PASS.

- [ ] **Step 4: The release gate**

```bash
npx vitest run --no-file-parallelism
npx tsc --noEmit
rm -rf .next && npm run build
npm run smoke
```

Expected: all green (a lone `Timeout calling "onTaskUpdate"` failure is the known flake — rerun that file alone); tsc no errors; build exit 0; smoke reports every check passed, `/insights` included.

- [ ] **Step 5: Commit and push main**

```bash
git add CHANGELOG.md package.json package-lock.json tests/ops/docker.test.ts
git commit -m "chore(release): v1.54.0

- Insights page: Recurring charges in two tiers, full Needs a look
- recurring marks from Transactions and Insights; account filter"
git push origin main
```

On a 403, `gh auth switch` and push again.

- [ ] **Step 6: Wait for the Test suite workflow**

```bash
gh run list --workflow test.yml --limit 3
gh run watch <id of the run for this commit> --exit-status
```

Expected: `Test suite` completes successfully. Do not tag until it does.

- [ ] **Step 7: Tag and watch the Release image**

```bash
git tag -a v1.54.0 -m "v1.54.0"
git push origin v1.54.0
gh run list --workflow release-image.yml --limit 3
gh run watch <id of the v1.54.0 run> --exit-status
```

Expected: `Release image` for `v1.54.0` completes successfully.

**Review focus:**
- The CHANGELOG entry passes the wording rule (the guard asserts it).
- The 1.53.1 section is untouched and pinned append-only.
