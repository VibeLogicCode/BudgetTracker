import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  IMPORT_CADENCE_OPTIONS,
  cadenceFormValue,
  cadenceLabel,
  cadenceSubtitle,
  cadenceWeeksFromForm,
  staleThresholdWeeks,
} from '@/lib/import/cadence';

/** Spec 2026-09-28 §2.2. One module owns the labels, the stored numbers and the one rule. */
describe('the cadence options', () => {
  it('offers exactly the six the spec names, in this order', () => {
    expect(IMPORT_CADENCE_OPTIONS.map((option) => [option.label, option.weeks])).toEqual([
      ['Household default', null],
      ['Weekly', 2],
      ['Every two weeks', 3],
      ['Monthly', 5],
      ['Yearly', 53],
      ['Never remind me', 0],
    ]);
  });

  /** The stored number is a threshold with a week of slack, so a statement a few days late does not nag. */
  it('stores one week more than the cadence named, except never', () => {
    const byLabel = new Map(IMPORT_CADENCE_OPTIONS.map((option) => [option.label, option.weeks]));
    expect(byLabel.get('Weekly')).toBe(1 + 1);
    expect(byLabel.get('Every two weeks')).toBe(2 + 1);
    expect(byLabel.get('Monthly')).toBe(4 + 1);
    expect(byLabel.get('Yearly')).toBe(52 + 1);
  });
});

describe('reading a form value', () => {
  it("'' is the household default and 0 is never -- both real answers, neither invalid", () => {
    expect(cadenceWeeksFromForm('')).toBeNull();
    expect(cadenceWeeksFromForm('0')).toBe(0);
    expect(cadenceWeeksFromForm('5')).toBe(5);
  });

  /** A value the select does not offer (written by SQL, or by another build) must still round-trip. */
  it('accepts any small non-negative integer, not only the offered ones', () => {
    expect(cadenceWeeksFromForm('7')).toBe(7);
  });

  it('rejects anything that is not one', () => {
    for (const bad of ['abc', '-1', '1.5', '1000', ' 5']) expect(cadenceWeeksFromForm(bad)).toBeUndefined();
  });

  it('round-trips through the form value', () => {
    for (const option of IMPORT_CADENCE_OPTIONS) {
      expect(cadenceWeeksFromForm(cadenceFormValue(option.weeks))).toBe(option.weeks);
    }
  });
});

describe('labels', () => {
  it('names an offered value by its label and an unoffered one by its number', () => {
    expect(cadenceLabel(5)).toBe('Monthly');
    expect(cadenceLabel(null)).toBe('Household default');
    expect(cadenceLabel(7)).toBe('Every 7 weeks');
  });

  it('gives the accounts page a subtitle word only when the account has its own cadence', () => {
    expect(cadenceSubtitle(null)).toBeNull();
    expect(cadenceSubtitle(0)).toBe('no import reminders');
    expect(cadenceSubtitle(5)).toBe('imported monthly');
    expect(cadenceSubtitle(3)).toBe('imported every two weeks');
  });
});

describe('the one rule', () => {
  it('uses the account value when set, the household value when not, and passes 0 through', () => {
    expect(staleThresholdWeeks(null, 3)).toBe(3);
    expect(staleThresholdWeeks(5, 3)).toBe(5);
    expect(staleThresholdWeeks(0, 3)).toBe(0);
  });
});

/** accounts-manager.tsx is 'use client' and value-imports this module (tests/ops/client-bundle.test.ts). */
describe('the module is pure', () => {
  it('imports nothing', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/import/cadence.ts'), 'utf8');
    expect(source).not.toMatch(/^import /m);
  });
});
