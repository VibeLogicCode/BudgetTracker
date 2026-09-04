'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';
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
  deleteRuleAndClearAction,
  previewRerunAllAction,
  previewRuleClearAction,
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
  /**
   * v1.25.0 (item 18). Whether the row being edited is currently claimed by a preset pack
   * (packSource non-null), which decides one extra sentence in the dialog's re-key note below.
   * Read off the row rather than recomputed, and false for a new rule, since a rule nobody has
   * written yet cannot belong to a pack.
   */
  isPreset: boolean;
}

const BLANK: RuleFormValues = { id: null, pattern: '', matchType: 'exact', ruleKind: 'category', categoryId: null, renameTo: '', isPreset: false };

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

/**
 * v1.24.0 (owner ask): "all date ranges or user chooses". One control, two dialogs -- Delete and
 * clear, and Run rules -- because a person setting a range in one of them and then the other must
 * meet the same two fields in the same order, not two different inventions.
 *
 * Deliberately NOT src/components/ui/DateRangePicker.tsx, which was checked first. That component
 * is built for a page's `<form method="get">` (MUST-12.2: "a form control, not a router"): it is
 * preset-driven (`range=this_month`, resolved SERVER-side against the app timezone), uses
 * `defaultValue` so nothing re-renders as you type, and submits by pressing the page's own Search
 * button. Both of those are wrong inside a dialog whose entire purpose is a live count that has to
 * change AS the range changes -- that needs controlled inputs and no navigation at all -- and the
 * two ends here are literal bounds handed to a server action, not a preset id anything resolves.
 * Reusing it would have meant adding a second, contradictory mode to a component whose docblock
 * pins its one mode down hard.
 */
type ScopeMode = 'all' | 'range';

interface ScopeState {
  mode: ScopeMode;
  from: string;
  to: string;
}

/**
 * The dates as the SERVER will see them ('' means unbounded) plus the one client-side check worth
 * making: a transposed pair. Both mutating actions refuse it again server-side (parseScope in
 * actions.ts); this is here so the person is told in the dialog instead of after submitting, and
 * so the preview call is not fired for a range that cannot mean anything.
 */
function scopeBounds(scope: ScopeState): { from: string; to: string; backwards: boolean } {
  const from = scope.mode === 'range' ? scope.from : '';
  const to = scope.mode === 'range' ? scope.to : '';
  return { from, to, backwards: from !== '' && to !== '' && from > to };
}

