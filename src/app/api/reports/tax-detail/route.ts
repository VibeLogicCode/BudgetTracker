import { isSameOriginOrHeaderless } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { mustChangePassword } from '@/lib/auth/users';
import { parseTaxYear } from '@/lib/tax';
import { yearEndDetailCsv } from '@/lib/year-end';

export const dynamic = 'force-dynamic';

/**
 * v1.63.0 (plan 2026-11-12, B5). The tax detail CSV for one year: every transaction, or part of a
 * split, behind the tax totals, with the receipts that go with each. The same file the year-end
 * pack carries (yearEndDetailCsv), so the two downloads cannot disagree.
 *
 * The tax-export route's guards, in its order: origin (a header-less request allowed, the plain-HTTP
 * LAN default), session, the forced-password-change gate, then the year. A self viewer is served
 * their own rows (owner decision 1); the read itself scopes to the viewer.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isSameOriginOrHeaderless(request.headers)) return new Response('Forbidden', { status: 403 });

  const user = userFromRequest(request);
  if (!user) return new Response('Unauthorized', { status: 401 });

  if (mustChangePassword(user.id)) return new Response('Finish setting your password first.', { status: 403 });

  const year = parseTaxYear(new URL(request.url).searchParams.get('year'));
  if (year === null) return new Response('Bad Request', { status: 400 });

  return new Response(yearEndDetailCsv(year, user), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="budget-tax-detail-${year}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
