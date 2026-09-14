import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PRESETS, type BuiltinPresetName } from '@/lib/import/presets';
import { detectImportProfile, type ProfileCandidate } from '@/lib/import/detect-profile';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function fixture(name: string): Buffer {
  return fs.readFileSync(path.join(root, 'fixtures', name));
}

/**
 * The candidate list the import page would hand this: every ACTIVE profile with a readable
 * mapping. Built from the shipped presets rather than from a database so this file tests the
 * detector, not the profile table -- ids are stable and assigned here in list order.
 */
const NAMES: BuiltinPresetName[] = [
  'TD Chequing/Debit',
  'TD Visa',
  'Scotiabank Chequing/Debit',
  'Amex Canada',
  'RBC Chequing/Visa',
];

function candidates(only?: BuiltinPresetName[]): ProfileCandidate[] {
  return (only ?? NAMES).map((key, index) => ({
    id: index + 1,
    name: BUILTIN_PRESETS[key].name,
    mapping: BUILTIN_PRESETS[key].mapping,
  }));
}

function detect(file: string, only?: BuiltinPresetName[]) {
  return detectImportProfile({ buf: fixture(file), filename: file, candidates: candidates(only) });
}

/**
 * The detector answers one question -- "which of the profiles this household actually has can
 * READ this file?" -- by running each mapping over the file and counting what parses. It is
 * deliberately not a fingerprint table of bank layouts: presets.ts already describes every
 * layout once, and a second description of the same thing is the shape that drifts the first
 * time a bank changes its export.
 */
describe('detectImportProfile: the built-in presets against their own real exports', () => {
  it('reads a TD chequing export as TD Chequing/Debit', () => {
    const result = detect('td-chequing.csv');
    expect(result.profile?.name).toBe('TD Chequing/Debit');
    expect(result.confidence).toBe('certain');
  });

  it('reads a TD Visa export as TD Visa, not as its chequing sibling', () => {
    const result = detect('td-visa.csv');
    expect(result.profile?.name).toBe('TD Visa');
  });

  it('reads a Scotiabank export as Scotiabank', () => {
    expect(detect('scotia.csv').profile?.name).toBe('Scotiabank Chequing/Debit');
  });

  it('reads an Amex export as Amex Canada', () => {
    expect(detect('amex.csv').profile?.name).toBe('Amex Canada');
  });

  /**
   * The point of this fixture is its ENCODING -- windows-1252 accents in the merchant names --
   * not its layout: its dates are MM/DD/YYYY, so it is a TD Visa-shaped file despite the name,
   * and asserting the chequing preset here would be asserting something untrue about the file.
   * What matters is that every row is read: detection runs on decoded text, so a file full of
   * accented bytes must not score as unreadable and send the household hunting for a profile.
   */
  it('reads every row of a windows-1252 export -- detection runs after decoding, not before', () => {
    const result = detect('td-chequing-win1252.csv');
    expect(result.profile).not.toBeNull();
    expect(result.scores.find((s) => s.profileId === result.profile?.id)?.cleanRate).toBe(1);
  });
});

/**
 * Two presets can describe the same layout. CIBC Chequing/Visa is TD Chequing/Debit with no
 * balance column: same ISO dates, same four columns, same header-less shape -- so a TD export
 * parses perfectly under both and a clean-rate race between them is a dead heat. The tie-break is
 * which mapping EXPLAINS MORE of the file: TD reads column 4 as the running balance, CIBC leaves
 * it unaccounted for. A mapping that accounts for every column of a file is the better description
 * of that file, and it is the one whose preview will show the household more.
 */
describe('detectImportProfile: two presets describing one layout', () => {
  it('prefers the mapping that accounts for more of the file', () => {
    const result = detect('td-chequing.csv', ['TD Chequing/Debit', 'CIBC Chequing/Visa']);
    expect(result.profile?.name).toBe('TD Chequing/Debit');
  });

  it('still reports both as readable, so the runner-up is visible', () => {
    const result = detect('td-chequing.csv', ['TD Chequing/Debit', 'CIBC Chequing/Visa']);
    expect(result.scores.every((score) => score.cleanRate === 1)).toBe(true);
  });
});

describe('detectImportProfile: when it cannot tell', () => {
  /**
   * The two TD presets are the case the owner raised: two exports from one bank that look alike.
   * They are separable HERE (five columns and ISO dates vs four and MM/DD/YYYY) and the tests
   * above prove it -- but a file that no offered profile can read cleanly must say so rather
   * than hand back whichever scored least badly.
   */
  it('picks nothing when every offered profile chokes on the file', () => {
    const result = detect('amex.csv', ['TD Chequing/Debit', 'Scotiabank Chequing/Debit']);
    expect(result.profile).toBeNull();
    expect(result.confidence).toBe('none');
  });

  it('picks nothing from an empty candidate list', () => {
    const result = detectImportProfile({ buf: fixture('td-visa.csv'), filename: 'td-visa.csv', candidates: [] });
    expect(result.profile).toBeNull();
  });

  it('is unsure about a file with a high error rate, even when one profile fits its shape', () => {
    // mint-like-edge-cases.csv is TD-Visa-shaped on purpose and carries deliberately broken rows.
    // A shape match with a quarter of the rows unreadable is not a confident answer.
    const result = detect('mint-like-edge-cases.csv');
    expect(result.confidence).not.toBe('certain');
  });
});

describe('detectImportProfile: OFX and QFX', () => {
  it('needs no profile at all, and says so', () => {
    const buf = Buffer.from('OFXHEADER:100\n<OFX><BANKMSGSRSV1></BANKMSGSRSV1></OFX>', 'utf8');
    const result = detectImportProfile({ buf, filename: 'statement.ofx', candidates: candidates() });
    expect(result.profile).toBeNull();
    expect(result.source).toBe('ofx');
    expect(result.reason).toContain('names its own columns');
  });
});

describe('detectImportProfile: what it reports', () => {
  it('carries a reason naming the profile and how much of the file it read', () => {
    const result = detect('td-chequing.csv');
    expect(result.reason).toContain('TD Chequing/Debit');
    expect(result.reason).toMatch(/\d+ of \d+ rows/);
  });

  it('scores every candidate, so a caller can show the runners-up', () => {
    const result = detect('td-chequing.csv');
    expect(result.scores).toHaveLength(NAMES.length);
    const winner = result.scores.find((s) => s.name === 'TD Chequing/Debit');
    expect(winner?.cleanRate).toBe(1);
  });
});