function ScopeChoice({
  name,
  scope,
  onChange,
  backwards,
}: {
  /** Distinct radio-group name per dialog, so two mounted shells could never share a selection. */
  name: string;
  scope: ScopeState;
  onChange: (next: ScopeState) => void;
  backwards: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="field-label">Apply to</legend>
        <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
          <input
            type="radio"
            name={name}
            value="all"
            checked={scope.mode === 'all'}
            onChange={() => onChange({ ...scope, mode: 'all' })}
            className="accent-accent"
          />
          All time
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
          <input
            type="radio"
            name={name}
            value="range"
            checked={scope.mode === 'range'}
            onChange={() => onChange({ ...scope, mode: 'range' })}
            className="accent-accent"
          />
          Date range
        </label>
      </fieldset>
      {scope.mode === 'range' ? (
        <div className="flex flex-wrap gap-3">
          <Field label="From">
            <input type="date" value={scope.from} onChange={(event) => onChange({ ...scope, from: event.target.value })} className={inputClass} />
          </Field>
          <Field label="To">
            <input type="date" value={scope.to} onChange={(event) => onChange({ ...scope, to: event.target.value })} className={inputClass} />
          </Field>
        </div>
      ) : null}
      {backwards ? (
        <p role="alert" className="text-xs font-medium text-negative-soft-fg">
          That date range ends before it starts -- swap the From and To dates.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Dialogs 2 and 3 of v1.24.0, one component because the flow is identical and only the honest
 * wording differs by kind:
 *
 *  - category / transfer: "this cannot be undone", because it genuinely cannot -- no column
 *    anywhere records what a row's category (or transfer flag) was before a rule set it, so there
 *    is nothing to restore from (see clearRuleFromTransactions in src/lib/categorize/engine.ts).
 *    These two get the date range.
 *  - rename: "descriptions go back to the text from your bank", because for a rename that is the
 *    literal truth -- raw_description was never touched and the display columns are recomputed
 *    from the rule set on every pass. So "cannot be undone" attaches to DELETING THE RULE here,
 *    never to the transactions, and the copy must not borrow the other kinds' warning. No date
 *    range at all: a bounded rename revert silently unwinds on the next rename pass, which is why
 *    the engine refuses to offer one.
 *
 * The count is fetched from the server rather than reused from the row's own "Affects" figure, even
 * though the two agree for category and rename rules: for a TRANSFER rule they are opposite sets
 * ("Affects" is the rows the rule would still flag; clearing touches the rows it already flagged --
 * see ruleClearIds' docblock), and one dialog stating a number the button does not honour is worse
 * than a moment of "Checking…".
 */
function ClearRuleDialog({
  rule,
  action,
  deleteAction,
  onClose,
}: {
  rule: MerchantRuleRecord;
  action: (formData: FormData) => void;
  /**
   * v1.25.0. The ORDINARY delete (deleteRuleAction), used when the server comes back with an
   * affected count of zero. Not a styling detail: at zero this dialog's whole subject -- clearing
   * transactions -- has nothing to act on, so the thing being agreed to really is a plain delete,
   * and it should submit the action that says so and return "Rule deleted." rather than a
   * clear-and-delete that reports having cleared nothing.
   */
  deleteAction: (formData: FormData) => void;
  onClose: () => void;
}) {
  const isRename = rule.ruleKind === 'rename';
  const [scope, setScope] = useState<ScopeState>({ mode: 'all', from: '', to: '' });
  const { from, to, backwards } = scopeBounds(scope);
  const [affected, setAffected] = useState<number | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (backwards) return;
    // `live` guards against a slower earlier response landing after a faster later one and
    // pinning a count that belongs to a range the person has already changed.
    let live = true;
    setAffected(null);
    void previewRuleClearAction(rule.id, from === '' ? null : from, to === '' ? null : to).then((result) => {
      if (!live) return;
      setAffected(result.affected);
      setPreviewError(result.error ?? null);
    });
    return () => {
      live = false;
    };
  }, [rule.id, from, to, backwards]);

  const count = affected === null ? null : `${affected} transaction${affected === 1 ? '' : 's'}`;

  /**
   * v1.25.0, owner finding: the v1.24.0 dialog gave a count of ZERO the full treatment -- "This
   * cannot be undone. 0 transactions were categorized by this rule.", three paragraphs of
   * consequence, a date-range picker and a red Delete and clear -- for an action that would change
   * nothing. Every one of those is a claim about data that is not there, and a red button on a
   * no-op teaches a person to distrust red buttons on the ones that are not.
   *
   * Guarded on previewError being absent so an unusable date range (transposed, per scopeSchema)
   * keeps the full form and its own error, rather than reading its enforced 0 as "nothing to do".
   * The switch happens only once a real count has ARRIVED (affected is null while in flight), so
   * the scope radios cannot be unmounted from under someone mid-edit -- changing the range resets
   * affected to null, and this must not blank the control that change came from.
   *
   * WHY THE ROW MENU STILL OFFERS THIS at zero, rather than hiding it: the only count the menu has
   * in hand is the row's own "Affects" figure, and for a TRANSFER rule that number points the
   * opposite way from this one by design (ruleImpactCounts counts the rows the rule would still
   * flag; clearing touches the rows it already flagged -- see ruleClearIds' docblock). The clear
   * count also depends on a date range that only exists inside the dialog. Hiding the item on a
   * number that can legitimately disagree with the one the dialog computes would put a second
   * source of truth in front of the first, which is the exact failure this area keeps repeating. The
   * real count arrives here, so zero is answered here.
   */
  const nothingToClear = affected === 0 && previewError === null;

  return (
    <RowDialog
      dialogId="clear-rule-dialog"
      title={
        nothingToClear
          ? // Deliberately the same words as the ordinary delete dialog's title: at zero that is
            // precisely what this is, and a title still promising to "clear it from transactions"
            // would be the untrue half of the screen.
            'Delete this rule?'
          : isRename
            ? 'Delete rule and restore original descriptions?'
            : 'Delete rule and clear it from transactions?'
      }
      onClose={onClose}
    >
      {nothingToClear ? (
        <p className="text-sm text-ink">
          {isRename
            ? 'This rule has not renamed any transactions, so there are no descriptions to restore.'
            : rule.ruleKind === 'transfer'
              ? 'No transactions are flagged as a transfer by this rule, so there is nothing to clear.'
              : 'No transactions were categorized by this rule, so there is nothing to clear.'}{' '}
          Deleting it removes the rule and nothing else.
        </p>
      ) : isRename ? (
        <>
          <p className="text-sm text-ink">
            Deleting the rule cannot be undone. Descriptions it changed go back to the text from your bank.
          </p>
          <p className="text-sm text-ink">
            Applies to every transaction this rule renamed{affected === null ? '' : ` -- ${affected} of them`}. No date range.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-ink">
            <strong className="font-semibold">This cannot be undone.</strong>{' '}
            {count === null
              ? 'Checking how many transactions this rule has changed…'
              : rule.ruleKind === 'transfer'
                ? `${count} ${affected === 1 ? 'is' : 'are'} flagged as a transfer by this rule.`
                : `${count} ${affected === 1 ? 'was' : 'were'} categorized by this rule.`}
          </p>
          {rule.ruleKind === 'transfer' ? (
            <p className="text-sm text-ink">
              Clearing removes the transfer flag, so they count as ordinary money again in every report and budget.
              Whether they were flagged before this rule existed is not recorded and cannot be brought back.
            </p>
          ) : (
            <p className="text-sm text-ink">
              Clearing removes their category and returns them to Needs review. The category they had before this rule
              is not recorded and cannot be brought back.
            </p>
          )}
          {/* v1.25.0, owner finding: this paragraph used to read "Other rules are not re-run, so
              these stay uncategorized until you run rules again" -- unqualified, directly under a
              bold "This cannot be undone", and read as "deleting one rule un-categorizes
              everything". It never meant that: clearing only ever touches the rows this one rule
              accounts for (ruleClearIds). What it actually describes is the narrow shadowing case
              -- a second, broader rule that also matches one of those rows (TIM HORTONS -> Coffee
              over a broader TIM -> Fast Food) does not take over on its own.

              STATED CONDITIONALLY rather than with the real number, and that is a scope limit
              rather than a preference: computing "how many of these rows would another rule claim"
              means re-simulating the affected rows with this rule removed from the rule set, which
              needs their normalized_merchant text. The exported engine functions that could supply
              it (ruleImpactIds per remaining rule) would cost one full pass per rule on every
              keystroke in the date field, and the cheap version belongs beside ruleClearIds in
              src/lib/categorize/engine.ts -- a file this lane does not own. Reported rather than
              reached across; "if" is honest about a case that may not apply, where the old sentence
              was not. */}
          <p className="text-sm text-ink">
            If another rule also matches one of these, it will not take over automatically -- other rules are not
            re-run, so they stay {rule.ruleKind === 'transfer' ? 'unflagged' : 'uncategorized'} until you run rules
            again.
          </p>
          <ScopeChoice name="clear-rule-scope" scope={scope} onChange={setScope} backwards={backwards} />
        </>
      )}
      {previewError ? (
        <p role="alert" className="text-xs font-medium text-negative-soft-fg">
          {previewError}
        </p>
      ) : null}
      <div className="flex gap-2">
        <form action={nothingToClear ? deleteAction : action} onSubmit={onClose}>
          <input type="hidden" name="ruleId" value={String(rule.id)} />
          {nothingToClear ? null : (
            <>
              <input type="hidden" name="from" value={isRename ? '' : from} />
              <input type="hidden" name="to" value={isRename ? '' : to} />
            </>
          )}
          <SubmitButton
            variant={nothingToClear ? 'primary' : 'danger'}
            size="sm"
            disabled={backwards || previewError !== null}
          >
            {nothingToClear ? 'Delete rule' : isRename ? 'Delete and restore' : 'Delete and clear'}
          </SubmitButton>
        </form>
        <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
          Cancel
        </button>
      </div>
    </RowDialog>
  );
}

/**
 * Dialog 4 of v1.24.0, and a deliberate REVERSAL of the note that used to sit on this page's
 * inline "Re-run rules" panel (and is quoted in RowDialog.tsx's own when-to-use docblock as the
 * worked example of a page-level panel that correctly stayed inline). That reasoning was sound on
 * its own terms -- a re-run only ever adds, so there was nothing destructive to weigh -- but the
 * owner asked for the dialog anyway (2026-09-01: "when we click re-run it should open a dialogue
 * saying re-runs rules for all or specific date range... blurred popup with proper disclaimer"),
 * and the reason is one this file could not see from inside its own decision: with delete-and-clear
 * now asking the SAME "all time or a date range" question in a blurred dialog, leaving the re-run
 * as an inline strip would teach that the two idioms mean different degrees of seriousness. One
 * confirm idiom across the page is worth more than one panel's correctness in isolation.
 *
 * The counts are still previewed before the click, exactly as the inline panel did -- that part was
 * never the problem -- only now they are recomputed whenever the range changes.
 */
function RunRulesDialog({ action, onClose }: { action: (formData: FormData) => void; onClose: () => void }) {
  const [scope, setScope] = useState<ScopeState>({ mode: 'all', from: '', to: '' });
  const { from, to, backwards } = scopeBounds(scope);
  const [preview, setPreview] = useState<{ eligible: number; wouldChange: number } | null>(null);

  useEffect(() => {
    if (backwards) return;
    let live = true;
    setPreview(null);
    void previewRerunAllAction(from === '' ? null : from, to === '' ? null : to).then((result) => {
      if (live) setPreview(result);
    });
    return () => {
      live = false;
    };
  }, [from, to, backwards]);

  return (
    <RowDialog dialogId="run-rules-dialog" title="Run rules now?" onClose={onClose}>
      {/*
        This wording is written from ELIGIBLE and applyRenameRules (src/lib/categorize/engine.ts),
        not the other way round. "Transactions you haven't set by hand" would have been too
        generous: the engine also skips a row a rule has already settled (source = 'rule' with a
        category) and any row with splits, whose parts ARE its categorization. And renames are
        already retroactive at save time, so a run genuinely has little left to do for them.
      */}
      <p className="text-sm text-ink">
        Category rules are applied to transactions that are still uncategorized or were only auto-guessed. Anything you
        categorized by hand, split into parts, or that a rule has already settled is left exactly as it is.
      </p>
      <p className="text-sm text-ink">
        Renames are applied the moment you save a rename rule, so a run has little left to do for them.
      </p>
      <p className="text-sm text-ink">
        {preview === null ? (
          'Checking what a run would change…'
        ) : preview.eligible === 0 ? (
          'Nothing to run -- no eligible transaction is waiting.'
        ) : (
          <>
            This will look at <strong className="font-semibold">{preview.eligible}</strong> transaction
            {preview.eligible === 1 ? '' : 's'}; about <strong className="font-semibold">{preview.wouldChange}</strong>{' '}
            would actually change.
          </>
        )}
      </p>
      <ScopeChoice name="run-rules-scope" scope={scope} onChange={setScope} backwards={backwards} />
      <div className="flex gap-2">
        <form action={action} onSubmit={onClose}>
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="to" value={to} />
          <SubmitButton size="sm" disabled={backwards}>
            Run rules
          </SubmitButton>
        </form>
        <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
          Cancel
        </button>
      </div>
    </RowDialog>
  );
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
  /**
   * ruleId -> the rule that already covers it with the identical outcome (item 10's redundancy
   * detection, widened for 'word' -- see findRedundantRules' own docblock in
   * src/lib/categorize/rules.ts for the coverage matrix). Carries the covering rule's OWN pattern
   * and match type, not just its id: a household cannot judge "is this safe to delete" from a
   * number alone, and the covering rule is frequently off the current page, so the row has to be
   * handed everything it needs to name it without a second lookup.
   */
  redundantByRuleId: Record<number, { id: number; pattern: string; matchType: MatchType }>;
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
  const [clearState, deleteAndClear] = useActionState(deleteRuleAndClearAction, initial);

  const [selected, setSelected] = useState<number[]>([]);
  const toggle = (id: number) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const allOnPageSelected = rows.length > 0 && rows.every((rule) => selected.includes(rule.id));
  const toggleAllOnPage = () => {
    if (allOnPageSelected) setSelected((prev) => prev.filter((id) => !rows.some((rule) => rule.id === id)));
    else setSelected((prev) => [...new Set([...prev, ...rows.map((rule) => rule.id)])]);
  };

  const [editing, setEditing] = useState<RuleFormValues | null>(null);
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
  /** v1.24.0. Three nullable slots, one per dialog -- the same idiom `editing` already uses, so
   *  each dialog is only ever mounted while it is open (RowDialog's own mount-once contract). */
  const [deletingRule, setDeletingRule] = useState<MerchantRuleRecord | null>(null);
  const [clearingRule, setClearingRule] = useState<MerchantRuleRecord | null>(null);
  const [runningRules, setRunningRules] = useState(false);

  const notice = saveState.message ?? deleteState.message ?? bulkDeleteState.message ?? bulkDisableState.message ?? disableState.message ?? applyState.message ?? rerunState.message ?? clearState.message;
  const error = saveState.error ?? deleteState.error ?? bulkDeleteState.error ?? bulkDisableState.error ?? disableState.error ?? applyState.error ?? rerunState.error ?? clearState.error;

  const selectedRules = rows.filter((rule) => selected.includes(rule.id));
  // Only rows on THIS page are resolvable to a real record for the confirm text below -- a
  // selection spanning several pages still deletes correctly (ids travel with the form
  // regardless), it just cannot show a fully-accurate consequence count for ids off-page. Good
  // enough: the common case is selecting within one page's redundant/rename rows at a time.
  const revertCount = selectedRules
    .filter((rule) => rule.ruleKind === 'rename')
    .reduce((sum, rule) => sum + (impactCounts[rule.id] ?? 0), 0);

  /**
   * Dialog 1 of v1.24.0, replacing the `window.confirm` that RowMenuForm used to put up for this
   * row's Delete. It says the one thing the old one-liner could not fit and the owner asked for:
   * that the transactions this rule already changed KEEP what it gave them -- which is exactly why
   * the second menu item (Delete and clear) has to exist at all.
   *
   * Never offered for a rename rule. A rename delete already reverts every row it set
   * (deleteRuleAction -> deleteRenameRule), so this dialog's third sentence would be a plain lie
   * for that kind; a rename row's single Delete opens the clear dialog instead, whose copy is
   * written for what actually happens.
   */
  function deleteRuleDialog() {
    if (!deletingRule) return null;
    const isOverride = deletingRule.ruleKind === 'not_transfer';
    return (
      <RowDialog dialogId="delete-rule-dialog" title="Delete this rule?" onClose={() => setDeletingRule(null)}>
        <p className="text-sm text-ink">
          Deleting a rule cannot be undone. The rule stops matching future imports. Transactions it already changed keep
          what it gave them.
        </p>
        {isOverride ? (
          // Kind-true and worth the extra line: a not_transfer rule's whole job is vetoing the
          // built-in card-payment patterns (detectTransfer, src/lib/categorize/engine.ts), so
          // deleting it hands that merchant straight back to them.
          <p className="text-sm text-ink">
            Without this override, the card-payment patterns can flag that merchant as a transfer again the next time
            rules run.
          </p>
        ) : null}
        <div className="flex gap-2">
          <form action={removeRule} onSubmit={() => setDeletingRule(null)}>
            <input type="hidden" name="ruleId" value={String(deletingRule.id)} />
            <SubmitButton variant="danger" size="sm">Delete rule</SubmitButton>
          </form>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setDeletingRule(null)}>
            Cancel
          </button>
        </div>
      </RowDialog>
    );
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
          {/* v1.25.0 (item 18). Which row this dialog was opened on -- absent for a new rule. It
              does NOT make the save an update-by-id (the note further down still holds, and the
              action still upserts on the key): it is the only way a save that lands under a NEW key
              can tell the pack "the rule you installed lives here now", so the next pack update
              leaves the household's version alone instead of offering the original back. */}
          {editing.id === null ? null : <input type="hidden" name="fromRuleId" value={editing.id} />}
          <Field label="Pattern" hint="Compared against the UPPERCASE normalized merchant text -- any case you type is uppercased on save.">
            <input name="pattern" defaultValue={editing.pattern} placeholder="WALMART" required autoFocus className={inputClass} />
          </Field>
          {/* v1.25.0 (item 16). "Whole word" is written for a person, and the helper text uses the
              two REAL merchants from the bug it fixes (IGA/MICHIGAN) rather than FOO/BAR: the
              whole difficulty of this field is that "contains" sounds harmless until you have
              seen it match inside a longer word once. The option values stay the stored enum
              values -- the label is prose, the value is data. */}
          <Field
            label="Match"
            hint="exact: the whole merchant text, nothing else. contains: anywhere in the text, even inside a longer word. Whole word: matches IGA in IGA MARCHE, but never inside MICHIGAN — available for category and rename rules."
          >
            <select
              name="matchType"
              defaultValue={editing.matchType}
              className={selectClass}
            >
              <option value="exact">exact</option>
              <option value="contains">contains</option>
              <option value="word">Whole word</option>
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
              {/* v1.25.0 (item 18). Before this release, following the advice above on a preset rule
                  was a trap: deleting the pack's row left the update flow with no way to tell the
                  replacement apart from a rule written from scratch, so the next update added the
                  original straight back. The condition on the promise is exact -- an origin is only
                  carried onto a row this save CREATES, so a pattern that already has a rule of its
                  own is updated in place and inherits nothing (planPackOriginCarry, src/lib/packs.ts). */}
              {editing.isPreset
                ? ' This rule came from the preset pack: save it under a pattern you do not already have a rule for, and a later pack update leaves your version alone instead of adding this one back.'
                : ''}
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
          <strong className="font-semibold text-ink">not a transfer</strong> rule is an override that stops a
          merchant from being auto-flagged as a card payment.
        </p>
        <p>
          <strong className="font-semibold text-ink">Disable</strong> is a switch you can flip back; it stops a
          rule from matching without losing it, and reverts a rename rule&apos;s rows exactly like deleting one
          would. <strong className="font-semibold text-ink">Delete rule</strong> is for a genuine mistake: the rule
          stops matching, and the transactions it already changed keep what it gave them.{' '}
          <strong className="font-semibold text-ink">Delete rule and clear from transactions</strong> also takes the
          category (or the transfer flag) back off those transactions and returns them to Needs review -- that part
          cannot be undone, so it tells you how many are involved and asks first. A row marked{' '}
          <strong className="font-semibold text-ink">redundant</strong> is already matched by a broader rule with
          the identical outcome -- filter to it below for what that means and what to do about it.
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
              // v1.27.0, owner finding: a redundant rule changes NO categorization today --
              // longest-pattern-wins means the covering rule already produces the identical
              // outcome, so this is a tidy-up, not a fault. 'warning' carried the same visual
              // weight as something broken, which is exactly the confusion the owner reported
              // ("a yellow banner catches eye but i dont know what to do"). Same tone as the
              // Preset chip below when active -- neither filter is flagging a problem.
              <Link href={chipHref(currentQuery, { redundant: redundantOnly ? null : '1' })} className="inline-flex min-h-11 items-center sm:min-h-0">
                <Pill tone={redundantOnly ? 'accent' : 'neutral'}>{`Redundant (${redundantCount})`}</Pill>
              </Link>
            ) : null}
            {presetCount > 0 ? (
              <Link href={chipHref(currentQuery, { preset: presetOnly ? null : '1' })} className="inline-flex min-h-11 items-center sm:min-h-0">
                <Pill tone={presetOnly ? 'accent' : 'neutral'}>{`Preset (${presetCount})`}</Pill>
              </Link>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
            {/* Label unchanged ("Re-run rules"): the page guide above names this control, and the
                dialog it now opens explains itself in full. */}
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setRunningRules(true)}>
              Re-run rules
            </button>
            <span className="text-sm text-muted">
              For all time, or a date range you choose.
            </span>
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

      {/*
        v1.27.0, owner finding: the redundant explanation used to live in the last sentence of a
        long PageGuide paragraph, and the chip itself said nothing -- an eye-catching filter with
        no explanation in view and no action offered. This is IN VIEW the moment the filter is
        active, states both halves of why a household should care (nothing changes today; the
        risk is later), and offers the one action that follows from it.

        "Delete these N" reuses the SAME bulk-delete path the multi-select toolbar above already
        uses (setSelected + confirmingBulkDelete -> bulkDeleteDialog -> bulkDelete), rather than a
        second delete mechanism: it selects every redundant rule (redundantByRuleId carries every
        one of them, not just this page's -- see that prop's own docblock) and opens the same
        confirm. That dialog already states the count and, for a rename rule among the selection,
        the transactions that would revert.
      */}
      {redundantOnly && redundantCount > 0 ? (
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-neutral-soft px-4 py-3">
          <p className="text-sm text-ink">
            Each of these rules matches text a broader rule already resolves to the identical outcome, so deleting
            them changes nothing about how transactions are categorized today. The reason to still care: if you
            later edit the broader rule to a different category, a redundant rule underneath it keeps overriding it
            for that one merchant string -- silently, with no sign on screen that your edit did not take effect.
          </p>
          <button
            type="button"
            className="btn btn--secondary btn--sm w-fit"
            onClick={() => {
              setSelected(Object.keys(redundantByRuleId).map(Number));
              setConfirmingBulkDelete(true);
            }}
          >
            {`Delete these ${redundantCount}`}
          </button>
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
                        // v1.27.0, owner finding: this used to name only a rule ID, in a `title`
                        // attribute nobody sees without hovering -- a household cannot judge "is
                        // this safe to delete" without seeing WHAT covers it. Both the badge and
                        // the covering rule's own pattern/match type are in view here, not just on
                        // hover (the title is kept too, for anyone who does hover).
                        <span
                          className="ml-2 inline-flex items-center gap-1"
                          title={`Already covered by the ${coveredBy.matchType} rule "${coveredBy.pattern}"`}
                        >
                          <span className="badge badge--amber">redundant</span>
                          <span className="text-[11px] font-normal text-muted">
                            {`covered by ${coveredBy.matchType} "${coveredBy.pattern}"`}
                          </span>
                        </span>
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
                              isPreset: rule.packSource !== null,
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
                        {/*
                          v1.24.0. Two delete items for a category or transfer rule -- "the rule
                          only" and "the rule and what it did" -- because those are two genuinely
                          different acts and the old single Delete quietly did the first while a
                          person expected the second (the owner's report: "user deletes the rule
                          but nothing gets fixed").

                          A RENAME rule keeps ONE item: deleting it already reverts every row it
                          set, so a "delete only" choice does not exist for that kind and offering
                          one would be a menu entry that cannot do what it says.

                          A NOT_TRANSFER rule keeps ONE item too, for the opposite reason: clearing
                          it would mean re-flagging its rows AS transfers, which is a stronger
                          claim than a revert and would drop that money out of every report and
                          budget. Delete-only, and the engine refuses it as well
                          (clearRuleFromTransactions) so a stale form cannot reach it.

                          Both items now open a RowDialog. The window.confirm they replace could
                          not hold the disclosure this decision needs, and the owner asked for the
                          same blurred popup the notes editor uses.
                        */}
                        {rule.ruleKind === 'rename' ? (
                          <RowMenuButton onSelect={() => setClearingRule(rule)}>Delete rule</RowMenuButton>
                        ) : (
                          <RowMenuButton onSelect={() => setDeletingRule(rule)}>Delete rule</RowMenuButton>
                        )}
                        {rule.ruleKind === 'category' || rule.ruleKind === 'transfer' ? (
                          <RowMenuButton onSelect={() => setClearingRule(rule)}>
                            Delete rule and clear from transactions
                          </RowMenuButton>
                        ) : null}
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
      {deleteRuleDialog()}
      {/* `key` on the rule id: RowDialog's mount-once contract (its own docblock) means switching
          which row a mounted dialog acts on must force a remount, not reuse one instance. */}
      {clearingRule ? (
        <ClearRuleDialog
          key={clearingRule.id}
          rule={clearingRule}
          action={deleteAndClear}
          deleteAction={removeRule}
          onClose={() => setClearingRule(null)}
        />
      ) : null}
      {runningRules ? <RunRulesDialog action={rerunAll} onClose={() => setRunningRules(false)} /> : null}
    </div>
  );
}
