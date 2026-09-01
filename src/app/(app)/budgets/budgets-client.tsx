'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { FormError } from '@/components/FormError';
import { AutoSaveCheckbox, AutoSaveTextInput, useAutoSave } from '@/components/ui/AutoSave';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';
import { MetricCard } from '@/components/ui/MetricCard';
import { Money } from '@/components/ui/Money';
import { MonthNav } from '@/components/ui/MonthNav';
import { Notice } from '@/components/ui/Notice';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill, type PillTone } from '@/components/ui/Pill';
import { PillNav } from '@/components/ui/PillNav';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { categoryIcon, ExpandIcon } from '@/components/ui/icons';
import { monthLabel } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import type { SinkingFund } from '@/lib/bills';
import type { BudgetRow, BudgetScope, CategoryTransactionRow } from '@/lib/budgets';
import { MIN_HISTORY_MONTHS } from '@/lib/predict/constants';
import type { BudgetPredictions, CategorySuggestion, SectionPredictions } from '@/lib/predict/suggest';
// Type-only: a 'use client' file may never VALUE-import from a module that reaches @/db (Lane
// 1's src/lib/savings-target.ts does, for getSavingsTarget/saveSavingsTarget) --
// tests/ops/client-bundle.test.ts guards exactly this. Every name below is erased at compile
// time, so this edge never exists in the bundled graph at all.
import type { SavingsProgress, SavingsTarget, SavingsTargetMode } from '@/lib/savings-target';
import {
  applyAllSuggestionsAction,
  applySuggestionAction,
  copyPreviousMonthAction,
  setLimitAction,
  setRolloverAction,
  setSavingsTargetAction,
  type BudgetActionState,
} from './actions';
// A NEW file, not ./actions.ts (2026-08-30 plan, Lane 1's file list leaves that module
// untouched) -- imported the SAME way ./actions already is, by a relative specifier, so
// tests/ops/client-bundle.test.ts's walk of this file's @/-qualified value imports never has a
// reason to follow either one into src/lib/budgets.ts's own @/db/client import. See that file's
// own doc comment for the rest of the reasoning.
import { categoryTransactionsAction } from './category-transactions-action';

const initial: BudgetActionState = {};

/** Bound once: both actions are `(prevState, formData)` for useActionState, and the auto-save
 *  controls want `(formData)`. No server-side change of any kind. */
const saveLimit = (formData: FormData) => setLimitAction({}, formData);
const saveRollover = (formData: FormData) => setRolloverAction({}, formData);
// Named `saveTarget`, not `saveSavingsTarget` -- that name belongs to the Lane 1 library
// function of the same job (src/lib/savings-target.ts), and this file must never import that
// module as a VALUE (tests/ops/client-bundle.test.ts). Same bind-the-first-argument reasoning
// as saveLimit/saveRollover above.
const saveTarget = (formData: FormData) => setSavingsTargetAction({}, formData);

/** '' for no target, else `mode:value` -- cheap enough to compare across renders without a
 *  deep-equal, and it is exactly the two fields that decide whether the SERVER'S row changed. */
function targetKey(target: SavingsTarget | null): string {
  return target === null ? '' : `${target.mode}:${target.value}`;
}

function targetValueText(target: SavingsTarget | null): string {
  if (target === null) return '';
  return target.mode === 'percent' ? String(target.value) : (target.value / 100).toFixed(2);
}

/**
 * Ruling T6: the savings target lives on Budgets, beside the month it applies to, not in
 * Settings. Ruling T2: a target is a percent of income OR a fixed amount, never both -- so
 * there is exactly one value field, and its UNIT is whatever `mode` currently is.
 *
 * Auto-save, no Save button (v1.11.0 ruling R1 / tests/ops/row-controls.test.ts) -- but this is
 * not an AutoSaveSelect/AutoSaveTextInput pair the way the rows above it are, because those two
 * each write ONE field and savings_targets has no partial-row upsert: mode and value must reach
 * the server TOGETHER every time either one is saved. So both are lifted into this component's
 * own state, and only the value field's commit ever calls the server -- switching mode is local
 * only (see the comment on its onChange) until a value for the new unit is actually typed.
 */
function SavingsTargetControl({ month, progress }: { month: string; progress: SavingsProgress | null }) {
  const target = progress?.target ?? null;
  const [mode, setMode] = useState<SavingsTargetMode>(target?.mode ?? 'percent');
  const [valueText, setValueText] = useState(targetValueText(target));
  const { save, pending, status, error } = useAutoSave(saveTarget, { month, mode });
  const valueInput = useRef<HTMLInputElement | null>(null);
  /** The server row this control has already reacted to -- same resync discipline as
   *  AutoSaveTextInput/AutoSaveSelect (v1.12.1 ruling R3): revalidatePath after a save, or
   *  another admin changing the target, re-renders this component with new props without
   *  remounting it, and nothing else here would ever pick that up. */
  const serverKey = useRef(targetKey(target));

  useEffect(() => {
    if (pending) return;
    const key = targetKey(target);
    if (key === serverKey.current) return;
    // A focused value field is mid-edit; the blur that eventually follows commits whatever was
    // typed, same reasoning as AutoSaveTextInput's own resync guard.
    if (valueInput.current !== null && document.activeElement === valueInput.current) return;
    serverKey.current = key;
    setMode(target?.mode ?? 'percent');
    setValueText(targetValueText(target));
  }, [target, pending]);

  const commitValue = () => {
    const raw = valueText.trim();
    if (raw === '') return; // Nothing typed yet -- there is no value to save.
    // No onSuccess resync here: revalidatePath (setSavingsTargetAction) re-renders this
    // component with a fresh `progress` prop reflecting exactly what the server just accepted,
    // and the effect above picks that up the same way it picks up any other change in origin
    // (another admin, or "Copy previous month"). Guessing the server's own formatting here --
    // an amount mode's `value` is CENTS, not the dollar string just typed -- would only recreate
    // the mismatch this effect exists to avoid.
    save('value', raw);
  };

  const resolved = (() => {
    if (target === null) return null;
    if (target.mode === 'amount') return `Fixed at ${formatCents(target.value)} every month.`;
    // Ruling T5: a percent target is provisional until the month closes, because income is
    // still landing -- this sentence names both the percent it came from and the figure it
    // resolves to today, rather than one bare dollar amount with no context for why it will
    // keep moving.
    if (progress?.targetCents == null) return `${target.value}% of income -- no income recorded yet this month.`;
    return `${target.value}% of income so far — ${formatCents(progress.targetCents)}. Provisional until the month closes.`;
  })();

  return (
    <Card as="section">
      <CardHeader
        title="Savings target"
        description="What this household means by “keep enough” each month -- a percent of income or a fixed amount, applied to the month shown above."
      />
      <CardBody className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Mode
          <select
            value={mode}
            onChange={(event) => {
              const nextMode = event.target.value as SavingsTargetMode;
              setMode(nextMode);
              // A percent and a dollar amount are not the same number -- carrying the old
              // digits into the new unit would silently save, say, "20" (a 20% target) as
              // $20.00 the instant amount mode is picked. Nothing saves until a real value is
              // typed for whichever unit is now selected.
              setValueText('');
            }}
            className="field-control w-auto min-h-11 px-2 py-1 text-sm sm:min-h-0"
            aria-label="Savings target mode"
          >
            <option value="percent">% of income</option>
            <option value="amount">Fixed amount</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          {mode === 'percent' ? 'Percent' : 'Amount ($)'}
          <input
            ref={valueInput}
            value={valueText}
            onChange={(event) => setValueText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              commitValue();
            }}
            onBlur={commitValue}
            inputMode={mode === 'percent' ? 'numeric' : 'decimal'}
            placeholder={mode === 'percent' ? '20' : '250.00'}
            aria-label={mode === 'percent' ? 'Savings target percent' : 'Savings target amount'}
            className="field-control w-24 min-h-11 px-2 py-1 text-right text-sm sm:min-h-0"
          />
        </label>
        <span role="status" aria-live="polite" className="text-xs text-muted">
          {pending ? 'Saving…' : status === 'saved' ? 'Saved' : ''}
        </span>
        {error ? (
          <span role="alert" className="text-xs font-medium text-negative-soft-fg">
            {error}
          </span>
        ) : null}
        <p className="w-full text-xs text-muted">
          {resolved ?? 'No savings target set for this month yet.'}
        </p>
      </CardBody>
    </Card>
  );
}

/** Everything a row needs from the predictions, resolved once per section. */
interface RowPredictions {
  suggestionOf: Map<number, CategorySuggestion>;
  projectionOf: Map<number, number>;
  /** MUST-14.4: the number the projection's title sentence names. */
  dayOfMonth: number;
}

