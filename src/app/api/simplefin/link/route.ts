import { z } from '@/lib/zod';
import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { acceptsTransactions, getAccount, type AccountRecord } from '@/lib/accounts';
import { isIsoDate, todayIso } from '@/lib/dates';
import { MAX_SIMPLEFIN_BODY_BYTES, SimplefinError } from '@/lib/simplefin/client';
import { linkAccount, linkOverlap, listLinks, unlinkAccount } from '@/lib/simplefin/connection';

export const dynamic = 'force-dynamic';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const bodySchema = z.union([
  // v1.61.0 item 3a: what the account already holds from the bridge's 90 days, before linking.
  z.object({ action: z.literal('preview'), accountId: z.number().int().positive() }),
  z.object({
    action: z.literal('link'),
    simplefinAccountId: z.string().min(1).max(200),
    accountId: z.number().int().positive(),
    currency: z.string().min(1).max(8),
    // v1.61.0 item 3b: the first day to take from the bank. Range-checked below against today.
    syncFrom: z.string().regex(ISO_DATE).optional(),
  }),
  z.object({ action: z.literal('unlink'), simplefinAccountId: z.string().min(1).max(200) }),
]);

/** The local account a preview or link names, or the response that refuses it. */
function linkableAccount(accountId: number): { account: AccountRecord } | { refusal: Response } {
  const account = getAccount(accountId);
  if (!account) return { refusal: Response.json({ error: 'Unknown account.' }, { status: 404 }) };
  // v1.13.0 ruling R10 (item I6): an asset account holds a typed balance and takes no
  // transactions or syncs at all -- this route had no equivalent of the type gate every other
  // account-accepting write path (manual entry, CSV commit) already enforces.
  if (!acceptsTransactions(account.type)) {
    return { refusal: Response.json({ error: 'That account only holds a balance you type in.' }, { status: 400 }) };
  }
  // v1.61.0: the sync skips a deactivated account (v1.60.0), so linking one would do nothing.
  if (!account.isActive) {
    return {
      refusal: Response.json(
        { error: 'That account is deactivated, so the sync would skip it. Reactivate it in Settings → Accounts first.' },
        { status: 400 },
      ),
    };
  }
  return { account };
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof CsrfError) return Response.json({ error: 'Forbidden' }, { status: 403 });
    throw error;
  }
  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

  // Reject on the declared size BEFORE json() buffers the whole body — same
  // authenticated-memory-DoS defence as the CSV/pack upload routes.
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_SIMPLEFIN_BODY_BYTES) {
    return Response.json({ error: `Request body is larger than ${MAX_SIMPLEFIN_BODY_BYTES} bytes` }, { status: 413 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid request.' }, { status: 400 });

  if (parsed.data.action === 'unlink') {
    unlinkAccount(parsed.data.simplefinAccountId);
    return Response.json({ links: listLinks(), csvRestored: true });
  }

  const target = linkableAccount(parsed.data.accountId);
  if ('refusal' in target) return target.refusal;
  const overlap = linkOverlap(target.account.id, todayIso());

  if (parsed.data.action === 'preview') return Response.json(overlap);

  // No start date (a client from before v1.61.0) takes the suggested one, never the whole 90 days,
  // so an old client cannot pull statement-era rows in a second time.
  const syncFrom = parsed.data.syncFrom ?? overlap.suggestedStart;
  if (!isIsoDate(syncFrom) || syncFrom < overlap.windowStart || syncFrom > overlap.today) {
    return Response.json(
      { error: `Choose a first day from ${overlap.windowStart} to ${overlap.today}: the bank only sends the last 90 days.` },
      { status: 400 },
    );
  }

  try {
    linkAccount({
      simplefinAccountId: parsed.data.simplefinAccountId,
      accountId: target.account.id,
      currency: parsed.data.currency,
      syncFrom,
    });
  } catch (error) {
    if (error instanceof SimplefinError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }

  const currency = parsed.data.currency.toUpperCase();
  return Response.json({
    links: listLinks(),
    csvDisabled: true,
    syncFrom,
    currencyWarning: currency === 'CAD' ? null : `This account reports ${currency}; this app stores CAD cents with no conversion.`,
  });
}
