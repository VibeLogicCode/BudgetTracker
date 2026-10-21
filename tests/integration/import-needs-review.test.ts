import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewQueueCount } from '@/lib/categorize/engine';
import { commitStagedImport } from '@/lib/import/flow';
import { getBuiltinPreset, getProfileByName } from '@/lib/import/presets';
import { writeStagedFile } from '@/lib/import/staging';
import { saveLoanRule } from '@/lib/loans';
import { setupLoanTest, type LoanTestContext } from '../lib/loans/fixtures';

/**
 * The import summary's "needs review" count is the review queue's own definition (REVIEW_WHERE),
 * counted after the loan matcher has linked payments, so a row the import linked to a loan is not
 * counted even though it has no category.
 */

const CSV =
  [
    '"2026-03-02","POS PURCHASE       CORNER BAKERY #12 TORONTO ON","4.85",,"1000.00"',
    '"2026-03-03","PRE-AUTH PAYMENT HONDA FIN PMT","412.00",,"588.00"',
  ].join('\n') + '\n';

let ctx: LoanTestContext | null = null;
let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-needs-review-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
  ctx?.t.cleanup();
  ctx = null;
});

function runImport() {
  ctx = setupLoanTest();
  const profileId = getProfileByName('TD Chequing/Debit')!.id;
  return {
    ctx,
    commit: () =>
      commitStagedImport({
        stagingId: writeStagedFile(Buffer.from(CSV)),
        filename: 'td.csv',
        accountId: ctx!.accountId,
        profileId,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
        userId: ctx!.userId,
      }),
  };
}

describe('import summary needsReview', () => {
  it('excludes a row the loan matcher linked from needsReview', () => {
    const { ctx: c, commit } = runImport();
    const { itemId } = c.seedLoan();
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });

    const result = commit();
    expect(result.rowsAdded).toBe(2);
    expect(result.loanLinksCreated).toBe(1);
    expect(result.needsReview).toBe(1);
    expect(result.needsReview).toBe(reviewQueueCount());
  });

  it('agrees with the review queue when no loan rule exists', () => {
    const { commit } = runImport();

    const result = commit();
    expect(result.loanLinksCreated).toBe(0);
    expect(result.needsReview).toBe(2);
    expect(result.needsReview).toBe(reviewQueueCount());
  });
});
