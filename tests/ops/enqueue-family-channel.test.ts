import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Finding I-2 (v1.30.0 whole-branch review). `enqueue`'s `familyChannelOnly` is OPTIONAL and its
 * default is the pre-S-18 behaviour: omit it and the personal row is written, which for a body
 * built from household figures is exactly the delivery ruling R2 exists to prevent. `tsc` cannot
 * see an omission, and `enqueue` cannot derive the flag itself -- it knows the recipient but not
 * whether THIS body carries household figures, and `subjectScope` cannot answer that either, since
 * `weekly_digest` and `coming_due` both default to 'household' with personal-shaped bodies.
 *
 * This is the same failure mode `src/lib/transactions.ts` cites for a required `viewer`, and this
 * release has already had one S-18 sweep miss a call site (`evaluate/savings.ts`) by exactly this
 * kind of invisibility. So: the named list below, in the discipline of REQUIRE_VIEWER/EXEMPT in
 * tests/ops/visibility-invariants.test.ts. Every `enqueue(` call under `src/` must appear in it
 * with one sentence saying where its subject/body comes from, and a NEW call site fails this guard
 * until somebody writes down which kind it is.
 *
 * The review ruled the guard STRONGER than making the parameter required (23 mechanical
 * `familyChannelOnly: false` arguments are as easy to write wrong as to omit, and this is a
 * defects-only release). The two are not exclusive; the guard is the one that catches the case the
 * type system cannot, which is a body that quietly BECOMES household-derived under a call site
 * whose flag was never revisited.
 */
interface EnqueueSite {
  file: string;
  /** 1-based position of the `enqueue(` call within the file, top to bottom. */
  nth: number;
  /**
   * Text that must appear inside this call's own arguments. It is what keeps `nth` honest: move
   * or reorder the calls in a file and the marker no longer matches, so the reason below can never
   * end up describing a different call than the one it was written for.
   */
  marker: string;
  /**
   * Can the subject/body passed as the PERSONAL delivery (enqueue's `subject`/`body`, not its
   * `household` override) carry a figure derived from more money than the recipient's own?
   * If yes, `familyChannelOnly` is required for a self-scoped recipient: the routed row is the
   * family channel's business, the personal copy is the leak.
   */
  householdDerivedBody: boolean;
  /** Whether the call passes `familyChannelOnly` today. Asserted against the source BOTH ways. */
  familyChannelOnly: 'passed' | 'absent';
  /** One sentence, from the code: where this body's numbers come from. */
  why: string;
  /**
   * Set ONLY where householdDerivedBody is true and the flag is absent anyway. Names the ruling or
   * the earlier gate that makes the omission correct rather than an oversight. Nothing is exempt
   * without one.
   */
  exception?: string;
}

