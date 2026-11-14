import { isSameOriginOrHeaderless } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { aiReceiptPoll } from '@/lib/ai/receipt';
import { enqueueAiJob } from '@/lib/ai/queue';
import { STAGING_ID_RE, readSidecar, stagedByViewer } from '@/lib/warranty/staging';

export const dynamic = 'force-dynamic';

/**
 * The client polls this every 1.5 s while OCR runs, and gives up after 3 minutes with
 * "Still processing — save now and re-run OCR from the item page." It is an authenticated,
 * read-only GET, so it uses the relaxed isSameOriginOrHeaderless() rule (§5, §6.3) for the
 * same reason /api/backup/download does: on plain HTTP a same-origin request carries no
 * Origin and no Sec-Fetch-* header at all.
 *
 * The recognised LINES are returned (capped at OCR_LINES_MAX) so the person can see what was
 * read and tap the figure they meant; spec §16 item 6 deferred EDITING the text, not showing
 * it. Owner-scoped like everything else here (D7).
 *
 * A staged job whose file was purged writes NO sidecar (Task 5's known deferred concern),
 * so readSidecar() returning null is indistinguishable from "still running" and this
 * endpoint reports 'pending' either way. That is safe only because the CLIENT bounds its
 * own polling to 3 minutes (above) and never trusts this endpoint to eventually resolve on
 * its own — a forever-purged staging id therefore cannot hang a client, it just eventually
 * gives up with the message quoted above.
 */
export async function GET(request: Request, ctx: { params: Promise<{ stagingId: string }> }): Promise<Response> {
  if (!isSameOriginOrHeaderless(request.headers)) return Response.json({ error: 'Forbidden' }, { status: 403 });

  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { stagingId } = await ctx.params;
  // Validated against the UUID regex BEFORE any path is built (§6.3). Ruling P10b: imported
  // from staging.ts, not duplicated here.
  if (!STAGING_ID_RE.test(stagingId)) return Response.json({ error: 'Invalid staging id' }, { status: 400 });

  /*
    D7. Only the member who staged this upload may poll it. The refusal is the SAME
    { status: 'pending' } an unknown id gets, because that is already this endpoint's answer for
    "nothing to tell you" and the client bounds its own polling -- so a wrong id says nothing about
    whether it exists, and nobody hangs.
  */
  if (!stagedByViewer(stagingId, user.id)) return Response.json({ status: 'pending' });

  const sidecar = readSidecar(stagingId);
  if (sidecar === null) return Response.json({ status: 'pending' });
  if (sidecar.status === 'failed') {
    return Response.json({ status: 'failed', error: sidecar.error ?? 'OCR failed.', retryable: sidecar.retryable });
  }
  /*
    v1.64.0 (D1). The local AI's read of this receipt rides along on the done answer. The first done
    poll with AI on queues the job (one per staging id: the queue's claimed set, then the AI sidecar,
    make it idempotent) and says pending; the OCR tree itself never reaches the network.
  */
  let ai = aiReceiptPoll(stagingId);
  if (ai.status === 'not-started') {
    enqueueAiJob({ kind: 'receipt', stagingId, userId: user.id });
    ai = { status: 'pending' };
  }
  return Response.json({
    status: 'done',
    suggestions: sidecar.suggestions ?? {},
    lines: sidecar.lines ?? [],
    candidates: sidecar.candidates ?? { amounts: [], dates: [] },
    ai,
  });
}
