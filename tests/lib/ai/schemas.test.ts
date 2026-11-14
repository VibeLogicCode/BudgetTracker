import { describe, it, expect } from 'vitest';
import {
  MAX_CATEGORY_CHOICES,
  MODEL_NAME_RE,
  RECEIPT_ANSWER,
  categoryChoices,
  chatEnvelopeSchema,
  cleanMerchantName,
  isModelName,
  merchantAnswer,
  parseModelJson,
  type CategoryChoiceInput,
} from '@/lib/ai/schemas';

/** v1.64.0 (plan 2026-11-12, A4, L1 and L7). */
const cat = (id: number, name: string, parentId: number | null, extra: Partial<CategoryChoiceInput> = {}): CategoryChoiceInput => ({
  id,
  name,
  parentId,
  isArchived: false,
  sortOrder: id,
  ...extra,
});

describe('categoryChoices', () => {
  it('labels Parent > Child in tree order, leaves archived ones out, and makes a repeat unique', () => {
    const { labels, idByLabel } = categoryChoices([
      cat(1, 'Food', null),
      cat(2, 'Groceries', 1),
      cat(3, 'Dining out', 1),
      cat(4, 'Home', null),
      cat(5, 'Groceries', 1, { sortOrder: 9 }),
      cat(6, 'Old', null, { isArchived: true }),
      cat(7, 'Snacks', 6),
      cat(8, 'Kids', null, { sortOrder: 0 }),
    ]);
    expect(labels).toEqual(['Kids', 'Food', 'Food > Groceries', 'Food > Dining out', 'Food > Groceries (2)', 'Home', 'Old > Snacks']);
    expect(new Set(labels).size).toBe(labels.length);
    expect(idByLabel.get('Food > Groceries')).toBe(2);
    expect(idByLabel.get('Food > Groceries (2)')).toBe(5);
    expect(idByLabel.has('Old')).toBe(false);
  });

  it('offers at most 300', () => {
    const many = Array.from({ length: 320 }, (_, i) => cat(i + 1, `Category ${i + 1}`, null));
    expect(categoryChoices(many).labels).toHaveLength(MAX_CATEGORY_CHOICES);
  });
});

describe('merchantAnswer', () => {
  const { jsonSchema, zodSchema } = merchantAnswer(['Groceries', 'Dining out']);

  it('tells the server both keys, the labels and nothing else', () => {
    expect(jsonSchema).toEqual({
      type: 'object',
      properties: {
        category: { anyOf: [{ type: 'string', enum: ['Groceries', 'Dining out'] }, { type: 'null' }] },
        merchant: { anyOf: [{ type: 'string', maxLength: 60 }, { type: 'null' }] },
      },
      required: ['category', 'merchant'],
      additionalProperties: false,
    });
  });

  it('accepts a label or null, and refuses an unknown label, an extra key, a missing key and a 61-character name', () => {
    expect(zodSchema.safeParse({ category: 'Groceries', merchant: 'Maple Grocer' }).success).toBe(true);
    expect(zodSchema.safeParse({ category: null, merchant: null }).success).toBe(true);
    expect(zodSchema.safeParse({ category: 'Fuel', merchant: 'Maple Grocer' }).success).toBe(false);
    expect(zodSchema.safeParse({ category: 'Groceries', merchant: 'Maple Grocer', confidence: 1 }).success).toBe(false);
    expect(zodSchema.safeParse({ category: 'Groceries' }).success).toBe(false);
    expect(zodSchema.safeParse({ category: 'Groceries', merchant: 'M'.repeat(61) }).success).toBe(false);
  });

  it('with no categories, offers only null', () => {
    const empty = merchantAnswer([]);
    expect(empty.zodSchema.safeParse({ category: null, merchant: 'Maple Grocer' }).success).toBe(true);
    expect(empty.zodSchema.safeParse({ category: 'Groceries', merchant: null }).success).toBe(false);
  });
});