const ENQUEUE_SITES: EnqueueSite[] = [
  {
    file: 'src/lib/canadian-pack.ts',
    nth: 1,
    marker: "eventId: 'pack_update_available'",
    householdDerivedBody: false,
    familyChannelOnly: 'absent',
    why: "renderEvent('pack_update_available') is given the pack label and the installed/bundled version strings only -- no transaction, no budget, no money of any kind -- and it is fanned out over adminUserIds().",
  },
  {
    file: 'src/lib/notify/evaluate/anomalies.ts',
    nth: 1,
    marker: "eventId: 'unusual_transaction'",
    householdDerivedBody: true,
    familyChannelOnly: 'absent',
    why: "the body carries one transaction's merchant, account name, date, amount and category straight out of readSlice(), which selects every household transaction with no attribution filter, and the loop fans that one render out over every recipient participants() returns.",
    exception:
      "Ruling R16 (v1.30.0) parked this as an open question (item M-8): MUST-9.36 in docs/superpowers/specs/2026-08-18-predictive-dateranges-design.md:622 makes the three anomaly detectors household-wide BY DESIGN, in direct conflict with ruling R2. v1.31.0's owner ruling resolved M-8 for this event by narrowing the RECIPIENT LIST to role === 'admin' (anomalies.ts's participants(), not a familyChannelOnly at this call) rather than scoping the figures (which would gut the feature) or dropping it (which would lose a genuine early warning): an admin is treated as unrestricted regardless of visibility (micro-ruling M1), so no self-scoped recipient reaches this call any more and there is nothing left for familyChannelOnly to withhold. subscription_creep (the site below) is a separate call, evaluated per notifiable user rather than through participants(), and is unchanged by this ruling.",
  },
  {
    file: 'src/lib/notify/evaluate/anomalies.ts',
    nth: 2,
    marker: "eventId: 'duplicate_charge'",
    householdDerivedBody: true,
    familyChannelOnly: 'absent',
    why: 'the body carries a merchant, an amount and two dates from the same unfiltered readSlice() as the site above, fanned out over every recipient participants() returns.',
    exception: 'The same v1.31.0 resolution as the site above: the recipient list narrows to role === \'admin\', so familyChannelOnly has nothing left to withhold here either.',
  },
  {
    file: 'src/lib/notify/evaluate/anomalies.ts',
    nth: 3,
    marker: "eventId: 'subscription_creep'",
    householdDerivedBody: true,
    familyChannelOnly: 'absent',
    why: "evaluateSubscriptionCreep groups the household's charges by merchant with no attribution filter, so the merchant, date, new amount and baseline in this body can all be another member's.",
    exception: 'Ruling R16 / MUST-9.36, as for the two sites above.',
  },
  {
    file: 'src/lib/notify/evaluate/budget.ts',
    nth: 1,
    marker: "eventId: 'budget_threshold'",
    householdDerivedBody: true,
    familyChannelOnly: 'passed',
    why: "fireFor renders the row it is given, and evaluateBudgets calls it once per row of budgetProgress(month, 'household', null) for EVERY participant; the flag is fireFor's own parameter, set to person.selfScoped on that household loop and left undefined on the personal loop below it.",
  },
  {
    file: 'src/lib/notify/evaluate/budget.ts',
    nth: 2,
    marker: "eventId: 'budget_exceeded'",
    householdDerivedBody: true,
    familyChannelOnly: 'passed',
    why: 'the second of fireFor\'s two sends, from the same household or personal row and the same parameter as the site above.',
  },
  {
    file: 'src/lib/notify/evaluate/coming-due.ts',
    nth: 1,
    marker: 'installmentOverdueKey(row.installmentId, month)',
    householdDerivedBody: false,
    familyChannelOnly: 'absent',
    why: 'the installment rows come from unpaidInstallments({ ownerUserId: input.userId }), so every name, due date and amount in this body is already the recipient\'s own.',
  },
  {
    file: 'src/lib/notify/evaluate/coming-due.ts',
    nth: 2,
    marker: 'comingDueKey(row.id, expiryDate)',
    householdDerivedBody: false,
    familyChannelOnly: 'absent',
    why: "the warranty query filters eq(warrantyItems.ownerUserId, input.userId), so the item name, vendor, price and expiry date in this body are the recipient's own.",
  },
  {
    file: 'src/lib/notify/evaluate/digest.ts',
    nth: 1,
    marker: "eventId: 'weekly_digest'",
    householdDerivedBody: false,
    familyChannelOnly: 'absent',
    why: "every figure in the personal body goes through viewerFor(input.userId) -- categoryBreakdown and topMerchants take the viewer, and the S-18 fix made overBudget read budgetProgress(month, 'personal', viewer.id) for a self-scoped recipient; the true household read reaches the family channel through the `household` override alone, which is the one row familyChannelOnly could not withhold anyway.",
  },
  {
    file: 'src/lib/notify/evaluate/monthly.ts',
    nth: 1,
    marker: "eventId: 'predicted_vs_actual'",
    householdDerivedBody: false,
    familyChannelOnly: 'passed',
    why: "the personal body is rendered from `own`, which is empty of household lines for a self-scoped recipient (ownHousehold is null) and carries no total sentence either; the household comparison reaches the family channel through the `household` override (finding I-1). The flag is passed for a DIFFERENT reason from budget.ts's and savings.ts's -- `own.length === 0` withholds a header with no lines under it from a member who has no attributed spend of their own but still contributes the room's message -- and it is only ever true for a self-scoped recipient, since for anyone else `own` is a superset of the family lines.",
  },
  {
    file: 'src/lib/notify/evaluate/monthly.ts',
    nth: 2,
    marker: "eventId: 'suggested_budget_refresh'",
    householdDerivedBody: false,
    familyChannelOnly: 'passed',
    why: 'the personal body is rendered from ownHousehold (empty for a self-scoped recipient) plus their own refreshFor(month, \'personal\', userId) list, and changedCount counts only those two; the household list reaches the family channel through the `household` override. The flag carries the same "this recipient\'s own message came out empty" meaning as the site above, here withholding a "0 suggested budgets changed" subject line.',
  },
  {
    file: 'src/lib/notify/evaluate/monthly.ts',
    nth: 3,
    marker: "eventId: 'monthly_digest'",
    householdDerivedBody: false,
    familyChannelOnly: 'absent',
    why: "renderMonthlyDigestFor is called with the recipient's own viewer for this body -- cashflowTrend and topMerchants take it, and the budgeted pair reads budgetProgress(month, 'personal', viewer.id) for a self-scoped recipient (the S-18 fix) -- while the family channel's copy is a second call through HOUSEHOLD_VIEWER passed as the `household` override.",
  },
  {
    file: 'src/lib/notify/evaluate/pace.ts',
    nth: 1,
    marker: "eventId: 'budget_pace'",
    householdDerivedBody: true,
    familyChannelOnly: 'passed',
    why: "the body is a projection over one budgetProgress row whose scope the caller chose, so it is household-derived exactly when candidate.scope === 'household' -- which is what the flag is guarded on, because a personal-scope send is not routable at all (subjectScope) and pairing the two would enqueue nothing.",
  },
  {
    file: 'src/lib/notify/evaluate/savings.ts',
    nth: 1,
    marker: "eventId: 'savings_target_met'",
    householdDerivedBody: true,
    familyChannelOnly: 'passed',
    why: "netCents and targetCents come from savingsProgress(month, HOUSEHOLD_WIDE) and ruling T3 gives them no personal analogue to narrow to, so the one render is shared across recipients and the flag is set per participant.selfScoped.",
  },
  {
    file: 'src/lib/notify/evaluate/savings.ts',
    nth: 2,
    marker: "eventId: 'savings_target_pace'",
    householdDerivedBody: true,
    familyChannelOnly: 'passed',
    why: 'the same household-wide savingsProgress figures plus a pro-rated target derived from them; the flag is the recipient\'s own selfScoped, resolved from viewerFor above the call.',
  },
  {
    file: 'src/lib/notify/evaluate/savings.ts',
    nth: 3,
    marker: "eventId: 'savings_month_closed'",
    householdDerivedBody: true,
    familyChannelOnly: 'passed',
    why: 'the closed month\'s household savingsProgress plus savingsStreak(closedMonth, HOUSEHOLD_WIDE); the function also skips both reads outright when the recipient is self-scoped and the event is routed to no family channel.',
  },
  {
    file: 'src/lib/notify/evaluate/stale.ts',
    nth: 1,
    marker: "eventId: 'stale_import'",
    householdDerivedBody: true,
    familyChannelOnly: 'absent',
    why: 'the body names an account and the date it was last imported into, taken from a query over every active account in the install with no owner filter.',
    exception:
      "Gated before the call, not at it: evaluateStaleImport returns 0 for a self-scoped viewer (v1.13.0 ruling R2, item I5) before any query runs, because -- unlike the digests -- 'which account is stale' has no honest re-scoped version to send instead. No self-scoped recipient ever reaches this line, so there is no personal delivery for the flag to withhold.",
  },
  {
    file: 'src/lib/notify/raise.ts',
    nth: 1,
    marker: "eventId: 'new_signin'",
    householdDerivedBody: false,
    familyChannelOnly: 'absent',
    why: "an account-security event about the recipient's own session: their name, the sign-in time, the IP and the user agent. No money.",
  },
  {
    file: 'src/lib/notify/raise.ts',
    nth: 2,
    marker: 'eventId: input.event',
    householdDerivedBody: false,
    familyChannelOnly: 'absent',
    why: "mfa_disabled / password_changed for the recipient's own account: their name and the time it happened. No money.",
  },
  {
    file: 'src/lib/notify/raise.ts',
    nth: 3,
    marker: "eventId: 'backup_failed'",
    householdDerivedBody: false,
    familyChannelOnly: 'absent',
    why: 'an admin-only operational alert carrying a date and an error message; no transaction, budget or balance is read.',
  },
  {
    file: 'src/lib/notify/raise.ts',
    nth: 4,
    marker: "eventId: 'restore_outcome'",
    householdDerivedBody: false,
    familyChannelOnly: 'absent',
    why: 'an admin-only operational alert carrying the restore status, source name, requesting username and receipt counts; no money.',
  },
  {
    file: 'src/lib/notify/raise.ts',
    nth: 5,
    marker: "eventId: 'sync_failed'",
    householdDerivedBody: false,
    familyChannelOnly: 'absent',
    why: 'an admin-only operational alert carrying a date and error.message only -- deliberately two fields, so the SimpleFIN access URL cannot ride in on a third.',
  },
  {
    file: 'src/lib/update/check.ts',
    nth: 1,
    marker: "eventId: 'update_available'",
    householdDerivedBody: false,
    familyChannelOnly: 'absent',
    why: 'an admin-only release notice: two version strings, a severity, a publish date and a can-apply flag. No money.',
  },
];

