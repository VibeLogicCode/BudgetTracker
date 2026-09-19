import { isSameOriginOrHeaderless } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { mustChangePassword, viewerFor } from '@/lib/auth/users';
import { isIsoDate, todayIso } from '@/lib/dates';
import { loanLedger } from '@/lib/loans';
import { getWarrantyItem } from '@/lib/warranty/items';

export const dynamic = 'force-dynamic';

/**
 * What the app believes this loan will owe on a given date (review F3).
 *
 * The reconcile form compares what a person has typed off their statement against the app's own
 * estimate. That estimate was the one for TODAY, printed under the words "Our estimate for
 * {the statement's date}" -- and the statement is routinely a week or a month old, so the two
 * figures being compared were never for the same day. On a mortgage the gap is real money, and the
 * form was inviting a household to wonder which of them was wrong.
 *
 * The engine is pure and takes `today` as a parameter (the v1.4.0 rule), so asking it for another
 * date is the whole implementation: nothing here re-derives anything.
 *
 * The same gate as ledger.csv beside it, for the same reason -- a loan's figures are among the
 * most private the app holds, so the read is no weaker than the page.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!isSameOriginOrHeaderless(request.headers)) return Response.json({ error: 'Forbidden' }, { status: 403 });

  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (mustChangePassword(user.id)) return Response.json({ error: 'Forbidden' }, { status: 403 });

  const viewer = viewerFor(user.id);
  if (viewer === null) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const itemId = Number((await context.params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) return Response.json({ error: 'Bad Request' }, { status: 400 });

  const asOf = new URL(request.url).searchParams.get('asOf') ?? todayIso();
  if (!isIsoDate(asOf)) return Response.json({ error: 'Enter the date as YYYY-MM-DD.' }, { status: 400 });
  // Forward of today the engine would walk periods that have not happened, which is not an
  // estimate of anything -- and the reconcile form refuses such a date on the way in as well.
  if (asOf > todayIso()) return Response.json({ error: 'That date is in the future.' }, { status: 400 });

  // Ownership first, THEN the ledger: a 200 for an item the viewer cannot see would leak its
  // figures even with nothing else in the body.
  if (getWarrantyItem(itemId, viewer) === null) return Response.json({ error: 'Not Found' }, { status: 404 });

  const ledger = loanLedger(itemId, asOf);
  // No basis, or no statement to run from: there is no estimate, and null says so plainly.
  return Response.json({ asOf, owingCents: ledger?.owingCents ?? null }, { status: 200 });
}
