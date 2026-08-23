'use client';

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { NetWorthPoint } from '@/lib/networth';
import { AXIS_TICK, CHART_GRID, TOOLTIP_CURSOR, tooltipStyles } from './chart-theme';

/**
 * Assets, debts and net over time. Same LineChart skeleton as DebtTrendChart (h-64,
 * cents-to-dollars, theme tokens via CSS custom properties), plus CashflowChart's Legend
 * because three series need one to tell them apart.
 *
 * Debts is plotted as the already-positive magnitude NetWorthPoint.debtsCents carries (never
 * negative -- see that field's docblock in src/lib/networth.ts), so the line reads as "how
 * much is owed" rather than a mirrored dip below zero. Net gets the accent token rather than
 * the positive/negative money pair, the same choice CategoryBarChart makes for its own single
 * derived series: assets and debts already own green and red, so net (their difference) takes
 * a third, neutral color instead of competing for one of those two.
 *
 * Unlike DebtTrendChart, netWorthOverTime never returns a null point mid-series (an unknown
 * loan figure folds into debtsCents as 0 rather than propagating), so there is no gap to leave
 * unconnected and no isolated-point dot to worry about.
 */
export function NetWorthChart({ data }: { data: NetWorthPoint[] }) {
  const series = data.map((point) => ({
    month: point.month,
    Assets: point.assetsCents / 100,
    Debts: point.debtsCents / 100,
    Net: point.netCents / 100,
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
            cursor={{ ...TOOLTIP_CURSOR, stroke: 'var(--line-strong)' }}
            {...tooltipStyles()}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--muted)', paddingTop: 8 }} />
          <Line type="monotone" dataKey="Assets" stroke="var(--positive-solid)" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="Debts" stroke="var(--negative-solid)" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="Net" stroke="var(--accent)" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