/**
 * Unique per (scope, user, category). Used as a plain element id -- an Edit-limits disclosure's
 * `aria-controls` names exactly the rows it hides, and two sections that happen to share a
 * category id (a household row and someone's personal row both named "Hobbies") never collide on
 * one DOM id. Pre-dates the 2026-08-30 card redesign (it named a `<tr>` then); the shape survives
 * unchanged because nothing about it was ever about being a table row specifically.
 */
function rowId(scope: BudgetScope, userId: number | null, categoryId: number): string {
  return `budget-row-${scope}-${userId ?? 'h'}-${categoryId}`;
}

/** What each section's collapse-state hook hands back to the header that renders it. */
interface GroupOpenState {
  isOpen: (categoryId: number) => boolean;
  toggle: (categoryId: number) => void;
  expandAll: () => void;
  collapseAll: () => void;
  /** Drives the one Expand-all/Collapse-all button's own label -- "collapse" only once every
   *  group in the section is already open. */
  anyCollapsed: boolean;
}

/**
 * Ruling U5: which category groups are open is a viewing preference, not household data -- it
 * lives in THIS browser's localStorage, never in the database, and it is a convenience the page
 * must render correctly without (a private window, cleared site data, or storage that simply
 * throws). Every read and write below is wrapped in try/catch, and a failure is treated as
 * "nothing was ever saved" rather than surfaced anywhere.
 *
 * Ruling U3: the very first render -- server and client alike, before the effect below has ever
 * run -- is always "every group closed" (`new Set()`), so the page has the same shape on every
 * visit regardless of what an earlier visit left behind. The effect only ever layers a
 * previously-saved OPEN set on top of that deterministic default once localStorage has actually
 * been read, which is also why it runs after mount rather than during the initial render.
 *
 * Lane 1 (2026-08-30 plan): this same state now drives TWO surfaces that used to be one -- a
 * View-mode card's "View breakdown" footer action, and an Edit-limits row's disclosure chevron --
 * because both ask the identical question ("are this category's children showing right now?")
 * and a household that opens "Housing" in one mode should not find it closed again in the other.
 */
function useGroupOpenState(storageKey: string, groupIds: number[]): GroupOpenState {
  const [openIds, setOpenIds] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const restored = new Set(parsed.filter((id): id is number => typeof id === 'number' && groupIds.includes(id)));
      if (restored.size > 0) setOpenIds(restored);
    } catch {
      // Corrupted value, storage disabled, or a private window that throws on access -- the
      // deterministic all-closed default above is already a correct render, so there is
      // nothing here to repair.
    }
    // Intentionally keyed on storageKey alone: the category list behind groupIds does not
    // change while this page is open, and re-reading localStorage every time a render happens
    // to produce a new array identity would fight the writes `persist` below makes on click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const persist = (next: Set<number>) => {
    setOpenIds(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(Array.from(next)));
    } catch {
      // A convenience, never a correctness dependency (ruling U5) -- the in-memory state above
      // already reflects the click; this browser simply will not remember it next visit.
    }
  };

  return {
    isOpen: (categoryId) => openIds.has(categoryId),
    toggle: (categoryId) => {
      const next = new Set(openIds);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      persist(next);
    },
    expandAll: () => persist(new Set(groupIds)),
    collapseAll: () => persist(new Set()),
    anyCollapsed: groupIds.some((id) => !openIds.has(id)),
  };
}

/** Ruling D5, mapped onto Pill's own tone vocabulary (Pill has no 'calm'/'over' of its own --
 *  ProgressBar's BarTone and Pill's PillTone are two different enums naming the same three
 *  states, see Pill.tsx's own doc comment on why). */
function pillTone(pct: number): PillTone {
  if (pct > 100) return 'negative';
  if (pct >= 80) return 'warning';
  return 'positive';
}

/** The household total bar's own percentage -- the one thing budgetTotals() reports as a pair of
 *  cents rather than a ready-made pct the way a BudgetRow already carries one. Same $0-limit rule
 *  budgets.ts's own (unexported) computePct uses: a $0 limit with real spend against it is maximally
 *  over, not "no data". */
function totalPct(limitCents: number, spentCents: number): number {
  if (limitCents === 0) return spentCents > 0 ? 100 : 0;
  return Math.round((spentCents / limitCents) * 100);
}

/**
 * A category's own transactions for one month (Lane 1 / ruling: "a child expands to its own
 * transactions"). Fetched on demand, the moment a breakdown row is opened -- not pre-loaded for
 * every category on the page, which is what "the smallest query that works" (the plan's own
 * words for categoryTransactions, src/lib/budgets.ts) is really asking for on the CLIENT side
 * too: a household might open one child out of thirty without ever wanting the other twenty-nine
 * fetched.
 */
function CategoryTransactionsPanel({
  scope,
  userId,
  month,
  categoryId,
  categoryName,
}: {
  scope: BudgetScope;
  userId: number | null;
  month: string;
  categoryId: number;
  categoryName: string;
}) {
  type PanelState =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'loaded'; rows: CategoryTransactionRow[] };
  const [state, setState] = useState<PanelState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    categoryTransactionsAction({ scope, userId, month, categoryId })
      .then((result) => {
        if (cancelled) return;
        setState('error' in result ? { status: 'error', message: result.error } : { status: 'loaded', rows: result.rows });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', message: 'Could not load transactions. Try again.' });
      });
    return () => {
      cancelled = true;
    };
  }, [scope, userId, month, categoryId]);

  if (state.status === 'loading') {
    return <p className="px-4 py-3 text-xs text-muted sm:px-5">Loading transactions…</p>;
  }
  if (state.status === 'error') {
    return (
      <p role="alert" className="px-4 py-3 text-xs font-medium text-negative-soft-fg sm:px-5">
        {state.message}
      </p>
    );
  }
  if (state.rows.length === 0) {
    return <p className="px-4 py-3 text-xs text-subtle sm:px-5">No transactions in {categoryName} this month.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-line">
      {state.rows.map((row) => (
        <ListRow
          key={row.id}
          direction={row.amountCents >= 0 ? 'in' : 'out'}
          title={row.merchant}
          meta={row.date}
          amount={<Money cents={row.amountCents} />}
        />
      ))}
    </ul>
  );
}

/**
 * One child category, inside an open parent's "View breakdown" -- a ListRow (ruling D1) plus its
 * own small bar underneath, since ListRow itself has no bar slot to give it (that gap is reported
 * here rather than forked into a second ListRow variant: the bar is a SIBLING <li> using the
 * shared ProgressBar, not a change to ListRow). A trailing button expands this one child's own
 * transactions below it -- "a child expands to its own transactions".
 */
function ChildBreakdownRow({
  child,
  scope,
  userId,
  month,
  sinkingFund,
}: {
  child: BudgetRow;
  scope: BudgetScope;
  userId: number | null;
  month: string;
  /** v1.13.0 ruling R11 / micro-ruling M9: this child's own sinkingFundsFor() entry, if a bill
   *  is linked to it. Shown here (not just behind Edit limits) because budgets-page.test.tsx's
   *  household-viewer test reads this sentence straight off the loaded page with nothing
   *  expanded -- ruling U2/U3's "a collapsed group's children stay in the DOM, hidden rather
   *  than unmounted" applies to the View-mode breakdown exactly as it always did to the table. */
  sinkingFund: SinkingFund | null;
}) {
  const [txOpen, setTxOpen] = useState(false);
  const hasLimit = child.limitCents !== null;
  const pct = child.pct ?? 0;
  const Icon = categoryIcon(child.categoryName);
  const metaText = hasLimit ? `${Math.round(pct)}% of ${formatCents(child.limitCents as number)}` : 'No limit set';

  return (
    <>
      <ListRow
        icon={<Icon className="h-4 w-4" />}
        title={
          <>
            {child.categoryName}
            {child.isArchived ? <span className="ml-1.5 text-xs font-normal text-subtle">(archived)</span> : null}
          </>
        }
        meta={metaText}
        amount={<Money cents={child.spentCents} plain />}
        trailing={
          <button
            type="button"
            className="btn btn--ghost btn--sm px-2 text-xs"
            aria-expanded={txOpen}
            onClick={() => setTxOpen((open) => !open)}
          >
            {txOpen ? 'Hide transactions' : 'View transactions'}
          </button>
        }
      />
      {hasLimit ? (
        <li className="px-4 pb-2 sm:px-5">
          <ProgressBar pct={pct} label={`${child.categoryName} budget used`} />
        </li>
      ) : null}
      {sinkingFund ? (
        <li className="px-4 pb-2 text-xs text-muted sm:px-5">
          {/* Ruling R11: rollover IS the envelope; this sentence is what makes it legible. It
              reports what the carry already is -- it neither sets a target nor changes the limit. */}
          Accumulating for {sinkingFund.itemName} — {formatCents(sinkingFund.carriedCents)} of{' '}
          {formatCents(sinkingFund.targetCents)} by {sinkingFund.dueDate}
        </li>
      ) : null}
      {txOpen ? (
        <li className="bg-surface-2">
          <CategoryTransactionsPanel
            scope={scope}
            userId={userId}
            month={month}
            categoryId={child.categoryId}
            categoryName={child.categoryName}
          />
        </li>
      ) : null}
    </>
  );
}

