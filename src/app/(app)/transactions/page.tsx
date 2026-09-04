import { requireUser } from '@/lib/auth/session';
import { isSelfScoped, ownerScope } from '@/lib/auth/viewer';
import { acceptsTransactions, listAccounts } from '@/lib/accounts';
import { listCategories } from '@/lib/categories';
import { findUserById, listAttributablePeople } from '@/lib/auth/users';
import { loanLinksForTransactions, listLoans } from '@/lib/loans';
import { resolveRenameRule, reviewQueueCount } from '@/lib/categorize/engine';
// v1.26.0 Lane 1 (owner report: "shows amazon i dont know what orignal entry was so maybe its
// wrong maybe its not"). Read-only imports: listRules for the rule set, and (v1.31.0 R-09)
// resolveRenameRule from the engine for the resolution itself -- this page used to spell the
// resolution out with matchRule plus its own emptiness test, which was a second definition of
// the same question. See renameRules below for why this is the one honest way to answer "which
// rule renamed this row" at all.
import { listRules } from '@/lib/categorize/rules';
import { splitsForTransactions } from '@/lib/splits';
import { countMatchingMerchant, groupTransactionsByCategory, listTransactions } from '@/lib/transactions';
import { todayIso } from '@/lib/dates';
import { resolveRange } from '@/lib/date-range';
import { readEnv } from '@/lib/env';
// v1.26.0 Lane 3a: readFilter moved out of this file into a module the SERVER ACTIONS can share --
// see filter-params.ts's own top-of-file docblock for why a group bulk action has to rebuild the
// very filter this render used, and why two parsers would be two ways to misread one URL.
import { readFilter, readGroupMode, readGroupPage } from './filter-params';
import { TransactionsClient } from './transactions-client';

export const dynamic = 'force-dynamic';

/**
 * Bug fix (owner report): TransactionsClient's category chips used to build their hrefs from
 * `window.location.search`, read in a client effect -- empty on first paint (server-side, and for
 * one client render before that effect runs), so every chip's href dropped every OTHER active
 * filter, `review=1` included. Next.js hands this route the already-parsed params, not the literal
 * querystring, so this rebuilds an equivalent one from them -- passed down as `currentQuery` so
 * the client can build a correct chip href on the very first render, with no effect required to
 * fix it up afterwards. Repeated keys (there are none today, but nothing here assumes there won't
 * be) are preserved rather than collapsed, the same as a real querystring would carry them.
 */
