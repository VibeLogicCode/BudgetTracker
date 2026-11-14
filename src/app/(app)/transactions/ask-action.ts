'use server';

import { headers } from 'next/headers';
import { CROSS_ORIGIN_ERROR, isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { ASK_OFF_ERROR, askToFilter, beginAsk, endAsk, readQuestion, type AskState } from '@/lib/ai/ask';
import { localAiActive } from '@/lib/ai/config';
import { todayIso } from '@/lib/dates';

/**
 * v1.64.0 (plan 2026-11-12, E3). Ask in words. Returns a /transactions link and how the question
 * was read, never a figure: the page sums whatever the link filters, as it always has. Writes
 * nothing; the question is neither logged nor stored. Refused plainly when local AI is off, not set
 * up or waiting after failures, and one question at a time per person (src/lib/ai/ask.ts).
 */
export async function askInWordsAction(_prev: AskState, formData: FormData): Promise<AskState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();
  const at = new Date();
  if (!localAiActive(at)) return { error: ASK_OFF_ERROR };
  const question = readQuestion(formData.get('question'));
  if (!question.ok) return { error: question.error };
  const refused = beginAsk(user.id, at.getTime());
  if (refused !== null) return { error: refused };
  try {
    const result = await askToFilter({ question: question.question, viewer: user, today: todayIso(at), at });
    return result.ok ? { href: result.href, reading: result.reading } : { error: result.error };
  } finally {
    endAsk(user.id, new Date().getTime());
  }
}
