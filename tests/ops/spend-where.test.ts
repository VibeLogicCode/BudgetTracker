import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/** Same walk() shape as tests/ops/client-bundle.test.ts, scoped to src/lib per this guard's brief. */
function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

/** Same comment-stripping helper as tests/ops/client-bundle.test.ts, so a match inside a
 *  docblock or a `//` comment (e.g. this guard's own file, quoting the literal in prose) is
 *  never counted as a real occurrence. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * C-02 (Task 1): the literal `eq(transactions.isTransfer, false)` may appear under src/lib/ only
 * in spend-where.ts (NOT_TRANSFER's own definition) or in a file on this allowlist. Everywhere
 * else, "is this row spend" means the WHOLE rule -- transfers AND loan-principal movements --
 * via `SPEND_ROW_WHERE`, not transfers alone; the literal a bare filter is exactly the shape of
 * the bug this task fixes (see spend-where.ts's own docblock for the measured defect).
 *
 * Structured as an INVERTED denylist, not the report's original "ban the literal everywhere"
 * design: 14 of the 20 occurrences under src/lib/ found while writing this guard are legitimate
 * "does this household have any data at all" probes or eligibility/review-queue checks, not
 * money aggregates, and a flat ban would have failed on every one of them. Each entry names the
 * ONE sentence that makes it not a money aggregate, so a reviewer can check the reasoning
 * without re-deriving it, and so a NEW bare occurrence must be justified the same way or fixed.
 */
const ALLOWED_BARE_TRANSFER_FILTERS: Record<string, string> = {
  'src/lib/tax.ts': "taxYears() asks whether a year has any data at all, not what was spent in it",
  'src/lib/predict/history.ts': 'firstDataMonth() is the same kind of has-any-data probe',
  'src/lib/categorize/engine.ts': 'ELIGIBLE/REVIEW_WHERE gate the review queue and auto-categorisation eligibility, not a money total',
  'src/lib/import/flow.ts': 'the import flow reads whether a row is a transfer to route it, not to sum spend',
  'src/lib/loans.ts': 'a loan/warranty read keyed on transfer status, not a spend or income aggregate',
  'src/lib/transactions.ts': 'listTransactions\' transferView filter and duplicate-merchant lookup are row filters/lookups, not money aggregates',
};

const BARE_TRANSFER_FILTER = /eq\(\s*transactions\.isTransfer\s*,\s*false\s*\)/g;

describe('a bare `eq(transactions.isTransfer, false)` never substitutes for SPEND_ROW_WHERE in a money aggregate (C-02)', () => {
  const files = walk('src/lib');
  const countsByFile = new Map<string, number>();
  for (const file of files) {
    const source = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const matches = source.match(BARE_TRANSFER_FILTER);
    if (matches && matches.length > 0) countsByFile.set(file, matches.length);
  }

  it('finds at least the known occurrences (a scan that matches nothing proves nothing)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(countsByFile.size).toBeGreaterThanOrEqual(Object.keys(ALLOWED_BARE_TRANSFER_FILTERS).length + 1);
    expect(countsByFile.get('src/lib/spend-where.ts')).toBe(1);
  });

  it('appears only in spend-where.ts or an allowlisted file, each with a stated reason', () => {
    const offenders: string[] = [];
    for (const [file, count] of countsByFile) {
      if (file === 'src/lib/spend-where.ts') continue;
      if (Object.prototype.hasOwnProperty.call(ALLOWED_BARE_TRANSFER_FILTERS, file)) continue;
      offenders.push(
        `${file} (${count} occurrence${count === 1 ? '' : 's'}): a money aggregate composes SPEND_ROW_WHERE from ` +
          '@/lib/spend-where; if this is not a money aggregate, add it to ALLOWED_BARE_TRANSFER_FILTERS with a reason.',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry still names a file that actually exists under src/lib', () => {
    for (const file of Object.keys(ALLOWED_BARE_TRANSFER_FILTERS)) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} is allowlisted but no longer exists`).toBe(true);
    }
  });
});
