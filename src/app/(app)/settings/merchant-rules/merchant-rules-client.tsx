'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardBody, CardFooter } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill } from '@/components/ui/Pill';
import { RowDialog } from '@/components/ui/RowDialog';
import { RowMenu, RowMenuButton, RowMenuForm } from '@/components/ui/RowMenu';
import { TableWrap } from '@/components/ui/Table';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import { categoryOptionGroups } from '@/lib/category-order';
import type {
  CanadianPackInstallPreview,
  CanadianPackRemovalPreview,
  CanadianPackState,
  CanadianPackUpdateDiff,
} from '@/lib/canadian-pack';
import type { CategoryRecord } from '@/lib/categories';
import type { MatchType, MerchantRuleRecord, RuleKind } from '@/lib/categorize/rules';
import type { RulesExportRow } from '@/lib/packs';
import { CanadianPackPanel } from './canadian-pack-panel';
import { RulesPackPanel } from './rules-pack-panel';
import {
  applyRuleNowAction,
  bulkDeleteRulesAction,
  bulkSetDisabledAction,
  deleteRuleAction,
  previewRerunAllAction,
  rerunAllAction,
  saveRuleAction,
  setRuleDisabledAction,
  type RuleActionState,
} from './actions';

const initial: RuleActionState = {};

const KIND_LABEL: Record<RuleKind, string> = {
  category: 'Category',
  transfer: 'Transfer',
  rename: 'Rename',
  not_transfer: 'Not a transfer',
};

/** Reused across the search box, the four kind chips and the redundant chip -- every filter
 *  link resets to page 1 (a stale page number past the end of a narrower result would otherwise
 *  either 404 or silently clamp to a confusing page), and always carries the OTHER filters
 *  forward so clicking one chip never discards the others. Same idiom as transactions-client.tsx's
 *  own categoryChipHref, generalized across whichever param this call is changing (item 10: "copy
 *  the idiom" rather than invent a second one; the generic shell is what's actually shared here
 *  instead of a byte-for-byte copy, since this page's chips are keyed on `kind`/`redundant`, not
 *  `category`).
 */
function chipHref(current: string, changes: Record<string, string | null>): string {
  const params = new URLSearchParams(current);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  params.delete('page');
  const query = params.toString();
  return query.length > 0 ? `/settings/merchant-rules?${query}` : '/settings/merchant-rules';
}

/** Same shape as warranties-client.tsx's own pageHref (see the v1.21.0 research note this page's
 *  brief pointed at): transactions-client.tsx's own pager is incomplete (no working Prev/Next),
 *  so this follows the warranties page's idiom instead of copying a broken one. */
function pageHref(current: string, page: number): string {
  const params = new URLSearchParams(current);
  if (page > 1) params.set('page', String(page));
  else params.delete('page');
  const query = params.toString();
  return query.length > 0 ? `/settings/merchant-rules?${query}` : '/settings/merchant-rules';
}

interface RuleFormValues {
  id: number | null;
  pattern: string;
  matchType: MatchType;
  ruleKind: RuleKind;
  categoryId: number | null;
  renameTo: string;
}

const BLANK: RuleFormValues = { id: null, pattern: '', matchType: 'exact', ruleKind: 'category', categoryId: null, renameTo: '' };

/**
 * Deliberately NOT an import of categoryLabel from @/lib/categories: that module reaches
 * @/db/client (better-sqlite3), and a VALUE import of it from a 'use client' file breaks
 * `next build` ("Module not found: Can't resolve 'fs'") while tsc and vitest stay green --
 * exactly the trap src/lib/category-order.ts's own docblock warns about, and exactly why the
 * old managers-client.tsx defined this inline rather than importing it too.
 */
function categoryLabelFor(id: number | null, categories: CategoryRecord[]): string {
  if (id === null) return '—';
  const category = categories.find((c) => c.id === id);
  if (!category) return '—';
  const parent = category.parentId ? categories.find((c) => c.id === category.parentId) : undefined;
  return parent ? `${parent.name} › ${category.name}` : category.name;
}

