import { isSameOriginOrHeaderless } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { mustChangePassword, viewerFor } from '@/lib/auth/users';
import { todayIso } from '@/lib/dates';
import { loanLedger } from '@/lib/loans';
import { toCsv } from '@/lib/reports';
import { getWarrantyItem } from '@/lib/warranty/items';

/**
 * The loan ledger as a spreadsheet (ledger spec U7).
 *
 * Same origin-and-session gate as every other CSV route here, and one addition: the item is
 * fetched THROUGH the viewer, so a self-scoped member downloading a loan they cannot see on screen
 * gets the same 404 the page would give them. A loan's ledger is the most private table the app
 * holds -- what is owed, to whom, and at what rate -- so the download is no weaker than the view.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isSameOriginOrHeaderless(request.headers)) return new Response('Forbidden', { status: 403 });

  const user = userFromRequest(request);
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (mustChangePassword(user.id)) return new Response('Finish setting your password first.', { status: 403 });

  const viewer = viewerFor(user.id);
  if (viewer === null) return new Response('Unauthorized', { status: 401 });

  const itemId = Number((await context.params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) return new Response('Bad Request', { status: 400 });

  // Ownership first, THEN the ledger: reading the ledger of an item the viewer cannot see would
  // leak its figures through a 200 even if nothing else did.
  const item = getWarrantyItem(itemId, viewer);
  if (item === null) return new Response('Not Found', { status: 404 });

  const ledger = loanLedger(itemId, todayIso());
  if (ledger === null) return new Response('Not Found', { status: 404 });

  const dollars = (cents: number | null): string => (cents === null ? '' : (cents / 100).toFixed(2));
  const csv = toCsv(
    ledger.rows.map((row) => ({
      Date: row.date,
      Description: row.description,
      Payment: dollars(row.paymentCents),
      Interest: dollars(row.interestCents),
      Principal: dollars(row.principalCents),
      Balance: dollars(row.balanceCents),
      /*
        F7 (review). What had built up by the day a payment landed -- the figure that explains why
        a $500 payment took $437 off the balance. The card shows it by opening a row; a spreadsheet
        has no rows to open, so it gets a column. Blank on every row that is not a payment, because
        it is not additive with the Interest column beside it (see LedgerRow.detail's own note).
      */
      'Interest accrued to date': dollars(row.detail?.accruedToDayCents ?? null),
    })),
    [
      { key: 'Date', header: 'Date' },
      { key: 'Description', header: 'Description' },
      { key: 'Payment', header: 'Payment' },
      { key: 'Interest', header: 'Interest' },
      { key: 'Principal', header: 'Principal' },
      { key: 'Balance', header: 'Balance' },
      { key: 'Interest accrued to date', header: 'Interest accrued to date' },
    ],
  );

  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="loan-${itemId}-ledger.csv"`,
      'cache-control': 'no-store',
    },
  });
}
