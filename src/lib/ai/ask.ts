import { acceptsTransactions, listAccounts } from '@/lib/accounts';
import { listAttributablePeople } from '@/lib/auth/users';
import { isSelfScoped, type Viewer } from '@/lib/auth/viewer';
import { listCategories } from '@/lib/categories';
import { addMonthsClamped, dayLabel, isIsoDate } from '@/lib/dates';
import { transactionsHref } from '@/lib/transaction-links';
import { z } from '@/lib/zod';
import { LocalAiAnswerError, LocalAiServerError, chatJson, type LocalAiTimeouts } from '@/lib/ai/client';
import { readLocalAiConfig, recordLocalAiFailure } from '@/lib/ai/config';
import type { PromptPair } from '@/lib/ai/prompts';
import { categoryChoices, type JsonSchema } from '@/lib/ai/schemas';

/**
 * v1.64.0 (plan 2026-11-12, Lane E). Ask in words: a typed question becomes a Transactions filter,
 * and the page does every sum from that filter as it always has. The model never sees a
 * transaction, an amount or a total, and its answer can only become a link.
 *
 * - The prompt carries the question (3-200 characters, one line), the household's today, the
 *   non-archived category labels, the names of the accounts this viewer may see that take
 *   transactions, and the people a household viewer may pick. A self viewer is offered no person,
 *   and the page forces their own person scope whatever the link says (readFilter).
 * - The answer is a closed object: from, to, category, account, person, text (<= 40) and
 *   spendingOnly. Any other key is dropped. A name not on its list, an unreadable date, from after
 *   to, or a date more than 10 years from today refuses the whole answer, because quietly dropping
 *   part of it would show rows for a different question than the one asked.
 * - Names map back to ids from the same lists the prompt was built from, so an id in the link is
 *   always one this viewer may see.
 * - The question is never logged or stored. A server failure is recorded for the backoff (so the
 *   box goes away while the server is down); its sentence is the app's own.
 * - One question at a time per person, and a short wait after each.
 */

export const ASK_MIN_QUESTION_CHARS = 3;
export const ASK_MAX_QUESTION_CHARS = 200;
export const ASK_MAX_SEARCH_CHARS = 40;
/** A date in an answer must be within this many years of today, either side. */
export const ASK_YEARS_EITHER_SIDE = 10;
export const ASK_MAX_ACCOUNTS = 100;
export const ASK_MAX_PEOPLE = 50;
const MAX_NAME_CHARS = 80;
/** After an answer, the same person waits this long before asking again. */
export const ASK_COOLDOWN_MS = 3_000;

export const ASK_OFF_ERROR = 'Local AI is off or not answering. Use the filters instead.';
export const ASK_QUESTION_LENGTH_ERROR = `Type a question of ${ASK_MIN_QUESTION_CHARS} to ${ASK_MAX_QUESTION_CHARS} characters.`;
export const ASK_BUSY_ERROR = 'Still working on your last question.';
export const ASK_COOLDOWN_ERROR = 'Wait a few seconds before asking again.';
export const ASK_UNREADABLE_ERROR = "The model's answer could not be read. Try different words, or use the filters.";
export const ASK_SHAPE_ERROR = "The model's answer named something this page cannot filter by. Try different words, or use the filters.";
export const ASK_DATES_ERROR = "The model's dates did not make sense. Try naming the dates, or use the filters.";
export const ASK_NOTHING_ERROR =
  'The app could not find a filter in that question. Try naming a category, a store, an account or some dates.';

/** What the action hands the box: a link and how the question was read, or one sentence. */
export interface AskState {
  href?: string;
  reading?: string;
  error?: string;
}

export type AskResult = { ok: true; href: string; reading: string } | { ok: false; error: string };

interface NameChoices {
  labels: string[];
  idByLabel: Map<string, number>;
}

/** The three lists the model may pick from, each label mapping back to exactly one id. */
export interface AskChoices {
  categories: NameChoices;
  accounts: NameChoices;
  people: NameChoices;
}