/**
 * v1.21.0 item 2 (owner's screenshot: a parent reading $628.55 over children totalling $183.55).
 * The label is **"Not in a sub-category"** -- reused verbatim wherever this same bucket shows up
 * elsewhere (the un-rolled Reports breakdown names it identically, per the 2026-08-30 plan).
 *
 * Deliberately its own small component rather than a `BudgetRow`-shaped stand-in fed into
 * ChildBreakdownRow: this bucket has no limit (so no bar, no sinking fund, no "N% of $X" meta --
 * it is not a category, just money with no sub-category of its own), and its own
 * "View transactions" needs no query change -- `categoryId={row.categoryId}` is the PARENT's own
 * id, and categoryTransactions (src/lib/budgets.ts) already filters EFFECTIVE_CATEGORY =
 * categoryId exactly (no rollup), so it returns precisely this bucket's rows for free.
 */
function DirectSpendRow({
  row,
  scope,
  userId,
  month,
}: {
  row: BudgetRow;
  scope: BudgetScope;
  userId: number | null;
  month: string;
}) {
  const [txOpen, setTxOpen] = useState(false);
  const Icon = categoryIcon(row.categoryName);

  return (
    <>
      <ListRow
        icon={<Icon className="h-4 w-4" />}
        title="Not in a sub-category"
        meta="No limit set"
        amount={<Money cents={row.directSpentCents} plain />}
        trailing={
          <button
            type="button"
            className="btn btn--ghost btn--sm px-2 text-xs"
            aria-expanded={txOpen}
            onClick={() => setTxOpen((open) => !open)}
          >
            {txOpen ? 'Hide transactions' : 'View transactions'}
          </button>
        }
      />
      {txOpen ? (
        <li className="bg-surface-2">
          <CategoryTransactionsPanel
            scope={scope}
            userId={userId}
            month={month}
            categoryId={row.categoryId}
            categoryName="Not in a sub-category"
          />
        </li>
      ) : null}
    </>
  );
}

/**
 * View mode's one card per top-level category (the "budgets stops being a table" ruling). Uses
 * MetricCard verbatim (ruling D1): icon from categoryIcon, a subtitle that says something real, a
 * percentage Pill, spent as the hero with "of $X" beside it, a ProgressBar, and the remaining/over
 * sentence as status. The footer action is "View breakdown" for a category with children (which
 * expands them as ChildBreakdownRows) or "View transactions" for a leaf category (which expands
 * this category's own transactions directly) -- either way the card spans the full grid row while
 * open, so the breakdown is never squeezed into a third of the width.
 */
function BudgetCategoryCard({
  row,
  scope,
  userId,
  month,
  groupState,
  predict,
  sinkingFunds,
}: {
  row: BudgetRow;
  scope: BudgetScope;
  userId: number | null;
  month: string;
  /** Only consulted when row.children.length > 0. A leaf card's "View transactions" is a local,
   *  unpersisted peek (ruling U5 scopes localStorage to GROUP disclosure, not to a single leaf's
   *  transaction list), so it keeps its own useState below instead. */
  groupState: GroupOpenState;
  predict: RowPredictions | null;
  /** v1.13.0 ruling R11 / micro-ruling M9, keyed by category id -- looked up for this row's OWN
   *  category and passed through so every ChildBreakdownRow can look up its own entry too. */
  sinkingFunds: Record<number, SinkingFund>;
}) {
  const [leafTxOpen, setLeafTxOpen] = useState(false);
  const hasChildren = row.children.length > 0;
  const isOpen = hasChildren ? groupState.isOpen(row.categoryId) : leafTxOpen;
  const hasLimit = row.limitCents !== null;
  const pct = row.pct ?? 0;
  const Icon = categoryIcon(row.categoryName);
  const overChildren = row.children.filter((child) => child.overBudget).length;
  const projection = predict !== null ? (predict.projectionOf.get(row.categoryId) ?? null) : null;
  const sinkingFund = sinkingFunds[row.categoryId] ?? null;

  // v1.21.0 item 2: "N categories" used to name the direct-spend bucket as if it were one of
  // them -- it is not (it carries no limit, so it can never be "over") -- so this reads
  // "N sub-categories" now, and overChildren above is already computed from `row.children`
  // alone, which never includes that bucket (see BudgetRow.directSpentCents's own doc comment).
  const subtitle = hasChildren
    ? `${row.children.length} sub-categor${row.children.length === 1 ? 'y' : 'ies'} · ${overChildren} over`
    : undefined;

  const statusText = !hasLimit
    ? 'No limit set for this month'
    : row.overBudget
      ? `${formatCents(Math.abs(row.remainingCents ?? 0))} over budget`
      : `${formatCents(row.remainingCents ?? 0)} remaining`;

  return (
    <MetricCard
      className={isOpen ? 'lg:col-span-3' : ''}
      icon={<Icon className="h-5 w-5" />}
      title={
        <>
          {row.categoryName}
          {row.isArchived ? <span className="ml-1.5 text-xs font-normal text-subtle">(archived)</span> : null}
        </>
      }
      subtitle={subtitle}
      pill={hasLimit ? <Pill tone={pillTone(pct)}>{Math.round(pct)}%</Pill> : <Pill tone="neutral">No limit</Pill>}
      value={formatCents(row.spentCents)}
      compare={hasLimit ? `of ${formatCents(row.limitCents as number)}` : undefined}
      bar={hasLimit ? <ProgressBar pct={pct} label={`${row.categoryName} budget used`} /> : undefined}
      status={
        <>
          {statusText}
          {projection !== null ? (
            <>
              {' '}
              ·{' '}
              <span title={`Assumes the rest of the month looks like the ${predict?.dayOfMonth} days so far.`}>
                On pace for {formatCents(projection, { currency: true })}
              </span>
            </>
          ) : null}
          {sinkingFund ? (
            <>
              <br />
              Accumulating for {sinkingFund.itemName} — {formatCents(sinkingFund.carriedCents)} of{' '}
              {formatCents(sinkingFund.targetCents)} by {sinkingFund.dueDate}
            </>
          ) : null}
        </>
      }
      action={
        <button
          type="button"
          className="btn btn--ghost btn--sm w-fit px-0 text-xs"
          aria-expanded={isOpen}
          onClick={() => (hasChildren ? groupState.toggle(row.categoryId) : setLeafTxOpen((open) => !open))}
        >
          {hasChildren ? (isOpen ? 'Hide breakdown' : 'View breakdown') : isOpen ? 'Hide transactions' : 'View transactions'}
        </button>
      }
    >
      {hasChildren ? (
        // Ruling U2/U3, carried over from the table this replaces: a closed breakdown's children
        // stay in the DOM -- hidden via the real HTML attribute, not conditionally unmounted --
        // so a sinking-fund sentence or an over-budget marker on one of them is still readable by
        // a page-text scan (tests/app/budgets-page.test.tsx does exactly this) and by
        // find-in-page/assistive tech, even before anyone clicks "View breakdown". Unlike a
        // fetch-backed transactions panel, this list costs nothing extra to keep mounted -- it is
        // plain data budgetProgress() already returned.
        <ul hidden={!isOpen} className="-mx-4 mt-1 flex flex-col divide-y divide-line sm:-mx-5">
          {row.children.map((child) => (
            <ChildBreakdownRow
              key={child.categoryId}
              child={child}
              scope={scope}
              userId={userId}
              month={month}
              sinkingFund={sinkingFunds[child.categoryId] ?? null}
            />
          ))}
          {/* v1.21.0 item 2: rendered last, and only when this parent actually carries direct
              spend -- a parent whose money always lands on a child renders exactly as it always
              has, with nothing appended. */}
          {row.directSpentCents !== 0 ? (
            <DirectSpendRow row={row} scope={scope} userId={userId} month={month} />
          ) : null}
        </ul>
      ) : isOpen ? (
        // A leaf's transactions are NOT pre-fetched data -- see CategoryTransactionsPanel's own
        // doc comment ("fetched on demand") -- so this one stays conditionally mounted rather
        // than always-present-but-hidden: keeping it mounted-but-hidden would fire a server
        // action for every leaf category on every page load, which is the opposite of "the
        // smallest query that works".
        <div className="-mx-4 mt-1 sm:-mx-5">
          <CategoryTransactionsPanel
            scope={scope}
            userId={userId}
            month={month}
            categoryId={row.categoryId}
            categoryName={row.categoryName}
          />
        </div>
      ) : null}
    </MetricCard>
  );
}

