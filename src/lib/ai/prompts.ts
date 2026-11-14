/**
 * v1.64.0 (plan 2026-11-12, L6). Exactly what the model is told, and nothing more. PURE: the inputs
 * arrive as arguments, so what a prompt can carry is decided by its parameter types. A merchant
 * prompt carries the household's category labels and ONE row's description, amount and date: never
 * an account, a person, a note, another row or another merchant. A receipt prompt carries the
 * staged receipt's own text and the household's today. The test prompt carries made-up data only.
 */

export interface PromptPair {
  system: string;
  user: string;
}

/** The one row a merchant prompt may carry. Deliberately these three fields and no others. */
export interface MerchantPromptRow {
  rawDescription: string;
  amountCents: number;
  date: string;
}

export const MAX_PROMPT_DESCRIPTION_CHARS = 200;
export const MAX_PROMPT_RECEIPT_CHARS = 6_000;

export const MERCHANT_SYSTEM_PROMPT =
  "You file bank transactions for a household budget. Pick the one category from the list that fits this transaction, or null if none fits. Give the merchant's everyday name in title case, for example Maple Grocer, or null if you cannot tell. Answer only with JSON.";

export const RECEIPT_SYSTEM_PROMPT =
  'You read receipts and bills for a household budget. From the text, give the store or company name, the total paid or owed, the purchase date and the due date. Use only values printed in the text, and null for anything that is not printed. Dates are YYYY-MM-DD and the total is digits with two decimals, like 47.32. Answer only with JSON.';

/** One line: control characters out, runs of whitespace to one space. */
function oneLine(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Signed dollars from cents with integer arithmetic: -4217 -> `-42.17`. */
function signedAmount(cents: number): string {
  const magnitude = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(magnitude / 100);
  const rest = String(magnitude % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${dollars}.${rest}`;
}

export function merchantPrompt({ labels, row }: { labels: readonly string[]; row: MerchantPromptRow }): PromptPair {
  const description = oneLine(row.rawDescription).slice(0, MAX_PROMPT_DESCRIPTION_CHARS);
  const direction = row.amountCents < 0 ? 'money out' : 'money in';
  const user = [
    'Categories:',
    ...labels.map((label) => `- ${label}`),
    '',
    'Transaction:',
    `Description: ${description}`,
    `Amount: ${signedAmount(row.amountCents)} (${direction})`,
    `Date: ${oneLine(row.date)}`,
  ].join('\n');
  return { system: MERCHANT_SYSTEM_PROMPT, user };
}

export function receiptPrompt({ text, today }: { text: string; today: string }): PromptPair {
  // Line breaks are the receipt's layout and stay; every other control character goes.
  const body = text
    .slice(0, MAX_PROMPT_RECEIPT_CHARS)
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, ' ');
  return { system: RECEIPT_SYSTEM_PROMPT, user: `Today is ${oneLine(today)}.\n\nReceipt text:\n${body}` };
}

/** Settings' Test button asks about this made-up row, so no household data leaves on a test. */
export const TEST_LABELS: readonly string[] = ['Groceries', 'Dining out'];
export const TEST_ROW: MerchantPromptRow = { rawDescription: 'MAPLE GROCER 0042', amountCents: -4217, date: '2026-03-09' };
export const TEST_PROMPT: PromptPair = merchantPrompt({ labels: TEST_LABELS, row: TEST_ROW });
