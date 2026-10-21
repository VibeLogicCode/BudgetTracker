import { describe, it, expect } from 'vitest';
import { budgetCardId, budgetsHref } from '@/lib/budgets-links';

describe('budgets-links (spec 2026-10-21, fix from Budgets §2.6)', () => {
  it('names a card by scope, person and category', () => {
    expect(budgetCardId('household', null, 12)).toBe('budget-card-household-h-12');
    expect(budgetCardId('personal', 7, 12)).toBe('budget-card-personal-7-12');
  });
  it('writes only what it was given', () => {
    expect(budgetsHref({ month: '2026-03', personId: 7, cardId: 'budget-card-personal-7-12' })).toBe('/budgets?month=2026-03&person=7#budget-card-personal-7-12');
    expect(budgetsHref({ month: '2026-03', personId: null, cardId: null })).toBe('/budgets?month=2026-03');
    expect(budgetsHref({ month: null, personId: null, cardId: 'budget-card-household-h-12' })).toBe('/budgets#budget-card-household-h-12');
    expect(budgetsHref({ month: null, personId: null, cardId: null })).toBe('/budgets');
  });
});
