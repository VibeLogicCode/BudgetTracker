import { isSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { SimplefinError, fetchAccounts } from '@/lib/simplefin/client';
import { assertRequestBudget, consumeRequest, getAccessUrl, getConnection, listLinks, remainingRequestsToday } from '@/lib/simplefin/connection';
import { syncWindow } from '@/lib/simplefin/sync';

export const dynamic = 'force-dynamic';

/** A read of this route is refused: the call spends part of the daily SimpleFIN budget, so it is a POST. */
export async function GET(): Promise<Response> {
  return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'POST' } });
}

/**
 * Lists the remote accounts so the admin can map them. Costs one request against the budget.
 *
 * A POST under the strict isSameOrigin(), like claim, link and sync: a browser always sends Origin
 * on a POST, so the Connections page's own call passes on a plain-HTTP LAN install and a request
 * from another site does not.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request.headers)) return Response.json({ error: 'Forbidden' }, { status: 403 });

  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

  const connection = getConnection();
  const accessUrl = getAccessUrl();
  if (!connection || accessUrl === null) return Response.json({ error: 'No SimpleFIN connection is configured yet.' }, { status: 409 });

  try {
    assertRequestBudget();
    const window = syncWindow({ lastSyncAt: connection.lastSyncAt });
    consumeRequest();
    const set = await fetchAccounts({ accessUrl, startDate: window.startDate, endDate: window.endDate });
    return Response.json({
      accounts: set.accounts.map((account) => ({ id: account.id, name: account.name, currency: account.currency, balance: account.balance })),
      errlist: set.errlist,
      links: listLinks(),
      remainingRequests: remainingRequestsToday(),
    });
  } catch (error) {
    if (error instanceof SimplefinError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    throw error;
  }
}
