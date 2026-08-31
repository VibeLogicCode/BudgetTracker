import { requireAdmin } from '@/lib/auth/session';
import { listCategories } from '@/lib/categories';
import { ruleImpactCounts } from '@/lib/categorize/engine';
import { findRedundantExactRules, listRules, type MerchantRuleRecord, type RuleKind } from '@/lib/categorize/rules';
import { previewRulesPackExport } from '@/lib/packs';
import { MerchantRulesClient } from './merchant-rules-client';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;
const KINDS: readonly RuleKind[] = ['category', 'rename', 'transfer', 'not_transfer'];

function currentQueryString(params: Record<string, string | string[] | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) qs.append(key, one);
  }
  return qs.toString();
}

function one(params: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * v1.21.0 (item 10). 109 rules today for the household that asked for this page, and the whole
 * point is that the number only grows -- but it is still small enough (low hundreds, not
 * thousands) that filtering/searching/paging the already-fetched list in plain JS here is simpler
 * and cheaper than teaching src/lib/categorize/rules.ts a second, SQL-side query surface just for
 * this one page. Revisit if this household -- or any other -- ever reports enough rules for that
 * assumption to start costing something real.
 */
export default async function MerchantRulesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const params = await searchParams;

  const q = (one(params, 'q') ?? '').trim().toUpperCase();
  const kindParam = one(params, 'kind');
  const kind: RuleKind | null = KINDS.includes(kindParam as RuleKind) ? (kindParam as RuleKind) : null;
  const redundantOnly = one(params, 'redundant') === '1';
  const page = Math.max(1, Number(one(params, 'page') ?? '1') || 1);

  const categories = listCategories({ includeArchived: true });
  const allRules = listRules();
  const impactCounts = ruleImpactCounts();
  const redundant = findRedundantExactRules(allRules);
  const redundantByRuleId = new Map(redundant.map((r) => [r.ruleId, r.coveredByRuleId]));

  const kindCounts: Record<RuleKind, number> = { category: 0, transfer: 0, rename: 0, not_transfer: 0 };
  for (const rule of allRules) kindCounts[rule.ruleKind] += 1;

  let filtered = allRules;
  if (kind !== null) filtered = filtered.filter((rule) => rule.ruleKind === kind);
  if (redundantOnly) filtered = filtered.filter((rule) => redundantByRuleId.has(rule.id));
  if (q.length > 0) {
    filtered = filtered.filter(
      (rule) => rule.pattern.includes(q) || (rule.renameTo !== null && rule.renameTo.toUpperCase().includes(q)),
    );
  }

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount);
  const rows: MerchantRuleRecord[] = filtered.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  const impactRecord: Record<number, number> = {};
  for (const rule of allRules) {
    const value = impactCounts.get(rule.id);
    if (value !== undefined) impactRecord[rule.id] = value;
  }
  const redundantRecord: Record<number, number> = {};
  for (const [ruleId, coveredByRuleId] of redundantByRuleId) redundantRecord[ruleId] = coveredByRuleId;

  return (
    <MerchantRulesClient
      categories={categories}
      rows={rows}
      total={total}
      page={clampedPage}
      pageCount={pageCount}
      currentQuery={currentQueryString(params)}
      searchValue={one(params, 'q') ?? ''}
      activeKind={kind}
      redundantOnly={redundantOnly}
      kindCounts={kindCounts}
      redundantCount={redundant.length}
      impactCounts={impactRecord}
      redundantByRuleId={redundantRecord}
      rulesPackRows={previewRulesPackExport({ includeTransferRules: true })}
    />
  );
}
