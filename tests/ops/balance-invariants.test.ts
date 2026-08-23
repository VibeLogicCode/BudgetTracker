import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/**
 * The repo's established stripComments pattern (see tests/ops/install.test.ts,
 * tests/ops/loan-invariants.test.ts): strips comments before scanning, so that a docblock which
 * MENTIONS a dangerous identifier in prose -- src/lib/balance.ts's own header docblock spells
 * out transactionSplits/isTransfer/EFFECTIVE_AMOUNT by name on purpose, to warn the next reader
 * -- cannot false-trip the guard sitting right next to it. Only CODE use of these identifiers
 * (an import, a property access, a join) should ever fail this test.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Ruling R1 (spec 2026-08-23, v1.8.0, Task 4): "the single most dangerous line in the release."
 * balanceAsOf/balancesAsOf (src/lib/balance.ts) sum transactions.amount_cents raw, off the
 * parent table, for a purpose (resolving an account's real-money balance) where the filters
 * that are CORRECT for spend reporting are catastrophically wrong: a credit-card payment marked
 * is_transfer=1 to keep it out of spend totals must still count here, or the card balance climbs
 * forever while looking entirely plausible; a split's parent amount_cents is the true movement,
 * so the splits table / EFFECTIVE_AMOUNT's split-aware coalesce must never enter this path.
 *
 * tests/lib/balance.test.ts pins the same ruling with behavioural fixtures (a transfer-flagged
 * payment, a split transaction). This is the second, independent guard: a plain grep, so a
 * future change that reintroduces either bug fails a test even when whatever fixture motivated
 * the change does not happen to cover it.
 */
describe('Ruling R1 (spec 2026-08-23 v1.8.0): the balance resolver reads raw transaction amounts', () => {
  it('src/lib/balance.ts never references transactionSplits, isTransfer, or EFFECTIVE_AMOUNT in code', () => {
    const source = stripComments(read('src/lib/balance.ts'));
    expect(/transactionSplits/.test(source)).toBe(false);
    expect(/isTransfer/.test(source)).toBe(false);
    expect(/EFFECTIVE_AMOUNT/.test(source)).toBe(false);
  });

  it('src/lib/balance.ts never imports a spend-aggregate helper from budgets.ts, reports.ts, or categorize/engine.ts', () => {
    const source = read('src/lib/balance.ts');
    expect(/from\s+['"]@\/lib\/budgets['"]/.test(source)).toBe(false);
    expect(/from\s+['"]@\/lib\/reports['"]/.test(source)).toBe(false);
    expect(/from\s+['"]@\/lib\/categorize\/engine['"]/.test(source)).toBe(false);
  });

  it('scanner correctness: a fixture that DOES reference the forbidden identifiers is caught', () => {
    // Same self-check discipline as tests/ops/use-server-exports.test.ts's synthetic fixtures --
    // proves this guard's own regex actually fires before trusting it to guard the real file.
    const offender = `
      import { transactionSplits } from '@/db/schema';
      export function balanceAsOf() { return transactionSplits; }
    `;
    expect(/transactionSplits/.test(stripComments(offender))).toBe(true);

    const commentOnly = `
      /**
       * Do not reintroduce transactionSplits, isTransfer or EFFECTIVE_AMOUNT here (ruling R1).
       */
      export function fine() { return 1; }
    `;
    expect(/transactionSplits|isTransfer|EFFECTIVE_AMOUNT/.test(stripComments(commentOnly))).toBe(false);
  });
});
