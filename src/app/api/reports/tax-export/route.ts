import { isSameOriginOrHeaderless } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { taxYearCsv } from '@/lib/tax';

/**
 * Tax-year CSV download (spec 2026-08-22, v1.7.0, Task 15b). Session required, and the origin
 * is checked even though a GET is normally CSRF-exempt: this streams a household's whole
 * tax-relevant spend history for one year, same reasoning as its sibling /api/reports/export.
 * No admin restriction -- the Reports page itself is requireUser(), not requireAdmin(), so this
 * route holds to the same bar as the page that links to it.
 *
 * isSameOriginOrHeaderless(), not isSameOrigin() -- deliberately matching /api/reports/export's
 * guard rather than inventing a weaker or stricter one: a header-less request is allowed because
 * the Download CSV link on this card produces exactly that on the documented plain-HTTP LAN
 * default deployment. See the helper's docblock for the ruling.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isSameOriginOrHeaderless(request.headers)) return new Response('Forbidden', { status: 403 });

  const user = userFromRequest(request);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const year = parseTaxYear(new URL(request.url).searchParams.get('year'));
  if (year === null) return new Response('Bad Request', { status: 400 });

  const csv = taxYearCsv(year);
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="budget-tax-year-${year}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

/**
 * Plainly four digits (so never negative, fractional or otherwise non-numeric), then the same
 * 1900-2999 bound src/lib/dates.ts's buildIso() already uses for a parsed statement date --
 * reused here rather than invented fresh. Anything outside this is rejected before it ever
 * reaches taxYearCsv()/taxYearReport()'s plain string date-range comparison, which has no format
 * validation of its own and would otherwise silently accept a nonsensical year instead of
 * erroring.
 */
function parseTaxYear(value: string | null): number | null {
  if (!value || !/^\d{4}$/.test(value)) return null;
  const year = Number(value);
  if (year < 1900 || year > 2999) return null;
  return year;
}
