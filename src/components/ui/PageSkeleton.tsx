import { Card, CardBody } from '@/components/ui/Card';

/**
 * 2026-09-15. The placeholder a `loading.tsx` renders while a force-dynamic route runs its
 * queries.
 *
 * Every page in this app is `force-dynamic` and reads SQLite on the server, so a navigation blocks
 * until those queries finish. Two routes had a skeleton and twenty-six had nothing — meaning the
 * browser sat on the PREVIOUS page with no sign anything was happening, which reads as a dead
 * click rather than a slow one. On a local database that window is short; on a Raspberry Pi with a
 * wide date range it is not, and the cost of being wrong about which is a household pressing the
 * link again.
 *
 * ONE SHAPE, PARAMETERISED. The two hand-written skeletons that predate this (Transactions,
 * Reports) are shaped like the page they stand in for — a table, a chart — and are left alone.
 * This is for the card-stack pages, which is most of them, and it exists so adding a skeleton to a
 * route is one line rather than an invitation to invent a sixth grey rectangle.
 *
 * `motion-keep` because reduced motion must not freeze it: a still skeleton is indistinguishable
 * from a page that has finished loading badly. See the reduced-motion block in globals.css.
 */
export function PageSkeleton({ label, cards = 3 }: { label: string; cards?: number }) {
  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <p role="status" className="sr-only">
        {label}
      </p>
      {/* The page header's own shape: a title bar, nothing else. */}
      <span className="h-7 w-48 motion-keep animate-pulse rounded bg-surface-2" />
      {Array.from({ length: cards }, (_, index) => (
        <Card key={index}>
          <CardBody className="flex flex-col gap-3 py-6">
            <span className="h-4 w-40 motion-keep animate-pulse rounded bg-surface-2" />
            <span className="h-4 w-full motion-keep animate-pulse rounded bg-surface-2" />
            <span className="h-4 w-2/3 motion-keep animate-pulse rounded bg-surface-2" />
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
