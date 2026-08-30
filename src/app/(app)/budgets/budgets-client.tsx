'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { BudgetProgressBar } from '@/components/BudgetProgressBar';
import { FormError } from '@/components/FormError';
import { ChevronDownIcon } from '@/components/icons';
import { AutoSaveCheckbox, AutoSaveTextInput, useAutoSave } from '@/components/ui/AutoSave';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { MonthNav } from '@/components/ui/MonthNav';
import { Notice } from '@/components/ui/Notice';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { monthLabel } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import type { SinkingFund } from '@/lib/bills';
import type { BudgetRow } from '@/lib/budgets';
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
 * Unique per (scope, user, category), so a disclosure's `aria-controls` can name exactly the
 * rows it hides and two sections that happen to share a category id -- a household row and
 * someone's personal row both named "Hobbies" -- never collide on one DOM id.
 */
function rowId(scope: 'household' | 'personal', userId: number | null, categoryId: number): string {
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

function Row({
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
  scope: 'household' | 'personal';
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
  /** Present only on the one Row per top-level category that actually has children (ruling U2:
   *  a parent with no children stays an ordinary row, so this is never passed for one). Carries
   *  everything a disclosure toggle needs to announce and control itself. */
  disclosure?: { open: boolean; onToggle: () => void };
  /** Ruling U6: bubbles a successful limit save -- this row's own, or (via the recursive call
   *  below) any child's -- up to whichever Row owns the "children add up to more than the
   *  parent" warning. Undefined on that owning Row itself, which is how it knows to keep the
   *  report rather than forward it again. */
  onGroupLimitSaved?: (categoryId: number, previousBaseCents: number | null) => void;
}) {
  const suggestion = predict?.suggestionOf.get(row.categoryId) ?? null;
  const projection = predict?.projectionOf.get(row.categoryId) ?? null;
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
  // it is only ever READ on the one Row that also received `disclosure` -- an ordinary row, or a
  // child row that only ever forwards its own edits upward via `onGroupLimitSaved`, never looks
  // at its own copy of this state.
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
  // into any field. Only meaningful on the one Row that owns a disclosure; every other Row
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
      <tr id={rowId(scope, userId, row.categoryId)} hidden={hidden} className={depth === 0 ? 'bg-surface-2' : undefined}>
        {/* v1.15.0 (responsive rows): this cell is BOTH the tree indent (the inline
            paddingLeft that v1.13.2 fixed the ordering/nesting of) and the phone card's
            headline -- a child row's indent must keep working exactly as it does in the
            table, so cell-stack-headline goes on this same <td>, not a new one. */}
        <td
          style={{ paddingLeft: `${16 + depth * 20}px` }}
          className={`${depth === 0 ? 'font-medium text-ink' : 'text-muted'} cell-stack-headline`}
          data-label="Category"
        >
          {disclosure ? (
            <button
              type="button"
              aria-expanded={disclosure.open}
              aria-controls={row.children.map((child) => rowId(scope, userId, child.categoryId)).join(' ')}
              onClick={disclosure.onToggle}
              className="inline-flex min-h-11 items-center gap-1.5 py-1 text-left font-medium text-ink sm:min-h-0"
            >
              {/* Ruling U3: closed is the page's default shape, so the chevron points at the
                  direction opening will take it -- sideways when closed, down once open -- the
                  same convention a native <details> uses. */}
              <ChevronDownIcon
                className={`h-4 w-4 shrink-0 text-muted transition-transform ${disclosure.open ? '' : '-rotate-90'}`}
              />
              {row.categoryName}
            </button>
          ) : (
            row.categoryName
          )}
          {row.isArchived ? <span className="ml-1.5 text-xs text-subtle">(archived)</span> : null}
          {/* Ruling U3: the marker that lets an over-budget group still announce itself while its
              disclosure is closed -- a different signal from the U6 warning below, which is
              about the children's LIMITS outgrowing the parent's, not about actual spend. */}
          {disclosure && row.overBudget ? <span className="badge badge--red ml-2 align-middle">Over budget</span> : null}
        </td>
        {/* No width class on this cell or the progress one any more: the colgroup owns the
            widths under fixed layout, and a `w-44` here only reads as if it still decided
            something. */}
        <td data-label="Limit">
          {row.isArchived || !editable ? (
            // Two reasons a limit is not editable here. Archived categories can no longer
            // be actively budgeted (spec section 3) — the row is a read-only record of the
            // spend it still rolled up this month. And a non-admin looking at someone
            // else's personal section may only read it: setLimitAction rejects the write,
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
                className="field-control w-24 px-2 py-1 text-right text-xs"
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
              {row.baseLimitCents !== null && row.carryCents > 0 ? (
                <p className="mt-1 text-xs text-muted">
                  {formatCents(row.baseLimitCents)} plus {formatCents(row.carryCents)} carried
                </p>
              ) : null}
              {sinkingFund ? (
                <p className="mt-1 text-xs text-muted">
                  {/* Ruling R11: rollover IS the envelope; this sentence is what makes it legible.
                      It reports what the carry already is -- it does not set a target and it does not
                      change the limit above it. */}
                  Accumulating for {sinkingFund.itemName} — {formatCents(sinkingFund.carriedCents)} of{' '}
                  {formatCents(sinkingFund.targetCents)} by {sinkingFund.dueDate}
                </p>
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
            <span className="mt-1 flex">
              {/* An unchecked box is ABSENT from the request, which is exactly what
                  setRolloverAction reads (`formData.get('enabled') === 'on'`). */}
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
            </span>
          ) : null}
        </td>
        <td className="text-right" data-label="Net spent"><Money cents={row.spentCents} plain /></td>
        {/* Remaining, not Net spent, is the money-column call: it is the number a member
            actually scans for -- how much is left to spend -- so it is the one carried into
            row 1 of the phone card. */}
        <td className="text-right cell-stack-amount" data-label="Remaining">
          {row.remainingCents === null ? (
            <span className="text-subtle">—</span>
          ) : (
            <Money cents={row.remainingCents} />
          )}
        </td>
        {/* v1.16.0 Lane C item 4: the bar is neither text nor a form control, so `:has(select,
            textarea, input)` (globals.css) has nothing to match here -- `cell-stack-block` is
            the opt-in twin of that rule, stacking the label above and letting the bar itself
            span the card's full width instead of being squeezed into the right half next to a
            label it has no room to sit beside. */}
        <td className="cell-stack-block" data-label="Progress and pace">
          <BudgetProgressBar limitCents={row.limitCents} spentCents={row.spentCents} label={row.categoryName} />
          {projection !== null && predict !== null ? (
            <p
              className={`mt-1 text-xs ${row.limitCents !== null && projection > row.limitCents ? 'text-negative' : 'text-muted'}`}
              title={`Assumes the rest of the month looks like the ${predict.dayOfMonth} days so far.`}
            >
              On pace for {formatCents(projection, { currency: true })}
            </p>
          ) : null}
        </td>
      </tr>
      {overParentLimit ? (
        <tr>
          {/* Never `hidden`, unlike the children rows below: ruling U6 requires this visible
              whether the group is open or closed, since the closed header is where most people
              will actually see it. */}
          <td colSpan={5} className="px-4 py-3">
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
          </td>
        </tr>
      ) : null}
      {row.children.map((child) => (
        <Row
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

/**
 * One table shape, rendered once for the household section and once per person, so the
 * column widths only have to be decided here.
 *
 * `fixed` because this row is mostly controls, not text. Under auto layout the browser gave
 * the category names all the width they asked for and left the limit cell with the remainder,
 * which was too narrow for "Roll over unspent" to sit beside its checkbox and Save -- the
 * label wrapped and the two Save buttons stacked, next to a category column of empty space.
 * The widths below are what each cell's contents actually need, so nothing is renegotiable:
 * the limit column is sized from its widest line (checkbox + label + status), not from whatever
 * the text columns leave behind. They sum to 56rem, inside the shell's content width, and the
 * wrapper still scrolls horizontally below that so no column is ever cut off.
 */
function BudgetTable({ children, paceTitle }: { children: React.ReactNode; paceTitle?: string }) {
  return (
    <TableWrap bare fixed minWidth="56rem" responsive>
      <colgroup>
        {/* Deepest label plus its indent (16px + 20px per level, see Row). Longer names wrap
            rather than truncate, so nothing is hidden. */}
        <col style={{ width: '18rem' }} />
        {/* Was 16rem to fit checkbox + "Roll over unspent" + Save on one line. The Save is
            gone, so the widest line here is now the checkbox, its label and the 1rem status
            slot -- 4rem narrower, and the table fits a 1280px viewport without scrolling. */}
        <col style={{ width: '12rem' }} />
        {/* Two money columns; a formatted amount with a minus sign is the widest thing in them. */}
        <col style={{ width: '7rem' }} />
        <col style={{ width: '7rem' }} />
        {/* Progress bar over the "On pace for ..." sentence, which wraps to two lines happily. */}
        <col style={{ width: '12rem' }} />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">Category</th>
          <th scope="col">Limit</th>
          <th scope="col" className="text-right">Net spent</th>
          <th scope="col" className="text-right">Remaining</th>
          <th scope="col" title={paceTitle}>{paceTitle ? 'Progress and pace' : null}</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </TableWrap>
  );
}

/**
 * Extracted from BudgetsClient's own `personal.map(...)` (v1.18.0 Lane 2) because a per-section
 * collapse state (`useGroupOpenState`) is a React hook, and hooks cannot be called from inside a
 * `.map` callback that lives directly in another component's body -- the number of times it
 * would run depends on `personal.length`, which breaks the fixed call order React requires. A
 * real component, one instance per person with its own stable `key`, is the only place this
 * hook can live.
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
  paceTitle,
  showHistorySentence,
  personNoAttribution,
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
  paceTitle?: string;
  showHistorySentence: boolean;
  personNoAttribution: boolean;
}) {
  const personRolloverOn = new Set(person.rolloverIds ?? []);
  // Ruling U2: only a category that actually HAS children becomes a disclosure -- an ordinary
  // row is never counted here, so Expand all/Collapse all never appears for a section with none.
  const groupIds = person.rows.filter((row) => row.children.length > 0).map((row) => row.categoryId);
  // Ruling U5: keyed by this person's own id, distinct from the household key below and from
  // every other person's, so opening Bob's "Food" group never opens Alice's.
  const groupState = useGroupOpenState(`budgets:groups:personal:${person.userId}`, groupIds);

  return (
    <Card as="section">
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
          editable || groupIds.length > 0 ? (
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
            </>
          ) : null
        }
      />
      {showHistorySentence || personNoAttribution ? (
        <CardBody className="pt-5 pb-0">
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
      <BudgetTable paceTitle={paceTitle}>
        {person.rows.map((row) => (
          <Row
            key={row.categoryId}
            row={row}
            depth={0}
            scope="personal"
            userId={person.userId}
            month={month}
            applyAction={applyAction}
            editable={editable}
            // Same admin-or-owner rule as editable, for personal scope (unlike
            // household, where rollover is admin-only but the amount is not).
            canToggleRollover={editable}
            rolloverOn={personRolloverOn}
            predict={personPredict}
            sinkingFunds={person.sinkingFunds ?? {}}
            disclosure={
              row.children.length > 0
                ? { open: groupState.isOpen(row.categoryId), onToggle: () => groupState.toggle(row.categoryId) }
                : undefined
            }
          />
        ))}
      </BudgetTable>
    </Card>
  );
}

export function BudgetsClient({
  month,
  currentUserId,
  currentUserIsAdmin = false,
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
  const paceTitle = predictions ? 'Appears from the 7th of the month.' : undefined;

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
  // saying "you have not set any budgets" -- the same all-zero test the progress bar just below
  // already uses to fall back to "No budget" instead of a real $0 bar.
  const noHouseholdBudgets =
    householdTotals !== null && householdTotals.budgetedLimitCents === 0 && householdTotals.budgetedSpentCents === 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={monthLabel(month)}
        title="Budgets"
        description="A limit set here applies to this month and every month after it, until you change it again."
        actions={<MonthNav month={month} basePath="/budgets" />}
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
          beside each row, and from the seventh of the current month the progress column also
          shows the pace the month is running at. Both are read off your own past spending in
          that category; neither is an opinion about what the amount ought to be.
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
        <Card as="section">
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
              </>
            }
          />
          <CardBody className="pb-4">
            <div className="max-w-xs">
              <BudgetProgressBar
                // No budgeted rows at all this month reads as "no budget", not a $0 budget —
                // only an explicit resolved limit on at least one row should drive this bar.
                limitCents={
                  householdTotals.budgetedLimitCents === 0 && householdTotals.budgetedSpentCents === 0
                    ? null
                    : householdTotals.budgetedLimitCents
                }
                spentCents={householdTotals.budgetedSpentCents}
                label="Household budgeted total"
              />
            </div>
            {predictions !== null && predictions.monthsUsed < MIN_HISTORY_MONTHS ? (
              <p className="text-sm text-muted">Suggestions appear once there are three full calendar months of history.</p>
            ) : null}
          </CardBody>
          <BudgetTable paceTitle={paceTitle}>
            {household.map((row) => (
              // Household budgets are editable by every member (spec section 6).
              <Row
                key={row.categoryId}
                row={row}
                depth={0}
                scope="household"
                userId={null}
                month={month}
                applyAction={applyAction}
                editable
                canToggleRollover={currentUserIsAdmin}
                rolloverOn={householdRolloverOn}
                predict={householdPredict}
                sinkingFunds={householdSinkingFunds}
                disclosure={
                  row.children.length > 0
                    ? { open: householdGroupState.isOpen(row.categoryId), onToggle: () => householdGroupState.toggle(row.categoryId) }
                    : undefined
                }
              />
            ))}
          </BudgetTable>
        </Card>
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
            paceTitle={paceTitle}
            showHistorySentence={showHistorySentence}
            personNoAttribution={personNoAttribution}
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
