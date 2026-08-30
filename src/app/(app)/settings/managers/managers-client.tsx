'use client';

import { useActionState, useEffect, useState } from 'react';
import { FormError } from '@/components/FormError';
import { MappingEditor } from '@/components/MappingEditor';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import { AutoSaveCheckbox, AutoSaveTextInput } from '@/components/ui/AutoSave';
import { ExpandIcon } from '@/components/ui/icons';
import { categoryOptionGroups, orderedCategoryRows } from '@/lib/category-order';
import type { CategoryRecord } from '@/lib/categories';
import type { MerchantRuleRecord } from '@/lib/categorize/rules';
import type { ProfileRecord, ProfileUsage } from '@/lib/import/presets';
import type { ImportMapping } from '@/lib/import/mapping';
import type { ProfilesExportRow, RulesExportRow } from '@/lib/packs';
import { RulesPackPanel } from './rules-pack-panel';
import { ProfilesPackPanel } from './profiles-pack-panel';
import {
  archiveCategoryAction,
  createCategoryAction,
  deleteProfileAction,
  deleteRuleAction,
  renameCategoryAction,
  saveProfileMappingAction,
  setCategoryTaxRelevantAction,
  setProfileActiveAction,
  updateRuleAction,
  type ManagerState,
} from './actions';

const initial: ManagerState = {};

const rowInput = 'field-control w-auto px-2 py-1 text-xs';

const saveCategoryName = (formData: FormData) => renameCategoryAction({}, formData);
const saveCategoryTaxRelevant = (formData: FormData) => setCategoryTaxRelevantAction({}, formData);

/** How the delete confirm step describes what a delete will do, computed from a read path
 * (getProfileUsage, via the server page) rather than from deleteProfile's own return value --
 * the admin needs the truth BEFORE committing to the delete, not after. */
function describeProfileUsage(usage: ProfileUsage): string {
  const parts: string[] = [];
  if (usage.accounts > 0) {
    parts.push(
      `${usage.accounts} account${usage.accounts === 1 ? '' : 's'} will lose ${usage.accounts === 1 ? 'its' : 'their'} remembered mapping`,
    );
  }
  if (usage.imports > 0) {
    parts.push(
      `${usage.imports} past import${usage.imports === 1 ? '' : 's'} will lose the record of which mapping was used`,
    );
  }
  return parts.length > 0 ? `${parts.join(' and ')}.` : 'Nothing currently references it.';
}

/**
 * The deactivate confirm step's wording (spec 2026-08-22 v1.6.0, MUST-4.3). Unlike
 * describeProfileUsage above, this only ever mentions ACCOUNTS -- past imports referencing the
 * profile are unaffected by deactivation (import history never changes), so bringing them up
 * here would be a false alarm. Deliberately says the pin is treated as unpinned, not cleared:
 * nothing is deleted, and reactivating resumes it immediately.
 */
function describeDeactivationImpact(usage: ProfileUsage): string {
  return `${usage.accounts} account${usage.accounts === 1 ? '' : 's'} pinned to it will be treated as unpinned until it is reactivated. Nothing is deleted — reactivating resumes the pin immediately.`;
}

/** Unique per category id -- an open parent's `aria-controls` names exactly the child rows it
 *  reveals, and the same id lets a closed row's `hidden` state be found in tests the way
 *  budgets-client.tsx's own `rowId` already does for Edit-limits rows. */
function categoryRowId(categoryId: number): string {
  return `category-row-${categoryId}`;
}

interface CategoryGroup {
  parent: CategoryRecord;
  children: CategoryRecord[];
}

/**
 * 2026-08-30 plan item 2: groups `orderedCategoryRows`'s already-correctly-ordered flat list
 * (parent immediately followed by its own children, backlog 2a) into parent/children pairs, the
 * same walk `categoryOptionGroups` (category-order.ts) already does for a `<select>`'s
 * `<optgroup>`s. Kept archived rows in, unlike that helper -- this admin table is exactly the one
 * place an archived category must still be visible and reachable (it can be restored from here).
 */
function groupCategories(categories: CategoryRecord[]): CategoryGroup[] {
  const groups: CategoryGroup[] = [];
  for (const { row, depth } of orderedCategoryRows(categories)) {
    if (depth === 0) groups.push({ parent: row, children: [] });
    else groups[groups.length - 1].children.push(row);
  }
  return groups;
}

