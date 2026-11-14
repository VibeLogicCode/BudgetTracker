import { describe, it, expect } from 'vitest';
import { effectivePartPerson, partPeople, splitPersonOf } from '@/lib/split-person';

/**
 * v1.63.0 (plan 2026-11-12, Lane A, A2). The pure half of a part's person, for screens that must
 * not reach @/db. ALEX and SAM are user ids; NULL is Household, as on transactions.
 */
const ALEX = 3;
const SAM = 4;

describe('effectivePartPerson', () => {
  it('a part that follows belongs to whoever the transaction belongs to', () => {
    expect(effectivePartPerson({ personSet: false, attributedUserId: null }, ALEX)).toBe(ALEX);
    expect(effectivePartPerson({ personSet: false, attributedUserId: null }, null)).toBeNull();
  });

  it('a part set to someone belongs to them, whoever the transaction belongs to', () => {
    expect(effectivePartPerson({ personSet: true, attributedUserId: SAM }, ALEX)).toBe(SAM);
    expect(effectivePartPerson({ personSet: true, attributedUserId: SAM }, null)).toBe(SAM);
  });

  it('a part set to Household is Household, not the transaction person', () => {
    expect(effectivePartPerson({ personSet: true, attributedUserId: null }, ALEX)).toBeNull();
  });

  it('a part read before 0032 (no person fields) follows', () => {
    expect(effectivePartPerson({}, ALEX)).toBe(ALEX);
  });
});

describe('partPeople', () => {
  it('lists each effective person once, in part order', () => {
    const parts = [
      { personSet: false, attributedUserId: null },
      { personSet: true, attributedUserId: SAM },
      { personSet: true, attributedUserId: null },
      { personSet: true, attributedUserId: ALEX },
      { personSet: true, attributedUserId: SAM },
    ];
    expect(partPeople(parts, ALEX)).toEqual([ALEX, SAM, null]);
  });

  it('is one person when every part follows', () => {
    expect(partPeople([{ personSet: false }, { personSet: false }], SAM)).toEqual([SAM]);
  });

  it('is empty for no parts', () => {
    expect(partPeople([], ALEX)).toEqual([]);
  });
});

describe('splitPersonOf', () => {
  it('reads a stored part back as the editor choice that wrote it', () => {
    expect(splitPersonOf({ personSet: false, attributedUserId: null })).toBe('follow');
    expect(splitPersonOf({ personSet: true, attributedUserId: null })).toBe('household');
    expect(splitPersonOf({ personSet: true, attributedUserId: SAM })).toBe(SAM);
    expect(splitPersonOf({})).toBe('follow');
  });
});
