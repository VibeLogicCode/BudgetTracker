import { Readable } from 'node:stream';
import { isSameOriginOrHeaderless } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { mustChangePassword } from '@/lib/auth/users';
import { todayIso } from '@/lib/dates';
import { readEnv } from '@/lib/env';
import { parseTaxYear } from '@/lib/tax';
import { planYearEndPack } from '@/lib/year-end';
import { zipLength, zipStream } from '@/lib/zip-stream';

export const dynamic = 'force-dynamic';

/**
 * v1.63.0 (plan 2026-11-12, Y2 and B5). The year-end pack: the tax detail CSV, the tax totals CSV,
 * a README and the receipts the downloader may open, as one zip streamed straight from disk.
 *
 * Guards in the tax-export route's order: origin, session, the forced-password-change gate, the
 * year. Then the plan (src/lib/year-end.ts), scoped to the viewer: a self viewer's pack is their own
 * rows, and a receipt goes in only when its item is one they could open in the app today. Every
 * receipt path comes from the database through resolveReceiptPath; nothing in the request names a
 * file.
 *
 * Over the cap the answer is a 413 with a written sentence before any zip byte is sent. Otherwise
 * every size was read before the response starts, so content-length is exact; a file that changes
 * while streaming errors the body, and the browser marks the download failed rather than keeping a
 * broken zip.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isSameOriginOrHeaderless(request.headers)) return new Response('Forbidden', { status: 403 });

  const user = userFromRequest(request);
  if (!user) return new Response('Unauthorized', { status: 401 });

  if (mustChangePassword(user.id)) return new Response('Finish setting your password first.', { status: 403 });

  const year = parseTaxYear(new URL(request.url).searchParams.get('year'));
  if (year === null) return new Response('Bad Request', { status: 400 });

  const plan = planYearEndPack(year, user, { today: todayIso(new Date(), readEnv().tz) });
  if (plan.tooLargeMessage !== null) {
    return new Response(plan.tooLargeMessage, {
      status: 413,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const length = zipLength(plan.entries);
  const body = Readable.toWeb(zipStream(plan.entries)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="budget-year-end-${year}.zip"`,
      'content-length': String(length),
      'cache-control': 'no-store',
    },
  });
}
