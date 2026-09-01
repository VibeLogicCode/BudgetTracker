'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { CROSS_ORIGIN_ERROR, isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { markImportRulesReviewed } from '@/lib/import/commit';

/**
 * v1.26.0 Lane 3b. Dismisses one row of the dashboard's "rules did this, nobody has looked"
 * card (src/components/RuleReviewCard.tsx) -- the standing notice for an import whose rule
 * assignments nobody has checked, per unreviewedRuleImports (src/lib/import/commit.ts).
 *
 * Its own file rather than an addition to an existing actions.ts for the same reason
 * ComingUpCard's BillActionState lives in src/app/(app)/bills/actions.ts: the card that calls
 * this is the dashboard's own, so the action belongs to the page that renders it.
 *
 * tests/ops/use-server-exports.test.ts requires every export here to be an async function, so
 * the state interface below is a type (erased at compile time, exempt).
 */
export interface DismissRuleImportState {
  error?: string;
}

const importIdField = z.coerce.number().int().positive();

/**
 * No confirm dialog on purpose -- markImportRulesReviewed is reversible in the library
 * (`reviewed: false` clears the marker) and destroys nothing, the same reasoning the doc
 * comment on that function gives for why it needs a way back at all. There is no UI for the
 * reverse direction here (see RuleReviewCard's own doc comment for why), but the data itself
 * is never lost by a dismiss.
 *
 * Same guard order every action in this codebase uses: origin first, then auth, then
 * validation, before any write.
 */
export async function dismissRuleImportAction(
  _prev: DismissRuleImportState,
  formData: FormData,
): Promise<DismissRuleImportState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  // unreviewedRuleImports() is deliberately not viewer-scoped (an import is a household-level
  // event, not a per-person one -- see its own doc comment), so dismissing one is likewise not
  // something a self-scoped viewer should be able to do; the card itself is never rendered for
  // one (dashboard/page.tsx), but this route is reachable directly.
  if (isSelfScoped(user)) return { error: 'Not available on this account.' };

  const parsed = importIdField.safeParse(formData.get('importId'));
  if (!parsed.success) return { error: 'Invalid request.' };

  markImportRulesReviewed({ importId: parsed.data });
  revalidatePath('/dashboard');
  return {};
}
