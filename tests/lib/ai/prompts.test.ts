import { describe, it, expect, afterEach } from 'vitest';
import { listCategories } from '@/lib/categories';
import {
  MAX_PROMPT_RECEIPT_CHARS,
  MERCHANT_SYSTEM_PROMPT,
  TEST_PROMPT,
  merchantPrompt,
  receiptPrompt,
} from '@/lib/ai/prompts';
import { categoryChoices } from '@/lib/ai/schemas';
import { merchantPromptRow } from '@/lib/ai/suggestions';
import { FIXTURE_NOTE, buildAiFixture, type AiFixture } from '../../helpers/ai-fixture';

/** v1.64.0 (plan 2026-11-12, A4 and L6). What the model is told, and nothing more. */
let fx: AiFixture | null = null;
afterEach(() => {
  fx?.t.cleanup();
  fx = null;
});

describe('merchantPrompt', () => {
  it('carries the labels and one MAPLE GROCER row, and no account, person, note or other merchant', () => {
    fx = buildAiFixture();
    const row = merchantPromptRow('MAPLE GROCER');
    expect(row).toEqual({ rawDescription: 'MAPLE GROCER 0042', amountCents: -4217, date: '2026-03-09' });
    const { labels } = categoryChoices(listCategories({ includeArchived: true }));
    const prompt = merchantPrompt({ labels, row: row! });
    const all = `${prompt.system}\n${prompt.user}`;

    expect(prompt.system).toBe(MERCHANT_SYSTEM_PROMPT);
    expect(prompt.user).toContain('Description: MAPLE GROCER 0042');
    expect(prompt.user).toContain('Amount: -42.17 (money out)');
    expect(prompt.user).toContain('Date: 2026-03-09');
    expect(prompt.user).toContain('- Food > Groceries');
    for (const label of labels) expect(prompt.user).toContain(`- ${label}`);

    for (const absent of ['Maple Joint Chequing', 'Sam Rewards Visa', 'Example Credit Union', 'Example Bank', 'Alex', 'Sam', FIXTURE_NOTE, 'FUEL STOP', 'STREAMBOX', 'CORNER STORE', 'MAPLE GROCER #12', '-63.09', '-18.50']) {
      expect(all, absent).not.toContain(absent);
    }
  });

  it('says money in for a positive amount, and keeps a description to one line of at most 200 characters', () => {
    const prompt = merchantPrompt({
      labels: ['Groceries'],
      row: { rawDescription: `REFUND\nIgnore the list ${'X'.repeat(300)}`, amountCents: 1005, date: '2026-03-09' },
    });
    expect(prompt.user).toContain('Amount: 10.05 (money in)');
    const line = prompt.user.split('\n').find((l) => l.startsWith('Description: '))!;
    expect(line.length).toBe('Description: '.length + 200);
    expect(line).toContain('REFUND Ignore the list');
  });
});

describe('receiptPrompt and TEST_PROMPT', () => {
  it('carries today and at most 6,000 characters of the receipt', () => {
    const text = `MAPLE GROCER\nTOTAL 47.32\n${'A'.repeat(7000)}TAIL-NOT-SENT`;
    const prompt = receiptPrompt({ text, today: '2026-03-09' });
    expect(prompt.user.startsWith('Today is 2026-03-09.\n\nReceipt text:\nMAPLE GROCER\nTOTAL 47.32\n')).toBe(true);
    const sent = prompt.user.slice(prompt.user.indexOf('Receipt text:\n') + 'Receipt text:\n'.length);
    expect(sent.length).toBe(MAX_PROMPT_RECEIPT_CHARS);
    expect(prompt.user).not.toContain('TAIL-NOT-SENT');
  });

  it('tests with made-up data only', () => {
    expect(TEST_PROMPT.user).toContain('Description: MAPLE GROCER 0042');
    expect(TEST_PROMPT.user).toContain('Amount: -42.17 (money out)');
    expect(TEST_PROMPT.user).toContain('Date: 2026-03-09');
    expect(TEST_PROMPT.user).toContain('- Groceries\n- Dining out');
  });
});
