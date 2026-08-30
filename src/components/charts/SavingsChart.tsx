'use client';

import { Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { MonthTrendRow } from '@/lib/reports';
import { AXIS_TICK, CHART_GRID, TOOLTIP_CURSOR, tooltipStyles } from './chart-theme';

/**
 * Savings targets, Lane 4 (spec docs/superpowers/plans/2026-08-30-savings-targets.md,
 * v1.17.0). Replaces CashflowChart on the Reports "Cash flow and savings rate" card -- the net
 * was text-only there, so the shape of the household's saving over time was invisible.
 *
 * One cashflowTrend() row (src/lib/reports.ts) plus its resolved savings target. `targetCents`
 * comes from savingsProgress() (src/lib/savings-target.ts, Lane 1) rather than being
 * recomputed here (ruling T1: this file must not invent a second definition of "saved" or
 * reimplement the percent/amount resolution) -- reports/page.tsx fetches it per month and
 * hands it down already resolved. It is `null` for a month with no target set, or a percent
 * target with no income to resolve against, and that null MUST reach the chart as-is: a
 * fallback zero would draw a target line reading "your target was nothing" for a month that in
 * fact had no opinion at all.
 */
export interface SavingsChartRow extends MonthTrendRow {
  targetCents: number | null;
}

/**
 * One shaped point of the recharts series. Exported so `buildSavingsSeries` below can be unit
 * tested directly, without mounting the chart: jsdom has no layout engine, so
 * ResponsiveContainer always measures 0x0 here and renders none of its children -- the same
 * limitation every other chart in this codebase already works around by not asserting on chart
 * internals in tests (see reports-client.test.tsx and reports.test.tsx).
 */
export interface SavingsSeriesPoint {
  month: string;
  Income: number;
  Spend: number;
  Net: number;
  'Cumulative saved': number;
  /** null, never 0, for a month with no target -- see SavingsChartRow's docblock above. */
  Target: number | null;
}

/**
 * Cents-to-dollars, plus the running total, in one pass. "Cumulative saved" sums netCents
 * across exactly the rows given -- the range is whatever the caller passed in, so it always
 * starts back at zero for THIS chart's data rather than carrying some other window's total.
 */
export function buildSavingsSeries(data: SavingsChartRow[]): SavingsSeriesPoint[] {
  let cumulativeCents = 0;
  return data.map((row) => {
    cumulativeCents += row.netCents;
    return {
      month: row.month,
      Income: row.incomeCents / 100,
      Spend: row.spendCents / 100,
      Net: row.netCents / 100,
      'Cumulative saved': cumulativeCents / 100,
      Target: row.targetCents === null ? null : row.targetCents / 100,
    };
  });
}

export function SavingsChart({ data }: { data: SavingsChartRow[] }) {
  const series = buildSavingsSeries(data);
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...CHART_GRID} />
          <XAxis dataKey="month" {...AXIS_TICK} />
          {/* Two axes, not one: Income/Spend/Net/Target are one month's flow, but Cumulative
              saved is a running total across the whole range and can dwarf any single month's
              bars by the end of it -- sharing an axis would flatten the monthly detail. */}
          <YAxis yAxisId="flow" {...AXIS_TICK} width={56} />
          <YAxis yAxisId="cumulative" orientation="right" {...AXIS_TICK} width={64} />
          <Tooltip
            formatter={(value: number) => `$${value.toFixed(2)}`}
            // Same reasoning as DebtTrendChart/NetWorthChart: recharts' Curve cursor (drawn for
            // the Line/Area series) hard-codes stroke #ccc unless one is given explicitly, so
            // both the Bar cursor's fill and the Line cursor's stroke are supplied here.
            cursor={{ ...TOOLTIP_CURSOR, stroke: 'var(--line-strong)' }}
            {...tooltipStyles()}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--muted)', paddingTop: 8 }} />
          {/* Income and Spend keep the money tokens every other chart in this app uses for the
              same pair (CashflowChart). */}
          <Bar yAxisId="flow" dataKey="Income" fill="var(--positive-solid)" radius={[4, 4, 0, 0]} />
          <Bar yAxisId="flow" dataKey="Spend" fill="var(--negative-solid)" radius={[4, 4, 0, 0]} />
          <Area
            yAxisId="cumulative"
            type="monotone"
            dataKey="Cumulative saved"
            stroke="var(--accent)"
            fill="var(--accent)"
            fillOpacity={0.15}
            strokeWidth={2}
          />
          <Line yAxisId="flow" type="monotone" dataKey="Net" stroke="var(--accent)" strokeWidth={2} dot={false} />
          {/* Target shares Net's colour on purpose -- it is the goal line for that exact
              series, so the two are told apart by dash rather than by hue. connectNulls is
              FALSE: a month with no target is a `null` point (never a fallback 0, see
              SavingsChartRow's docblock above), and a line that bridged over it would draw a
              target where none was set -- "a month with no target draws no segment" is the
              whole point. The dot marks an isolated month -- one with no target on either
              side -- the same gap DebtTrendChart's own dot exists for, since a lone point with
              connectNulls false is otherwise a zero-length, invisible segment. */}
          <Line
            yAxisId="flow"
            type="monotone"
            dataKey="Target"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeDasharray="6 4"
            dot={{ r: 2, fill: 'var(--accent)', strokeWidth: 0 }}
            connectNulls={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