/**
 * Item 2: which category groups are open is a per-browser viewing preference, not household
 * data -- same ruling U5 budgets-client.tsx's own `useGroupOpenState` already applies, duplicated
 * here rather than imported because this lane's file list keeps the two pages' client components
 * independent of each other. Closed by default (a fresh render's `openIds` is always an empty
 * Set), and every localStorage read or write is wrapped in try/catch so a private window, cleared
 * site data, or storage that simply throws still leaves the page in a correct, all-closed state.
 */
function useCategoryGroupOpenState(groupIds: number[]): { isOpen: (categoryId: number) => boolean; toggle: (categoryId: number) => void } {
  const STORAGE_KEY = 'managers:categoryGroups';
  const [openIds, setOpenIds] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const restored = new Set(parsed.filter((id): id is number => typeof id === 'number' && groupIds.includes(id)));
      if (restored.size > 0) setOpenIds(restored);
    } catch {
      // Corrupted value, storage disabled, or a private window that throws on access -- the
      // deterministic all-closed default above is already a correct render.
    }
    // Intentionally run once: the category list behind groupIds does not change while this
    // page is open, and re-reading on every render would fight the writes below make on click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (categoryId: number) => {
    const next = new Set(openIds);
    if (next.has(categoryId)) next.delete(categoryId);
    else next.add(categoryId);
    setOpenIds(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(next)));
    } catch {
      // A convenience, never a correctness dependency -- the in-memory state above already
      // reflects the click; this browser simply will not remember it next visit.
    }
  };

  return { isOpen: (categoryId) => openIds.has(categoryId), toggle };
}

/**
 * One category row -- a disclosure (chevron + rename field) for a parent WITH children, an
 * ordinary indented row otherwise (mirrors budgets-client.tsx EditRow's own "only a category
 * that actually has children becomes a disclosure" rule). NOT MetricCard: a category has no
 * number to be the hero and no progress bar, so a metric card here would be an empty frame
 * pretending to be data -- this is a plain flex row, the same rhythm Edit-limits already uses,
 * in an appropriate (bordered list) container instead.
 *
 * The rename field is always an input, even on a parent -- unlike a budget row's read-only
 * category name, there is no non-editable rendering of a category name to fall back to, so the
 * chevron sits BESIDE the input rather than wrapping it (an <input> cannot nest inside a
 * <button>, and the button needs its own accessible name distinct from the field beside it).
 */
