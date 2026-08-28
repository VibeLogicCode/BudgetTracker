import Link from 'next/link';
import { Card, CardBody } from '@/components/ui/Card';

/**
 * v1.12.1 (item W / UX-1). notFound() is called from src/app/(app)/warranties/[id]/page.tsx and
 * src/app/(app)/warranties/new/page.tsx, and until now nothing caught it -- a stale bookmark to a
 * deleted item rendered the framework's own "404 | This page could not be found" outside the app
 * shell entirely, with no link home.
 *
 * A server component: there is nothing interactive here, and this way it costs no client bundle.
 */
export default function NotFound() {
  return (
    <Card>
      <CardBody className="flex flex-col items-start gap-4 py-10">
        <h1 className="text-lg font-semibold text-ink">That page is gone</h1>
        <p className="max-w-prose text-sm text-muted">
          Whatever was here has been deleted, or the address is not one this app knows. If you
          followed a bookmark, the item behind it no longer exists.
        </p>
        <Link href="/dashboard" className="btn btn--primary">
          Back to the Dashboard
        </Link>
      </CardBody>
    </Card>
  );
}
