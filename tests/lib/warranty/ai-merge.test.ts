import { describe, it, expect } from 'vitest';
import { mergeAiReceiptFields } from '@/lib/warranty/ai-merge';

describe('mergeAiReceiptFields', () => {
  it('takes the AI vendor even when the pattern found one', () => {
    expect(mergeAiReceiptFields({ vendor: 'MAPLE' }, { vendor: 'Maple Grocer' })).toEqual({ vendor: 'Maple Grocer' });
  });
  it('keeps the pattern date, total and due date over the AI ones', () => {
    const pattern = { purchaseDate: '2026-03-01', priceCents: 1299, dueDate: '2026-03-20' };
    const ai = { purchaseDate: '2026-03-02', priceCents: 1300, dueDate: '2026-03-21' };
    expect(mergeAiReceiptFields(pattern, ai)).toEqual({});
  });
  it('fills each missing key from the AI', () => {
    const ai = { purchaseDate: '2026-03-02', priceCents: 1300, dueDate: '2026-03-21' };
    expect(mergeAiReceiptFields({}, ai)).toEqual(ai);
    expect(mergeAiReceiptFields({ priceCents: 5 }, ai)).toEqual({ purchaseDate: '2026-03-02', dueDate: '2026-03-21' });
  });
  it('is empty for empty inputs', () => {
    expect(mergeAiReceiptFields({}, {})).toEqual({});
    expect(mergeAiReceiptFields({ vendor: 'A', priceCents: 1 }, {})).toEqual({});
  });
});
