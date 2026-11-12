import { describe, it, expect } from 'vitest';
import { errorText, z } from '@/lib/zod';

/**
 * v1.60.1. The first issue's message for each schema shape the app uses, as zod 3.25.76 printed
 * it. The app shows `issues[0].message` to people, so these strings are what a form or an import
 * route says when it refuses something. Every expectation is a literal copied from zod 3's output,
 * never computed: after the zod 4 bump, src/lib/zod.ts has to reproduce them byte for byte.
 */
function first(schema: z.ZodType, input: unknown): string {
  const result = schema.safeParse(input);
  if (result.success) throw new Error(`expected a refusal for ${String(input)}`);
  return result.error.issues[0]?.message ?? '';
}

/** The id chain every form and route uses for a row id. */
const id = () => z.coerce.number().int().positive();

describe('zod messages the app shows (pinned on zod 3)', () => {
  it('a coerced positive id', () => {
    for (const input of [null, '', '0', '-3']) expect(first(id(), input)).toBe('Number must be greater than 0');
    for (const input of [undefined, 'abc']) expect(first(id(), input)).toBe('Expected number, received nan');
    for (const input of ['1.5', 'Infinity']) expect(first(id(), input)).toBe('Expected integer, received float');
    expect(first(z.object({ id: id() }), {})).toBe('Expected number, received nan');
  });

  it('number types and ranges', () => {
    expect(first(z.number().int().positive(), '5')).toBe('Expected number, received string');
    const port = z.coerce.number().int().min(1).max(65535);
    expect(first(port, '0')).toBe('Number must be greater than or equal to 1');
    expect(first(port, '70000')).toBe('Number must be less than or equal to 65535');
    expect(first(z.number().int().nonnegative(), -1)).toBe('Number must be greater than or equal to 0');
  });

  it('string lengths, missing values and object shape', () => {
    expect(first(z.string().trim().max(80), 'a'.repeat(81))).toBe('String must contain at most 80 character(s)');
    expect(first(z.string().trim().min(1), '  ')).toBe('String must contain at least 1 character(s)');
    expect(first(z.string().min(1), null)).toBe('Expected string, received null');
    expect(first(z.string().min(1), undefined)).toBe('Required');
    expect(first(z.object({ a: z.string() }), {})).toBe('Required');
    expect(first(z.object({ a: z.string() }), null)).toBe('Expected object, received null');
  });

  it('an email address', () => {
    const email = z.email().max(254);
    for (const input of ['not-an-email', '', 'x'.repeat(300)]) expect(first(email, input)).toBe('Invalid email');
    expect(email.safeParse('Alex.Sam+x@example.co').success).toBe(true);
  });

  it.each([
    ['alex@example.com', true],
    ['.alex@example.com', false],
    ['alex.@example.com', false],
    ['alex..sam@example.com', false],
    ["o'brien@example.com", true],
    ['alex+budget@example.com', true],
    ['alex-sam@example.com', true],
    ['alex@my-domain.example', true],
    ['alex@-example.com', false],
    ['alex@example-.com', true],
    ['alex@example.c', false],
    ['alex@example.123', false],
    ['alex@example', false],
    ['ALEX@EXAMPLE.COM', true],
    ['Alex.Sam@Example.Co', true],
    ['alex@example.com\n', false],
    ['alex@@example.com', false],
    ['alex@.example.com', false],
    ['alex@example..com', false],
    ['alex@example.com.', false],
    ['alex sam@example.com', false],
    ['alex@exa_mple.com', false],
    ['a@b.co', true],
    ['alex@sub.example.co.uk', true],
    ['alex_sam@example.com', true],
  ])('email %j accepted: %s', (input, accepted) => {
    expect(z.email().max(254).safeParse(input).success).toBe(accepted);
  });

  it('a staging id', () => {
    const stagingId = z.guid();
    expect(first(stagingId, 'nope')).toBe('Invalid uuid');
    expect(stagingId.safeParse('11111111-2222-3333-4444-555555555555').success).toBe(true);
  });

  it('enums, literals and a regex', () => {
    const type = z.enum(['chequing', 'credit']);
    expect(first(type, 'x')).toBe("Invalid enum value. Expected 'chequing' | 'credit', received 'x'");
    expect(first(type, null)).toBe("Expected 'chequing' | 'credit', received null");
    expect(first(type, undefined)).toBe('Required');
    expect(first(z.literal('on'), null)).toBe('Invalid literal value, expected "on"');
    expect(first(z.literal(1), 2)).toBe('Invalid literal value, expected 1');
    expect(first(z.string().regex(/^[0-9a-f]{64}$/), 'zz')).toBe('Invalid');
  });

  it('array lengths', () => {
    expect(first(z.array(z.number()).min(1), [])).toBe('Array must contain at least 1 element(s)');
    expect(first(z.array(z.number()).max(2), [1, 2, 3])).toBe('Array must contain at most 2 element(s)');
  });

  it('unions and booleans', () => {
    const optionalId = z.union([z.literal(''), id()]);
    expect(first(optionalId, 'abc')).toBe('Invalid input');
    expect(first(optionalId, '-5')).toBe('Number must be greater than 0');
    expect(first(z.union([z.literal('off'), z.enum(['1h', '6h'])]), 'x')).toBe('Invalid input');
    expect(first(z.boolean(), 'true')).toBe('Expected boolean, received string');
  });

  it('keeps every message the code wrote itself', () => {
    expect(first(z.number().int('Price must be a whole number of cents'), 1.5)).toBe('Price must be a whole number of cents');
    expect(first(z.number().int().positive('Target must be greater than zero'), 0)).toBe('Target must be greater than zero');
    expect(first(z.string().refine((value) => value === '', 'Pick an owner, or Joint.'), 'x')).toBe('Pick an owner, or Joint.');

    const relay = z
      .object({ security: z.string(), preset: z.string() })
      .refine((value) => value.security !== 'none' || value.preset === 'custom', {
        error: 'Unencrypted SMTP is only available with the Custom SMTP preset.',
        path: ['security'],
      });
    const refused = relay.safeParse({ security: 'none', preset: 'brevo' });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe('Unencrypted SMTP is only available with the Custom SMTP preset.');
    expect(refused.error?.issues[0]?.path).toEqual(['security']);

    const paired = z.object({ cycle: z.string().nullable() }).superRefine((value, ctx) => {
      if (value.cycle === null) ctx.addIssue({ code: 'custom', path: ['cycle'], message: 'Set a cycle and an amount together.' });
    });
    const unpaired = paired.safeParse({ cycle: null });
    expect(unpaired.success).toBe(false);
    expect(unpaired.error?.issues[0]?.message).toBe('Set a cycle and an amount together.');
    expect(unpaired.error?.issues[0]?.path).toEqual(['cycle']);
  });

  it('defaults, the optional-text preprocess and pack-style transforms', () => {
    expect(z.string().default('').parse(undefined)).toBe('');
    expect(z.number().nullable().default(null).parse(undefined)).toBeNull();
    expect(z.enum(['auto', 'utf-8']).default('auto').parse(undefined)).toBe('auto');

    const optionalText = (max: number) =>
      z.preprocess((value) => (typeof value === 'string' && value.trim().length === 0 ? null : value), z.string().trim().max(max).nullable());
    const note = z.object({ v: optionalText(5) });
    expect(first(note, {})).toBe('Required');
    expect(note.parse({ v: '  ' })).toEqual({ v: null });
    expect(first(note, { v: 'toolong' })).toBe('String must contain at most 5 character(s)');

    const packEntry = z.object({
      p: z.string().nullable().optional().transform((v) => v ?? null),
      b: z.boolean().optional().transform((v) => v ?? false),
    });
    expect(packEntry.parse({})).toEqual({ p: null, b: false });
  });
});

describe('the zod 3 message map itself (zod 4)', () => {
  it('refuses an id past the safe-integer range with a zod 3 sentence', () => {
    expect(first(id(), '9007199254740993')).toBe('Number must be less than or equal to 9007199254740991');
  });

  it('reads a malformed guid as a uuid', () => {
    expect(first(z.guid(), 'nope')).toBe('Invalid uuid');
  });

  it('leaves an issue kind the app never raises to zod 4', () => {
    expect(first(z.number().multipleOf(5), 7)).toBe('Invalid number: must be a multiple of 5');
  });

  it('runs jitless', () => {
    expect(z.config().jitless).toBe(true);
  });

  it('errorText gives one line for any thrown value', () => {
    const zodError = (() => {
      try {
        z.string().trim().min(1, 'Name is required').parse('   ');
      } catch (error) {
        return error;
      }
      throw new Error('expected a throw');
    })();
    expect(zodError).toBeInstanceOf(z.ZodError);
    expect(errorText(zodError, 'Could not save.')).toBe('Name is required');
    expect(errorText(new Error('That person no longer exists.'), 'Could not save.')).toBe('That person no longer exists.');
    expect(errorText('not an error', 'Could not save.')).toBe('Could not save.');
  });
});
