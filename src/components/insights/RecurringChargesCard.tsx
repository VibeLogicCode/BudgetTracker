import Link from 'next/link';
import { RecurringMarkForm } from '@/components/insights/RecurringMarkForm';
import { buttonClass } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, selectClass } from '@/components/ui/form';
import { Money } from '@/components/ui/Money';
import { TableWrap } from '@/components/ui/Table';
import { formatCents } from '@/lib/money';
import type { RecurringCadence } from '@/lib/predict/anomalies';
// Type-only, so @/lib/recurring (which imports @/db) never becomes a bundle edge --
// tests/ops/client-bundle.test.ts draws exactly that line.
import type { RecurringAccount, RecurringChargeRow, RecurringCharges } from '@/lib/recurring';
// Every /transactions link in this app is built here (F-01).
import { transactionsHref } from '@/lib/transaction-links';

/**
 * Spec 2026-10-05 §2.3–§2.5. "Recurring charges" on Insights, in two tiers. Known recurring is the
 * household's word (a mark, or a recorded item covering a detected rhythm); Looks recurring is a
 * rhythm and nothing more.
 *
 * THE WORDING IS STILL THE FEATURE. Cadence detection cannot tell a once-a-month shop from a bill
 * that varies, so every string states what was measured or what the household said, and none says
 * "subscription", "wasted", "forgotten" or "cancel".
 *
 * What is saved: the household's marks, as merchant rules (Mark recurring, Not recurring, Unmark).
 * What is not: the detector's verdict, which is read fresh on every render.
 */
const CADENCE_LABEL: Record<RecurringCadence, string> = { monthly: 'Monthly', yearly: 'Yearly' };

/** Spec §2.3, forming rhythms. One sentence from the per-band count; null at zero, so the empty state stands. */
export function formingSentence(forming: Record<RecurringCadence, number>): string | null {
  const total = forming.monthly + forming.yearly;
  if (total === 0) return null;
  const merchants = (count: number) => `${count} ${count === 1 ? 'merchant has' : 'merchants have'}`;
  const bands =
    forming.monthly > 0 && forming.yearly > 0
      ? `${merchants(forming.monthly)} charged twice about a month apart, and ${forming.yearly} about a year apart.`
      : `${merchants(total)} charged twice about a ${forming.monthly > 0 ? 'month' : 'year'} apart.`;
  return `${bands} One more charge and ${total === 1 ? 'it appears' : 'they appear'} here.`;
}

/**
 * Spec §2.4. A plain GET form, so the choice is part of the address and can be bookmarked or sent.
 * The options are the accounts the listed rows charged. It lives here rather than in src/app because tests/ops/row-controls.test.ts refuses a lone select
 * with a submit button there, and this is a filter, not a row control.
 */
function AccountFilter({ accounts, accountId, person }: { accounts: RecurringAccount[]; accountId: number | null; person: number | null }) {
  return (
    <form method="get" action="/insights" className="flex flex-wrap items-end gap-2">
      {person === null ? null : <input type="hidden" name="person" value={String(person)} />}
      <Field label="Account">
        <select name="account" defaultValue={accountId === null ? '' : String(accountId)} className={selectClass}>
          <option value="">All accounts</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </Field>
      <button type="submit" className={buttonClass('secondary', 'sm', 'min-h-11 sm:min-h-0')}>
        Show
      </button>
    </form>
  );
}

function ChargeRowView({ row, person }: { row: RecurringChargeRow; person: number | null }) {
  return (
    <tr>
      <td className="cell-stack-headline" data-label="Merchant">
        <Link
          href={transactionsHref({ range: null, person }, { kind: 'merchant', merchant: row.merchant })}
          className="font-medium text-ink hover:text-accent-text"
        >
          {row.merchant}
        </Link>
        {/* How many charges, and what the charge usually is: how a reader judges the row. */}
        <div className="cell-stack-meta text-xs text-subtle">
          {row.chargeCount} {row.chargeCount === 1 ? 'charge' : 'charges'} · usually{' '}
          {row.typicalCents === null ? '—' : formatCents(row.typicalCents)}
        </div>
      </td>
      <td data-label="Rhythm">
        <span className="badge badge--slate">{row.cadence === null ? 'Marked' : CADENCE_LABEL[row.cadence]}</span>
      </td>
      <td className="text-right cell-stack-amount" data-label="Last charge">
        <Money cents={row.lastAmountCents} plain />
      </td>
      <td className="tabnum whitespace-nowrap text-muted" data-label="Last seen">{row.lastDate}</td>
      <td className="text-muted" data-label="Accounts">{row.accounts.map((account) => account.name).join(', ')}</td>
      <td data-label="Recorded">
        {row.tracked === null ? (
          <Link href={`/warranties/new?transactionId=${row.transactionId}`} className={buttonClass('secondary', 'sm', 'min-h-11 sm:min-h-0')}>
            Track
          </Link>
        ) : (
          /* NAMES the record: an item-name match is a resemblance and can be wrong (covers, recurring.ts). */
          <Link
            href={`/warranties/${row.tracked.itemId}`}
            className="badge badge--green hover:underline"
            title={
              row.tracked.kind === 'rule'
                ? `A payment-matching rule on "${row.tracked.itemName}" matches this merchant.`
                : `Recorded as the item "${row.tracked.itemName}".`
            }
          >
            {row.tracked.itemName}
          </Link>
        )}
      </td>
      <td data-label="Mark">
        <div className="flex flex-wrap items-start gap-2">
          {row.tier === 'looks' ? (
            <>
              <RecurringMarkForm transactionId={row.transactionId} mark="recurring" label="Mark recurring" ariaLabel={`Mark ${row.merchant} as recurring`} />
              <RecurringMarkForm
                transactionId={row.transactionId}
                mark="not_recurring"
                label="Not recurring"
                ariaLabel={`Mark ${row.merchant} as not recurring and take it off this list`}
              />
            </>
          ) : row.knownBy === 'mark' ? (
            <RecurringMarkForm transactionId={row.transactionId} mark="clear" label="Unmark" ariaLabel={`Unmark ${row.merchant}`} />
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function Tier({ title, note, rows, person, empty }: { title: string; note: string; rows: RecurringChargeRow[]; person: number | null; empty: string }) {
  return (
    <section className="border-t border-line">
      <div className="px-4 pt-4 sm:px-5">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="text-xs text-subtle">{note}</p>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted sm:px-5">{empty}</p>
      ) : (
        <TableWrap bare responsive>
          <thead>
            <tr>
              <th scope="col">Merchant</th>
              <th scope="col">Rhythm</th>
              <th scope="col" className="text-right">Last charge</th>
              <th scope="col">Last seen</th>
              <th scope="col">Accounts</th>
              <th scope="col">Recorded</th>
              <th scope="col">Mark</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ChargeRowView key={row.merchant} row={row} person={person} />
            ))}
          </tbody>
        </TableWrap>
      )}
    </section>
  );
}

