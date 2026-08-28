import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

function srcFiles(dir = path.join(root, 'src'), acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) srcFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * The repo's established stripComments pattern (see tests/ops/install.test.ts), so a docblock
 * that MENTIONS `tx.delete(transactions)` in prose -- loans.ts's own reverseLoanLinksForTransactions
 * comment does exactly that -- can't false-trip this scan into reporting a second delete site.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('MUST-13.16: exactly one place deletes a transaction row', () => {
  it('is undoImport, which must reverse the loan links first', () => {
    const sites = srcFiles()
      .filter((file) => /(?<![.\w])tx\.delete\(transactions\)/.test(stripComments(fs.readFileSync(file, 'utf8'))))
      .map((file) => path.relative(root, file).replace(/\\/g, '/'));
    expect(
      sites,
      'A second transaction-delete path must call reverseLoanLinksForTransactions() BEFORE the delete: the ON DELETE CASCADE removes the link rows, but a cascade cannot restore a balance.',
    ).toEqual(['src/lib/import/commit.ts']);

    const commit = read('src/lib/import/commit.ts');
    expect(commit.indexOf('reverseLoanLinksForTransactions')).toBeLessThan(commit.indexOf('tx.delete(transactions)'));
  });
});

describe('ruling P4: one helper owns the sign flip', () => {
  it('src/lib/loans.ts never spells the direction value itself', () => {
    // Every sign decision goes through loanSignedDelta/isLoanRepayment (src/lib/warranty/
    // constants.ts), and every partition tests === 'owed'. A literal 'lent' in this file is a
    // second place the convention lives, which is how the two drift apart.
    const offenders = read('src/lib/loans.ts')
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter((entry) => /'lent'|"lent"/.test(entry.line));
    expect(offenders).toEqual([]);
  });
});

describe('MUST-13.1: the interest rate is display only', () => {
  it('no arithmetic operator is ever applied to interestRateBps in src/lib/loans.ts', () => {
    const offenders = read('src/lib/loans.ts')
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter((entry) => !entry.line.startsWith('//') && !entry.line.startsWith('*'))
      .filter((entry) => /interestRateBps\s*[*/+-]|[*/+-]\s*interestRateBps/.test(entry.line));
    expect(offenders).toEqual([]);
  });
});

describe('MUST-13.2: loan payments are invisible to every spend calculation', () => {
  it('budgets, reports and the categorizer never read the link table', () => {
    for (const file of ['src/lib/budgets.ts', 'src/lib/reports.ts', 'src/lib/categorize/engine.ts']) {
      const source = read(file);
      expect({ file, hit: /loan_payments|loanPayments/.test(source) }).toEqual({ file, hit: false });
    }
  });
});

describe('ruling B10: applyLoanMatchers was renamed, not aliased', () => {
  it('the old name is never CODE in src/ -- no import, call, export or wrapper assignment', () => {
    // v1.12.0 renamed applyLoanMatchers to applyPaymentMatchers because it now matches bills
    // too and the old name would be a lie. This repo deletes superseded helpers rather than
    // keeping wrappers -- KIND_WORDING superseding the four boolean label helpers is the
    // precedent. A re-added alias is the obvious "kind" thing to do for a caller you did not
    // notice, and it is exactly what must not happen: two names for one function is two places
    // to read before you know what runs.
    //
    // stripComments (defined above for MUST-13.16, same reason here) keeps this from flagging
    // src/db/schema.ts and src/lib/loans.ts, which each keep one docblock mention of the old
    // name narrating WHY the rename happened -- prose that explains a ruling is not a second
    // definition of the thing the ruling forbids.
    const offenders = srcFiles()
      .filter((file) => /\bapplyLoanMatchers\b/.test(stripComments(fs.readFileSync(file, 'utf8'))))
      .map((file) => path.relative(root, file).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });

  it('finds the new name, so the check above cannot pass vacuously', () => {
    const users = srcFiles()
      .filter((file) => /\bapplyPaymentMatchers\b/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file).replace(/\\/g, '/'));
    // The definition plus its five call sites plus the two client-side comments that name it.
    expect(users).toContain('src/lib/loans.ts');
    expect(users.length).toBeGreaterThanOrEqual(6);
  });

  it('the loan_matcher_rules TABLE keeps its name, and the schema says why out loud', () => {
    // The other half of ruling B10: the function name was free to change and a shipped table
    // name is not. A future session reading only the rename would reasonably assume the table
    // was renamed too.
    const schema = read('src/db/schema.ts');
    expect(schema).toMatch(/sqliteTable\(\r?\n\s*'loan_matcher_rules'/);
    expect(schema).toMatch(/bill-kind items/i);
  });
});
