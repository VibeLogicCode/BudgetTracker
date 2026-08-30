import { Card, CardBody } from '@/components/ui/Card';

/**
 * v1.12.1 (item AX / UX-10). The same skeleton Reports gets, shaped like a table instead of a
 * chart: Transactions is force-dynamic too and a wide date range makes it just as slow.
 */
export default function TransactionsLoading() {
  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <p role="status" className="sr-only">
        Loading your transactions…
      </p>
      <Card>
        <CardBody className="flex flex-col gap-3 py-8">
          <span className="h-4 w-56 animate-pulse rounded bg-surface-2" />
          {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
            <span key={row} className="h-6 w-full animate-pulse rounded bg-surface-2" />
          ))}
        </CardBody>
      </Card>
    </div>
  );
}