/** One line: control characters out, runs of whitespace to one space. */
function oneLine(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Names as unique labels: a repeat gets ` (2)`, ` (3)`, the way categoryChoices does it. */
function uniqueNames(items: readonly { id: number; name: string }[], max: number): NameChoices {
  const labels: string[] = [];
  const idByLabel = new Map<string, number>();
  for (const item of items.slice(0, max)) {
    const base = oneLine(item.name).slice(0, MAX_NAME_CHARS) || `#${item.id}`;
    let label = base;
    for (let n = 2; idByLabel.has(label); n += 1) label = `${base} (${n})`;
    labels.push(label);
    idByLabel.set(label, item.id);
  }
  return { labels, idByLabel };
}

/**
 * What this viewer may filter by. Categories are the household's (every viewer sees the category
 * list); accounts are listAccounts for this viewer (a self viewer's own only) that take
 * transactions, as the page's own account select lists them; people are listAttributablePeople for
 * a household viewer and nobody for a self viewer.
 */
export function askChoices(viewer: Viewer): AskChoices {
  const categories = categoryChoices(listCategories());
  const accounts = uniqueNames(
    listAccounts({}, viewer)
      .filter((account) => acceptsTransactions(account.type))
      .map((account) => ({ id: account.id, name: account.name })),
    ASK_MAX_ACCOUNTS,
  );
  const people = isSelfScoped(viewer)
    ? { labels: [], idByLabel: new Map<string, number>() }
    : uniqueNames(
        listAttributablePeople().map((person) => ({ id: person.id, name: person.name })),
        ASK_MAX_PEOPLE,
      );
  return { categories, accounts, people };
}

/** The question as one line, or the length sentence. Nothing is kept. */
export function readQuestion(raw: unknown): { ok: true; question: string } | { ok: false; error: string } {
  const question = typeof raw === 'string' ? oneLine(raw) : '';
  if (question.length < ASK_MIN_QUESTION_CHARS || question.length > ASK_MAX_QUESTION_CHARS) {
    return { ok: false, error: ASK_QUESTION_LENGTH_ERROR };
  }
  return { ok: true, question };
}

export const ASK_SYSTEM_PROMPT =
  "You turn a question about a household budget into a filter for its list of transactions. Fill in only what the question names: from and to as dates (YYYY-MM-DD, worked out from today's date for words like last year or this month), one category, account or person copied exactly from its list, a word or two to search the transaction descriptions for (a store or merchant name), and spendingOnly true when the question is about money spent. Use null for anything the question does not name, and false for spendingOnly when it is not about spending. Do not answer the question or add anything up. Answer only with JSON.";

/** Exactly what the model is told: the lists, today and the question. No transaction, amount or total. */
export function askPrompt({ question, today, choices }: { question: string; today: string; choices: AskChoices }): PromptPair {
  const lines = [`Today is ${oneLine(today)}.`];
  const section = (title: string, labels: readonly string[]) => {
    if (labels.length > 0) lines.push('', `${title}:`, ...labels.map((label) => `- ${label}`));
  };
  section('Categories', choices.categories.labels);
  section('Accounts', choices.accounts.labels);
  section('People', choices.people.labels);
  lines.push('', `Question: ${oneLine(question).slice(0, ASK_MAX_QUESTION_CHARS)}`);
  return { system: ASK_SYSTEM_PROMPT, user: lines.join('\n') };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nullableString = (extra: Record<string, unknown>) => ({ anyOf: [{ type: 'string', ...extra }, { type: 'null' }] });
const choiceSchema = (labels: readonly string[]) => (labels.length > 0 ? nullableString({ enum: [...labels] }) : { type: 'null' });
const zodChoice = (labels: readonly string[]) => (labels.length > 0 ? z.enum(labels as [string, ...string[]]).nullable() : z.null());

/**
 * The answer's shape, as a JSON schema for the server and as zod for the app. Every key is
 * required; the three names are enums of their own lists (or null only, for an empty list). The
 * zod object is not strict: a key the schema does not name is dropped, never read.
 */
export function askAnswer(choices: AskChoices) {
  const jsonSchema: JsonSchema = {
    type: 'object',
    properties: {
      from: nullableString({ pattern: DATE_RE.source }),
      to: nullableString({ pattern: DATE_RE.source }),
      category: choiceSchema(choices.categories.labels),
      account: choiceSchema(choices.accounts.labels),
      person: choiceSchema(choices.people.labels),
      text: nullableString({ maxLength: ASK_MAX_SEARCH_CHARS }),
      spendingOnly: { type: 'boolean' },
    },
    required: ['from', 'to', 'category', 'account', 'person', 'text', 'spendingOnly'],
    additionalProperties: false,
  };
  const zodSchema = z.object({
    from: z.string().regex(DATE_RE).nullable(),
    to: z.string().regex(DATE_RE).nullable(),
    category: zodChoice(choices.categories.labels),
    account: zodChoice(choices.accounts.labels),
    person: zodChoice(choices.people.labels),
    text: z.string().max(ASK_MAX_SEARCH_CHARS).nullable(),
    spendingOnly: z.boolean(),
  });
  return { jsonSchema, zodSchema };
}

/** `Food > Groceries` as the app shows a category: `Food › Groceries`. */
const shownCategory = (label: string) => label.replace(' > ', ' › ');

/**
 * The model's answer as a link and a sentence, or a refusal. Pure apart from the lists it is
 * handed: the ids come from `choices`, the dates are checked against `today`.
 */
export function readAskAnswer(content: unknown, choices: AskChoices, today: string): AskResult {
  const parsed = askAnswer(choices).zodSchema.safeParse(content);
  if (!parsed.success) return { ok: false, error: ASK_SHAPE_ERROR };
  const answer = parsed.data;

  const floor = addMonthsClamped(today, -12 * ASK_YEARS_EITHER_SIDE);
  const ceiling = addMonthsClamped(today, 12 * ASK_YEARS_EITHER_SIDE);
  const inBounds = (date: string | null) => date === null || (isIsoDate(date) && date >= floor && date <= ceiling);
  if (!inBounds(answer.from) || !inBounds(answer.to)) return { ok: false, error: ASK_DATES_ERROR };
  if (answer.from !== null && answer.to !== null && answer.from > answer.to) return { ok: false, error: ASK_DATES_ERROR };

  const categoryId = answer.category === null ? null : (choices.categories.idByLabel.get(answer.category) ?? null);
  const accountId = answer.account === null ? null : (choices.accounts.idByLabel.get(answer.account) ?? null);
  const personId = answer.person === null ? null : (choices.people.idByLabel.get(answer.person) ?? null);
  // The enums already hold these to their lists; this is the same rule said once more at the map.
  if ((answer.category !== null && categoryId === null) || (answer.account !== null && accountId === null) || (answer.person !== null && personId === null)) {
    return { ok: false, error: ASK_SHAPE_ERROR };
  }
  const search = answer.text === null ? '' : oneLine(answer.text).slice(0, ASK_MAX_SEARCH_CHARS);

  let range: { from: string; to: string } | null = null;
  let dates = 'every date';
  if (answer.from !== null && answer.to !== null) {
    range = { from: answer.from, to: answer.to };
    dates = `${dayLabel(answer.from, today)} to ${dayLabel(answer.to, today)}`;
  } else if (answer.from !== null) {
    // `Since March`: up to today, or to that day when it is still ahead.
    range = { from: answer.from, to: answer.from > today ? answer.from : today };
    dates = `since ${dayLabel(answer.from, today)}`;
  } else if (answer.to !== null) {
    range = { from: floor, to: answer.to };
    dates = `up to ${dayLabel(answer.to, today)}`;
  }

  if (range === null && categoryId === null && accountId === null && personId === null && search === '' && !answer.spendingOnly) {
    return { ok: false, error: ASK_NOTHING_ERROR };
  }

  const href = transactionsHref(
    { range, person: personId },
    { kind: 'filter', categoryId, accountId, search: search === '' ? null : search, spendingOnly: answer.spendingOnly },
  );
  const parts: string[] = [];
  if (answer.category !== null) parts.push(shownCategory(answer.category));
  if (search !== '') parts.push(`matching “${search}”`);
  if (answer.account !== null) parts.push(answer.account);
  if (answer.person !== null) parts.push(answer.person);
  if (answer.spendingOnly) parts.push('spending only');
  parts.push(dates);
  const sentence = parts.join(', ');
  return { ok: true, href, reading: sentence.charAt(0).toUpperCase() + sentence.slice(1) };
}

/**
 * One question to the model. The caller has already checked that local AI is active and that this
 * person may ask now (beginAsk). A server failure is recorded for the backoff and reads as off; an
 * answer that cannot be read is this question's problem only and is not recorded.
 */
export async function askToFilter(input: {
  question: unknown;
  viewer: Viewer;
  today: string;
  at: Date;
  timeouts?: Partial<LocalAiTimeouts>;
}): Promise<AskResult> {
  const question = readQuestion(input.question);
  if (!question.ok) return question;
  const config = readLocalAiConfig();
  if (config === null) return { ok: false, error: ASK_OFF_ERROR };
  const choices = askChoices(input.viewer);
  const { jsonSchema } = askAnswer(choices);
  let content: unknown;
  try {
    ({ content } = await chatJson({
      config,
      prompt: askPrompt({ question: question.question, today: input.today, choices }),
      schemaName: 'transactions_filter',
      jsonSchema,
      timeouts: input.timeouts,
    }));
  } catch (error) {
    if (error instanceof LocalAiServerError) {
      recordLocalAiFailure(input.at, error.message);
      return { ok: false, error: ASK_OFF_ERROR };
    }
    if (error instanceof LocalAiAnswerError) return { ok: false, error: ASK_UNREADABLE_ERROR };
    throw error;
  }
  return readAskAnswer(content, choices, input.today);
}

// ---------------------------------------------------------------------------------- one at a time

const asking = new Set<number>();
const lastAnsweredAt = new Map<number, number>();

/** Claims this person's one question in flight. Returns the refusal sentence, or null when they may ask. */
export function beginAsk(userId: number, nowMs: number): string | null {
  if (asking.has(userId)) return ASK_BUSY_ERROR;
  const last = lastAnsweredAt.get(userId);
  if (last !== undefined && nowMs - last < ASK_COOLDOWN_MS) return ASK_COOLDOWN_ERROR;
  asking.add(userId);
  return null;
}

/** Releases the claim; the cooldown runs from here. */
export function endAsk(userId: number, nowMs: number): void {
  asking.delete(userId);
  lastAnsweredAt.set(userId, nowMs);
}

export function resetAskLimitsForTests(): void {
  asking.clear();
  lastAnsweredAt.clear();
}
