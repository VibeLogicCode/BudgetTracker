import Link from 'next/link';
import { RecurringRowActions } from '@/components/insights/RecurringRowActions';
import { ListRow } from '@/components/ui/ListRow';
import { TableWrap } from '@/components/ui/Table';
import { dayLabel } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import type { RecurringChargeRow, RecurringTier } from '@/lib/recurring';
import { nextExpectedText, priceRiseText, rhythmLabel, TIER_LABEL } from '@/lib/recurring-view';
// Every /transactions link in this app is built here (F-01).
import { transactionsHref } from '@/lib/transaction-links';

const TIER_BADGE: Record<RecurringTier, string> = { known: 'badge badge--accent', looks: 'badge badge--slate', forming: 'badge badge--muted' };

const money = (cents: number | null) => (cents === null ? '—' : formatCents(cents));

/** Late, the price rise, and the record that covers the merchant -- measured facts, no verdicts (spec §2.7). */
function Tags({ row }: { row: RecurringChargeRow }) {
  const rise = priceRiseText(row);
  if (!row.late && rise === null && row.tracked === null) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {row.late ? <span className="badge badge--red">Late</span> : null}
      {rise === null ? null : <span className="badge badge--amber">{rise}</span>}
      {row.tracked === null ? null : (
        <Link href={`/warranties/${row.tracked.itemId}`} className="badge badge--green hover:underline">
          {row.tracked.itemName}
        </Link>
      )}
    </span>
  );
}

/**
 * Spec 2026-10-06 §2.2. Laid out like Transactions: a list of ListRows on a phone and a table from
 * `sm` up. A real browser shows one of the two; jsdom shows both, so tests scope to
 * data-recurring-cards or data-recurring-table. One row per merchant, every tier, no cap.
 */
export function RecurringTable({ rows, person, today }: { rows: RecurringChargeRow[]; person: number | null; today: string }) {
  const merchantLink = (row: RecurringChargeRow) => (
    <Link href={transactionsHref({ range: null, person }, { kind: 'merchant', merchant: row.merchant })} className="font-medium text-ink hover:text-accent-text">
      {row.merchant}
    </Link>
  );
  return (
    <>
      <ul className="border-t border-line sm:hidden" data-recurring-cards>
        {rows.map((row) => (
          <ListRow
            key={row.merchant}
            title={merchantLink(row)}
            meta={`${TIER_LABEL[row.tier]} · ${rhythmLabel(row)} · ${row.accounts.map((account) => account.name).join(', ')}`}
            detail={
              <>
                <span>Last {dayLabel(row.lastDate, today)}</span>
                {row.nextExpected === null ? null : (
                  <span>{row.nextExpected < today ? nextExpectedText(row, today) : `next ${nextExpectedText(row, today)}`}</span>
                )}
                <Tags row={row} />
              </>
            }
            amount={row.monthlyCents === null ? '—' : `${formatCents(row.monthlyCents)}/mo`}
            trailing={<RecurringRowActions row={row} />}
          />
        ))}
      </ul>
      <div className="hidden sm:block" data-recurring-table>
        <TableWrap bare>
          <thead>
            <tr>
              <th scope="col">Merchant</th>
              <th scope="col">Tier</th>
              <th scope="col">Rhythm</th>
              <th scope="col" className="text-right">Typical</th>
              <th scope="col" className="text-right">Monthly</th>
              <th scope="col">Last charge</th>
              <th scope="col">Next expected</th>
              <th scope="col">Accounts</th>
              <th scope="col">Tags</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.merchant}>
                <td>
                  {merchantLink(row)}
                  <div className="text-xs text-subtle">
                    {row.chargeCount} {row.chargeCount === 1 ? 'charge' : 'charges'}
                  </div>
                </td>
                <td>
                  <span className={TIER_BADGE[row.tier]}>{TIER_LABEL[row.tier]}</span>
                </td>
                <td>{rhythmLabel(row)}</td>
                <td className="tabnum text-right">{money(row.typicalCents)}</td>
                <td className="tabnum text-right">{money(row.monthlyCents)}</td>
                <td className="tabnum whitespace-nowrap text-muted">{dayLabel(row.lastDate, today)}</td>
                <td className={row.late ? 'text-danger' : 'text-muted'}>{nextExpectedText(row, today)}</td>
                <td className="text-muted">{row.accounts.map((account) => account.name).join(', ')}</td>
                <td>
                  <Tags row={row} />
                </td>
                <td>
                  <RecurringRowActions row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </div>
    </>
  );
}
