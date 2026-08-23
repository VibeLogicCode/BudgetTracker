import { describe, it, expect } from 'vitest';
import { parseImportMapping, serializeImportMapping, importMappingSchema, normalizeCardValue } from '@/lib/import/mapping';
import { BUILTIN_PRESETS, BUILTIN_PRESET_NAMES, getBuiltinPreset } from '@/lib/import/presets';

// Verbatim shape of what v1.5.1 (and every earlier version) actually wrote to
// import_profiles.mapping for the built-in "Amex Canada" preset — copied field-for-field from
// src/lib/import/presets.ts as it stood before cardCol existed. No `cardCol` key anywhere.
// This is the exact JSON already sitting in every install's database today.
const AMEX_1_5_X_MAPPING_JSON = JSON.stringify({
  hasHeader: true,
  headerRows: 1,
  dateCol: 0,
  dateFormat: 'DD-MMM-YYYY',
  descCols: [2],
  amountMode: 'signed',
  amountCol: 5,
  debitCol: null,
  creditCol: null,
  signConvention: 'positive_is_spend',
  encoding: 'auto',
  skipRules: null,
});

describe('importMappingSchema', () => {
  it('accepts every built-in preset', () => {
    for (const name of BUILTIN_PRESET_NAMES) {
      expect(() => importMappingSchema.parse(getBuiltinPreset(name))).not.toThrow();
    }
  });

  it('round-trips through JSON', () => {
    const mapping = getBuiltinPreset('Amex Canada');
    expect(parseImportMapping(serializeImportMapping(mapping))).toEqual(mapping);
  });

  it('rejects signed mode without an amount column', () => {
    const broken = { ...getBuiltinPreset('Amex Canada'), amountCol: null };
    expect(() => parseImportMapping(broken)).toThrowError(/amountCol is required/);
  });

  it('rejects debit_credit mode with no debit and no credit column', () => {
    const broken = { ...getBuiltinPreset('TD Visa'), debitCol: null, creditCol: null };
    expect(() => parseImportMapping(broken)).toThrowError(/debitCol or creditCol is required/);
  });

  it('rejects an empty descCols list', () => {
    const broken = { ...getBuiltinPreset('TD Visa'), descCols: [] };
    expect(() => parseImportMapping(broken)).toThrow();
  });

  it('pins the four built-in preset shapes from spec section 3', () => {
    expect(BUILTIN_PRESETS['TD Chequing/Debit'].mapping.amountMode).toBe('debit_credit');
    expect(BUILTIN_PRESETS['TD Visa'].mapping.hasHeader).toBe(false);
    expect(BUILTIN_PRESETS['Scotiabank Chequing/Debit'].mapping.signConvention).toBe('negative_is_spend');
    expect(BUILTIN_PRESETS['Amex Canada'].mapping.signConvention).toBe('positive_is_spend');
    expect(BUILTIN_PRESETS['Amex Canada'].mapping.hasHeader).toBe(true);
  });
});

describe('cardCol back-compat (MUST-2.1, spec 2026-08-22 v1.6.0)', () => {
  it('parses a verbatim v1.5.x mapping JSON that has no cardCol key at all, defaulting cardCol to null', () => {
    // This is the critical regression guard: every mapping stored by v1.5.1 or earlier
    // (including all four built-in bank presets, on every existing install) lacks this key
    // entirely. If cardCol were required, this parse would throw, and every profile would
    // flip to "unreadable mapping" (the v1.5.1 hasReadableMapping guard) on next boot.
    expect(() => parseImportMapping(AMEX_1_5_X_MAPPING_JSON)).not.toThrow();
    const parsed = parseImportMapping(AMEX_1_5_X_MAPPING_JSON);
    expect(parsed.cardCol).toBeNull();
    // Everything else about the legacy shape still reads correctly.
    expect(parsed.dateFormat).toBe('DD-MMM-YYYY');
    expect(parsed.amountCol).toBe(5);
  });

  it('accepts cardCol as an explicit column index', () => {
    const withCardCol = { ...getBuiltinPreset('Amex Canada'), cardCol: 3 };
    const parsed = parseImportMapping(withCardCol);
    expect(parsed.cardCol).toBe(3);
  });

  it('serializeImportMapping includes cardCol explicitly, even when null', () => {
    const mapping = getBuiltinPreset('TD Visa');
    const json = serializeImportMapping(mapping);
    expect(JSON.parse(json)).toHaveProperty('cardCol', null);
  });

  it('round-trips a mapping with cardCol set through serialize/parse', () => {
    const mapping = { ...getBuiltinPreset('Amex Canada'), cardCol: 4 };
    expect(parseImportMapping(serializeImportMapping(mapping))).toEqual(mapping);
  });

  it('rejects an out-of-range cardCol the same way every other column index field is bounded', () => {
    const broken = { ...getBuiltinPreset('Amex Canada'), cardCol: 500 };
    expect(() => parseImportMapping(broken)).toThrow();
  });
});

describe('balanceCol back-compat (Task 3, spec 2026-08-23 v1.8.0)', () => {
  it('defaults balanceCol to null for a mapping stored before v1.8.0', () => {
    const stored = JSON.parse(serializeImportMapping(BUILTIN_PRESETS['TD Chequing/Debit'].mapping)) as Record<string, unknown>;
    delete stored.balanceCol;
    expect(parseImportMapping(stored).balanceCol).toBeNull();
  });

  it('carries balanceCol through a serialize/parse round trip', () => {
    const mapping = { ...BUILTIN_PRESETS['TD Chequing/Debit'].mapping, balanceCol: 4 };
    expect(parseImportMapping(serializeImportMapping(mapping)).balanceCol).toBe(4);
  });

  it('ships the TD Chequing/Debit preset with the balance column mapped', () => {
    expect(BUILTIN_PRESETS['TD Chequing/Debit'].mapping.balanceCol).toBe(4);
  });

  it('rejects an out-of-range balanceCol the same way every other column index field is bounded', () => {
    const broken = { ...getBuiltinPreset('TD Chequing/Debit'), balanceCol: 500 };
    expect(() => parseImportMapping(broken)).toThrow();
  });
});

describe('normalizeCardValue (MUST-2.4)', () => {
  it('trims, collapses internal whitespace runs to one space, and uppercases', () => {
    expect(normalizeCardValue('  alex   morgan ')).toBe('ALEX MORGAN');
  });

  it('handles the real Amex Account # suffix shape untouched by whitespace collapsing', () => {
    expect(normalizeCardValue('-1001')).toBe('-1001');
  });

  it('is idempotent — normalizing an already-normalized value is a no-op', () => {
    const once = normalizeCardValue('  Sam   Rivera ');
    expect(normalizeCardValue(once)).toBe(once);
  });

  it('collapses tabs and newlines along with doubled spaces', () => {
    expect(normalizeCardValue('alex\t\t\nmorgan')).toBe('ALEX MORGAN');
  });
});
