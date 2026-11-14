import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aiReceiptPoll, groundReceiptAnswer } from '@/lib/ai/receipt';
import { recordLocalAiFailure, saveLocalAiConfig, turnOffLocalAi } from '@/lib/ai/config';
import type { ReceiptAnswer } from '@/lib/ai/schemas';
import { writeAiSidecar, writeStagedReceipt } from '@/lib/warranty/staging';
import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';

/** v1.64.0 (plan 2026-11-12, A8 and L7). A receipt value is kept only where the receipt prints it. */
const TODAY = '2026-03-09';
const TEXT = [
  'MAPLE GROCER',
  '123 Example Street',
  'Date: 2026-03-08',
  'MILK 4.99',
  'SUBTOTAL 42.17',
  'TOTAL 47.32',
  'Payment due 2026-04-08',
  'Next statement 2027-10-15',
].join('\n');

const answer = (over: Partial<ReceiptAnswer>): ReceiptAnswer => ({ vendor: null, total: null, purchaseDate: null, dueDate: null, ...over });

describe('groundReceiptAnswer', () => {
  it('keeps a printed total and drops one that is not printed', () => {
    expect(groundReceiptAnswer(answer({ total: '47.32' }), TEXT, TODAY)).toEqual({ priceCents: 4732 });
    expect(groundReceiptAnswer(answer({ total: '100.00' }), TEXT, TODAY)).toEqual({});
    expect(groundReceiptAnswer(answer({ total: '0.00' }), 'TOTAL 0.00', TODAY)).toEqual({});
  });

  it('drops a date that is not printed, and keeps one that is', () => {
    expect(groundReceiptAnswer(answer({ purchaseDate: '2026-03-08' }), TEXT, TODAY)).toEqual({ purchaseDate: '2026-03-08' });
    expect(groundReceiptAnswer(answer({ purchaseDate: '2026-03-07' }), TEXT, TODAY)).toEqual({});
    expect(groundReceiptAnswer(answer({ purchaseDate: '2026-02-30' }), 'Date 2026-02-30', TODAY)).toEqual({});
  });

  it('keeps the windows the pattern reader uses: no purchase after today, no due date 19 months ahead', () => {
    expect(groundReceiptAnswer(answer({ dueDate: '2026-04-08' }), TEXT, TODAY)).toEqual({ dueDate: '2026-04-08' });
    expect(groundReceiptAnswer(answer({ dueDate: '2027-10-15' }), TEXT, TODAY)).toEqual({});
    expect(groundReceiptAnswer(answer({ purchaseDate: '2026-04-08' }), TEXT, TODAY)).toEqual({});
  });

  it('drops a vendor whose words are not in the text, and keeps one that shares a word, accents folded', () => {
    expect(groundReceiptAnswer(answer({ vendor: 'Maple Grocer' }), TEXT, TODAY)).toEqual({ vendor: 'Maple Grocer' });
    expect(groundReceiptAnswer(answer({ vendor: 'Fuel Stop' }), TEXT, TODAY)).toEqual({});
    expect(groundReceiptAnswer(answer({ vendor: 'Café Lumière' }), 'CAFE LUMIERE\nTOTAL 6.50', TODAY)).toEqual({ vendor: 'Café Lumière' });
    expect(groundReceiptAnswer(answer({ vendor: 'Ab' }), 'AB\nTOTAL 6.50', TODAY)).toEqual({});
  });

  it('keeps the other fields when one is dropped', () => {
    expect(
      groundReceiptAnswer(answer({ vendor: 'Maple Grocer', total: '99.99', purchaseDate: '2026-03-08', dueDate: '2026-04-08' }), TEXT, TODAY),
    ).toEqual({ vendor: 'Maple Grocer', purchaseDate: '2026-03-08', dueDate: '2026-04-08' });
  });
});

describe('aiReceiptPoll', () => {
  let t: TestDb;
  let dataDir: string;
  let originalDataDir: string | undefined;
  let alex: number;
  const at = new Date('2026-03-09T15:00:00.000Z');

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ai-receipt-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    t = createTestDb();
    alex = insertTestUser(t.db, { name: 'Alex', username: 'alex' });
  });

  afterEach(() => {
    t.cleanup();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('is off while the helper is off, not started before an answer, then the sidecar state', () => {
    const stagingId = writeStagedReceipt(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpeg', alex);
    expect(aiReceiptPoll(stagingId, at)).toEqual({ status: 'off' });

    saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId: alex, at });
    expect(aiReceiptPoll(stagingId, at)).toEqual({ status: 'not-started' });

    writeAiSidecar(stagingId, { status: 'done', fields: { vendor: 'Maple Grocer' }, at: at.toISOString() });
    expect(aiReceiptPoll(stagingId, at)).toEqual({ status: 'done', fields: { vendor: 'Maple Grocer' } });

    writeAiSidecar(stagingId, { status: 'failed', at: at.toISOString() });
    expect(aiReceiptPoll(stagingId, at)).toEqual({ status: 'failed' });

    recordLocalAiFailure(at, 'Could not reach the model server at 192.168.1.50:11434.');
    expect(aiReceiptPoll(stagingId, new Date('2026-03-09T15:04:00.000Z'))).toEqual({ status: 'off' });
    expect(aiReceiptPoll(stagingId, new Date('2026-03-09T15:05:00.000Z'))).toEqual({ status: 'failed' });

    turnOffLocalAi({ userId: alex, at });
    expect(aiReceiptPoll(stagingId, new Date('2026-03-09T16:00:00.000Z'))).toEqual({ status: 'off' });
  });
});