/**
 * Comments are stripped before scanning, because `enqueue()` is named in a dozen docblocks and one
 * `/** ... See enqueue(). *\/` above a parameter is not a call site. The `[^:]` guard on the
 * line-comment rule keeps a `https://` inside a string literal from swallowing the rest of its
 * line; nothing under src/ writes `/*` inside a string.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The text of one call's arguments, `(` to its matching `)`, skipping over string literals. */
function argumentsAt(code: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced enqueue( arguments: this scanner can no longer read the file');
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) acc.push(full);
  }
  return acc;
}

interface FoundCall {
  file: string;
  nth: number;
  args: string;
}

function findCalls(): FoundCall[] {
  const found: FoundCall[] = [];
  for (const full of sourceFiles(path.join(root, 'src'))) {
    const file = path.relative(root, full).split(path.sep).join('/');
    const code = stripComments(fs.readFileSync(full, 'utf8'));
    let nth = 0;
    let from = 0;
    for (;;) {
      const at = code.indexOf('enqueue(', from);
      if (at === -1) break;
      from = at + 'enqueue('.length;
      const before = code.slice(Math.max(0, at - 16), at);
      // `export function enqueue(input: {` in outbox.ts is the declaration, not a call, and
      // `kickOutbox`-style identifiers ending in "enqueue" would be a different function.
      if (/function\s+$/.test(before) || /[A-Za-z0-9_$.]$/.test(before)) continue;
      nth += 1;
      found.push({ file, nth, args: argumentsAt(code, from - 1) });
    }
  }
  return found;
}

