import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/**
 * Ruling R2 / item AF. The reader boundary is six modules deep and nothing in the type system says
 * "this function returns other people's money" -- so this is the second, independent guard: every
 * read-model helper a PAGE OR ROUTE calls must take a viewer.
 *
 * Micro-ruling M3: this is a NAMED require-list, not a blanket scan for every exported get-or-list
 * function.
 * Taken literally, a blanket scan pulls in internal resolvers no page ever calls with a user-supplied
 * id, and a guard that fails for a correct reason nobody can act on is a guard people delete. The
 * exempt list below carries the reason for each exemption, and adding to it is a decision somebody
 * has to write down.
 */
const REQUIRE_VIEWER: { file: string; fn: string }[] = [
  { file: 'src/lib/transactions.ts', fn: 'listTransactions' },
  { file: 'src/lib/transactions.ts', fn: 'getTransaction' },
  { file: 'src/lib/accounts.ts', fn: 'listAccounts' },
  { file: 'src/lib/goals.ts', fn: 'listGoals' },
  { file: 'src/lib/goals.ts', fn: 'getGoal' },
  { file: 'src/lib/goals.ts', fn: 'listContributions' },
  { file: 'src/lib/loans.ts', fn: 'listLoans' },
  { file: 'src/lib/warranty/items.ts', fn: 'getWarrantyItem' },
  { file: 'src/lib/warranty/search.ts', fn: 'searchWarrantyItems' },
  { file: 'src/lib/warranty/search.ts', fn: 'expiringSoonItems' },
  { file: 'src/lib/reports.ts', fn: 'categoryBreakdown' },
  { file: 'src/lib/reports.ts', fn: 'cashflowTrend' },
  { file: 'src/lib/reports.ts', fn: 'categoryMonthOverMonth' },
  { file: 'src/lib/reports.ts', fn: 'categoryYearOverYear' },
  { file: 'src/lib/reports.ts', fn: 'personSpendSplit' },
  { file: 'src/lib/reports.ts', fn: 'topMerchants' },
  { file: 'src/lib/reports.ts', fn: 'transactionsCsv' },
  { file: 'src/lib/bills.ts', fn: 'upcomingBills' },
  { file: 'src/lib/bills.ts', fn: 'safeToSpend' },
  { file: 'src/lib/bills.ts', fn: 'sinkingFundsFor' },
  { file: 'src/lib/insights.ts', fn: 'householdInsights' },
  { file: 'src/lib/networth.ts', fn: 'latestSnapshots' },
  { file: 'src/lib/networth.ts', fn: 'netWorthOverTime' },
  // Addendum A: a WRITER, not a read model -- it is listed here for the one guarantee this list
  // mechanically asserts, that the viewer parameter exists and is never optional. That is what
  // stops a future caller compiling a create that skips the owner rules (rulings A10, A12).
  { file: 'src/lib/loans.ts', fn: 'createLoanFromTransaction' },
  // Controller ruling R11 (task-3, S-01). categoryTransactionsAction posted the caller's own
  // scope/userId straight through with no owner narrowing of any kind, so a self-scoped member
  // asking for `scope: 'household'` (or for another member by id) read every household
  // transaction -- merchant, date, amountCents -- in that category. Fixed the same way
  // listTransactions is: append eq(transactions.attributedUserId, ownerScope(viewer)) AFTER the
  // caller's own attributedUserId clause, never instead of it.
  { file: 'src/lib/budgets.ts', fn: 'categoryTransactions' },
];

