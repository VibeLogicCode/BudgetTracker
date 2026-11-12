// The one place the app imports zod (tests/ops/zod-v4-only.test.ts holds every other file to
// `@/lib/zod`). zod 4 rewords every default message, and the app shows `issues[0].message` to
// people, so this keeps zod 3's English for the issue kinds this app's schemas raise
// (tests/lib/zod-compat.test.ts pins them) and returns undefined for anything else, which lets
// zod 4's own wording apply. A message written on a schema or a check still wins over this map.
import { z } from 'zod';

type Inst = { _zod?: { def?: { type?: string; checks?: Array<{ _zod: { def: { check?: string; format?: string } } }> } } };

/** zod 3's name for a received value's type, as its "received ..." clauses spelled it. */
function v3Type(data: unknown): string {
  if (typeof data === 'number') return Number.isNaN(data) ? 'nan' : 'number';
  if (typeof data !== 'object') return typeof data;
  if (data === null) return 'null';
  if (Array.isArray(data)) return 'array';
  if (data instanceof Date) return 'date';
  if (data instanceof Map) return 'map';
  if (data instanceof Set) return 'set';
  return 'object';
}

const joinValues = (values: readonly unknown[]) => values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(' | ');
/** zod 4 reports an .int() field's range as origin 'int'; zod 3 called it a number. */
const size = (origin: string) => (origin === 'int' ? 'number' : origin);
const isIntField = (inst: Inst | undefined) =>
  (inst?._zod?.def?.checks ?? []).some((c) => c._zod.def.check === 'number_format' && c._zod.def.format === 'safeint');

export function zod3Message(iss: z.core.$ZodRawIssue): string | undefined {
  const inst = iss.inst as Inst | undefined;
  switch (iss.code) {
    case 'invalid_type': {
      if (iss.expected === 'int') return 'Expected integer, received float';
      // +-Infinity on an .int() field: zod 3 let z.number() through and failed it at .int().
      if (iss.expected === 'number' && typeof iss.input === 'number' && !Number.isNaN(iss.input) && isIntField(inst)) {
        return 'Expected integer, received float';
      }
      const received = v3Type(iss.input);
      return received === 'undefined' ? 'Required' : `Expected ${iss.expected}, received ${received}`;
    }
    case 'invalid_value': {
      const type = inst?._zod?.def?.type;
      if (type === 'literal') return `Invalid literal value, expected ${JSON.stringify(iss.values[0])}`;
      if (type !== 'enum') return undefined;
      if (typeof iss.input === 'string') return `Invalid enum value. Expected ${joinValues(iss.values)}, received '${iss.input}'`;
      const received = v3Type(iss.input);
      return received === 'undefined' ? 'Required' : `Expected ${joinValues(iss.values)}, received ${received}`;
    }
    case 'too_small': {
      const k = size(iss.origin);
      if (k === 'array') return `Array must contain ${iss.exact ? 'exactly' : iss.inclusive ? 'at least' : 'more than'} ${iss.minimum} element(s)`;
      if (k === 'string') return `String must contain ${iss.exact ? 'exactly' : iss.inclusive ? 'at least' : 'over'} ${iss.minimum} character(s)`;
      if (k === 'number') return `Number must be ${iss.exact ? 'exactly equal to ' : iss.inclusive ? 'greater than or equal to ' : 'greater than '}${iss.minimum}`;
      return undefined;
    }
    case 'too_big': {
      const k = size(iss.origin);
      if (k === 'array') return `Array must contain ${iss.exact ? 'exactly' : iss.inclusive ? 'at most' : 'less than'} ${iss.maximum} element(s)`;
      if (k === 'string') return `String must contain ${iss.exact ? 'exactly' : iss.inclusive ? 'at most' : 'under'} ${iss.maximum} character(s)`;
      if (k === 'number') return `Number must be ${iss.exact ? 'exactly' : iss.inclusive ? 'less than or equal to' : 'less than'} ${iss.maximum}`;
      return undefined;
    }
    case 'invalid_format':
      if (iss.format === 'regex') return 'Invalid';
      if (iss.format === 'email' || iss.format === 'url') return `Invalid ${iss.format}`;
      if (iss.format === 'guid' || iss.format === 'uuid') return 'Invalid uuid';
      return undefined;
    case 'invalid_union':
    case 'custom':
      return 'Invalid input';
    default:
      return undefined;
  }
}

// jitless: zod 4 otherwise probes for `new Function` to compile object parsers, and the app's CSP
// has no 'unsafe-eval'. The results are the same either way.
z.config({ jitless: true, customError: zod3Message });

export { z };

/** A thrown error as one line for a form. A ZodError's own .message is a JSON dump. */
export function errorText(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? fallback;
  return error instanceof Error ? error.message : fallback;
}
