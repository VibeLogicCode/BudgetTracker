import Link from 'next/link';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { TableWrap } from '@/components/ui/Table';
import { formatCents } from '@/lib/money';
// F-05: type-only, so @/lib/recurring (which imports @/db) never becomes a bundle edge --
// tests/ops/client-bundle.test.ts draws exactly that line.
import type { RecurringChargeRow } from '@/lib/recurring';
// Every /transactions link in this app is built here (F-01). A hand-built querystring is what
// drops the person scope and quietly answers a different question than the row above it.
import { transactionsHref } from '@/lib/transaction-links';

/**
 * F-05 (2026-09-02 review, v1.31.0). "Recurring charges": merchants whose charges have arrived
 * on a monthly or yearly rhythm and are still arriving.
 *
 * THE WORDING IS THE FEATURE. Cadence detection cannot tell a streaming subscription from a
 * once-a-month grocery shop or a utility bill that varies -- they make the same dates -- so
 * every string below describes what was MEASURED (a rhythm, an amount, a date, a count) and
 * none of them says "subscription", "wasted", "forgotten" or "cancel". The card's own
 * description says outright that a rhythm is not a subscription, and the disclosure sits in the
 * card rather than in a tooltip because a person who reads only the title and the numbers must
 * still not be misled. Three v1.30.0 fixes and one this release exist because a surface
 * asserted more than its data supported; this one is written not to need a fifth.
 *
 * The household supplies the judgement by pressing Track, which opens the ordinary new-item
 * form prefilled from the newest charge (/warranties/new?transactionId=, the ONE prefill path
 * -- see warranties/new/page.tsx, where the prefill is computed server-side from the row and no
 * field value is ever trusted from the URL). There is no "dismiss", and deliberately: dismissing
 * a row would have to be stored somewhere, and nothing about this feature is stored.
 */
export function RecurringChargesCard({
  rows,
  /** The person scope the rows were built with, passed straight into every drill-down link so
   *  the link and the figure ask the same question (transactionsHref's own rule). */
  person,
}: {
  rows: RecurringChargeRow[];
  person: string | number | null;
}) {
  return (
    <Card>
      <CardHeader
        title="Recurring charges"
        description={
          <>
            Merchants whose charges have arrived on a monthly or yearly rhythm, read from the
            ledger going back about three years. A rhythm is not a subscription — a once-a-month
            shop or a bill that varies looks the same from here — so this is a list of candidates
            to look at, not a verdict. Nothing on this card is saved anywhere; Track records one
            as an item.
          </>
        }
      />
      <CardBody padded={false}>
        {rows.length === 0 ? (
          <div className="px-4 pb-4 sm:px-5 sm:pb-5">
            <EmptyState
              size="compact"
              title="No merchant is charging on a regular rhythm yet"
              noAction="Nothing to do: this card reads the ledger, so it fills in on its own once a merchant has charged three times a month or a year apart."
            >
              Once a merchant has charged three times about a month (or a year) apart, it appears
              here. Importing more history is what makes a rhythm visible.
            </EmptyState>
          </div>
        ) : (
          <TableWrap bare responsive>
            <thead>
              <tr>
                <th scope="col">Merchant</th>
                <th scope="col">Rhythm</th>
                <th scope="col" className="text-right">Last charge</th>
                <th scope="col">Last seen</th>
                <th scope="col">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.merchant}>
                  <td className="cell-stack-headline" data-label="Merchant">
                    <Link
                      href={transactionsHref({ range: null, person }, { kind: 'merchant', merchant: row.merchant })}
                      className="font-medium text-ink hover:text-accent-text"
                    >
                      {row.merchant}
                    </Link>
                    {/* How many charges the rhythm was read from, and what the charge usually is.
                        Both are here because they are how a reader judges the row for themselves:
                        three charges is weaker evidence than thirty, and a "usually" far from the
                        last amount is the signature of a variable bill rather than a fixed fee. */}
                    <div className="cell-stack-meta text-xs text-subtle">
                      {row.chargeCount} charges · usually {formatCents(row.typicalCents)}
                    </div>
                  </td>
                  <td data-label="Rhythm">
                    <span className="badge badge--slate">{row.cadence === 'monthly' ? 'Monthly' : 'Yearly'}</span>
                  </td>
                  <td className="text-right cell-stack-amount" data-label="Last charge">
                    <Money cents={row.lastAmountCents} plain />
                  </td>
                  <td className="tabnum whitespace-nowrap text-muted" data-label="Last seen">{row.lastDate}</td>
                  <td data-label="Recorded">
                    {row.tracked === null ? (
                      /* The one action, and it goes nowhere new: the same prefill link the
                         transactions row menu already uses. */
                      <Link
                        href={`/warranties/new?transactionId=${row.transactionId}`}
                        className="btn btn--secondary btn--sm min-h-11 sm:min-h-0"
                      >
                        Track
                      </Link>
                    ) : (
                      /* NAMES the item, rather than a bare "tracked" tick. An item-name match is
                         a resemblance and can be wrong (see `covers` in src/lib/recurring.ts);
                         printing which record claimed this merchant is what lets a reader catch
                         it instead of wondering why a live charge has no Track link. */
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
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * The Contracts & Coverage header line: what the household has RECORDED as recurring billing.
 *
 * Kept in this module beside the card rather than inlined in warranties-client.tsx, because the
 * card's whole argument is about the difference between a recorded figure and a detected one --
 * the two wordings have to be read together to stay honest, and a reader changing one should
 * have the other on screen.
 *
 * The dashboard tile deliberately does NOT reuse this sentence: its VALUE already is the monthly
 * figure, so a hint repeating it would print the same number twice in one tile. It carries the
 * same two nouns ("Recorded billing", "recorded items") and the same never-blend-the-cycles rule
 * in its own hint instead.
 *
 * "Recorded", every time. The figure is the sum of billing amounts somebody typed into items;
 * it is emphatically NOT what the household actually pays, and the card above exists precisely
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