/** Exempt, WITH the reason. Nothing is exempt without one. */
const EXEMPT: { file: string; fn: string; why: string }[] = [
  {
    file: 'src/lib/accounts.ts',
    fn: 'getAccount',
    why: 'internal resolver: createManualTransaction, commitImport and commitStagedImport call it with an id they produced themselves and have no viewer to pass. No page or route resolves a user-supplied account id through it.',
  },
  {
    file: 'src/lib/warranty/items.ts',
    fn: 'getWarrantyReceipt',
    why: 'internal resolver: warranties/actions.ts (deleteReceiptAction, reRunOcrAction) and api/warranties/receipts/[id]/route.ts use it only to find the receipt\'s parent item id, then check canActOnOwner(getWarrantyItem(item.id, viewer)) before acting on or returning it.',
  },
  {
    file: 'src/lib/warranty/items.ts',
    fn: 'listWarrantyReceipts',
    why: 'internal resolver: warranties/[id]/page.tsx calls it only with item.id after getWarrantyItem(id, viewer) already returned non-null for this viewer, so the id it receives was already viewer-checked.',
  },
  {
    file: 'src/lib/loans.ts',
    fn: 'listLoanRules',
    why: 'internal resolver: warranties/[id]/page.tsx and warranties/actions.ts call it only with item.id after getWarrantyItem(id, viewer) already confirmed the viewer may see this item.',
  },
  {
    file: 'src/lib/transactions.ts',
    fn: 'transactionOwners',
    why: 'not a read-model: returns transaction id and attributed_user_id only -- no amount, no description, no merchant, no joins. It exists so the bulk ownership pre-check in transactions/actions.ts costs one query instead of one getTransaction per selected id, and its callers compare the owners it returns against ownerScope(viewer) themselves before any write (item BL, v1.13.1).',
  },
  {
    file: 'src/lib/budgets.ts',
    fn: 'categorySpend',
    why: "internal resolver, investigated for task-3 (S-01) alongside categoryTransactions above. Its only caller is budgetProgress (this file), which has no viewer of its own -- so the real question is whether any caller of budgetProgress ever hands it a raw, user-supplied id. task-3 fix round 1 (Important 2): the true invariant is narrower than 'nothing user-supplied reaches it' -- a user-supplied id DOES reach it, but only when ownerScope(viewer) is null, i.e. a viewer already entitled to any member's figures, because `??` makes a non-null ownerScope win. dashboard/page.tsx's `scopeUserId = ownerScope(viewer) ?? urlScope` (from `?person=`) and bills.ts's safeToSpend both resolve ownerScope FIRST, so a self-scoped viewer can never steer either through the URL or a form value -- only a household-visibility viewer or an admin (ownerScope null) ever lets the user-supplied value through, and both are already entitled to any member's figures. budgets/page.tsx's personal loop runs only over listAttributablePeople() already filtered to the viewer's own id for a self-scoped viewer. The remaining callers -- notify/evaluate/budget.ts, pace.ts, monthly.ts and digest.ts -- are server-side notification evaluators with no request at all: they loop over member ids the evaluator itself derived from the household roster, never a value read from a URL or form.",
  },
  {
    file: 'src/lib/budgets.ts',
    fn: 'categorySpendWithRollupSeries',
    why: "internal resolver, no viewer of its own -- investigated for task-3 (S-01) alongside categoryTransactions above, and exported for F-06 (2026-09-02 review, v1.31.0). Its first caller is still effectiveBudget (this file), itself called only from buildRow inside budgetProgress: the identical viewer-derived scope/userId chain categorySpend's own exemption above describes. F-06 added a second caller, budgets/category-history-action.ts's six-month history strip, which does NOT lean on that chain -- it receives the client's own scope/userId, unvalidated, the same shape categoryTransactionsAction's task-3 bug had. It carries the gate itself, the same 'no viewer, caller narrows' shape HOUSEHOLD_ONLY_AT_PAGE names for budgetProgress: it resolves ownerScope(viewer) first, and returns an EMPTY history (never a rewrite to the viewer's own scope) the moment a self-scoped, non-admin viewer's request does not already name their own personal scope -- so a household figure or another member's never reaches them, mislabelled as their own card or otherwise.",
  },
];

/**
 * Third named list (v1.13.0 whole-branch review, item M-d). These read-models are, by design,
 * household-wide with NO viewer parameter at all -- unlike REQUIRE_VIEWER's functions, which
 * scope themselves down for a self viewer, the five below have no self-scoped shape to fall back
 * to (see item C1's own fix, src/app/(app)/reports/page.tsx: a self viewer gets NO category
 * baselines, not a household-scoped call run and discarded).
 *
 * The guarantee they carry is different from both REQUIRE_VIEWER and EXEMPT above: the CALLER
 * gates, not the function, because the function structurally cannot -- it has no viewer to refuse
 * with. The list's name is historical (S-18, v1.30.0): pages were the only callers when it was
 * written, and four notification evaluators have since joined them, which is why the rule is
 * stated in terms of callers rather than pages. Two gate shapes satisfy it, and every entry's
 * reason below says which one each caller uses:
 *
 *   1. SKIP THE CALL OUTRIGHT for a self-scoped viewer -- never run it and throw the result away.
 *      Every page caller does this, and so does a notification evaluator whose household read has
 *      no audience (evaluate/pace.ts and evaluate/digest.ts skip theirs when the event is routed
 *      to no family channel).
 *   2. RUN IT, BUT DELIVER IT ONLY TO THE FAMILY CHANNEL. Available to a notification evaluator
 *      alone, and only for a household-eligible event (src/lib/notify/events.ts): enqueue's
 *      familyChannelOnly writes the household row -- user_id NULL, householdTarget(channel), one
 *      message to a room an admin deliberately pointed the household's bot at -- and suppresses
 *      the self-scoped member's own personal copy. Ruling R2 governs what reaches a member's
 *      screen or inbox; it does not govern that room (evaluate/digest.ts's HOUSEHOLD_VIEWER
 *      docblock, v1.28.0 decision 3, has the argument). Gate shape 1 alone was tried first and
 *      was wrong: it removed the family channel's only contributor in a household whose opted-in
 *      members are all self-scoped, silencing a shipped feature while protecting nobody.
 *
 * This list exists so a future caller of one of these is one grep away from the rule it must
 * uphold, and each reason names exactly which callers currently carry that gate, and how.
 */