export function RecurringChargesCard({ result, person }: { result: RecurringCharges; person: number | null }) {
  // The options are the accounts the listed rows charged, and the selected value is the filter the
  // read model actually applied; both come from the result so there is one source of truth.
  const { accounts, accountId } = result;
  const sentence = formingSentence(result.forming);
  const listed = result.known.length + result.looks.length;
  const chosen = accountId === null ? null : (accounts.find((account) => account.id === accountId) ?? null);
  return (
    <Card>
      <CardHeader
        title="Recurring charges"
        description="Merchants that bill on a rhythm, read from about three years of the ledger. Known recurring is what you said; Looks recurring is what the dates show. Mark recurring and Not recurring are saved as rules on the merchant, and Track records one as an item."
        action={<AccountFilter accounts={accounts} accountId={accountId} person={person} />}
      />
      <CardBody padded={false}>
        {listed === 0 && chosen !== null ? (
          <p className="px-4 pb-4 text-sm text-muted sm:px-5 sm:pb-5">
            Nothing on either list charged {chosen.name}.{sentence === null ? '' : ` ${sentence}`}
          </p>
        ) : listed === 0 && sentence === null ? (
          <div className="px-4 pb-4 sm:px-5 sm:pb-5">
            <EmptyState
              size="compact"
              title="No merchant is charging on a regular rhythm yet"
              noAction="Nothing to do: this card reads the ledger, so it fills in on its own once a merchant has charged three times a month or a year apart."
            >
              Once a merchant has charged three times about a month (or a year) apart, it appears here. Importing more
              history is what makes a rhythm visible.
            </EmptyState>
          </div>
        ) : (
          <>
            <Tier
              title="Known recurring"
              note="You marked it, or you track it."
              rows={result.known}
              person={person}
              empty="Nothing marked yet. Mark a merchant recurring from Looks recurring below, or from its row menu on Transactions."
            />
            <Tier
              title="Looks recurring"
              note="A rhythm, which is not a verdict: a once-a-month shop and a monthly bill make the same dates."
              rows={result.looks}
              person={person}
              empty={sentence ?? 'Nothing else is charging on a regular rhythm.'}
            />
            {result.looks.length > 0 && sentence !== null ? (
              <p className="border-t border-line px-4 py-3 text-sm text-muted sm:px-5">{sentence}</p>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * The Contracts & Coverage header line: what the household has RECORDED as recurring billing.
 *
 * Lives in this module, beside the Recurring charges card, rather than inlined in
 * warranties-client.tsx, because the card's whole argument is about the difference between a recorded figure and a detected one --
 * the two wordings have to be read together to stay honest, and a reader changing one should
 * have the other on screen.
 *
 * The dashboard tile deliberately does NOT reuse this sentence: its VALUE already is the monthly
 * figure, so a hint repeating it would print the same number twice in one tile. It carries the
 * same two nouns ("Recorded billing", "recorded items") and the same never-blend-the-cycles rule
 * in its own hint instead.
 *
 * "Recorded", every time. The figure is the sum of billing amounts somebody typed into items;
 * it is emphatically NOT what the household actually pays, and the Recurring charges card on Insights exists precisely
 * because the two differ. A line reading "Recurring: $412/month" -- the proposal's own wording
 * -- would have been read as the second thing while only ever being the first.
 */
export function recordedBillingSentence(load: { monthlyCents: number; annualCents: number; itemCount: number }): string | null {
  if (load.itemCount === 0) return null;
  const items = `${load.itemCount} recorded ${load.itemCount === 1 ? 'item' : 'items'}`;
  // The two cycles are never folded into one figure: dividing an annual bill by twelve invents
  // a monthly payment nobody makes, and adding it to the monthly total double-counts it.
  if (load.annualCents === 0) return `${formatCents(load.monthlyCents)} a month across ${items}.`;
  if (load.monthlyCents === 0) return `${formatCents(load.annualCents)} a year across ${items}.`;
  return `${formatCents(load.monthlyCents)} a month, plus ${formatCents(load.annualCents)} a year billed annually, across ${items}.`;
}
