import { z } from '@/lib/zod';

/**
 * v1.64.0 (plan 2026-11-12, L1 and L7). What the model is asked to answer, as a JSON schema the
 * server constrains its output to, and the same shape again as zod, because the server's promise is
 * not the app's check. PURE: no @/db, no node builtin (tests/ops/notify-egress).
 */

/** The category fields categoryChoices reads. CategoryRecord (src/lib/categories.ts) satisfies it. */
export interface CategoryChoiceInput {
  id: number;
  name: string;
  parentId: number | null;
  isArchived: boolean;
  sortOrder: number;
}

export const MAX_CATEGORY_CHOICES = 300;
export const MAX_CLEAN_NAME_CHARS = 60;
/** A model's JSON answer is a few hundred bytes; anything over this is not an answer. */
export const MAX_MODEL_JSON_BYTES = 8 * 1024;
export const MAX_RECEIPT_VENDOR_CHARS = 60;

/** A model name as Ollama and llama.cpp list them: `llama3.2:3b`, `org/model-7b@q4`. */
export const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,99}$/;

/**
 * MODEL_NAME_RE, and never anything shaped like an address: the name is written into the audit
 * detail, which must never carry a scheme and a user name.
 */
export function isModelName(value: unknown): value is string {
  return typeof value === 'string' && MODEL_NAME_RE.test(value) && !/:\/\//.test(value);
}

const squashSpaces = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();

function byOrder(a: CategoryChoiceInput, b: CategoryChoiceInput): number {
  return a.sortOrder - b.sortOrder || a.id - b.id;
}

/**
 * The household's non-archived categories as the labels the model picks from: `Parent > Child`,
 * each parent followed by its children, as the category manager lists them. A label that would
 * repeat gets ` (2)`, ` (3)`, so each maps back to exactly one id. At most 300.
 */
export function categoryChoices(categories: readonly CategoryChoiceInput[]): { labels: string[]; idByLabel: Map<string, number> } {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const live = categories.filter((category) => !category.isArchived);
  const liveIds = new Set(live.map((category) => category.id));
  const parents = live.filter((category) => category.parentId === null || !liveIds.has(category.parentId)).sort(byOrder);
  const ordered: CategoryChoiceInput[] = [];
  for (const parent of parents) {
    ordered.push(parent);
    if (parent.parentId === null) ordered.push(...live.filter((category) => category.parentId === parent.id).sort(byOrder));
  }
  const labels: string[] = [];
  const idByLabel = new Map<string, number>();
  for (const category of ordered.slice(0, MAX_CATEGORY_CHOICES)) {
    const parent = category.parentId === null ? undefined : byId.get(category.parentId);
    const base = squashSpaces(parent ? `${parent.name} > ${category.name}` : category.name) || `Category ${category.id}`;
    let label = base;
    for (let n = 2; idByLabel.has(label); n += 1) label = `${base} (${n})`;
    labels.push(label);
    idByLabel.set(label, category.id);
  }
  return { labels, idByLabel };
}

/** A JSON schema value: what the server is told to produce. */
export type JsonSchema = Record<string, unknown>;

const nullableString = (extra: Record<string, unknown>) => ({ anyOf: [{ type: 'string', ...extra }, { type: 'null' }] });

/** The merchant job's answer: one of the labels or null, and an everyday name or null. */
export function merchantAnswer(labels: readonly string[]) {
  const jsonSchema: JsonSchema = {
    type: 'object',
    properties: {
      category: labels.length > 0 ? nullableString({ enum: [...labels] }) : { type: 'null' },
      merchant: nullableString({ maxLength: MAX_CLEAN_NAME_CHARS }),
    },
    required: ['category', 'merchant'],
    additionalProperties: false,
  };
  const category = labels.length > 0 ? z.enum(labels as [string, ...string[]]).nullable() : z.null();
  const zodSchema = z.object({ category, merchant: z.string().max(MAX_CLEAN_NAME_CHARS).nullable() }).strict();
  return { jsonSchema, zodSchema };
}

export type MerchantAnswer = { category: string | null; merchant: string | null };

const TOTAL_RE = /^\d{1,7}\.\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The receipt job's answer. Every field may be null; L7's grounding decides what is kept. */
export const RECEIPT_ANSWER = {
  jsonSchema: {
    type: 'object',
    properties: {
      vendor: nullableString({ maxLength: MAX_RECEIPT_VENDOR_CHARS }),
      total: nullableString({ pattern: TOTAL_RE.source }),
      purchaseDate: nullableString({ pattern: DATE_RE.source }),
      dueDate: nullableString({ pattern: DATE_RE.source }),
    },
    required: ['vendor', 'total', 'purchaseDate', 'dueDate'],
    additionalProperties: false,
  } as JsonSchema,
  zodSchema: z
    .object({
      vendor: z.string().max(MAX_RECEIPT_VENDOR_CHARS).nullable(),
      total: z.string().regex(TOTAL_RE).nullable(),
      purchaseDate: z.string().regex(DATE_RE).nullable(),
      dueDate: z.string().regex(DATE_RE).nullable(),
    })
    .strict(),
};

export type ReceiptAnswer = { vendor: string | null; total: string | null; purchaseDate: string | null; dueDate: string | null };

/** The OpenAI-compatible reply: only `choices[0].message.content` is read, and it must be a string. */
export const chatEnvelopeSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

/** GET /v1/models: the ids are all the app reads. */
export const modelsEnvelopeSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

/**
 * The model's content as JSON: at most one surrounding ```json fence removed, at most 8 KiB, parsed.
 * Not zod-checked here; each job checks its own shape.
 */
export function parseModelJson(content: string): { ok: true; value: unknown } | { ok: false } {
  if (typeof content !== 'string') return { ok: false };
  let text = content.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  if (text.length === 0 || new TextEncoder().encode(text).length > MAX_MODEL_JSON_BYTES) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

const compact = (value: string) => value.toLowerCase().replace(/\s+/g, '');

/**
 * The everyday name a model gave, or null when it is not one: control characters stripped and
 * spaces collapsed, 1-60 characters with at least two letters, nothing that looks like an address
 * (`://`, `www.`, `@`), and not the bank's own text handed back (ignoring case and spaces).
 */
export function cleanMerchantName(name: unknown, rawDescription: string): string | null {
  if (typeof name !== 'string') return null;
  const cleaned = squashSpaces(name);
  if (cleaned.length === 0 || cleaned.length > MAX_CLEAN_NAME_CHARS) return null;
  if ((cleaned.match(/\p{L}/gu)?.length ?? 0) < 2) return null;
  if (/:\/\//.test(cleaned) || /www\./i.test(cleaned) || cleaned.includes('@')) return null;
  if (compact(cleaned) === compact(rawDescription)) return null;
  return cleaned;
}
