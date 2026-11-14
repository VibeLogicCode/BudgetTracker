'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from '@/lib/zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import { appendAudit } from '@/lib/audit';
import { nowIso } from '@/lib/clock';
import { listModels } from '@/lib/ai/client';
import { saveLocalAiConfig, testLocalAiConnection, turnOffLocalAi } from '@/lib/ai/config';
import { addressLabel, normalizeLocalAiBaseUrl } from '@/lib/ai/lan';
import { sweepAiWork } from '@/lib/ai/queue';
import { MODEL_NAME_RE } from '@/lib/ai/schemas';
import { forgetAiSuggestions } from '@/lib/ai/suggestions';

/**
 * v1.64.0 Lane B. Settings, Connections: Local AI. Every action runs, in order: the origin check,
 * requireAdmin, then the zod form. Only an admin can point the app at a model server, and the
 * address is re-checked (LAN only) by the library on every save and test.
 */
export interface LocalAiActionState {
  error?: string;
  message?: string;
  /** Model ids the server listed, for the card's picker. Set only by a Test that reached it. */
  models?: string[];
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';
const FORM_ERROR = 'Enter the model server address and the model name.';

const formSchema = z.object({
  baseUrl: z.string().trim().max(200),
  model: z.string().trim().regex(MODEL_NAME_RE),
});

function parseForm(formData: FormData) {
  return formSchema.safeParse({ baseUrl: formData.get('baseUrl') ?? '', model: formData.get('model') ?? '' });
}

function revalidateLocalAi(): void {
  revalidatePath('/settings/connections');
  revalidatePath('/settings/audit');
  revalidatePath('/transactions');
}

export async function saveLocalAiAction(_prev: LocalAiActionState, formData: FormData): Promise<LocalAiActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const admin = await requireAdmin();
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: FORM_ERROR };

  const saved = saveLocalAiConfig({ baseUrl: parsed.data.baseUrl, model: parsed.data.model, userId: admin.id, at: new Date() });
  if (!saved.ok) return { error: saved.error };
  try {
    sweepAiWork(new Date());
  } catch (error) {
    // A sweep problem never fails a save that already happened.
    console.error('[ai] first sweep failed', error);
  }
  revalidateLocalAi();
  return { message: `Local AI is on: ${saved.config.model} at ${addressLabel(saved.config.baseUrl)}. Suggestions start shortly.` };
}

export async function testLocalAiAction(_prev: LocalAiActionState, formData: FormData): Promise<LocalAiActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireAdmin();
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: FORM_ERROR };

  const result = await testLocalAiConnection({ baseUrl: parsed.data.baseUrl, model: parsed.data.model }, new Date());
  if (!result.ok) return { error: result.message };
  let models: string[] | undefined;
  const address = normalizeLocalAiBaseUrl(parsed.data.baseUrl);
  if (address.ok) {
    try {
      models = await listModels({ baseUrl: address.baseUrl, model: parsed.data.model });
    } catch {
      models = undefined;
    }
  }
  return models && models.length > 0 ? { message: result.message, models } : { message: result.message };
}

export async function turnOffLocalAiAction(_prev: LocalAiActionState, _formData: FormData): Promise<LocalAiActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const admin = await requireAdmin();
  turnOffLocalAi({ userId: admin.id, at: new Date() });
  revalidateLocalAi();
  return { message: 'Local AI is off. Review and receipts work as before; suggestions already made are hidden.' };
}

export async function forgetAiSuggestionsAction(_prev: LocalAiActionState, formData: FormData): Promise<LocalAiActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const admin = await requireAdmin();
  if (formData.get('confirm') !== '1') return { error: 'Tick the box to confirm before forgetting every AI suggestion.' };

  const count = forgetAiSuggestions();
  const noun = `${count} AI ${count === 1 ? 'suggestion' : 'suggestions'}`;
  if (count > 0) {
    appendAudit({ userId: admin.id, action: 'forget_ai_suggestions', entity: 'settings', entityId: 0, detail: `Forgot ${noun}`, at: nowIso(new Date()) });
  }
  revalidateLocalAi();
  return { message: `Forgot ${noun}. Rows are unchanged.` };
}
