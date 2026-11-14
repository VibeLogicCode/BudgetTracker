import { addMonthsClamped, isIsoDate } from '@/lib/dates';
import { parseAmountToCents } from '@/lib/money';
import { localAiActive } from '@/lib/ai/config';
import type { ReceiptAnswer } from '@/lib/ai/schemas';
import type { AiReceiptPoll } from '@/lib/ai/types';
import { readAiSidecar } from '@/lib/warranty/staging';
import {
  MAX_DUE_DATE_MONTHS_AHEAD,
  MAX_DUE_DATE_MONTHS_BEHIND,
  MAX_SUGGESTED_PRICE_CENTS,
  MAX_SUGGESTION_AGE_MONTHS,
  MAX_VENDOR_CHARS,
  currencyFigures,
  printedDates,
  type SuggestedFields,
} from '@/lib/warranty/suggest';

/**
 * v1.64.0 (plan 2026-11-12, A8 and L7). What the local AI read off a receipt, kept only where the
 * receipt itself says so. A model can be fluent and wrong, so nothing it says reaches a form unless
 * the printed text backs it: the total must be a figure printed on the receipt, each date a date
 * printed on it and inside the windows the pattern reader already uses, and the vendor must share a
 * word with the text. A field that fails is dropped; the rest are kept.
 */

/** Lowercase, accents off, so `CAFÉ` and `cafe` are one word. */
function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function groundVendor(vendor: string | null, foldedText: string): string | undefined {
  if (vendor === null) return undefined;
  const cleaned = vendor.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0 || cleaned.length > MAX_VENDOR_CHARS) return undefined;
  const words = fold(cleaned).match(/\p{L}{3,}/gu) ?? [];
  return words.some((word) => foldedText.includes(word)) ? cleaned : undefined;
}

function groundTotal(total: string | null, text: string): number | undefined {
  if (total === null) return undefined;
  const cents = parseAmountToCents(total);
  if (cents === null || cents <= 0 || cents >= MAX_SUGGESTED_PRICE_CENTS) return undefined;
  return currencyFigures(text).includes(cents) ? cents : undefined;
}

function groundDate(date: string | null, printed: readonly string[], floor: string, ceiling: string): string | undefined {
  if (date === null || !isIsoDate(date)) return undefined;
  if (date < floor || date > ceiling) return undefined;
  return printed.includes(date) ? date : undefined;
}

/**
 * The model's receipt answer, grounded in the OCR text. The purchase date keeps
 * suggestPurchaseDate's window (never after today, at most 240 months back); the due date keeps
 * suggestDueDate's (12 months back to 18 months ahead).
 */
export function groundReceiptAnswer(answer: ReceiptAnswer, text: string, today: string): SuggestedFields {
  const out: SuggestedFields = {};
  const source = typeof text === 'string' ? text : '';
  const printed = printedDates(source);
  const vendor = groundVendor(answer.vendor, fold(source));
  if (vendor !== undefined) out.vendor = vendor;
  const priceCents = groundTotal(answer.total, source);
  if (priceCents !== undefined) out.priceCents = priceCents;
  const purchaseDate = groundDate(answer.purchaseDate, printed, addMonthsClamped(today, -MAX_SUGGESTION_AGE_MONTHS), today);
  if (purchaseDate !== undefined) out.purchaseDate = purchaseDate;
  const dueDate = groundDate(
    answer.dueDate,
    printed,
    addMonthsClamped(today, -MAX_DUE_DATE_MONTHS_BEHIND),
    addMonthsClamped(today, MAX_DUE_DATE_MONTHS_AHEAD),
  );
  if (dueDate !== undefined) out.dueDate = dueDate;
  return out;
}

/**
 * The poll route's `ai` answer for a staged receipt the caller has already checked is the viewer's
 * own. `off` while the helper is off, not set up or waiting after failures, so no form waits on a
 * server that is not there; otherwise the AI sidecar's state, or `not-started` when there is none
 * yet (the route then enqueues the job and reports pending).
 */
export function aiReceiptPoll(stagingId: string, now: Date = new Date()): AiReceiptPoll | { status: 'not-started' } {
  if (!localAiActive(now)) return { status: 'off' };
  const sidecar = readAiSidecar(stagingId);
  if (sidecar === null) return { status: 'not-started' };
  if (sidecar.status === 'failed') return { status: 'failed' };
  return { status: 'done', fields: sidecar.fields ?? {} };
}