export function MerchantRulesClient({
  categories,
  rows,
  total,
  page,
  pageCount,
  currentQuery,
  searchValue,
  activeKind,
  redundantOnly,
  presetOnly,
  presetCount,
  kindCounts,
  redundantCount,
  impactCounts,
  redundantByRuleId,
  rulesPackRows,
  canadianPack,
  canadianInstallPreview,
  canadianRemovalPreview,
  canadianUpdateDiff,
}: {
  categories: CategoryRecord[];
  rows: MerchantRuleRecord[];
  total: number;
  page: number;
  pageCount: number;
  currentQuery: string;
  searchValue: string;
  activeKind: RuleKind | null;
  redundantOnly: boolean;
  /** Backlog item 17: the "Preset" filter chip, same idiom as redundantOnly. */
  presetOnly: boolean;
  presetCount: number;
  kindCounts: Record<RuleKind, number>;
  redundantCount: number;
  /** Sparse: absent means 0 (item 12's ruleImpactCounts never stores a zero entry). */
  impactCounts: Record<number, number>;
  /** ruleId -> the contains rule id that already covers it (item 10's redundancy detection). */
  redundantByRuleId: Record<number, number>;
  rulesPackRows: RulesExportRow[];
  canadianPack: CanadianPackState;
  canadianInstallPreview: CanadianPackInstallPreview | null;
  canadianRemovalPreview: CanadianPackRemovalPreview | null;
  canadianUpdateDiff: CanadianPackUpdateDiff | null;
}) {
  const [saveState, saveRule] = useActionState(saveRuleAction, initial);
  const [deleteState, removeRule] = useActionState(deleteRuleAction, initial);
  const [bulkDeleteState, bulkDelete] = useActionState(bulkDeleteRulesAction, initial);
  const [bulkDisableState, bulkSetDisabled] = useActionState(bulkSetDisabledAction, initial);
  const [disableState, setDisabled] = useActionState(setRuleDisabledAction, initial);
  const [applyState, applyNow] = useActionState(applyRuleNowAction, initial);
  const [rerunState, rerunAll] = useActionState(rerunAllAction, initial);

  const [selected, setSelected] = useState<number[]>([]);
  const toggle = (id: number) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const allOnPageSelected = rows.length > 0 && rows.every((rule) => selected.includes(rule.id));
  const toggleAllOnPage = () => {
    if (allOnPageSelected) setSelected((prev) => prev.filter((id) => !rows.some((rule) => rule.id === id)));
    else setSelected((prev) => [...new Set([...prev, ...rows.map((rule) => rule.id)])]);
  };

  const [editing, setEditing] = useState<RuleFormValues | null>(null);
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
  const [rerunPreview, setRerunPreview] = useState<'idle' | 'loading' | { eligible: number; wouldChange: number }>('idle');

  const notice = saveState.message ?? deleteState.message ?? bulkDeleteState.message ?? bulkDisableState.message ?? disableState.message ?? applyState.message ?? rerunState.message;
  const error = saveState.error ?? deleteState.error ?? bulkDeleteState.error ?? bulkDisableState.error ?? disableState.error ?? applyState.error ?? rerunState.error;

  const selectedRules = rows.filter((rule) => selected.includes(rule.id));
  // Only rows on THIS page are resolvable to a real record for the confirm text below -- a
  // selection spanning several pages still deletes correctly (ids travel with the form
  // regardless), it just cannot show a fully-accurate consequence count for ids off-page. Good
  // enough: the common case is selecting within one page's redundant/rename rows at a time.
  const revertCount = selectedRules
    .filter((rule) => rule.ruleKind === 'rename')
    .reduce((sum, rule) => sum + (impactCounts[rule.id] ?? 0), 0);

  async function loadRerunPreview() {
    setRerunPreview('loading');
    const result = await previewRerunAllAction();
    setRerunPreview(result);
  }

  /**
   * Owner ask (2026-08-31), same conversion as the Canadian pack panel's three confirmations
   * (canadian-pack-panel.tsx, its own docblock spells out the rule this follows): this confirm is
   * PAGE-LEVEL -- it acts on a multi-row SELECTION, not one row a person can keep looking at while
   * they decide -- and it states a real consequence (how many transactions a rename rule among
   * the selection will revert) that has to be read before agreeing. It stayed inline this whole
   * time only because it was written before RowDialog existed as a shared shell to reach for.
   * Every word of the confirm text is unchanged; only the shell and this dialog's title are new.
   *
   * Deliberately NOT extended to the "Re-run rules" preview further up this file: that panel
   * previews a SAFE, reversible, forward-only operation ("about N would actually change... a
   * hand-categorized transaction is never touched") with no destructive consequence to weigh --
   * it is closer to a live status readout than a decision with something to lose, so it stays the
   * one page-level confirm-shaped panel on this page that stays inline.
   */
  function bulkDeleteDialog() {
    if (!confirmingBulkDelete) return null;
    return (
      <RowDialog
        dialogId="bulk-delete-rules-dialog"
        title={`Delete ${selected.length} rule${selected.length === 1 ? '' : 's'}`}
        onClose={() => setConfirmingBulkDelete(false)}
      >
        <p className="text-sm text-ink">
          Delete {selected.length} rule{selected.length === 1 ? '' : 's'}?
          {revertCount > 0
            ? ` ${revertCount} transaction${revertCount === 1 ? '' : 's'} using a rename rule among them will revert to the bank's wording.`
            : ' This cannot be undone.'}
        </p>
        <div className="flex gap-2">
          <form
            action={bulkDelete}
            onSubmit={() => {
              setConfirmingBulkDelete(false);
              setSelected([]);
            }}
          >
            <input type="hidden" name="ids" value={selected.join(',')} />
            <SubmitButton variant="danger" size="sm">Delete permanently</SubmitButton>
          </form>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConfirmingBulkDelete(false)}>
            Cancel
          </button>
        </div>
      </RowDialog>
    );
  }

  function ruleDialog() {
    if (!editing) return null;
    const isNew = editing.id === null;
    return (
      <RowDialog
        dialogId="rule-dialog"
        key={editing.id ?? 'new'}
        title={isNew ? 'New merchant rule' : `Edit rule for "${editing.pattern}"`}
        onClose={() => setEditing(null)}
      >
        <form action={saveRule} onSubmit={() => setEditing(null)} className="flex flex-col gap-3">
          <Field label="Pattern" hint="Compared against the UPPERCASE normalized merchant text -- any case you type is uppercased on save.">
            <input name="pattern" defaultValue={editing.pattern} placeholder="WALMART" required autoFocus className={inputClass} />
          </Field>
          <Field label="Match">
            <select
              name="matchType"
              defaultValue={editing.matchType}
              className={selectClass}
            >
              <option value="exact">exact</option>
              <option value="contains">contains</option>
            </select>
          </Field>
          <Field label="Kind" hint="A rename changes only what you see; a category rule changes budgeting. They are different commitments.">
            <select name="ruleKind" defaultValue={editing.ruleKind} className={selectClass}>
              <option value="category">category</option>
              <option value="transfer">transfer</option>
              <option value="rename">rename</option>
              <option value="not_transfer">not a transfer (override)</option>
            </select>
          </Field>
          <Field label="Category (category rules only)">
            <select name="categoryId" defaultValue={editing.categoryId ?? ''} className={selectClass}>
              <option value="">(none -- transfer, not_transfer and rename rules)</option>
              {categoryOptionGroups(categories).map((group) =>
                group.label === null ? (
                  <option key={group.options[0].id} value={group.options[0].id}>{group.options[0].label}</option>
                ) : (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </optgroup>
                ),
              )}
            </select>
          </Field>
          <Field label="Renames to (rename rules only)">
            <input name="renameTo" defaultValue={editing.renameTo} placeholder="Walmart" className={inputClass} />
          </Field>
          {!isNew ? (
            <p className="text-xs text-subtle">
              Changing the pattern, match or kind creates a separate rule rather than renaming this one in place --
              save it under its new pattern, then delete this row from the table if it should not also remain.
            </p>
          ) : null}
          <div className="flex gap-2">
            <SubmitButton className="w-fit">{isNew ? 'Create rule' : 'Save rule'}</SubmitButton>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      </RowDialog>
    );
  }

  const kindChip = (label: string, kind: RuleKind | null, count: number) => {
    const active = activeKind === kind && !redundantOnly && !presetOnly;
    return (
      <Link key={kind ?? 'all'} href={chipHref(currentQuery, { kind, redundant: null, preset: null })} className="inline-flex min-h-11 items-center sm:min-h-0">
        <Pill tone={active ? 'accent' : 'neutral'}>{`${label} (${count})`}</Pill>
      </Link>
    );
  };

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        eyebrow="Settings"
        title="Merchant rules"
        description="Category, rename, transfer and not-a-transfer rules -- searched, filtered and acted on in bulk, the same idiom as Transactions."
        actions={
          <button type="button" className="btn btn--primary btn--sm min-h-11 sm:min-h-0" onClick={() => setEditing(BLANK)}>
            New rule
          </button>
        }
      />

      <PageGuide>
        <p>
          A <strong className="font-semibold text-ink">rename</strong> rule changes only what you see; it is
          already retroactive the moment you save it. A <strong className="font-semibold text-ink">category</strong>{' '}
          rule changes budgeting, and (unlike rename) only ever applies going forward, to new imports, unless you
          use <strong className="font-semibold text-ink">Apply now</strong> on its own row or{' '}
          <strong className="font-semibold text-ink">Re-run rules</strong> below to catch up older data -- neither
          one ever overwrites a transaction you categorized by hand. A{' '}
          <strong className="font-semibold text-ink">not a transfer</strong> rule is an exact-match override that
          stops one merchant from being auto-flagged as a card payment.
        </p>
        <p>
          <strong className="font-semibold text-ink">Disable</strong> is a switch you can flip back; it stops a
          rule from matching without losing it, and reverts a rename rule&apos;s rows exactly like deleting one
          would. <strong className="font-semibold text-ink">Delete</strong> is for a genuine mistake. A row marked{' '}
          <strong className="font-semibold text-ink">redundant</strong> is an exact rule a broader contains rule
          already covers with the identical outcome -- safe to prune.
        </p>
      </PageGuide>

      <FormError message={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <Card>
        <CardBody className="flex flex-col gap-4">
          <form method="get" className="flex flex-wrap items-end gap-3">
            {activeKind ? <input type="hidden" name="kind" value={activeKind} /> : null}
            {redundantOnly ? <input type="hidden" name="redundant" value="1" /> : null}
            {presetOnly ? <input type="hidden" name="preset" value="1" /> : null}
            <Field label="Search">
              <input
                name="q"
                defaultValue={searchValue}
                placeholder="Search by pattern or rename target"
                aria-label="Search by pattern or rename target"
                className={`${inputClass} min-w-[16rem]`}
              />
            </Field>
            <button type="submit" className="btn btn--secondary btn--sm min-h-11 sm:min-h-0">Search</button>
          </form>

          <div role="group" aria-label="Filter by kind" className="flex flex-wrap items-center gap-2">
            <Link href={chipHref(currentQuery, { kind: null, redundant: null, preset: null })} className="inline-flex min-h-11 items-center sm:min-h-0">
              <Pill tone={activeKind === null && !redundantOnly && !presetOnly ? 'accent' : 'neutral'}>{`All (${Object.values(kindCounts).reduce((a, b) => a + b, 0)})`}</Pill>
            </Link>
            {kindChip(KIND_LABEL.category, 'category', kindCounts.category)}
            {kindChip(KIND_LABEL.rename, 'rename', kindCounts.rename)}
            {kindChip(KIND_LABEL.transfer, 'transfer', kindCounts.transfer)}
            {kindChip(KIND_LABEL.not_transfer, 'not_transfer', kindCounts.not_transfer)}
            {redundantCount > 0 ? (
              <Link href={chipHref(currentQuery, { redundant: redundantOnly ? null : '1' })} className="inline-flex min-h-11 items-center sm:min-h-0">
                <Pill tone={redundantOnly ? 'warning' : 'neutral'}>{`Redundant (${redundantCount})`}</Pill>
              </Link>
            ) : null}
            {presetCount > 0 ? (
              <Link href={chipHref(currentQuery, { preset: presetOnly ? null : '1' })} className="inline-flex min-h-11 items-center sm:min-h-0">
                <Pill tone={presetOnly ? 'accent' : 'neutral'}>{`Preset (${presetCount})`}</Pill>
              </Link>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
            {rerunPreview === 'idle' ? (
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => void loadRerunPreview()}>
                Re-run rules
              </button>
            ) : rerunPreview === 'loading' ? (
              <span className="text-sm text-muted">Checking what a re-run would change…</span>
            ) : rerunPreview.eligible === 0 ? (
              <span className="text-sm text-muted">Nothing to re-run -- no eligible transaction is waiting.</span>
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-line p-3 text-sm">
                <span className="text-ink">
                  This will look at <strong className="font-semibold">{rerunPreview.eligible}</strong> uncategorized/rule-guessed
                  transaction{rerunPreview.eligible === 1 ? '' : 's'}; about{' '}
                  <strong className="font-semibold">{rerunPreview.wouldChange}</strong> would actually change. A hand-categorized
                  transaction is never touched.
                </span>
                <form action={rerunAll} onSubmit={() => setRerunPreview('idle')}>
                  <SubmitButton size="sm">Re-run now</SubmitButton>
                </form>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRerunPreview('idle')}>Cancel</button>
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      {selected.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-lg border border-accent-soft bg-accent-soft px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold text-accent-soft-fg">{selected.length} selected</span>
            <form action={bulkSetDisabled}>
              <input type="hidden" name="ids" value={selected.join(',')} />
              <input type="hidden" name="disabled" value="1" />
              <SubmitButton variant="secondary" size="sm">Disable</SubmitButton>
            </form>
            <form action={bulkSetDisabled}>
              <input type="hidden" name="ids" value={selected.join(',')} />
              <input type="hidden" name="disabled" value="0" />
              <SubmitButton variant="secondary" size="sm">Enable</SubmitButton>
            </form>
            {!confirmingBulkDelete ? (
              <button type="button" className="btn btn--danger btn--sm" onClick={() => setConfirmingBulkDelete(true)}>
                Delete selected
              </button>
            ) : null}
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSelected([])}>Clear selection</button>
          </div>
        </div>
      ) : null}

      <Card>
        {rows.length === 0 ? (
          <CardBody>
            <EmptyState title="No rules match this filter" action={<Link href="/settings/merchant-rules" className="btn btn--secondary btn--sm">Clear filters</Link>}>
              Try a broader search, or clear the kind/redundant filter above.
            </EmptyState>
          </CardBody>
        ) : (
          <TableWrap bare fixed minWidth="66rem" responsive>
            <colgroup>
              <col style={{ width: '2.5rem' }} />
              <col style={{ width: '14rem' }} />
              <col style={{ width: '6rem' }} />
              <col style={{ width: '9rem' }} />
              <col style={{ width: '13rem' }} />
              <col style={{ width: '10rem' }} />
              <col style={{ width: '9rem' }} />
              <col style={{ width: '3rem' }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">
                  <input type="checkbox" checked={allOnPageSelected} onChange={toggleAllOnPage} aria-label="Select all rules on this page" className="accent-accent" />
                </th>
                <th scope="col">Pattern</th>
                <th scope="col">Match</th>
                <th scope="col">Kind</th>
                <th scope="col">Category / renames to</th>
                <th scope="col">Status</th>
                <th scope="col" className="text-right">Affects</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {rows.map((rule) => {
                const impact = impactCounts[rule.id] ?? 0;
                const coveredBy = redundantByRuleId[rule.id];
                const disabled = rule.disabledAt !== null;
                return (
                  <tr key={rule.id}>
                    <td data-label="">
                      <input
                        type="checkbox"
                        checked={selected.includes(rule.id)}
                        onChange={() => toggle(rule.id)}
                        aria-label={`Select rule ${rule.pattern}`}
                        className="accent-accent"
                      />
                    </td>
                    <td className="font-mono text-xs text-ink cell-stack-headline" data-label="Pattern">
                      {rule.pattern}
                      {rule.packSource !== null ? (
                        <span className="ml-2 badge badge--blue" title={`Installed by the ${rule.packSource} preset pack, v${rule.packVersion}`}>preset</span>
                      ) : null}
                      {coveredBy !== undefined ? (
                        <span className="ml-2 badge badge--amber" title={`Already covered by rule #${coveredBy}`}>redundant</span>
                      ) : null}
                    </td>
                    <td className="text-xs text-muted" data-label="Match">{rule.matchType}</td>
                    <td className="text-xs" data-label="Kind"><span className="badge badge--slate">{KIND_LABEL[rule.ruleKind]}</span></td>
                    <td className="text-xs text-muted" data-label="Category / renames to">
                      {rule.ruleKind === 'category' ? categoryLabelFor(rule.categoryId, categories) : rule.ruleKind === 'rename' ? (rule.renameTo ?? '—') : '—'}
                    </td>
                    <td className="text-xs" data-label="Status">
                      {disabled ? <span className="badge badge--muted">disabled</span> : <span className="badge badge--green">enabled</span>}
                    </td>
                    <td className="tabnum text-right text-xs text-muted cell-stack-amount" data-label="Affects">
                      {impact} transaction{impact === 1 ? '' : 's'}
                    </td>
                    <td className="text-right cell-stack-actions" data-label="">
                      <RowMenu label={`Actions for ${rule.pattern}`}>
                        <RowMenuButton
                          onSelect={() =>
                            setEditing({
                              id: rule.id,
                              pattern: rule.pattern,
                              matchType: rule.matchType,
                              ruleKind: rule.ruleKind,
                              categoryId: rule.categoryId,
                              renameTo: rule.renameTo ?? '',
                            })
                          }
                        >
                          Edit
                        </RowMenuButton>
                        {rule.ruleKind !== 'rename' && !disabled ? (
                          <RowMenuForm action={applyNow} fields={{ ruleId: String(rule.id) }}>
                            {`Apply now (${impact} would affect)`}
                          </RowMenuForm>
                        ) : null}
                        <RowMenuForm action={setDisabled} fields={{ ruleId: String(rule.id), disabled: disabled ? '0' : '1' }}>
                          {disabled ? 'Enable' : 'Disable'}
                        </RowMenuForm>
                        <RowMenuForm
                          action={removeRule}
                          fields={{ ruleId: String(rule.id) }}
                          confirm={
                            rule.ruleKind === 'rename' && impact > 0
                              ? `Delete this rule? ${impact} transaction${impact === 1 ? '' : 's'} will revert to the bank's wording.`
                              : 'Delete this rule? This cannot be undone.'
                          }
                        >
                          Delete
                        </RowMenuForm>
                      </RowMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
        {pageCount > 1 ? (
          <CardFooter>
            <nav className="flex items-center gap-3" aria-label="Pages">
              <span>Page {page} of {pageCount} · {total} rule{total === 1 ? '' : 's'}</span>
              {page > 1 ? <Link href={pageHref(currentQuery, page - 1)} className="btn btn--ghost btn--sm">Prev</Link> : null}
              {page < pageCount ? <Link href={pageHref(currentQuery, page + 1)} className="btn btn--ghost btn--sm">Next</Link> : null}
            </nav>
          </CardFooter>
        ) : rows.length > 0 ? (
          <CardFooter>{total} rule{total === 1 ? '' : 's'}</CardFooter>
        ) : null}
      </Card>

      <Card>
        <CardBody>
          <CanadianPackPanel
            state={canadianPack}
            installPreview={canadianInstallPreview}
            removalPreview={canadianRemovalPreview}
            updateDiff={canadianUpdateDiff}
          />
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <RulesPackPanel rows={rulesPackRows} />
        </CardBody>
      </Card>

      {ruleDialog()}
      {bulkDeleteDialog()}
    </div>
  );
}
