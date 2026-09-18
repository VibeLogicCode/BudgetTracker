import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { TableWrap } from '@/components/ui/Table';
import { formatCents } from '@/lib/money';
import { BASIS_LABELS, INTEREST_WORDING } from '@/lib/loans/basis-labels';
import type { LoanAnchor, LoanInterest, LoanReconciliation } from '@/lib/loans';
import type { LoanDirection } from '@/lib/warranty/constants';

/**
 * What interest has done to this loan since the last figure a person confirmed.
 *
 * EVERY RATE-DERIVED NUMBER HERE IS AN ESTIMATE, and the card says so once, at the bottom, rather
 * than hedging every line (ruling I20). The app cannot reproduce a lender's arithmetic -- different
 * posting days, different rounding, fees, a rate that changed mid-period -- and pretending
 * otherwise on the largest number a household owes would be worse than saying nothing.
 *
 * TWO FIGURES ARE NOT ESTIMATES, and they are the reason the statement history exists (ruling I21):
 *   - what the balance moved BETWEEN two confirmed statements, beyond the payments linked here --
 *     that is what the lender actually added, fees and all;
 *   - the interest the statements themselves printed, when somebody typed it in.
 * Both are labelled as facts and neither depends on a rate or a convention.
 *
 * The card renders nothing at all when no basis is set, which is every loan on every existing
 * install until somebody chooses one (ruling I5).
 */
export function LoanInterestCard({
  interest,
  reconciliation,
  direction,
  onReconcile,
}: {
  interest: LoanInterest | null;
  reconciliation: LoanReconciliation | null;
  direction: LoanDirection;
  /** Rendered as the Reconcile button when the caller can open the form. */
  onReconcile?: React.ReactNode;
}) {
  if (interest === null) return null;
  const words = INTEREST_WORDING[direction];
  const free = interest.basis === 'none';

  return (
    <Card>
      <CardHeader
        title={free ? words.free : `${words.charged} — our estimate`}
        description={BASIS_LABELS[interest.basis]}
        action={onReconcile}
      />
      <CardBody>
        <div className="flex flex-col gap-4">
          {/*
            OWING NOW LEADS, and the figure a person typed becomes the line beneath it (ruling I17).
            Two headline figures for one loan would make a reader choose between them; one leads and
            the second says where it came from.
          */}
          <div>
            <p className="money-xl text-ink">{formatCents(interest.owingCents)}</p>
            <p className="text-sm text-muted">
              {free ? 'Owing now' : 'Owing now, estimated'} · statement{' '}
              {interest.anchorDate} was {formatCents(interest.anchorBalanceCents)}
            </p>
          </div>

          {free ? null : (
            <dl className="grid gap-4 sm:grid-cols-3">
              <Figure label="This month" value={formatCents(interest.thisMonthChargeCents)} />
              {/*
                NEVER "annual interest". On any amortising loan the balance falls all year, so
                twelve times this month overstates it -- the label has to carry the condition
                (ruling I20, flag 1).
              */}
              <Figure
                label="A year at this balance"
                value={formatCents(interest.yearAtCurrentBalanceCents)}
                hint="if the balance stayed where it is"
              />
              <Figure
                label={`Since ${interest.anchorDate}`}
                value={formatCents(interest.interestSinceAnchorCents)}
              />
            </dl>
          )}

          {reconciliation === null || reconciliation.statedInterestTotalCents === null ? null : (
            <p className="text-sm text-ink">
              <span className="font-medium">{formatCents(reconciliation.statedInterestTotalCents)}</span>{' '}
              {words.paid.toLowerCase()}, from your statements
              <span className="text-muted">
                {' '}
                ({reconciliation.statedInterestCount}{' '}
                {reconciliation.statedInterestCount === 1 ? 'statement' : 'statements'})
              </span>
            </p>
          )}

          {interest.months.length === 0 ? null : <MonthTable interest={interest} anchors={reconciliation?.anchors ?? []} />}

          <p className="text-xs text-subtle">{claim(reconciliation)}</p>
        </div>
      </CardBody>
    </Card>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="money text-ink">{value}</dd>
      {hint === undefined ? null : <p className="text-xs text-subtle">{hint}</p>}
    </div>
  );
}

/** Month by month: the "how has it grown" view the request asked for. */
function MonthTable({ interest, anchors }: { interest: LoanInterest; anchors: LoanAnchor[] }) {
  const byMonth = new Map(anchors.map((anchor) => [anchor.asOfDate.slice(0, 7), anchor]));
  return (
    <TableWrap bare responsive minWidth="34rem">
      <thead>
        <tr>
          <th scope="col">Month</th>
          <th scope="col" className="text-right">Charged</th>
          <th scope="col" className="text-right">Paid off</th>
          <th scope="col" className="text-right">Owing at month end</th>
        </tr>
      </thead>
      <tbody>
        {interest.months.map((month) => {
          const anchor = byMonth.get(month.month);
          return (
            <tr key={month.month}>
              <td className="cell-stack-headline" data-label="Month">
                {month.month}
                {anchor === undefined ? null : (
                  // A statement lands INSIDE the list, where the estimate it corrected can be seen
                  // beside it -- the correction is its own line, never a rewrite (ruling R6).
                  <span className="block text-xs text-subtle">
                    statement {formatCents(anchor.balanceCents)}
                    {anchor.differenceCents === null || anchor.differenceCents === 0
                      ? null
                      : ` · ${formatCents(Math.abs(anchor.differenceCents))} ${anchor.differenceCents > 0 ? 'more' : 'less'} than our estimate`}
                  </span>
                )}
                {month.shortfall ? (
                  <span className="block text-xs text-warning-soft-fg">Did not cover the month&rsquo;s interest.</span>
                ) : null}
              </td>
              <td className="money text-right" data-label="Charged">{formatCents(month.chargedCents)}</td>
              <td className="money text-right text-muted" data-label="Paid off">
                {formatCents(month.principalPaidCents)}
                {month.advancedCents === 0 ? null : (
                  <span className="block text-xs text-subtle">{formatCents(month.advancedCents)} advanced</span>
                )}
              </td>
              <td className="money text-right" data-label="Owing at month end">{formatCents(month.closingCents)}</td>
            </tr>
          );
        })}
      </tbody>
    </TableWrap>
  );
}

/**
 * What the card is allowed to claim, by state (ruling R9). The wording is the point: "our estimate
 * since your 1 Sep statement" is defensible, "your interest this year" is not.
 */
function claim(reconciliation: LoanReconciliation | null): string {
  const newest = reconciliation?.newest ?? null;
  if (newest === null) return 'Estimated from the rate and balance recorded here.';

  const from = `Estimated from your rate and the balance of ${newest.asOfDate}.`;
  const caveat =
    ' Your lender’s statement can differ — it may charge interest on different days, round differently, add fees, or have changed your rate.';

  if (reconciliation !== null && reconciliation.stale) {
    return `${from}${caveat} It has not been checked against a statement since ${newest.asOfDate} — the longer that goes, the further these figures drift.`;
  }
  if (reconciliation !== null && !reconciliation.everReconciled) {
    return `${from}${caveat} Reconcile to a statement to check it.`;
  }
  return `${from}${caveat} Reconcile again whenever a new statement arrives.`;
}