const HOUSEHOLD_ONLY_AT_PAGE: { file: string; fn: string; why: string }[] = [
  {
    file: 'src/lib/predict/history.ts',
    fn: 'suggestionsFor',
    why: "no viewer parameter at all. budgets/page.tsx and reports/page.tsx both skip the scope: 'household' call OUTRIGHT for a self viewer (item C1) rather than running it and discarding the result -- the same 'no household figure leaves this file, even unrendered' reasoning both pages document inline. Gate shape 1 again in notify/evaluate/monthly.ts, which S-18 added: comparePredicted (called for scope 'household' by firePredictedVsActual) and refreshFor (by fireSuggestedRefresh) are both skipped outright for a self-scoped recipient, so neither a household suggestion figure nor the total derived from it is computed for them, let alone rendered. The two remaining callers, budgets/actions.ts's applySuggestionAction and applySuggestionsAction, are WRITE paths: they resolve scope through their own MUST-7.6 authz check and return only an error or a set/skipped count, never a suggestion figure.",
  },
  {
    file: 'src/lib/tax.ts',
    fn: 'taxYearReport',
    why: 'no viewer parameter at all -- rolls up every household member\'s spend with no owner scoping of its own. reports/page.tsx only calls it when showHouseholdTotals is true, and the Tax year card is dropped entirely (not scoped-to-zero) for a self viewer.',
  },
  {
    file: 'src/lib/tax.ts',
    fn: 'taxYears',
    why: 'no viewer parameter at all -- lists every year with a non-transfer transaction across the whole household. reports/page.tsx only calls it when showHouseholdTotals is true.',
  },
  {
    file: 'src/lib/loans.ts',
    fn: 'debtOverTime',
    why: 'no viewer parameter at all -- sums every loan balance household-wide with no per-owner split. reports/page.tsx only calls it when showHouseholdTotals is true, and the Debt over time card is dropped entirely for a self viewer.',
  },
  // S-18 fix (v1.13.0 ruling R2, review follow-up): added AFTER the fix that makes this `why`
  // true, not before -- an exemption whose stated reason is false is worse than none (this
  // release already had to correct one). budgetProgress is the keystone the two EXEMPT entries
  // above (categorySpend, categorySpendWithRollupSeries) both lean on: it has no viewer of its
  // own, so every caller -- page or notify evaluator -- carries the gate itself.
  {
    file: 'src/lib/budgets.ts',
    fn: 'budgetProgress',
    why: "no viewer parameter at all. Page callers use gate shape 1: budgets/page.tsx and dashboard/page.tsx both skip the household call OUTRIGHT for a self viewer (item C1's own 'no household figure leaves this file, even unrendered' reasoning), and bills.ts's safeToSpend resolves ownerScope(viewer) FIRST and calls budgetProgress(month, 'personal', scope) instead of the household form whenever it is non-null. The four notify evaluators carry the gate one layer down (S-18, this ruling, applied to notifications), each with the shape its own message allows. Shape 2, because budget_threshold/budget_exceeded/budget_pace are household-eligible and their household rows ARE the family channel's message: evaluate/budget.ts and evaluate/pace.ts still fire those rows for a self-scoped participant but pass enqueue's familyChannelOnly, so the row reaches the family channel and never that member's own inbox. Shape 1 wherever there is no family channel to feed or no household-shaped message to send: evaluate/pace.ts and evaluate/digest.ts skip the household read entirely for a self-scoped recipient when the event is routed nowhere; evaluate/digest.ts scopes that recipient's own overBudget line to their personal scope; evaluate/monthly.ts skips its predicted_vs_actual and suggested_budget_refresh household reads outright and substitutes personal scope for the monthly digest's one Budgets line. No household category name, amount or limit reaches a self-scoped recipient through a PER-USER notification on any of these paths.",
  },
];

