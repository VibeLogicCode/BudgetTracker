import { and, inArray, like } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { settings, transactions } from '@/db/schema';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import { addDaysIso } from '@/lib/dates';
import { CREEP_LOOKBACK_DAYS } from '@/lib/predict/constants';
import { deleteSetting, setSetting } from '@/lib/settings';

/**
 * Reported 2026-09-20: "how do i get rid of take a look? it goes to transactions with no way to
 * clear it or am i missing something?"
 *
 * Nothing was missing -- there was no way to clear one. The Needs-a-look card's own docblock had
 * ruled a dismiss out, but the argument recorded there ("a card with a dismiss button is a card
 * somebody dismisses once and never sees again") is about dismissing the WHOLE CARD, and it still
 * holds for that. The question asked is a different one: a charge has been looked at and judged
 * fine, and it keeps sitting on the dashboard for a fortnight regardless.
 *
 * THREE DECISIONS, and each rules something out:
 *
 *   1. Per FINDING, never per merchant. A merchant whitelist is how a detector turns into a list of
 *      exceptions nobody revisits -- the reason a merchant fired this month is not the reason it
 *      fires next month. The same merchant charging an odd amount again is a new charge and a new
 *      question, and answering it is one more press.
 *
 *   2. Household-wide, not per person. One member deciding a charge is fine settles it; a per-user
 *      store would show the same row to everybody else to dismiss again, which is nagging.
 *
 *   3. In `settings`, with no migration. The volume is bounded by the detectors themselves: an
 *      unusual or duplicate finding cannot exist past its 14-day lookback, and creep past 35, so a
 *      dismissal older than the longest window can never match anything and is pruned on every
 *      write. Live rows number in the tens.
 *
 * The KEY is not invented here. unusualTransactionKey/subscriptionCreepKey/duplicateChargeKey
 * (src/lib/notify/events.ts) already define what one of these findings IS, for the notification
 * outbox, and the card must not disagree with the outbox about the identity of the same anomaly.
 */
const PREFIX = 'insight_dismissed:';

/**
 * The three shapes those key builders produce. Validated rather than trusted, because the key
 * arrives from a form post: it reaches a `like`/`inArray` query and the transaction-scope check
 * below parses ids straight out of it.
 */
const KEY_SHAPE = /^(?:unusual|creep):[1-9]\d*$|^dupe:[1-9]\d*:[1-9]\d*$/;

export function isDismissalKey(key: string): boolean {
  return KEY_SHAPE.test(key);
}

/** Every finding the household has already cleared. */
export function listDismissedKeys(): Set<string> {
  const rows = getDb().select().from(settings).where(like(settings.key, `${PREFIX}%`)).all();
  return new Set(rows.map((row) => row.key.slice(PREFIX.length)));
}

/**
 * Clears one finding off the card, or puts it back. The value stored is the date it was cleared,
 * which is what the prune reads -- no other caller has any use for it.
 *
 * Reversible on purpose, and there is no button for the reverse direction (see NeedsALookCard):
 * nothing is destroyed either way. The charge stays in the ledger, the merchant search still finds
 * it, and the finding would have aged out within weeks regardless.
 */
export function dismissInsight(input: { key: string; on: string; dismissed?: boolean }): void {
  if (!isDismissalKey(input.key)) return;
  if (input.dismissed === false) {
    deleteSetting(`${PREFIX}${input.key}`);
    return;
  }
  setSetting(`${PREFIX}${input.key}`, input.on);
  pruneInsightDismissals(input.on);
}

/**
 * Drops every dismissal older than the longest detector window, because past that point it cannot
 * be hiding anything: the finding it names is no longer computed at all.
 */
export function pruneInsightDismissals(today: string): void {
  const cutoff = addDaysIso(today, -CREEP_LOOKBACK_DAYS);
  const stale = getDb()
    .select()
    .from(settings)
    .where(like(settings.key, `${PREFIX}%`))
    .all()
    .filter((row) => row.value < cutoff)
    .map((row) => row.key);
  if (stale.length === 0) return;
  getDb().delete(settings).where(inArray(settings.key, stale)).run();
}

/**
 * R2. Whether every charge this key names is one the viewer may act on.
 *
 * The card is already viewer-scoped, so a self-scoped member never SEES a household charge here --
 * but the action behind the button is reachable directly, and "the UI would not have offered it"
 * has never been an access check in this codebase.
 */
export function dismissalIsInScope(key: string, viewer: Viewer): boolean {
  if (!isDismissalKey(key)) return false;
  const scope = ownerScope(viewer);
  if (scope === null) return true;
  const ids = key
    .split(':')
    .slice(1)
    .map((part) => Number.parseInt(part, 10));
  const rows = getDb()
    .select({ id: transactions.id, attributedUserId: transactions.attributedUserId })
    .from(transactions)
    .where(and(inArray(transactions.id, ids)))
    .all();
  if (rows.length !== ids.length) return false;
  return rows.every((row) => row.attributedUserId === scope);
}
