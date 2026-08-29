import { redirect } from 'next/navigation';

/**
 * Review round (fold /review in): the review queue is a filter on Transactions now (ruling R1),
 * not a second page. This route stays (ruling R6) so a bookmark, the dashboard callout, the
 * import link and a hand-typed address all keep working -- it does nothing but redirect.
 *
 * Deliberately no auth check here: `/transactions?review=1` handles the self-viewer refusal
 * itself (ruling R2, page.tsx forces `reviewOnly` off for one), so a self viewer who lands on
 * this old address simply gets their own ordinary transactions list, the same as anyone who
 * types the new address by hand.
 */
export default function ReviewPage() {
  redirect('/transactions?review=1');
}
