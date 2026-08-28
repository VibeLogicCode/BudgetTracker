import { describe, it, expect } from 'vitest';
import { canActOnOwner, isSelfScoped, ownerScope, NOT_YOURS_ERROR, type Viewer } from '@/lib/auth/viewer';

const household: Viewer = { id: 2, role: 'member', visibility: 'household' };
const child: Viewer = { id: 5, role: 'member', visibility: 'self' };
const admin: Viewer = { id: 1, role: 'admin', visibility: 'household' };
/** Unreachable through the UI (micro-ruling M1) -- pinned so a hand-edited row cannot lock an admin out. */
const adminSelf: Viewer = { id: 1, role: 'admin', visibility: 'self' };

describe('ownerScope (ruling R2)', () => {
  it('is null for a household member and for an admin', () => {
    expect(ownerScope(household)).toBeNull();
    expect(ownerScope(admin)).toBeNull();
  });

  it('is the viewer id for a self-scoped member', () => {
    expect(ownerScope(child)).toBe(5);
  });

  it('is null for an admin even when the row says self (micro-ruling M1)', () => {
    expect(ownerScope(adminSelf)).toBeNull();
  });

  it('isSelfScoped agrees with ownerScope in every case', () => {
    for (const viewer of [household, child, admin, adminSelf]) {
      expect(isSelfScoped(viewer)).toBe(ownerScope(viewer) !== null);
    }
  });
});

describe('canActOnOwner (ruling R3)', () => {
  it('lets a member act on their own rows and on shared rows', () => {
    expect(canActOnOwner(2, household)).toBe(true);
    expect(canActOnOwner(null, household)).toBe(true);
  });

  it('refuses a member acting on someone else', () => {
    expect(canActOnOwner(7, household)).toBe(false);
  });

  it('lets an admin act on anyone', () => {
    expect(canActOnOwner(7, admin)).toBe(true);
  });

  it('names no person in the refusal wording', () => {
    expect(NOT_YOURS_ERROR).toBe('That belongs to someone else in the household.');
  });
});