describe('household-only readers gated at the page (item M-d)', () => {
  for (const { file, fn } of HOUSEHOLD_ONLY_AT_PAGE) {
    it(`${file} :: ${fn} is exported and takes no viewer`, () => {
      const source = read(file);
      const signature = new RegExp(`export function ${fn}\\b[\\s\\S]{0,600}?\\)\\s*:`, 'm').exec(source)?.[0];
      expect(signature, `${fn} is not exported from ${file}`).toBeTruthy();
      // The whole point of this list: if one of these ever GROWS a viewer parameter, it belongs
      // in REQUIRE_VIEWER instead, gated by the function itself rather than by every caller.
      expect(signature).not.toMatch(/viewer\s*:\s*Viewer/);
    });
  }

  it('every entry carries a written reason naming the page that gates it', () => {
    for (const entry of HOUSEHOLD_ONLY_AT_PAGE) expect(entry.why.length).toBeGreaterThan(40);
  });

  // Raised from 4 to 5 (S-18 fix, v1.13.0 ruling R2 review follow-up): budgetProgress joined
  // this list once its own fix landed, so a future deletion of any one of the five now trips
  // this rather than silently going unnoticed.
  it('the list cannot shrink below 5 entries', () => {
    expect(HOUSEHOLD_ONLY_AT_PAGE.length).toBeGreaterThanOrEqual(5);
  });
});

describe('ruling R2: every read-model helper takes a viewer', () => {
  for (const { file, fn } of REQUIRE_VIEWER) {
    it(`${file} :: ${fn}`, () => {
      const source = read(file);
      const signature = new RegExp(`export function ${fn}\\b[\\s\\S]{0,600}?\\)\\s*:`, 'm').exec(source)?.[0];
      expect(signature, `${fn} is not exported from ${file}`).toBeTruthy();
      expect(signature).toMatch(/viewer\s*:\s*Viewer|viewer:\s*Viewer/);
      // Required, not optional: an optional viewer lets a forgotten call site compile into a leak.
      expect(signature).not.toMatch(/viewer\?\s*:/);
      // task-3 fix round 1 (Important 3). `viewer?: Viewer` is not the only way to make a
      // "required" viewer optional in practice -- `viewer: Viewer = SOME_DEFAULT` (or
      // `viewer: Viewer | undefined = undefined`) is syntactically non-optional and passes the
      // two assertions above, but a call site that omits the argument compiles anyway and gets
      // the default, silently reopening the exact leak this list exists to catch. A default is
      // the LIKELIER regression, not the rarer one: it is exactly what someone reaches for when
      // a new call site otherwise fails to compile. Proven by running this against
      // categoryTransactions with a temporarily-defaulted viewer (see task-3-report.md) -- it
      // failed, where the two assertions above did not.
      expect(signature).not.toMatch(/viewer\s*:\s*Viewer[^,)]*=/);
    });
  }

  it('every exemption carries a written reason', () => {
    for (const entry of EXEMPT) expect(entry.why.length).toBeGreaterThan(40);
  });

  // Not a claim that the scanner "found" anything -- there is no scanner, by design (M3). This
  // only checks that the two named lists above have not shrunk: a future edit that quietly
  // deletes entries from REQUIRE_VIEWER/EXEMPT rather than fixing a rotted signature still
  // trips this, even though every remaining named entry would otherwise still pass.
  //
  // v1.13.0 whole-branch review (item M-e): raised from 20 to 27, the actual count as of this
  // review (23 + 4) -- 20 had drifted well below reality and would not have caught a deletion
  // of up to seven real entries.
  //
  // task-3 fix round 1 (Minor 1): raised from 28 to 32, the actual count as of this fix round
  // (25 + 7) -- three entries (categoryTransactions in REQUIRE_VIEWER; categorySpend and
  // categorySpendWithRollupSeries in EXEMPT) were added for task-3 (S-01) while the floor stayed
  // at 28, so up to four real entries could have been deleted silently without tripping this.
  it('the named lists cannot shrink below 32 entries', () => {
    expect(REQUIRE_VIEWER.length + EXEMPT.length).toBeGreaterThanOrEqual(32);
  });
});

describe('ruling R3: the audit log is append-only', () => {
  it('nothing under src/ updates or deletes an audit_log row', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(path.join(root, 'src'));
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const name = path.relative(root, file).replace(/\\/g, '/');
      expect({ name, bad: /\.update\(\s*auditLog\s*\)|\.delete\(\s*auditLog\s*\)/.test(source) })
        .toEqual({ name, bad: false });
    }
  });
});

describe('ruling R1: no tenancy crept in', () => {
  it('no schema column or table is named for a household or tenant id', () => {
    const schema = read('src/db/schema.ts');
    expect(schema).not.toMatch(/household_id|householdId|tenant_id|tenantId/);
    for (const file of fs.readdirSync(path.join(root, 'drizzle')).filter((n) => n.endsWith('.sql'))) {
      expect(read(`drizzle/${file}`)).not.toMatch(/household_id|tenant_id/);
    }
  });
});