describe('RECEIPT_ANSWER', () => {
  it('takes a two-decimal total and ISO dates, each nullable, and nothing else', () => {
    const ok = { vendor: 'Maple Grocer', total: '47.32', purchaseDate: '2026-03-09', dueDate: null };
    expect(RECEIPT_ANSWER.zodSchema.safeParse(ok).success).toBe(true);
    expect(RECEIPT_ANSWER.zodSchema.safeParse({ ...ok, total: '47.3' }).success).toBe(false);
    expect(RECEIPT_ANSWER.zodSchema.safeParse({ ...ok, total: '$47.32' }).success).toBe(false);
    expect(RECEIPT_ANSWER.zodSchema.safeParse({ ...ok, purchaseDate: 'March 9' }).success).toBe(false);
    expect(RECEIPT_ANSWER.zodSchema.safeParse({ ...ok, note: 'x' }).success).toBe(false);
    expect(RECEIPT_ANSWER.jsonSchema).toMatchObject({ required: ['vendor', 'total', 'purchaseDate', 'dueDate'], additionalProperties: false });
  });
});

describe('the reply envelope and the model JSON', () => {
  it('reads choices[0].message.content as a string and refuses another shape', () => {
    expect(chatEnvelopeSchema.safeParse({ choices: [{ message: { content: '{}' } }] }).success).toBe(true);
    expect(chatEnvelopeSchema.safeParse({ choices: [] }).success).toBe(false);
    expect(chatEnvelopeSchema.safeParse({ message: { content: '{}' } }).success).toBe(false);
    expect(chatEnvelopeSchema.safeParse({ choices: [{ message: { content: null } }] }).success).toBe(false);
  });

  it('parses plain JSON, removes one surrounding fence, and refuses prose, two fences and an oversize answer', () => {
    expect(parseModelJson('{"category":null,"merchant":"Maple Grocer"}')).toEqual({ ok: true, value: { category: null, merchant: 'Maple Grocer' } });
    expect(parseModelJson('```json\n{"category":"Groceries","merchant":null}\n```')).toEqual({ ok: true, value: { category: 'Groceries', merchant: null } });
    expect(parseModelJson('```\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseModelJson('Sure! Here is the JSON: {"a":1}')).toEqual({ ok: false });
    expect(parseModelJson('```json\n```json\n{"a":1}\n```\n```')).toEqual({ ok: false });
    expect(parseModelJson(`{"a":"${'x'.repeat(9000)}"}`)).toEqual({ ok: false });
    expect(parseModelJson('')).toEqual({ ok: false });
  });
});

describe('cleanMerchantName', () => {
  it('keeps an everyday name, collapsed and without control characters', () => {
    expect(cleanMerchantName('  Maple\u0000  Grocer\n', 'MAPLE GROCER 0042')).toBe('Maple Grocer');
  });

  it('refuses the raw text handed back, an address, too few letters, too long, and a non-string', () => {
    expect(cleanMerchantName('Maple Grocer 0042', 'MAPLE GROCER 0042')).toBeNull();
    expect(cleanMerchantName('maplegrocer0042', 'MAPLE GROCER 0042')).toBeNull();
    expect(cleanMerchantName('https://maple.example', 'MAPLE')).toBeNull();
    expect(cleanMerchantName('www.maple.example', 'MAPLE')).toBeNull();
    expect(cleanMerchantName('orders@maple.example', 'MAPLE')).toBeNull();
    expect(cleanMerchantName('7-1', 'X')).toBeNull();
    expect(cleanMerchantName('M'.repeat(61), 'X')).toBeNull();
    expect(cleanMerchantName(null, 'X')).toBeNull();
    expect(cleanMerchantName(42, 'X')).toBeNull();
  });
});

describe('model names', () => {
  it('takes the names servers list, and never one shaped like an address', () => {
    for (const name of ['test-model:1b', 'llama3.2:3b', 'org/model-7b@q4', 'qwen2.5_7b']) {
      expect(isModelName(name), name).toBe(true);
      expect(MODEL_NAME_RE.test(name)).toBe(true);
    }
    for (const name of ['', ' llama', '-x', 'a b', 'evil://user:pass@host', 'm'.repeat(101), 42]) {
      expect(isModelName(name), String(name)).toBe(false);
    }
  });
});
