import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { listCategories } from '@/lib/categories';
import { countMatchingMerchant, listReviewQueue } from '@/lib/transactions';
import { reviewQueueCount } from '@/lib/categorize/engine';
import { ReviewClient } from './review-client';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  const user = await requireUser();
  // Controller ruling: listReviewQueue is household-wide by construction and unscoped, so hiding
  // Review from a self viewer's nav is not enough -- the page itself must refuse them.
  if (isSelfScoped(user)) redirect('/dashboard');
  const rows = listReviewQueue(100, 0);
  return (
    <ReviewClient
      total={reviewQueueCount()}
      rows={rows.map((row) => ({ ...row, matchingCount: countMatchingMerchant(row.normalizedMerchant) }))}
      categories={listCategories()}
    />
  );
}
