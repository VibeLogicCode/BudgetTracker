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

/**
 * v1.21.0 plan, item 5. Rebuilt after the owner's screenshot showed a chart with three separate
 * defects, all traced to the same root cause: this used to be ONE chart carrying five series
 * across two y-axes. The `dataviz` skill's first rule is "one axis -- two measures of different
 * scale become two charts, never a dual-axis chart" (the skill's own #1 chart mistake), and every
 * symptom here comes back to having ignored it:
 *
 * 1. Cumulative saved (a running total that grows across the whole window) shared a chart with
 *    Income/Spend/Net/Target (one month's own flow, an order of magnitude smaller by the end of
 *    a year) -- the second, right-hand axis this needed is exactly the "nothing indicates which
 *    series reads against which scale" complaint.
 * 2. With Cumulative saved sharing the SAME accent colour as Net and Target (the only sensible
 *    choice within one 4-color budget -- Income/Spend already own green/red), three of five
 *    series rendered as near-identical purple lines at two different scales, so the legend could
 *    not be matched back to the plot.
 *
 * The fix the plan agreed with the owner is exactly the skill's own remedy: split into two
 * charts, one axis each. Bars for Income/Spend plus the Net/Target lines that are directly
 * comparable to them (same "one month's flow" scale) stay together in `MonthlyFlowChart`;
 * Cumulative saved -- the only series with a running-total scale -- gets its own smaller chart
 * with no dual axis to reconcile and no legend to misread (a single series is named by its own
 * heading, not a legend box, per the skill's accessibility pass).
 *
 * Colour is UNCHANGED from before this fix, not re-picked: Income/Spend keep the green/red money
 * tokens every other chart in this app already uses for the same pair (NetWorthChart's
 * Assets/Debts, DebtTrendChart's Lent/Owed), and Net/Target/Cumulative saved keep `--accent` --
 * this app's fixed categorical order has exactly one "neutral, not money-in/money-out" colour
 * (NetWorthChart's own Net line makes the identical choice), so re-running the palette validator
 * would be validating a palette this codebase already shipped and already relies on elsewhere,
 * not a new one. What changed is that Net and Target no longer have to share a CHART with a third
 * accent-coloured series -- Target keeps telling itself apart from Net by dash, exactly as
 * before, and now that is the only ambiguity left to resolve.
 */
function MonthlyFlowChart({ series, showTarget }: { series: SavingsSeriesPoint[]; showTarget: boolean }) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...CHART_GRID} />
          <XAxis dataKey="month" {...AXIS_TICK} />
          <YAxis {...AXIS_TICK} width={56} />
          <Tooltip
            formatter={(value: number) => `$${value.toFixed(2)}`}
            // Same reasoning as DebtTrendChart/NetWorthChart: recharts' Curve cursor (drawn for
            // the Line series) hard-codes stroke #ccc unless one is given explicitly, so both the
            // Bar cursor's fill and the Line cursor's stroke are supplied here.
            cursor={{ ...TOOLTIP_CURSOR, stroke: 'var(--line-strong)' }}
            {...tooltipStyles()}
          />
          {/* >= 2 series always gets a legend (dataviz skill's accessibility pass) -- this chart
              never has fewer than three (Income, Spend, Net). */}
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--muted)', paddingTop: 8 }} />
          <Bar dataKey="Income" fill="var(--positive-solid)" radius={[4, 4, 0, 0]} />
          <Bar dataKey="Spend" fill="var(--negative-solid)" radius={[4, 4, 0, 0]} />
          <Line type="monotone" dataKey="Net" stroke="var(--accent)" strokeWidth={2} dot={false} />
          {/* v1.21.0 plan, item 5, defect 3: drawn only when at least one point in this window
              actually has a target -- never an all-null series that used to render as a flat,
              misleading line. A month with no target inside a window that DOES have one elsewhere
              still correctly draws no segment there (connectNulls false, dot marks an isolated
              point) -- this flag only stops the case a household that has never set ANY target
              still seeing a Target legend entry and line for one. Target shares Net's colour on
              purpose -- it is the goal line for that exact series, so the two are told apart by
              dash, not hue. */}
          {showTarget ? (
            <Line
              type="monotone"
              dataKey="Target"
              stroke="var(--accent)"
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={{ r: 2, fill: 'var(--accent)', strokeWidth: 0 }}
              connectNulls={false}
            />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * The running-total half of the split (see MonthlyFlowChart's docblock above for why it was
 * split out). Deliberately smaller (h-32 vs the flow chart's h-56) and its OWN axis -- "as its
 * own smaller chart" is the plan's own wording -- so a total that can dwarf any single month's
 * bars never again forces a second scale onto the chart above it. One series, so no legend box
 * (dataviz skill: a single series is named by its own heading, not a legend) -- the label right
 * above the chart does that job.
 */
function CumulativeSavedChart({ series }: { series: SavingsSeriesPoint[] }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted">Cumulative saved</p>
      <div className="h-32 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid {...CHART_GRID} />
            <XAxis dataKey="month" {...AXIS_TICK} />
            <YAxis {...AXIS_TICK} width={64} />
            <Tooltip
              formatter={(value: number) => `$${value.toFixed(2)}`}
              cursor={{ ...TOOLTIP_CURSOR, stroke: 'var(--line-strong)' }}
              {...tooltipStyles()}
            />
            <Area
              type="monotone"
              dataKey="Cumulative saved"
              stroke="var(--accent)"
              fill="var(--accent)"
              fillOpacity={0.15}
              strokeWidth={2}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/**
 * v1.21.0 plan, item 5, defect 3. Its own named, exported predicate (rather than an inline
 * `.some(...)` in the component below) for the same reason `buildSavingsSeries` is exported: so
 * a test can pin "an all-null window draws no Target line at all" without fighting jsdom's
 * inability to mount ResponsiveContainer's children (see that function's own docblock).
 */
export function hasAnyTarget(series: SavingsSeriesPoint[]): boolean {
  return series.some((point) => point.Target !== null);
}

export function SavingsChart({ data }: { data: SavingsChartRow[] }) {
  const series = buildSavingsSeries(data);
  const showTarget = hasAnyTarget(series);
  return (
    <div className="flex flex-col gap-4">
      <MonthlyFlowChart series={series} showTarget={showTarget} />
      <CumulativeSavedChart series={series} />
    </div>
  );
}
