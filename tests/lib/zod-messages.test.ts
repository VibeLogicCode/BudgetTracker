import { describe, it, expect } from 'vitest';
import { createAccountSchema } from '@/lib/accounts';
import { createPersonSchema, createUserSchema } from '@/lib/auth/users';
import { contributionSchema, createGoalSchema } from '@/lib/goals';
import { importMappingSchema } from '@/lib/import/mapping';
import { PROFILES_PACK_FORMAT, RULES_PACK_FORMAT, parseProfilesPack, parseRulesPack } from '@/lib/packs';
import { manualTransactionSchema } from '@/lib/transactions';
import { warrantyInputSchema } from '@/lib/warranty/items';
import { itemKindSchema } from '@/lib/warranty/types';

/**
 * v1.60.1. The messages the app's own exported schemas give, as zod 3.25.76 printed them. This
 * file imports no zod itself, so it checks what the lib modules really parse with. Every
 * expectation is a literal copied from zod 3's output.
 */
type Parsed = { success: boolean; error?: { issues: ReadonlyArray<{ message: string }> } };

function first(result: Parsed): string {
  if (result.success) throw new Error('expected a refusal');
  return result.error?.issues[0]?.message ?? '';
}

function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a throw');
}

describe('createAccountSchema', () => {
  const account = (over: Record<string, unknown> = {}) => ({
    name: 'Joint Chequing',
    institution: 'Maple Credit Union',
    type: 'chequing',
    ownerUserId: null,
    ...over,
  });

  it('accepts the base input', () => {
    expect(createAccountSchema.safeParse(account()).success).toBe(true);
  });

  it('refuses each field with zod 3 wording', () => {
    expect(first(createAccountSchema.safeParse(account({ name: 'a'.repeat(81) })))).toBe('String must contain at most 80 character(s)');
    expect(first(createAccountSchema.safeParse(account({ type: 'loan' })))).toBe(
      "Invalid enum value. Expected 'chequing' | 'credit' | 'cash' | 'savings' | 'asset', received 'loan'",
    );
    expect(first(createAccountSchema.safeParse(account({ ownerUserId: 0 })))).toBe('Number must be greater than 0');
  });
});

describe('createUserSchema and createPersonSchema', () => {
  it('refuses an unknown role and a missing username', () => {
    const user = { name: 'Alex', username: 'alex', password: 'long-enough-passphrase', role: 'root' };
    expect(first(createUserSchema.safeParse(user))).toBe("Invalid enum value. Expected 'admin' | 'member', received 'root'");
    expect(first(createPersonSchema.safeParse({ name: 'Sam' }))).toBe('Required');
  });
});

describe('createGoalSchema and contributionSchema', () => {
  it('refuses a fractional target, a zero goal id and a long note', () => {
    const goal = { name: 'Holiday', ownerUserId: null, targetCents: 1.5, targetDate: null };
    expect(first(createGoalSchema.safeParse(goal))).toBe('Expected integer, received float');
    const contribution = { goalId: 1, amountCents: 5000, date: '2026-03-15', note: null };
    expect(contributionSchema.safeParse(contribution).success).toBe(true);
    expect(first(contributionSchema.safeParse({ ...contribution, goalId: 0 }))).toBe('Number must be greater than 0');
    expect(first(contributionSchema.safeParse({ ...contribution, note: 'n'.repeat(201) }))).toBe(
      'String must contain at most 200 character(s)',
    );
  });
});

describe('manualTransactionSchema', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    accountId: 1,
    date: '2026-03-15',
    description: 'MAPLE GROCER',
    amountCents: -1234,
    categoryId: null,
    attributedUserId: null,
    notes: null,
    ...over,
  });

  it('refuses a long description and a fractional amount', () => {
    expect(manualTransactionSchema.safeParse(entry()).success).toBe(true);
    expect(first(manualTransactionSchema.safeParse(entry({ description: 'd'.repeat(301) })))).toBe(
      'String must contain at most 300 character(s)',
    );
    expect(first(manualTransactionSchema.safeParse(entry({ amountCents: 1.5 })))).toBe('Expected integer, received float');
  });
});