function CategoryRow({
  category,
  depth,
  disclosure,
  hidden = false,
  saveCategoryName,
  saveCategoryTaxRelevant,
  archiveCategory,
}: {
  category: CategoryRecord;
  depth: 0 | 1;
  /** Present only on the one row per top-level category that actually has children. */
  disclosure?: { open: boolean; onToggle: () => void; controlsId: string };
  /** Item 2's own version of ruling U2/U3: a closed group's children stay in the DOM (hidden,
   *  not unmounted), so an in-progress rename is never discarded by collapsing the group, and a
   *  raw markup scan (goals-page.test.tsx's sibling reasoning, or a browser's find-in-page)
   *  still finds every category even before anyone opens a group. */
  hidden?: boolean;
  saveCategoryName: (formData: FormData) => Promise<{ error?: string }>;
  saveCategoryTaxRelevant: (formData: FormData) => Promise<{ error?: string }>;
  archiveCategory: (formData: FormData) => void;
}) {
  return (
    <div
      id={categoryRowId(category.id)}
      hidden={hidden}
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2 last:border-b-0 sm:px-5 ${depth === 0 ? 'bg-surface-2' : ''}`}
    >
      <div style={{ paddingLeft: `${depth * 20}px` }} className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {disclosure ? (
          <button
            type="button"
            aria-expanded={disclosure.open}
            aria-controls={disclosure.controlsId}
            aria-label={`${disclosure.open ? 'Collapse' : 'Expand'} ${category.name}`}
            onClick={disclosure.onToggle}
            className="inline-flex min-h-11 min-w-0 shrink-0 items-center py-1 sm:min-h-0"
          >
            {/* Same chevron, same rhythm as budgets-client.tsx's EditRow: closed is the
                default shape, so only the OPEN state rotates. */}
            <ExpandIcon className={`h-4 w-4 shrink-0 text-muted transition-transform ${disclosure.open ? 'rotate-90' : ''}`} />
          </button>
        ) : null}
        <AutoSaveTextInput
          name="name"
          defaultValue={category.name}
          fields={{ categoryId: String(category.id) }}
          action={saveCategoryName}
          ariaLabel={`Rename ${category.name}`}
          className={`w-44 min-w-0 ${rowInput}`}
        />
        <span className={category.isIncome ? 'badge badge--green' : 'badge badge--slate'}>
          {category.isIncome ? 'income' : 'spend'}
        </span>
        {category.isArchived ? <span className="badge badge--muted">archived</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <AutoSaveCheckbox
          name="taxRelevant"
          defaultChecked={category.taxRelevant}
          fields={{ categoryId: String(category.id) }}
          action={saveCategoryTaxRelevant}
          label={`Mark ${category.name} tax-relevant`}
          labelHidden
        />
        <form action={archiveCategory}>
          <input type="hidden" name="categoryId" value={category.id} />
          <input type="hidden" name="archived" value={category.isArchived ? '0' : '1'} />
          <button type="submit" className="btn btn--ghost btn--sm px-2 text-xs">
            {category.isArchived ? 'restore' : 'archive'}
          </button>
        </form>
      </div>
    </div>
  );
}

/** A parent row plus its own children, as siblings in the DOM (a Fragment, not a wrapping div)
 *  so `last:border-b-0` (CategoryRow's own className) still finds the true last row in the
 *  whole list -- the same reason budgets-client.tsx's EditRow recurses instead of nesting. */
function CategoryGroupRows({
  group,
  groupState,
  saveCategoryName,
  saveCategoryTaxRelevant,
  archiveCategory,
}: {
  group: CategoryGroup;
  groupState: { isOpen: (categoryId: number) => boolean; toggle: (categoryId: number) => void };
  saveCategoryName: (formData: FormData) => Promise<{ error?: string }>;
  saveCategoryTaxRelevant: (formData: FormData) => Promise<{ error?: string }>;
  archiveCategory: (formData: FormData) => void;
}) {
  const hasChildren = group.children.length > 0;
  const open = hasChildren && groupState.isOpen(group.parent.id);
  return (
    <>
      <CategoryRow
        category={group.parent}
        depth={0}
        disclosure={
          hasChildren
            ? {
                open,
                onToggle: () => groupState.toggle(group.parent.id),
                controlsId: group.children.map((child) => categoryRowId(child.id)).join(' '),
              }
            : undefined
        }
        saveCategoryName={saveCategoryName}
        saveCategoryTaxRelevant={saveCategoryTaxRelevant}
        archiveCategory={archiveCategory}
      />
      {group.children.map((child) => (
        <CategoryRow
          key={child.id}
          category={child}
          depth={1}
          hidden={!open}
          saveCategoryName={saveCategoryName}
          saveCategoryTaxRelevant={saveCategoryTaxRelevant}
          archiveCategory={archiveCategory}
        />
      ))}
    </>
  );
}

export function ManagersClient({
  categories,
  rules,
  profiles,
  profileUsage,
  rulesPackRows,
  profilePackRows,
}: {
  categories: CategoryRecord[];
  rules: MerchantRuleRecord[];
  profiles: ProfileRecord[];
  profileUsage: Record<number, ProfileUsage>;
  rulesPackRows: RulesExportRow[];
  profilePackRows: ProfilesExportRow[];
}) {
  const [createState, createCategory] = useActionState(createCategoryAction, initial);
  const [archiveState, archiveCategory] = useActionState(archiveCategoryAction, initial);
  const [ruleState, saveRule] = useActionState(updateRuleAction, initial);
  const [deleteState, removeRule] = useActionState(deleteRuleAction, initial);
  const [profileState, saveProfile] = useActionState(saveProfileMappingAction, initial);
  const [deleteProfileState, removeProfile] = useActionState(deleteProfileAction, initial);
  const [activeState, setProfileActive] = useActionState(setProfileActiveAction, initial);
  const [editing, setEditing] = useState<{ id: number; mapping: ImportMapping } | null>(null);
  const [deletingProfileId, setDeletingProfileId] = useState<number | null>(null);
  const [deactivatingProfileId, setDeactivatingProfileId] = useState<number | null>(null);

  // Item 2 (2026-08-30 plan): the same fold Budgets already uses for a category's children,
  // closed by default with the open set kept in localStorage (useCategoryGroupOpenState above).
  // Only a parent that actually HAS children is ever a disclosure -- an ordinary top-level
  // category with none never grows a chevron it would do nothing with.
  const categoryGroups = groupCategories(categories);
  const categoryGroupIds = categoryGroups.filter((group) => group.children.length > 0).map((group) => group.parent.id);
  const categoryGroupState = useCategoryGroupOpenState(categoryGroupIds);

  const parents = categories.filter((c) => c.parentId === null);
  const label = (id: number | null) => {
    if (id === null) return '—';
    const category = categories.find((c) => c.id === id);
    if (!category) return '—';
    const parent = category.parentId ? categories.find((c) => c.id === category.parentId) : undefined;
    return parent ? `${parent.name} › ${category.name}` : category.name;
  };

  const notice =
    createState.message ??
    archiveState.message ??
    ruleState.message ??
    deleteState.message ??
    profileState.message ??
    deleteProfileState.message ??
    activeState.message;
  const error =
    createState.error ??
    archiveState.error ??
    ruleState.error ??
    deleteState.error ??
    profileState.error ??
    deleteProfileState.error ??
    activeState.error;

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        eyebrow="Settings"
        title="Categories, rules and import profiles"
        description="How a line from the bank turns into something with a name and a category."
      />
      <FormError message={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <Card>
        <CardHeader
          title="Categories"
          description="Categories are archived, never deleted — transactions, rules and budgets reference them permanently. Nesting is limited to two levels. Marking one tax-relevant (below, beside its name) includes it in the tax year report."
        />
        <CardBody className="pb-4">
          <form action={createCategory} className="flex flex-wrap items-end gap-3">
            <Field label="New category">
              <input name="name" placeholder="Groceries" required className={inputClass} />
            </Field>
            <Field label="Parent">
              <select name="parentId" className={selectClass}>
                <option value="">Top level</option>
                {parents.map((parent) => (
                  <option key={parent.id} value={parent.id}>{parent.name}</option>
                ))}
              </select>
            </Field>
            <SubmitButton>Add</SubmitButton>
          </form>
        </CardBody>
        {/* Item 2: folds the same way Budgets' Edit-limits list does -- a parent with children is
            a disclosure, closed by default, its children indented beneath it. Not a TableWrap any
            more: there is no shared column header left to hang a <thead> off once a category's
            own row carries its own controls directly, the same reasoning Budgets' own row list
            replaced its table with a Card of rows. */}
        {categoryGroups.map((group) => (
          <CategoryGroupRows
            key={group.parent.id}
            group={group}
            groupState={categoryGroupState}
            saveCategoryName={saveCategoryName}
            saveCategoryTaxRelevant={saveCategoryTaxRelevant}
            archiveCategory={archiveCategory}
          />
        ))}
      </Card>

      <Card>
        <CardHeader
          title={`Merchant rules (${rules.length})`}
          description={
            <>
              A <strong className="font-semibold text-ink">rename</strong> rule changes only what you see. Saving one applies it to every existing
              matching transaction that has not been renamed by hand; deleting one puts those rows back to the bank&apos;s wording. Transactions
              renamed individually are never touched. A <strong className="font-semibold text-ink">not a transfer</strong> rule is an exact-match
              override that stops one merchant from being auto-flagged as a card payment.
            </>
          }
        />
        <CardBody className="pb-4">
          <form action={saveRule} className="flex flex-wrap items-end gap-3">
            <Field label="Pattern">
              <input name="pattern" placeholder="Normalized merchant pattern" required className={inputClass} />
            </Field>
            <Field label="Match">
              <select name="matchType" className={selectClass}>
                <option value="exact">exact</option>
                <option value="contains">contains</option>
              </select>
            </Field>
            <Field label="Kind">
              <select name="ruleKind" className={selectClass}>
                <option value="category">category</option>
                <option value="transfer">transfer</option>
                <option value="rename">rename</option>
                <option value="not_transfer">not a transfer (override)</option>
              </select>
            </Field>
            <Field label="Category">
              <select name="categoryId" className={selectClass}>
                <option value="">(none — transfer, not_transfer and rename rules)</option>
                {categoryOptionGroups(categories).map((group) =>
                  group.label === null ? (
                    <option key={group.options[0].id} value={group.options[0].id}>
                      {group.options[0].label}
                    </option>
                  ) : (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  ),
                )}
              </select>
            </Field>
            <Field label="Renames to">
              <input name="renameTo" placeholder="Display name (rename rules only)" className={inputClass} />
            </Field>
            <SubmitButton>Save rule</SubmitButton>
          </form>
        </CardBody>
        {/* Item I. minWidth is the colgroup's own total (14+6+7+13+10+5+3 = 58rem); without it the
            scroll container has nothing to scroll and the columns crush instead. A long monospace
            pattern beside a "Parent › Child" label reached ~1100px and squeezed the delete button. */}
        <TableWrap bare fixed minWidth="58rem" responsive>
          <colgroup>
            {/* A monospace merchant pattern -- the widest thing in this table by a distance. */}
            <col style={{ width: '14rem' }} />
            {/* "exact" / "contains". */}
            <col style={{ width: '6rem' }} />
            {/* A rule kind: category / transfer / rename / not_transfer. */}
            <col style={{ width: '7rem' }} />
            {/* "Parent › Child" -- the cell that used to starve the button on the right. */}
            <col style={{ width: '13rem' }} />
            {/* A rename target, usually shorter than the pattern it replaces. */}
            <col style={{ width: '10rem' }} />
            {/* A hit count in tabular figures, right-aligned. */}
            <col style={{ width: '5rem' }} />
            {/* The delete button: one small button plus padding. */}
            <col style={{ width: '3rem' }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Pattern</th>
              <th scope="col">Match</th>
              <th scope="col">Kind</th>
              <th scope="col">Category</th>
              <th scope="col">Renames to</th>
              <th scope="col" className="text-right">Hits</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id}>
                {/* v1.15.0 (responsive rows): the pattern is what tells one rule from another --
                    the same merchant pattern never repeats across rows, unlike Kind or Category
                    -- so it is the phone card's headline. No cell-stack-amount: hitCount is a
                    count of matches, not money. */}
                <td className="font-mono text-xs text-ink cell-stack-headline" data-label="Pattern">{rule.pattern}</td>
                <td className="text-xs text-muted" data-label="Match">{rule.matchType}</td>
                <td className="text-xs" data-label="Kind"><span className="badge badge--slate">{rule.ruleKind}</span></td>
                <td className="text-xs text-muted" data-label="Category">{rule.ruleKind === 'category' ? label(rule.categoryId) : '—'}</td>
                <td className="text-xs text-muted" data-label="Renames to">{rule.renameTo ?? '—'}</td>
                <td className="tabnum text-right text-xs text-muted" data-label="Hits">{rule.hitCount}</td>
                <td className="text-right cell-stack-actions" data-label="">
                  <form action={removeRule}>
                    <input type="hidden" name="ruleId" value={rule.id} />
                    <button type="submit" className="btn btn--ghost btn--sm px-2 text-xs">delete</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        <CardBody className="pt-4">
          <RulesPackPanel rows={rulesPackRows} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Import profiles"
          description="Built-in profiles are shared. Editing one saves a copy instead of changing the original."
        />
        <ul className="border-t border-line text-sm">
          {profiles.map((profile) => {
            const usage = profileUsage[profile.id] ?? { accounts: 0, imports: 0 };
            return (
            <li key={profile.id} className="border-b border-line px-5 py-3 last:border-b-0 sm:px-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium text-ink">{profile.name}</span>{' '}
                  <span className="text-xs text-subtle">{profile.institution}{profile.isBuiltin ? ' · built-in' : ''}</span>{' '}
                  {profile.mapping === null ? <span className="badge badge--red">unreadable mapping</span> : null}{' '}
                  {profile.isActive ? null : <span className="badge badge--muted">inactive</span>}
                </span>
                <div className="flex items-center gap-2">
                  {profile.mapping === null ? null : (
                    <button
                      type="button"
                      onClick={() => setEditing(editing?.id === profile.id ? null : { id: profile.id, mapping: profile.mapping! })}
                      className="btn btn--ghost btn--sm text-xs"
                    >
                      {editing?.id === profile.id ? 'close' : 'edit mapping'}
                    </button>
                  )}
                  {profile.isActive ? (
                    usage.accounts > 0 ? (
                      // Deactivating a profile accounts are pinned to needs the confirm step
                      // below first (MUST-4.3) -- this is a plain button, not a form submit.
                      <button
                        type="button"
                        onClick={() => setDeactivatingProfileId(profile.id)}
                        className="btn btn--ghost btn--sm text-xs"
                      >
                        deactivate
                      </button>
                    ) : (
                      <form action={setProfileActive}>
                        <input type="hidden" name="profileId" value={profile.id} />
                        <input type="hidden" name="isActive" value="0" />
                        <SubmitButton variant="ghost" size="sm" className="text-xs">deactivate</SubmitButton>
                      </form>
                    )
                  ) : (
                    // Reactivating is always safe and reversible -- no confirm needed, unlike
                    // deactivating a profile with pinned accounts.
                    <form action={setProfileActive}>
                      <input type="hidden" name="profileId" value={profile.id} />
                      <input type="hidden" name="isActive" value="1" />
                      <SubmitButton variant="ghost" size="sm" className="text-xs">activate</SubmitButton>
                    </form>
                  )}
                  {profile.isBuiltin ? null : (
                    <button
                      type="button"
                      onClick={() => setDeletingProfileId(profile.id)}
                      className="btn btn--ghost btn--sm money-neg text-xs"
                    >
                      delete
                    </button>
                  )}
                </div>
              </div>
              {profile.mapping === null ? (
                <p className="mt-2 text-xs text-negative-soft-fg">
                  Its stored column layout could not be read ({profile.mappingError}), so it cannot be shown or edited. Delete it
                  and set up the bank again to replace it.
                </p>
              ) : null}
              {deactivatingProfileId === profile.id && profile.isActive ? (
                <div className="mt-3 flex flex-col gap-3 rounded-md border border-line p-3">
                  <p className="text-sm text-ink">
                    Deactivate <strong className="font-semibold">{profile.name}</strong>? It will come off the import picker.{' '}
                    {describeDeactivationImpact(usage)}
                  </p>
                  <form action={setProfileActive} className="flex gap-2">
                    <input type="hidden" name="profileId" value={profile.id} />
                    <input type="hidden" name="isActive" value="0" />
                    <SubmitButton size="sm">Deactivate anyway</SubmitButton>
                    <button type="button" onClick={() => setDeactivatingProfileId(null)} className="btn btn--secondary btn--sm">
                      Cancel
                    </button>
                  </form>
                </div>
              ) : null}
              {deletingProfileId === profile.id ? (
                <div className="mt-3 flex flex-col gap-3 rounded-md border border-negative-soft p-3">
                  <p className="text-sm text-ink">
                    Delete <strong className="font-semibold">{profile.name}</strong>? This cannot be undone.{' '}
                    {describeProfileUsage(usage)}
                  </p>
                  <form action={removeProfile} className="flex gap-2">
                    <input type="hidden" name="profileId" value={profile.id} />
                    <SubmitButton variant="danger" size="sm">Delete permanently</SubmitButton>
                    <button type="button" onClick={() => setDeletingProfileId(null)} className="btn btn--secondary btn--sm">
                      Cancel
                    </button>
                  </form>
                </div>
              ) : null}
              {editing?.id === profile.id ? (
                <form action={saveProfile} className="mt-3 flex flex-col gap-3">
                  <MappingEditor mapping={editing.mapping} onChange={(next) => setEditing({ id: profile.id, mapping: next })} />
                  <input type="hidden" name="profileId" value={profile.id} />
                  <input type="hidden" name="mapping" value={JSON.stringify(editing.mapping)} />
                  <SubmitButton className="w-fit">Save mapping</SubmitButton>
                </form>
              ) : null}
            </li>
            );
          })}
        </ul>
        <CardBody className="pt-4">
          <ProfilesPackPanel rows={profilePackRows} />
        </CardBody>
      </Card>
    </div>
  );
}
