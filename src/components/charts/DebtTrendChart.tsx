'use client';

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DebtPoint } from '@/lib/loans';
import { AXIS_TICK, CHART_GRID, TOOLTIP_CURSOR, tooltipStyles } from './chart-theme';

/**
 * The codebase's first line chart, modelled on CashflowChart's skeleton: same h-64, same
 * cents-to-dollars mapping, same theme imports, so it follows the theme toggle with no JS.
 *
 * The Owed series is var(--negative-solid) -- this is money owed -- and connectNulls is
 * FALSE so a gap in the data reads as a gap (MUST-15.7). A line that bridged an unknown month
 * would be inventing the very thing the reconstruction refuses to invent.
 *
 * Review fix-round: dot is a small token-styled marker rather than `false`. With
 * connectNulls false, any isolated non-null point -- a single point with NULL neighbours on
 * both sides -- is a zero-length segment, which a bare stroke renders as nothing at all. The
 * caller (reports-client.tsx) now keeps the fewer-than-two-points case out of this component
 * entirely, but two non-adjacent non-null points elsewhere in the series would still each be
 * an invisible segment without a dot to mark them.
 *
 * v1.14.0 (spec BU, rulings P5, P12): a second, optional series -- Lent, money owed TO the
 * household, and therefore the already-positive token (var(--positive-solid)) rather than a
 * mirrored dip below zero. It is drawn only when `showLent` is true (a lent loan with a
 * balance exists), same connectNulls={false} and dot treatment as Owed. The `<Legend>` exists
 * only because there are now two lines to tell apart -- a legend over a single line is noise,
 * so it too is conditional on `showLent`.
 */
export function DebtTrendChart({ data, showLent }: { data: DebtPoint[]; showLent: boolean }) {
  const series = data.map((point) => ({
    month: point.month,
    Owed: point.owedCents === null ? null : point.owedCents / 100,
    Lent: point.lentCents === null ? null : point.lentCents / 100,
  }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...CHART_GRID} />
          <XAxis dataKey="month" {...AXIS_TICK} />
          <YAxis {...AXIS_TICK} width={64} />
          <Tooltip
            formatter={(value: number) => `$${value.toFixed(2)}`}
            // TOOLTIP_CURSOR's `fill` styles a BarChart's rectangle cursor; recharts' Curve
            // cursor (what a LineChart draws instead) hard-codes stroke #ccc unless one is
            // given explicitly, so the theme token is added here rather than in the shared
            // constant, which stays correct for the bar charts that already use it as-is.
            cursor={{ ...TOOLTIP_CURSOR, stroke: 'var(--line-strong)' }}
            {...tooltipStyles()}
          />
          {showLent ? <Legend wrapperStyle={{ fontSize: 12, color: 'var(--muted)', paddingTop: 8 }} /> : null}
          <Line
            type="monotone"
            dataKey="Owed"
            stroke="var(--negative-solid)"
            strokeWidth={2}
            dot={{ r: 2, fill: 'var(--negative-solid)', strokeWidth: 0 }}
            connectNulls={false}
          />
          {showLent ? (
            <Line
              type="monotone"
              dataKey="Lent"
              stroke="var(--positive-solid)"
              strokeWidth={2}
              dot={{ r: 2, fill: 'var(--positive-solid)', strokeWidth: 0 }}
              connectNulls={false}
            />
          ) : null}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
