import { buttonClass } from '@/components/ui/Button';
import { labelClass, selectClass } from '@/components/ui/form';
import { RECURRING_SHOWS, RECURRING_SORTS, type RecurringLinkScope } from '@/lib/insights-links';
import type { RecurringAccount } from '@/lib/recurring';
import { SHOW_LABEL, SORT_LABEL } from '@/lib/recurring-view';

/**
 * Spec 2026-10-06 §2.2. A plain GET form: the choices are the page address, so a filtered list can be
 * bookmarked or sent. Each label wraps its select (no useId, so this renders on the server). Lives in
 * src/components, beside the other Insights pieces: it is a filter, not a row control
 * (tests/ops/row-controls.test.ts).
 */
export function RecurringFilters({ accounts, scope }: { accounts: RecurringAccount[]; scope: RecurringLinkScope }) {
  return (
    <form method="get" action="/insights/recurring" className="flex flex-wrap items-end gap-3">
      {scope.person === null ? null : <input type="hidden" name="person" value={String(scope.person)} />}
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Account</span>
        <select name="account" defaultValue={scope.account === null ? '' : String(scope.account)} className={selectClass}>
          <option value="">All accounts</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Show</span>
        <select name="show" defaultValue={scope.show} className={selectClass}>
          {RECURRING_SHOWS.map((value) => (
            <option key={value} value={value}>
              {SHOW_LABEL[value]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Sort</span>
        <select name="sort" defaultValue={scope.sort} className={selectClass}>
          {RECURRING_SORTS.map((value) => (
            <option key={value} value={value}>
              {SORT_LABEL[value]}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className={buttonClass('secondary', 'sm', 'min-h-11 sm:min-h-0')}>
        Apply
      </button>
    </form>
  );
}