const found = findCalls();
const key = (site: { file: string; nth: number }): string => `${site.file} #${site.nth}`;

describe('enqueue call sites are all classified (finding I-2)', () => {
  it('finds the call sites at all', () => {
    // A scanner that silently matches nothing would pass every assertion below. 20 is a floor, not
    // the count: the review enumerated 23 sites and new events are expected to add more.
    expect(found.length).toBeGreaterThanOrEqual(20);
  });

  it('lists every enqueue( call under src/, and nothing that is not one', () => {
    const listed = new Set(ENQUEUE_SITES.map(key));
    const actual = new Set(found.map(key));
    const unlisted = [...actual].filter((k) => !listed.has(k)).sort();
    const stale = [...listed].filter((k) => !actual.has(k)).sort();
    expect(
      unlisted,
      'a new enqueue() call site is not in ENQUEUE_SITES. Add it with one sentence saying where its subject/body numbers come from, and therefore whether familyChannelOnly is required',
    ).toEqual([]);
    expect(stale, 'ENQUEUE_SITES names a call site that no longer exists').toEqual([]);
  });

  it('still points at the calls the reasons were written for', () => {
    const drifted = ENQUEUE_SITES.filter((site) => {
      const call = found.find((c) => c.file === site.file && c.nth === site.nth);
      return call !== undefined && !call.args.includes(site.marker);
    }).map((site) => `${key(site)} no longer contains ${site.marker}`);
    expect(drifted, 'the calls in a file were reordered or rewritten: re-check each reason against the code before re-pointing it').toEqual([]);
  });

  it('agrees with the source about which calls pass familyChannelOnly', () => {
    const wrong = ENQUEUE_SITES.flatMap((site) => {
      const call = found.find((c) => c.file === site.file && c.nth === site.nth);
      if (call === undefined) return [];
      const passes = call.args.includes('familyChannelOnly');
      if (passes === (site.familyChannelOnly === 'passed')) return [];
      return [
        passes
          ? `${key(site)} passes familyChannelOnly but is listed as 'absent'`
          : `${key(site)} is listed as passing familyChannelOnly and does not`,
      ];
    });
    expect(
      wrong,
      "a call site's familyChannelOnly no longer matches what ENQUEUE_SITES says about it. If the body really did stop being household-derived, say so in `why`; if it did not, the personal delivery is now the pre-S-18 leak (ruling R2)",
    ).toEqual([]);
  });

  it('requires familyChannelOnly wherever the personal body is household-derived', () => {
    const unguarded = ENQUEUE_SITES.filter(
      (site) => site.householdDerivedBody && site.familyChannelOnly === 'absent' && (site.exception ?? '').length === 0,
    ).map(key);
    expect(
      unguarded,
      'a household-derived body is delivered to the recipient personally with no familyChannelOnly and no written exception',
    ).toEqual([]);
  });

  it('gives every entry a reason', () => {
    const thin = ENQUEUE_SITES.filter((site) => site.why.trim().length < 40).map(key);
    expect(thin, 'every entry needs a sentence, from the code, saying where its body comes from').toEqual([]);
  });
});
