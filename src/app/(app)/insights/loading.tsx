import { Card, CardBody } from '@/components/ui/Card';

/** Spec 2026-10-05 §2.1. The recurring read model scans about three years of charges; a skeleton says the page is coming. */
export default function InsightsLoading() {
  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <p role="status" className="sr-only">
        Loading insights…
      </p>
      {[0, 1].map((card) => (
        <Card key={card}>
          <CardBody className="flex flex-col gap-3 py-8">
            <span className="h-4 w-40 motion-keep animate-pulse rounded bg-surface-2" />
            <span className="h-32 w-full motion-keep animate-pulse rounded bg-surface-2" />
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