/**
 * Edit-limits mode's one row -- "the one thing the table did better", kept as its own compact
 * mode rather than folded into the card (a card busy enough to show spend, a bar and a pill has
 * no room left for an input, a rollover checkbox, a suggestion button and a carry sentence too).
 * Recursive, same as the table's old Row: a parent renders itself then its own children, indented
 * one level further. A disclosure row's children stay in the DOM (hidden, not unmounted) whether
 * this row is a top-level category or the parent that owns them -- see the `hidden` prop's own
 * doc comment below for why.
 */
function EditRow({
  row,
  depth,
  scope,
  userId,
  month,
  applyAction,
  editable,
  canToggleRollover,
  rolloverOn,
  predict,
  sinkingFunds,
  hidden = false,
  disclosure,
  onGroupLimitSaved,
}: {
  row: BudgetRow;
  depth: number;
  scope: BudgetScope;
  userId: number | null;
  month: string;
  applyAction: (formData: FormData) => void;
  editable: boolean;
  /**
   * v1.7.0 Task 11: admin, or for a personal-scope row its own owner -- a STRICTER gate than
   * `editable`, which lets every member edit a household row's amount. Rollover is a policy
   * choice about how a shared household budget behaves across months, so toggling it there is
   * admin-only; setRolloverAction carries the server-side twin of this check.
   */
  canToggleRollover: boolean;
  /** Category ids with rollover currently on, for this section (scope + user). */
  rolloverOn: Set<number>;
  predict: RowPredictions | null;
  /** v1.13.0 ruling R11 / micro-ruling M9: one linked bill's sinking-fund progress, keyed by
   *  category id (sinkingFundsFor, src/lib/bills.ts). */
  sinkingFunds: Record<number, SinkingFund>;
  /**
   * Ruling U2/U3: a collapsed group's children stay in the DOM -- hidden, not unmounted -- so an
   * edit in progress in one of them is never discarded by opening or closing the group, and
   * anything reading the page's raw markup (a browser's own find-in-page, an assistive-tech
   * tree walk) still sees the real figures even while the group is visually closed. Only ever
   * true for a depth-1 row: categories are limited to two levels (src/lib/categories.ts), so a
   * depth-1 row never has children of its own to pass this down to.
   */
  hidden?: boolean;
  /** Present only on the one EditRow per top-level category that actually has children (ruling
   *  U2: a parent with no children stays an ordinary row, so this is never passed for one).
   *  Carries everything a disclosure toggle needs to announce and control itself. */
  disclosure?: { open: boolean; onToggle: () => void };
  /** Ruling U6: bubbles a successful limit save -- this row's own, or (via the recursive call
   *  below) any child's -- up to whichever EditRow owns the "children add up to more than the
   *  parent" warning. Undefined on that owning row itself, which is how it knows to keep the
   *  report rather than forward it again. */
  onGroupLimitSaved?: (categoryId: number, previousBaseCents: number | null) => void;
}) {
  const suggestion = predict?.suggestionOf.get(row.categoryId) ?? null;
  const sinkingFund = sinkingFunds[row.categoryId] ?? null;

  // v1.12.1 (item X / UX-4, fix round 2). Clearing used to fire-and-forget the result of
  // setLimitAction (`void setLimitAction(...)`): a failure -- cross-origin rejection, someone
  // else's personal budget -- vanished with no message and the row looked cleared when it was
  // not. This reads the result and renders it inline beside the button, the same way
  // AutoSaveTextInput's own ErrorLine renders a failed save next to its control. Success needs
  // no message: the row re-rendering with `baseLimitCents: null` (and the clear button gone)
  // already says so.
  const [clearError, setClearError] = useState<string | null>(null);
  const clearLimit = async (formData: FormData) => {
    const result = await setLimitAction({}, formData);
    setClearError(result.error ?? null);
  };

  // Ruling U6's bookkeeping. Declared unconditionally (hooks cannot be conditional) even though
  // it is only ever READ on the one EditRow that also received `disclosure` -- an ordinary row,
  // or a child row that only ever forwards its own edits upward via `onGroupLimitSaved`, never
  // looks at its own copy of this state.
  const [ownGroupEdit, setOwnGroupEdit] = useState<{ categoryId: number; previousBaseCents: number | null } | null>(null);
  const [warningPending, setWarningPending] = useState(false);
  const [warningError, setWarningError] = useState<string | null>(null);

  // A child forwards through the callback its own parent handed it; the group header (which
  // receives no such callback, since nothing sits above it) is where a report actually lands.
  const reportLimitEdit =
    onGroupLimitSaved ??
    ((categoryId: number, previousBaseCents: number | null) => setOwnGroupEdit({ categoryId, previousBaseCents }));

  // The auto-save control below already calls setLimitAction (via `saveLimit`); this only adds
  // the bookkeeping ruling U6's Undo button needs. A real failure still surfaces exactly the way
  // it always has -- AutoSaveTextInput's own ErrorLine, reading the same `result.error`.
  const trackedSaveLimit = async (formData: FormData) => {
    const previousBaseCents = row.baseLimitCents;
    const result = await saveLimit(formData);
    if (!result.error) reportLimitEdit(row.categoryId, previousBaseCents);
    return result;
  };

  // Ruling U6: summed on the BASE limit, not the effective one -- rollover's carried-forward
  // cents (carryCents) answer a different question (what survived from past underspend), and
  // folding it in here would make "Raise Housing to $X" write a number nobody actually typed
  // into any field. Only meaningful on the one EditRow that owns a disclosure; every other row
  // leaves these at 0/false and renders nothing that reads them.
  const childrenBaseSumCents = disclosure
    ? row.children.reduce((sum, child) => sum + (child.baseLimitCents ?? 0), 0)
    : 0;
  const overParentLimit = disclosure !== undefined && row.baseLimitCents !== null && childrenBaseSumCents > row.baseLimitCents;

  const submitLimitFor = (categoryId: number, cents: number | null) => {
    const formData = new FormData();
    formData.set('scope', scope);
    formData.set('userId', userId === null ? '' : String(userId));
    formData.set('month', month);
    formData.set('categoryId', String(categoryId));
    formData.set('amount', cents === null ? '' : (cents / 100).toFixed(2));
    return saveLimit(formData);
  };

  const raiseParentToChildrenSum = async () => {
    setWarningPending(true);
    setWarningError(null);
    const previousBaseCents = row.baseLimitCents;
    const result = await submitLimitFor(row.categoryId, childrenBaseSumCents);
    setWarningPending(false);
    if (result.error) {
      setWarningError(result.error);
      return;
    }
    setOwnGroupEdit({ categoryId: row.categoryId, previousBaseCents });
  };

  const undoLastGroupEdit = async () => {
    if (ownGroupEdit === null) return;
    setWarningPending(true);
    setWarningError(null);
    const result = await submitLimitFor(ownGroupEdit.categoryId, ownGroupEdit.previousBaseCents);
    setWarningPending(false);
    if (result.error) {
      setWarningError(result.error);
      return;
    }
    setOwnGroupEdit(null);
  };

  return (
    <>
      <div
        id={rowId(scope, userId, row.categoryId)}
        hidden={hidden}
        className={`border-b border-line px-4 py-2 last:border-b-0 sm:px-5 ${depth === 0 ? 'bg-surface-2' : ''}`}
      >
        {/* 2026-09-01 fix (owner's screenshot: "when roll over text comes in it messes up the
            allignemnt"). Tier 1 -- every CONTROL in the row (name/disclosure, the amount input
            or its read-only span, clear, the suggestion button, the rollover checkbox) lives in
            this one flex-wrap container, and nothing else does. The carried-amount and
            sinking-fund sentences used to be flex ITEMS in here too, each carrying `w-full` --
            and `w-full` inside `flex-wrap` forces a line break, so on the one row that had
            something to report, every control declared after that note got shoved onto a second
            line while its neighbours (nothing to report) stayed on one. Moving both notes below
            this div entirely (Tier 2, at the bottom of this component) removes them from this
            flex layout altogether: a control's position here now depends only on the OTHER
            controls, never on whether a note happens to exist this month. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* 2026-08-30 fix (owner's screenshot): "Food" and "Transport" clipped their own "Over
              b…" pill on a narrow phone. This div had no `flex-wrap` of its own, and Pill.tsx
              carries `shrink-0` -- so once the name (which had no `min-w-0`, and therefore
              refused to shrink below its own text width either) and the pill together outgrew
              the row, neither could give ground and the excess just overflowed past Card's own
              `overflow-hidden` edge instead of reflowing. `flex-wrap` here lets the pill drop to
              its own line under the name instead of fighting it for the same one. */}
          <div style={{ paddingLeft: `${depth * 20}px` }} className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {disclosure ? (
              <button
                type="button"
                aria-expanded={disclosure.open}
                aria-controls={row.children.map((child) => rowId(scope, userId, child.categoryId)).join(' ')}
                onClick={disclosure.onToggle}
                // `min-w-0`: a flex item's default `min-width: auto` is its own content size, which
                // is what forced this button to hold its full width even when the row had no room
                // left for the pill beside it. Letting it shrink is what gives `flex-wrap` above
                // something to actually wrap around.
                className="inline-flex min-h-11 min-w-0 items-center gap-1.5 py-1 text-left font-medium text-ink sm:min-h-0"
              >
                {/* Ruling U3: closed is the page's default shape, so the chevron points at the
                    direction opening will take it -- ExpandIcon (lucide's ChevronRight) already
                    points sideways at rest, so only the OPEN state needs a rotation, the reverse
                    of the hand-drawn ChevronDownIcon this replaces. */}
                <ExpandIcon className={`h-4 w-4 shrink-0 text-muted transition-transform ${disclosure.open ? 'rotate-90' : ''}`} />
                {row.categoryName}
              </button>
            ) : (
              <span className={`min-w-0 ${depth === 0 ? 'font-medium text-ink' : 'text-muted'}`}>{row.categoryName}</span>
            )}
            {row.isArchived ? <span className="text-xs text-subtle">(archived)</span> : null}
            {/* Ruling U3: the marker that lets an over-budget group still announce itself while its
                disclosure is closed -- a different signal from the U6 warning below, which is
                about the children's LIMITS outgrowing the parent's, not about actual spend. */}
            {disclosure && row.overBudget ? <Pill tone="negative">Over budget</Pill> : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {row.isArchived || !editable ? (
              // Two reasons a limit is not editable here. Archived categories can no longer
              // be actively budgeted (spec section 3) — the row is a read-only record of the
              // spend it still rolled up this month. And a non-admin looking at someone
              // else's personal budget may only read it: setLimitAction rejects the write,
              // so rendering an input that always fails is a promise the server won't keep.
              <span className="text-xs text-subtle">
                {row.limitCents === null
                  ? 'read-only'
                  : row.baseLimitCents !== null && row.carryCents > 0
                    ? `${formatCents(row.baseLimitCents)} plus ${formatCents(row.carryCents)} carried · read-only`
                    : `${formatCents(row.limitCents)} · read-only`}
              </span>
            ) : (
              <>
                {/* This must default to the BASE limit, never the effective `limitCents`: a save
                    writes the base (setLimitAction -> upsertBudget), so defaulting to the
                    effective number would bake the carry into the base on the next edit. */}
                <AutoSaveTextInput
                  name="amount"
                  defaultValue={row.baseLimitCents === null ? '' : (row.baseLimitCents / 100).toFixed(2)}
                  fields={{
                    scope,
                    userId: userId === null ? '' : String(userId),
                    month,
                    categoryId: String(row.categoryId),
                  }}
                  action={trackedSaveLimit}
                  ariaLabel={`Monthly limit for ${row.categoryName}`}
                  inputMode="decimal"
                  placeholder="none"
                  // 2026-08-30 fix: this className used to REPLACE AutoSaveTextInput's own default
                  // (AUTO_SAVE_CONTROL), which is the only place `min-h-11 sm:min-h-0` lived --
                  // so this one input, alone among the row's auto-save controls, had no 44px
                  // floor on a phone. Carried over explicitly rather than reverting to the
                  // default class, since `w-24 ... text-right text-xs` is still what this
                  // particular cell needs at every width.
                  className="field-control w-24 px-2 py-1 text-right text-xs min-h-11 sm:min-h-0"
                />
                {row.baseLimitCents !== null ? (
                  <form action={clearLimit}>
                    <input type="hidden" name="scope" value={scope} />
                    <input type="hidden" name="userId" value={userId ?? ''} />
                    <input type="hidden" name="month" value={month} />
                    <input type="hidden" name="categoryId" value={row.categoryId} />
                    <input type="hidden" name="amount" value="" />
                    <button
                      type="submit"
                      aria-label={`Clear the budget for ${row.categoryName} from this month forward`}
                      title="Clears this budget from this month forward"
                      className="btn btn--ghost btn--sm px-2 text-xs"
                    >
                      clear
                    </button>
                    {clearError ? (
                      <span role="alert" className="ml-1.5 text-xs font-medium text-negative-soft-fg">
                        {clearError}
                      </span>
                    ) : null}
                  </form>
                ) : null}
                {suggestion ? (
                  <form action={applyAction}>
                    <input type="hidden" name="scope" value={scope} />
                    <input type="hidden" name="userId" value={userId ?? ''} />
                    <input type="hidden" name="month" value={month} />
                    <input type="hidden" name="categoryId" value={row.categoryId} />
                    <button
                      type="submit"
                      className="btn btn--ghost btn--sm px-2 text-xs"
                      title={`Median of the last ${suggestion.monthsUsed} full months${
                        suggestion.trend.direction === 'rising'
                          ? ', adjusted for a rising trend'
                          : suggestion.trend.direction === 'falling'
                            ? ', adjusted for a falling trend'
                            : ''
                      }${suggestion.seasonalApplied ? ', adjusted for the same month last year' : ''}. Confidence: ${suggestion.confidence}.`}
                    >
                      Use {formatCents(suggestion.suggestedCents, { currency: true })}
                    </button>
                  </form>
                ) : null}
              </>
            )}
            {!row.isArchived && canToggleRollover ? (
              <AutoSaveCheckbox
                name="enabled"
                defaultChecked={rolloverOn.has(row.categoryId)}
                fields={{
                  scope,
                  userId: userId === null ? '' : String(userId),
                  month,
                  categoryId: String(row.categoryId),
                }}
                action={saveRollover}
                label="Roll over unspent"
              />
            ) : null}
          </div>
        </div>

        {/* Tier 2 -- notes about this row, rendered BELOW the controls div above rather than
            inside it. Plain block-level <p>s, not flex items of anything, so neither one can
            ever be what forces a control in Tier 1 onto a second line -- see this component's
            own doc comment above Tier 1 for the mechanism that used to let them. Only ever
            reached on the editable branch: the read-only span above already folds the same
            carried figure into its own single line of text (see "read-only" branch above), so
            it never doubles this sentence. */}
        {!row.isArchived && editable && row.baseLimitCents !== null && row.carryCents > 0 ? (
          <p style={{ paddingLeft: `${depth * 20}px` }} className="pt-1 text-xs text-muted">
            {formatCents(row.baseLimitCents)} plus {formatCents(row.carryCents)} carried
          </p>
        ) : null}
        {!row.isArchived && editable && sinkingFund ? (
          <p style={{ paddingLeft: `${depth * 20}px` }} className="pt-1 text-xs text-muted">
            {/* Ruling R11: rollover IS the envelope; this sentence is what makes it legible.
                It reports what the carry already is -- it does not set a target and it does not
                change the limit above it. */}
            Accumulating for {sinkingFund.itemName} — {formatCents(sinkingFund.carriedCents)} of{' '}
            {formatCents(sinkingFund.targetCents)} by {sinkingFund.dueDate}
          </p>
        ) : null}
      </div>
      {overParentLimit ? (
        <div className="border-b border-line px-4 py-3 sm:px-5">
          <Notice tone="warning">
            <p>
              Children add up to {formatCents(childrenBaseSumCents)} —{' '}
              {formatCents(childrenBaseSumCents - (row.baseLimitCents ?? 0))} over {row.categoryName}&apos;s limit.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                className="btn btn--secondary btn--sm min-h-11 sm:min-h-0"
                disabled={warningPending}
                onClick={() => void raiseParentToChildrenSum()}
              >
                Raise {row.categoryName} to {formatCents(childrenBaseSumCents)}
              </button>
              {/* Ruling U6: omitted entirely, not disabled, when there is no previous value to
                  restore -- a fresh page load has seen no edit yet this session, and a button
                  that would do nothing is worse than no button at all. */}
              {ownGroupEdit !== null ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm min-h-11 sm:min-h-0"
                  disabled={warningPending}
                  onClick={() => void undoLastGroupEdit()}
                >
                  Undo
                </button>
              ) : null}
            </div>
            {warningError ? (
              <p role="alert" className="text-xs font-medium text-negative-soft-fg">
                {warningError}
              </p>
            ) : null}
          </Notice>
        </div>
      ) : null}
      {row.children.map((child) => (
        <EditRow
          key={child.categoryId}
          row={child}
          depth={depth + 1}
          scope={scope}
          userId={userId}
          month={month}
          applyAction={applyAction}
          editable={editable}
          canToggleRollover={canToggleRollover}
          rolloverOn={rolloverOn}
          predict={predict}
          sinkingFunds={sinkingFunds}
          hidden={disclosure ? !disclosure.open : hidden}
          onGroupLimitSaved={disclosure ? reportLimitEdit : onGroupLimitSaved}
        />
      ))}
    </>
  );
}