describe('itemKindSchema', () => {
  it('lists every kind when it refuses one', () => {
    expect(first(itemKindSchema.safeParse('boat'))).toBe(
      "Invalid enum value. Expected 'warranty' | 'subscription' | 'contract' | 'loan' | 'bill', received 'boat'",
    );
  });
});

describe('importMappingSchema', () => {
  const mapping = (over: Record<string, unknown> = {}) => ({
    hasHeader: true,
    headerRows: 1,
    dateCol: 0,
    dateFormat: 'YYYY-MM-DD',
    descCols: [1],
    amountMode: 'signed',
    amountCol: 2,
    debitCol: null,
    creditCol: null,
    signConvention: 'negative_is_spend',
    encoding: 'auto',
    skipRules: null,
    ...over,
  });

  it('refuses each field with zod 3 wording', () => {
    expect(importMappingSchema.safeParse(mapping()).success).toBe(true);
    expect(first(importMappingSchema.safeParse(mapping({ headerRows: 21 })))).toBe('Number must be less than or equal to 20');
    expect(first(importMappingSchema.safeParse(mapping({ descCols: [] })))).toBe('Array must contain at least 1 element(s)');
    expect(first(importMappingSchema.safeParse(mapping({ amountMode: 'x' })))).toBe(
      "Invalid enum value. Expected 'signed' | 'debit_credit', received 'x'",
    );
    expect(first(importMappingSchema.safeParse(mapping({ hasHeader: undefined })))).toBe('Required');
    expect(first(importMappingSchema.safeParse(mapping({ amountCol: null })))).toBe('amountCol is required when amountMode is "signed"');
  });
});

describe('warrantyInputSchema', () => {
  const schema = () => warrantyInputSchema('2026-03-15');
  const item = (over: Record<string, unknown> = {}) => ({
    name: 'Fridge',
    vendor: 'Maple Appliances',
    model: null,
    serial: null,
    purchaseDate: '2026-03-01',
    warrantyMonths: 24,
    isLifetime: false,
    priceCents: 129999,
    ownerUserId: 1,
    transactionId: null,
    typeId: null,
    notes: null,
    ...over,
  });

  it('refuses each field with zod 3 wording or the message the code wrote', () => {
    expect(schema().safeParse(item()).success).toBe(true);
    expect(first(schema().safeParse(item({ name: 'n'.repeat(201) })))).toBe('String must contain at most 200 character(s)');
    expect(first(schema().safeParse(item({ vendor: 'v'.repeat(201) })))).toBe('String must contain at most 200 character(s)');
    expect(first(schema().safeParse(item({ interestRateBps: -1 })))).toBe('Number must be greater than or equal to 0');
    expect(first(schema().safeParse(item({ postingDay: 0 })))).toBe('Number must be greater than or equal to 1');
    expect(first(schema().safeParse(item({ billingCycle: 'weekly' })))).toBe('Billing must be Monthly or Annual.');
    expect(first(schema().safeParse(item({ billingCycle: 5 })))).toBe('Billing must be Monthly or Annual.');
    expect(first(schema().safeParse(item({ loanDirection: 'x' })))).toBe("Invalid enum value. Expected 'owed' | 'lent', received 'x'");
  });

  it('stores a blank vendor as null', () => {
    const parsed = schema().safeParse(item({ vendor: '  ' }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.vendor).toBeNull();
  });
});

describe('pack parsing', () => {
  it('names the first issue in the malformed-pack sentence', () => {
    expect(thrown(() => parseRulesPack({ format: RULES_PACK_FORMAT, version: 1, categories: [{ name: '' }], rules: [] }))).toBe(
      'This rules pack is malformed: String must contain at least 1 character(s).',
    );
    const noDateCol = {
      hasHeader: true,
      headerRows: 1,
      dateFormat: 'YYYY-MM-DD',
      descCols: [1],
      amountMode: 'signed',
      amountCol: 2,
      debitCol: null,
      creditCol: null,
      signConvention: 'negative_is_spend',
      encoding: 'auto',
      skipRules: null,
    };
    const profiles = { format: PROFILES_PACK_FORMAT, version: 1, profiles: [{ name: 'Maple CU', institution: 'Maple Credit Union', mapping: noDateCol }] };
    expect(thrown(() => parseProfilesPack(profiles))).toBe('This profiles pack is malformed: Required.');
  });
});
