'use client';

import dynamic from 'next/dynamic';

/**
 * 2026-09-15. The charts, loaded on demand instead of in the first client bundle.
 *
 * recharts is by a wide margin the largest dependency this app ships to a browser, and it was
 * imported statically by five components across two pages — including the dashboard, which is
 * where every login lands. A household that never scrolls to a chart still paid for the whole
 * library before the page was interactive.
 *
 * WHY A SEPARATE MODULE rather than `dynamic()` at each call site. Two of the five call sites are
 * in a SERVER component (`dashboard/page.tsx`), and `ssr: false` is not allowed there — so the
 * wrappers have to live behind a `'use client'` boundary of their own. Putting all five here also
 * keeps the skeleton identical across them, which is the point of the loading state: a chart that
 * pops in over a differently-shaped placeholder reads as a layout bug.
 *
 * `ssr: false` is right for every one of these: a chart is a canvas of absolutely-positioned SVG
 * that measures its own container (recharts' ResponsiveContainer needs a real box), so the
 * server-rendered copy is throwaway markup that the client immediately replaces. Rendering it
 * twice buys nothing and costs the server the work.
 *
 * THE SKELETON IS NOT ANIMATED. The `.motion-keep` exemption exists for route-level skeletons that
 * stand in for a whole page; a chart arriving inside an already-drawn card is a smaller event, and
 * a pulsing rectangle inside a settled page draws more attention than the thing it is waiting for.
 */
function ChartSkeleton({ height }: { height: number }) {
  return (
    <div
      role="presentation"
      className="w-full rounded-md bg-surface-2"
      style={{ height }}
      data-chart-skeleton
    />
  );
}

/** Heights mirror each chart's own ResponsiveContainer, so nothing shifts when the real one lands. */
export const SavingsChart = dynamic(() => import('./SavingsChart').then((m) => m.SavingsChart), {
  ssr: false,
  loading: () => <ChartSkeleton height={280} />,
});

export const NetWorthChart = dynamic(() => import('./NetWorthChart').then((m) => m.NetWorthChart), {
  ssr: false,
  loading: () => <ChartSkeleton height={260} />,
});

export const CategoryBarChart = dynamic(() => import('./CategoryBarChart').then((m) => m.CategoryBarChart), {
  ssr: false,
  loading: () => <ChartSkeleton height={320} />,
});

export const DebtTrendChart = dynamic(() => import('./DebtTrendChart').then((m) => m.DebtTrendChart), {
  ssr: false,
  loading: () => <ChartSkeleton height={260} />,
});

export const CashflowChart = dynamic(() => import('./CashflowChart').then((m) => m.CashflowChart), {
  ssr: false,
  loading: () => <ChartSkeleton height={260} />,
});