/** The toggle that switches a section between the card grid and the compact edit list. Identical
 *  in both places it appears (household, and each PersonalCard) -- one implementation, per D1. */
function EditLimitsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="btn btn--ghost btn--sm" onClick={onToggle}>
      {open ? 'Done editing' : 'Edit limits'}
    </button>
  );
}

/**
 * The shared body of a section -- household or personal -- so the two never grow their own,
 * slightly different card-or-list logic (ruling D1). `editMode` off renders the MetricCard grid
 * (goals-client.tsx:99's own `grid gap-4 md:grid-cols-2 lg:grid-cols-3`); on, the compact
 * Edit-limits list, wrapped in a bordered Card the way the table it replaces always was.
 */
function BudgetSectionBody({
  rows,
  scope,
  userId,
  month,
  editMode,
  editable,
  canToggleRollover,
  rolloverOn,
  predict,
  sinkingFunds,
  applyAction,
  groupState,
}: {
  rows: BudgetRow[];
  scope: BudgetScope;
  userId: number | null;
  month: string;
  editMode: boolean;
  editable: boolean;
  canToggleRollover: boolean;
  rolloverOn: Set<number>;
  predict: RowPredictions | null;
  sinkingFunds: Record<number, SinkingFund>;
  applyAction: (formData: FormData) => void;
  groupState: GroupOpenState;
}) {
  if (editMode) {
    return (
      <Card as="div">
        {rows.map((row) => (
          <EditRow
            key={row.categoryId}
            row={row}
            depth={0}
            scope={scope}
            userId={userId}
            month={month}
            applyAction={applyAction}
            editable={editable}
            canToggleRollover={canToggleRollover}
            rolloverOn={rolloverOn}
            predict={predict}
            sinkingFunds={sinkingFunds}
            disclosure={
              row.children.length > 0
                ? { open: groupState.isOpen(row.categoryId), onToggle: () => groupState.toggle(row.categoryId) }
                : undefined
            }
          />
        ))}
      </Card>
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {rows.map((row) => (
        <BudgetCategoryCard
          key={row.categoryId}
          row={row}
          scope={scope}
          userId={userId}
          month={month}
          groupState={groupState}
          predict={predict}
          sinkingFunds={sinkingFunds}
        />
      ))}
    </div>
  );
}

/**
 * Extracted from BudgetsClient's own `personal.map(...)` (v1.18.0 Lane 2) because a per-section
 * collapse state (`useGroupOpenState`) is a React hook, and hooks cannot be called from inside a
 * `.map` callback that lives directly in another component's body -- the number of times it
 * would run depends on `personal.length`, which breaks the fixed call order React requires. A
 * real component, one instance per person with its own stable `key`, is the only place this
 * hook (and, since Lane 1, its own Edit-limits toggle) can live.
 */
function PersonalCard({
  person,
  month,
  currentUserId,
  editable,
  copyAction,
  applyAction,
  applyAllAction,
  personPredict,
  showHistorySentence,
  personNoAttribution,
  gridVisible,
}: {
  person: {
    userId: number;
    name: string;
    rows: BudgetRow[];
    rolloverIds?: number[];
    sinkingFunds?: Record<number, SinkingFund>;
  };
  month: string;
  currentUserId: number;
  editable: boolean;
  copyAction: (formData: FormData) => void;
  applyAction: (formData: FormData) => void;
  applyAllAction: (formData: FormData) => void;
  personPredict: RowPredictions | null;
  showHistorySentence: boolean;
  personNoAttribution: boolean;
  /** v1.21.0 item 1: whether THIS person is the scope the pill currently selects (computed by
   *  the caller's `personalGridVisible`, which also covers the self-viewer exception -- see its
   *  own doc comment). Gates only the category grid below; this card's own header, totals and
   *  actions render unconditionally regardless. */
  gridVisible: boolean;
}) {
  const personRolloverOn = new Set(person.rolloverIds ?? []);
  // Ruling U2: only a category that actually HAS children becomes a disclosure -- an ordinary
  // row is never counted here, so Expand all/Collapse all never appears for a section with none.
  const groupIds = person.rows.filter((row) => row.children.length > 0).map((row) => row.categoryId);
  // Ruling U5: keyed by this person's own id, distinct from the household key below and from
  // every other person's, so opening Bob's "Food" group never opens Alice's.
  const groupState = useGroupOpenState(`budgets:groups:personal:${person.userId}`, groupIds);
  const [editMode, setEditMode] = useState(false);

  return (
    <section className="flex flex-col gap-4">
      <Card as="div">
        <CardHeader
          title={
            <>
              {person.name}
              {person.userId === currentUserId ? ' (you)' : ''}
              {editable ? null : <span className="ml-2 text-xs font-normal text-subtle">read-only</span>}
            </>
          }
          description="Personal limits, on top of the household ones."
          action={
            <>
              {/* Same ownership rule as the limit inputs: no copy button where the copy
                  would be refused server-side by copyPreviousMonthAction. */}
              {editable ? (
                <>
                  <form action={copyAction}>
                    <input type="hidden" name="scope" value="personal" />
                    <input type="hidden" name="userId" value={person.userId} />
                    <input type="hidden" name="month" value={month} />
                    <button type="submit" className="btn btn--secondary btn--sm">Copy previous month</button>
                  </form>
                  {/* Same MUST-15.1 rule as the household section above. */}
                  {personPredict !== null && personPredict.suggestionOf.size > 0 ? (
                    <form action={applyAllAction}>
                      <input type="hidden" name="scope" value="personal" />
                      <input type="hidden" name="userId" value={person.userId} />
                      <input type="hidden" name="month" value={month} />
                      <button
                        type="submit"
                        className="btn btn--secondary btn--sm"
                        title="Only fills in categories with no limit set. Nothing you have typed is changed."
                      >
                        Apply all suggestions
                      </button>
                    </form>
                  ) : null}
                </>
              ) : null}
              {/* Ruling U3: one control for the whole section, regardless of edit permission --
                  expanding a group to read its children is not an edit, so even a read-only
                  viewer of someone else's section gets this. */}
              {groupIds.length > 0 ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={groupState.anyCollapsed ? groupState.expandAll : groupState.collapseAll}
                >
                  {groupState.anyCollapsed ? 'Expand all' : 'Collapse all'}
                </button>
              ) : null}
              <EditLimitsToggle open={editMode} onToggle={() => setEditMode((open) => !open)} />
            </>
          }
        />
        {showHistorySentence || personNoAttribution ? (
          <CardBody className="pt-0">
            {showHistorySentence ? (
              <p className="text-sm text-muted">Suggestions appear once there are three full calendar months of history.</p>
            ) : null}
            {personNoAttribution ? (
              <p className="text-sm text-muted">
                {/* L-6: "to you" is only true in the viewer's own section. Everyone else's
                    section names the person it is actually about. */}
                No transactions are attributed {person.userId === currentUserId ? 'to you' : `to ${person.name}`} yet, so
                there is nothing to base a personal suggestion on.
              </p>
            ) : null}
          </CardBody>
        ) : null}
      </Card>
      {/* v1.21.0 item 1: the ONE thing the scope pill decides for this section too -- the Card
          above (name, description, Copy previous month, Apply all suggestions, Expand/collapse,
          Edit limits toggle) renders unconditionally either way. */}
      {gridVisible ? (
        <BudgetSectionBody
          rows={person.rows}
          scope="personal"
          userId={person.userId}
          month={month}
          editMode={editMode}
          // Same admin-or-owner rule as editable, for personal scope (unlike
          // household, where rollover is admin-only but the amount is not).
          editable={editable}
          canToggleRollover={editable}
          rolloverOn={personRolloverOn}
          predict={personPredict}
          sinkingFunds={person.sinkingFunds ?? {}}
          applyAction={applyAction}
          groupState={groupState}
        />
      ) : null}
    </section>
  );
}

