import { Card, CardBody } from '@/components/ui/Card';

/**
 * v1.12.1 (item AX / UX-10). There was no loading.tsx anywhere in the tree and every page is
 * force-dynamic, so tapping Reports -- a dozen aggregates plus a tax-year report per request --
 * produced no spinner, no skeleton and no change of any kind until the whole payload arrived from
 * the NAS. On a slow disk the app looked frozen and people tapped again.
 *
 * A server component with no props: Next renders it as the Suspense fallback for this segment. The
 * role="status" region is what a screen reader hears; the bars are what everyone else sees.
 */
export default function ReportsLoading() {
  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <p role="status" className="sr-only">
        Loading your reports…
      </p>
      {[0, 1, 2].map((card) => (
        <Card key={card}>
          <CardBody className="flex flex-col gap-3 py-8">
            <span className="h-4 w-40 animate-pulse rounded bg-surface-2" />
            <span className="h-32 w-full animate-pulse rounded bg-surface-2" />
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