function currentQueryString(params: Record<string, string | string[] | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) qs.append(key, one);
  }
  return qs.toString();
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireUser();
  const params = await searchParams;
  const today = todayIso(new Date(), readEnv().tz);
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  // MUST-13.5: fallback null, because Transactions is the page people open to find a charge
  // from March and giving it a default range would hide exactly those rows.
  const range = resolveRange({ preset: one('range'), from: one('from'), to: one('to'), today, fallback: null });
  // Ruling R2: the review queue is household-wide by construction (same as the /review page it
  // replaces), so a self viewer's `?review=1` is silently ignored rather than refused -- they
  // just get their own ordinary transactions list, the same courtesy a hand-edited `?person=`
  // already gets above.
  const selfScopedViewer = isSelfScoped(viewer);
  const reviewMode = one('review') === '1' && !selfScopedViewer;
  const filter = readFilter(params, range, ownerScope(viewer), reviewMode);
  const page = listTransactions(filter, viewer);
  /**
   * v1.26.0 Lane 3a item 2 (owner: "if rules set category grocier i can just scoll and look at all
   * the groceries 1 shot whiel receiving rather then by just date"). `?group=category` renders the
   * clusters instead of the rows -- groupTransactionsByCategory over the SAME `filter` object the
   * row query above already used, so the groups can never describe a different set than the list
   * they link into (that function's own doc comment, src/lib/transactions.ts, makes the same point
   * about sharing one buildWhere).
   *
   * `null` when the param is off, which is what the client reads to decide which view to render --
   * one source of truth for "is this the grouped view", not a boolean prop beside the data that
   * could disagree with it.
   *
   * The row query above is NOT skipped in grouped mode, deliberately. It is one indexed page of 50
   * rows -- the identical query this page already ran on every visit before this release, so
   * grouped mode costs one grouped aggregate MORE, never a query per group (see this task's own
   * expand-vs-link decision: a group header links to the drill-down filter, it does not fetch that
   * group's rows). Keeping it also keeps `page.total`/`pageCount` available to the client for the
   * "N transactions in this view" line, taken from the same count `CategoryGroupPage.totalCount`
   * reports, which is how the two views are kept from stating different totals.
   */
  const groups = readGroupMode(params)
    ? groupTransactionsByCategory(filter, viewer, { page: readGroupPage(params) })
    : null;
  // Ruling: cheap even when nobody is looking at it -- one count(*) behind REVIEW_WHERE, the
  // same query the nav badge already runs. Always computed, never gated on reviewMode, so the
  // "Needs review (N)" chip stays accurate when a filtered view happens to be review-empty.
  const reviewCount = reviewQueueCount();
  // Review-mode-only (ruling: matchingCount is computed for review-mode rows only, Lane 1's own
  // docblock on the filter). A plain object keyed by id, the same shape loanLinks/splits below
  // already use for "extra data about this page's rows, not carried on TransactionRow itself".
  const matchingCounts: Record<number, number> = {};
  if (reviewMode) {
    for (const row of page.rows) matchingCounts[row.id] = countMatchingMerchant(row.normalizedMerchant);
  }
  /**
   * v1.26.0 Lane 1. Which rename rule (if any) produced a renamed row's display name -- there is
   * no rule_id column on the transaction itself (TransactionRow.displaySource, src/lib/
   * transactions.ts, only records THAT a rule acted, never which one), so this is resolved the
   * exact same way the engine resolves it for its own bookkeeping: resolveRenameRule(row.
   * normalizedMerchant, ctx) (src/lib/categorize/engine.ts), which is the very function
   * resolveRename -- and therefore applyRenameRules -- uses to keep a renamed row's display text
   * in sync with the current rule set. v1.31.0 R-09: it used to be this page's own matchRule call
   * plus its own `renameTo !== null` test, which is how "does this merchant have a rename?" came
   * to be answered three different ways in three files. A row is simply ABSENT from this map when that resolves to nothing --
   * the rule that renamed it may since have been edited or deleted -- and the client treats a
   * missing entry exactly like "the rule list was never available": bank text still shows, the
   * rule attribution does not (this task's own brief: never invent an attribution that could name
   * the wrong rule).
   */
  const renameRules: Record<number, { pattern: string; matchType: string; renameTo: string; ruleId: number }> = {};
  {
    const rules = listRules('rename');
    for (const row of page.rows) {
      if (row.displaySource !== 'rename') continue;
      // v1.31.0 (review finding R-09, P3): resolveRenameRule, the engine's own definition, in
      // place of this page's former `matchRule(...)` + `rule.renameTo !== null`. That test was a
      // second writing of "does this merchant have a rename?" and a LOOSER one than the engine's
      // -- it accepted `renameTo === ''`, which would have rendered an attribution card for a
      // rename to nothing. resolveRenameRule hands back the winning RULE, so this page still gets
      // the pattern and id it needs to name the rule, from the same call that decides there IS
      // one.
      const rule = resolveRenameRule(row.normalizedMerchant, { rules });
      if (rule !== null && rule.renameTo !== null) {
        renameRules[row.id] = { pattern: rule.pattern, matchType: rule.matchType, renameTo: rule.renameTo, ruleId: rule.id };
      }
    }
  }
  return (
    <TransactionsClient
      page={page}
      reviewMode={reviewMode}
      reviewCount={reviewCount}
      matchingCounts={matchingCounts}
      renameRules={renameRules}
      groups={groups}
      currentQuery={currentQueryString(params)}
      // Ruling R10: an asset account holds a typed balance and takes no transactions/imports, so
      // it is filtered out of every account picker on this page -- the filter select, quick-add
      // and (formerly) the bottom manual-entry form all shared this one `accounts` prop, so
      // filtering it once here covers all of them.
      accounts={listAccounts({}, viewer)
        .filter((account) => acceptsTransactions(account.type))
        .map((a) => ({ id: a.id, name: a.name }))}
      // Archived categories are included here (not just listCategories()) so a row whose
      // category was later archived can still render its real name on the per-row select
      // and keep it as the initial selection instead of silently falling back to
      // "Uncategorized". See TransactionsClient's activeCategories split.
      categories={listCategories({ includeArchived: true })}
      // Ruling R5: every attribution picker reads the same list -- active people, login or not.
      // This is also the fix for the pre-v1.13.0 inconsistency where this page listed deactivated
      // members and budgets/page.tsx did not.
      // v1.13.1 (item BO): except for a self viewer, who gets none. Every attribution choice is
      // refused for them server-side, so the names were travelling into the client for controls
      // that could never work.
      people={isSelfScoped(viewer) ? [] : listAttributablePeople().map((person) => ({ id: person.id, name: person.name }))}
      today={today}
      range={range}
      // Ruling R2: the pill/select that would let a self viewer pick someone else is not
      // rendered at all -- the read is already forced to their own id above, in readFilter.
      selfScoped={isSelfScoped(viewer)}
      // Ruling R7: quick-add's own default account, remembered per person.
      defaultAccountId={findUserById(viewer.id)?.lastAccountId ?? null}
      // MUST-14.9: empty for a household with no loans (or none with a balance still owed),
      // which is exactly what makes the row control disappear entirely on that page.
      loanOptions={listLoans(today, viewer)
        .filter((loan) => loan.currentBalanceCents !== null)
        .map((loan) => ({ id: loan.itemId, name: loan.name }))}
      loanLinks={Object.fromEntries(loanLinksForTransactions(page.rows.map((row) => row.id)))}
      splits={Object.fromEntries(splitsForTransactions(page.rows.map((row) => row.id)))}
    />
  );
}