export function BudgetsClient({
  month,
  currentUserId,
  currentUserIsAdmin = false,
  selectedPersonId = null,
  household,
  householdRolloverIds = [],
  householdTotals,
  personal,
  predictions = null,
  householdSinkingFunds = {},
  savingsProgress = null,
}: {
  month: string;
  currentUserId: number;
  currentUserIsAdmin?: boolean;
  /**
   * v1.21.0 item 1: which scope's category GRID is showing -- null for Household (the
   * default), a person's id for theirs. Read and validated server-side (budgets/page.tsx),
   * never client state -- a pill is a plain link to `?person=<id>`, a full navigation, the
   * same as the dashboard's own person-scope nav.
   *
   * Deliberately NOT a filter over `household`/`personal` themselves -- see this file's own
   * doc comment above BudgetSectionBody's household and PersonalCard call sites. Household and
   * personal budgets are separate records with their own limits, not one dataset viewed
   * through a filter, so every section's SUMMARY (its CardHeader, its totals, its "Copy
   * previous month"/"Apply all suggestions" actions) renders unconditionally at every setting
   * of this prop; only which section's GRID (BudgetSectionBody) is mounted follows it.
   *
   * Ruling R2: a self viewer's `household` is null, and for them this filter never applies at
   * all (see `personalGridVisible` below) -- their own, only, personal section always shows its
   * grid, which is also why they get no pills to change this with in the first place.
   */
  selectedPersonId?: number | null;
  /** v1.13.0 ruling R2: null for a self viewer -- there is no household scope for them at all,
   *  and the Household card below does not render. */
  household: BudgetRow[] | null;
  /** v1.7.0 Task 11: category ids (household scope) with "Roll over unspent" currently on. */
  householdRolloverIds?: number[];
  /** Ruling R2: null exactly when `household` is -- always both together. */
  householdTotals: { budgetedLimitCents: number; budgetedSpentCents: number; totalSpentCents: number } | null;
  personal: {
    userId: number;
    name: string;
    rows: BudgetRow[];
    rolloverIds?: number[];
    /** v1.13.0 ruling R11 / micro-ruling M9: this person's OWN sinkingFundsFor() result,
     *  serialized to a plain object keyed by category id. Computed per section on the server
     *  (see budgets/page.tsx) -- never shared with the household section's own map, since
     *  sinkingFundsFor's Map is keyed by categoryId alone with no scope of its own. */
    sinkingFunds?: Record<number, SinkingFund>;
  }[];
  /** MUST-14.1: null for a past or future month, and on any caller that has none. */
  predictions?: BudgetPredictions | null;
  /** v1.13.0 ruling R11 / micro-ruling M9: the Household section's own sinkingFundsFor()
   *  result, serialized to a plain object keyed by category id. */
  householdSinkingFunds?: Record<number, SinkingFund>;
  /** Ruling T3: household scope only, so this is null exactly when `household` is (a self
   *  viewer has no household scope to set a target for at all -- same pairing as
   *  householdTotals above). */
  savingsProgress?: SavingsProgress | null;
}) {
  const [copyState, dispatchCopy] = useActionState(copyPreviousMonthAction, initial);
  const [applyState, dispatchApply] = useActionState(applySuggestionAction, initial);
  const [applyAllState, dispatchApplyAll] = useActionState(applyAllSuggestionsAction, initial);
  const [householdEditMode, setHouseholdEditMode] = useState(false);

  // ONE banner, showing only the most recent submission. Independent action states
  // rendered side by side meant a success message from a save sat next to a fresh error
  // from a copy (and the other way round), so the page reported two contradictory
  // outcomes at once. Remembering which action fired last is enough to keep the banner
  // honest without merging the server actions. The limit and rollover controls report
  // themselves, inline, beside the control that failed -- a per-row failure now names its
  // own row by position instead of appearing at the top of the page.
  const [latest, setLatest] = useState<'copy' | 'apply' | 'applyAll' | null>(null);
  const copyAction = (formData: FormData) => {
    setLatest('copy');
    dispatchCopy(formData);
  };
  const applyAction = (formData: FormData) => {
    setLatest('apply');
    dispatchApply(formData);
  };
  const applyAllAction = (formData: FormData) => {
    setLatest('applyAll');
    dispatchApplyAll(formData);
  };
  const banner: BudgetActionState =
    latest === 'copy' ? copyState : latest === 'apply' ? applyState : latest === 'applyAll' ? applyAllState : initial;

  // Members may edit household budgets and their OWN personal budgets; admins may edit
  // anyone's (mirrors setLimitAction / copyPreviousMonthAction, spec section 6).
  const canEditPersonal = (userId: number) => currentUserIsAdmin || userId === currentUserId;

  // MUST-14.2: two Map.get calls are the whole of the client's involvement, built once per
  // section rather than per row.
  const rowPredict = (section: SectionPredictions | undefined): RowPredictions | null =>
    predictions == null || section === undefined
      ? null
      : {
          suggestionOf: new Map(section.suggestions.map((entry) => [entry.categoryId, entry])),
          projectionOf: new Map(section.projections.map((entry) => [entry.categoryId, entry.projectedCents])),
          dayOfMonth: predictions.dayOfMonth,
        };

  const householdPredict = rowPredict(predictions?.household);
  const personalPredict = new Map(
    (predictions?.personal ?? []).map((entry) => [entry.userId, rowPredict(entry.predictions)]),
  );

  // v1.7.0 Task 11: "Roll over unspent" is admin, and for a personal-scope budget its own
  // owner -- STRICTER than canEditPersonal for household scope (any member may edit a
  // household amount, but rollover is a policy choice about the shared budget, so changing it
  // there is admin-only). For personal scope the two checks are the same admin-or-owner rule.
  const householdRolloverOn = new Set(householdRolloverIds);

  // Ruling U2: only a category that actually has children becomes a disclosure. Called
  // unconditionally (household ?? [] rather than skipping the hook when household is null) --
  // hooks cannot be called only on some renders, and a self viewer's empty groupIds list simply
  // never renders the Expand all/Collapse all button below.
  const householdGroupIds = (household ?? []).filter((row) => row.children.length > 0).map((row) => row.categoryId);
  const householdGroupState = useGroupOpenState('budgets:groups:household', householdGroupIds);

  // Ruling U2/item 3: "spent $0.00 of $0.00 budgeted" is not information, it is three zeros
  // saying "you have not set any budgets" -- the same all-zero test the household total bar
  // below already uses to fall back to "No budget" instead of a real $0 bar.
  const noHouseholdBudgets =
    householdTotals !== null && householdTotals.budgetedLimitCents === 0 && householdTotals.budgetedSpentCents === 0;

  // v1.21.0 item 1: Household's own grid follows the pill -- mounted only while Household is
  // the selected scope, which is also the default (selectedPersonId's own doc comment). This
  // is read only inside the `household !== null` block below, so a self viewer (whose
  // `selectedPersonId` is forced null right alongside `household` being null, ruling R2) never
  // has this decide anything -- there is no Household section for it to gate in the first place.
  const householdGridVisible = selectedPersonId === null;
  // A person's own grid follows the SAME pill, with one deliberate exception: `household ===
  // null` means there is no household scope to distinguish a selection FROM (a self viewer,
  // ruling R2) -- there are no pills, and the one personal section they have is the only thing
  // on the page, so it always shows rather than waiting on a selection nothing ever sets it to.
  const personalGridVisible = (userId: number): boolean => household === null || selectedPersonId === userId;

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {/* Ruling U1 (v1.18.0): no eyebrow. MonthNav in `actions` already names the month, in the
          control that changes it -- an eyebrow beside it made the header state one fact twice,
          and the reader had to work out which of the two was authoritative. */}
      <PageHeader
        title="Budgets"
        description="A limit set here applies to this month and every month after it, until you change it again."
        actions={
          // v1.21.0 item 1 (2026-08-30 plan, item 1): PageHeader's own actions slot is a plain
          // row now (item 5 the same plan already shipped) -- a caller stacking several rows
          // composes its own column, exactly the way dashboard/page.tsx does for its own
          // month-nav-plus-pills pair. See PageHeader.tsx's own doc comment.
          <div className="flex w-full flex-col items-start gap-2 sm:items-end">
            <MonthNav
              month={month}
              basePath="/budgets"
              // Ruling (dashboard's own T7 precedent): the scope pill must survive a month
              // change, or picking a different month would silently reset which grid is
              // showing. Household (null) carries nothing extra, same as the dashboard's own
              // `person=` omission for its own default scope.
              extraParams={selectedPersonId !== null ? { person: String(selectedPersonId) } : {}}
            />
            {/* Ruling R2: no pills at all for a self viewer -- `household` is null for them
                (same gate the section below uses), and rendering even a disabled/inactive pill
                here would be the thing that leaks a household scope exists at all. */}
            {household !== null ? (
              <PillNav
                groupLabel="Which budgets to show"
                // Both options carry `month=` too, same reasoning as the dashboard's own nav --
                // switching which budgets are shown must not silently reset which month they are
                // shown for. No "All" option (2026-08-30 plan): that would rebuild the exact long
                // page this item exists to shorten.
                options={[
                  { key: 'household', href: `/budgets?month=${month}`, label: 'Household', active: selectedPersonId === null },
                  ...personal.map((person) => ({
                    key: String(person.userId),
                    href: `/budgets?person=${person.userId}&month=${month}`,
                    label: person.name,
                    active: selectedPersonId === person.userId,
                  })),
                ]}
              />
            ) : null}
          </div>
        }
      />

      {/* Ruling T3/T6: household scope only, so this sits beside the month navigation at the
          top of the page rather than inside the Household card below -- the same reasoning R2
          already applies to that card is why this is gated on the same `household !== null`. */}
      {household !== null ? <SavingsTargetControl month={month} progress={savingsProgress} /> : null}

      <PageGuide>
        <p>
          A budget here is a limit on one category for one month, and the figure beside it is
          what has actually been spent against it out of your imported transactions. Nothing is
          typed in twice — you set the limit, the spending comes from the statements.
        </p>
        <p>
          A limit you set applies to the month shown at the top and to every month after it,
          until you set a different one. So a normal month needs no visits at all; you come back
          when something has changed. Use the arrows beside the month, or the month field itself,
          to look at another one, or <strong className="font-semibold text-ink">Copy previous month</strong> to
          start from what was in force last month.
        </p>
        <p>
          There are two scopes. The Household section is the shared budget everyone in the house
          is measured against together. Below it, each person gets their own section for limits
          that apply only to the transactions attributed to them — a personal limit sits on top
          of the household one rather than replacing it.
        </p>
        <p>
          Once there are three full calendar months of history, a suggested figure appears
          beside each category behind <strong className="font-semibold text-ink">Edit limits</strong>, and from the
          seventh of the current month each card also shows the pace the month is running at. Both are
          read off your own past spending in that category; neither is an opinion about what the
          amount ought to be.
        </p>
        {household !== null ? (
          <p>
            The savings target above is a household decision, not a per-person one — a percent of
            income or a fixed amount, whichever this household finds easier to reason about. It
            measures income minus spending for the month; moving money into a savings account is
            not itself part of that number; see the dashboard&apos;s Saved this month tile for why.
          </p>
        ) : null}
      </PageGuide>

      <FormError message={banner.error} />
      {banner.message ? <Notice tone="success">{banner.message}</Notice> : null}

      {/* Ruling R2: a self viewer's `household`/`householdTotals` are null, together, from the
          server -- there is no household scope for them at all, so this section does not render
          rather than rendering an empty or zeroed one. */}
      {household !== null && householdTotals !== null ? (
        <section className="flex flex-col gap-4">
          <Card as="div">
            <CardHeader
              title={
                noHouseholdBudgets ? (
                  `No budgets set for ${monthLabel(month)}.`
                ) : (
                  <>
                    Household — spent {formatCents(householdTotals.budgetedSpentCents)} of {formatCents(householdTotals.budgetedLimitCents)} budgeted
                    <span className="font-normal text-muted"> · {formatCents(householdTotals.totalSpentCents)} total spent</span>
                  </>
                )
              }
              // Item 3: the three-zero header said nothing a person could act on. This sentence
              // names the one thing to actually do, and points at exactly where to do it.
              description={noHouseholdBudgets ? 'Set a limit on any category below to start tracking it.' : undefined}
              action={
                <>
                  <form action={copyAction}>
                    <input type="hidden" name="scope" value="household" />
                    <input type="hidden" name="month" value={month} />
                    {/* Lane 3 item 1: this button now also carries the savings target forward
                        (copySavingsTargetForward, in copyPreviousMonthAction) -- household scope
                        only, since ruling T3 gives the target no per-person copy of its own. */}
                    <button
                      type="submit"
                      className="btn btn--secondary btn--sm"
                      title="Also brings forward last month's savings target, if one was set."
                    >
                      Copy previous month
                    </button>
                  </form>
                  {/* MUST-15.1: a control that cannot act is not offered. There is nothing to apply
                      when there are no suggestions, whether that is because history is short or
                      because every category with history failed the suggestion floor. */}
                  {householdPredict !== null && householdPredict.suggestionOf.size > 0 ? (
                    <form action={applyAllAction}>
                      <input type="hidden" name="scope" value="household" />
                      <input type="hidden" name="month" value={month} />
                      <button
                        type="submit"
                        className="btn btn--secondary btn--sm"
                        title="Only fills in categories with no limit set. Nothing you have typed is changed."
                      >
                        Apply all suggestions
                      </button>
                    </form>
                  ) : null}
                  {/* Ruling U3: one control for the whole section. Absent when nothing in it can
                      collapse in the first place (every household row is an ordinary one). */}
                  {householdGroupIds.length > 0 ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={householdGroupState.anyCollapsed ? householdGroupState.expandAll : householdGroupState.collapseAll}
                    >
                      {householdGroupState.anyCollapsed ? 'Expand all' : 'Collapse all'}
                    </button>
                  ) : null}
                  <EditLimitsToggle open={householdEditMode} onToggle={() => setHouseholdEditMode((open) => !open)} />
                </>
              }
            />
            <CardBody className="pb-4 pt-0">
              <div className="max-w-xs">
                {/* No budgeted rows at all this month reads as "no budget", not a $0 budget —
                    only an explicit resolved limit on at least one row should drive this bar. */}
                {noHouseholdBudgets ? (
                  <span className="text-xs text-subtle">No budget</span>
                ) : (
                  <ProgressBar
                    pct={totalPct(householdTotals.budgetedLimitCents, householdTotals.budgetedSpentCents)}
                    label="Household budgeted total"
                  />
                )}
              </div>
              {predictions !== null && predictions.monthsUsed < MIN_HISTORY_MONTHS ? (
                <p className="text-sm text-muted">Suggestions appear once there are three full calendar months of history.</p>
              ) : null}
            </CardBody>
          </Card>
          {/* v1.21.0 item 1: the ONE thing the scope pill decides -- everything above (the
              summary Card, its totals, its own actions) rendered unconditionally either way. */}
          {householdGridVisible ? (
            <BudgetSectionBody
              rows={household}
              scope="household"
              userId={null}
              month={month}
              editMode={householdEditMode}
              editable // Household budgets are editable by every member (spec section 6).
              canToggleRollover={currentUserIsAdmin}
              rolloverOn={householdRolloverOn}
              predict={householdPredict}
              sinkingFunds={householdSinkingFunds}
              applyAction={applyAction}
              groupState={householdGroupState}
            />
          ) : null}
        </section>
      ) : null}

      {personal.map((person) => {
        const personPredict = personalPredict.get(person.userId) ?? null;
        const personNoAttribution =
          predictions?.personal.find((entry) => entry.userId === person.userId)?.predictions.noAttribution ?? false;
        const showHistorySentence = predictions !== null && predictions.monthsUsed < MIN_HISTORY_MONTHS;
        return (
          <PersonalCard
            key={person.userId}
            person={person}
            month={month}
            currentUserId={currentUserId}
            editable={canEditPersonal(person.userId)}
            copyAction={copyAction}
            applyAction={applyAction}
            applyAllAction={applyAllAction}
            personPredict={personPredict}
            showHistorySentence={showHistorySentence}
            personNoAttribution={personNoAttribution}
            gridVisible={personalGridVisible(person.userId)}
          />
        );
      })}

      <p className="text-xs text-subtle">
        Leaving a limit blank and saving clears the budget from {month} forward. Amounts you set apply to {month} and every later month until you
        change them again.
      </p>
    </div>
  );
}
