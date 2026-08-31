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
  it('budgets and reports never read the link table at all', () => {
    for (const file of ['src/lib/budgets.ts', 'src/lib/reports.ts']) {
      const source = read(file);
      expect({ file, hit: /loan_payments|loanPayments/.test(source) }).toEqual({ file, hit: false });
    }
  });

  /**
   * engine.ts is a special case, and narrowing this rather than banning the name outright is a
   * deliberate call made in v1.20.0 -- recorded here because loosening an invariant deserves an
   * argument, not a silent edit.
   *
   * What MUST-13.2 protects is that money moving to or from a loan still counts as ordinary
   * spending: a car payment belongs in the Transport budget and in the reports, and no code may
   * quietly filter it out on the grounds that it also repays a loan. budgets.ts and reports.ts
   * are exactly where that could go wrong, so for them the ban stays absolute.
   *
   * engine.ts holds TWO unrelated things in one file: the categorizer, which is a spend
   * calculation and must never see this table, and REVIEW_WHERE, which is the definition of the
   * "needs review" triage queue and is not a calculation at all -- it decides which rows still
   * need a person's attention. v1.20.0 added a clause there so that a transaction someone has
   * already assigned to a loan stops reappearing in that queue, which was the reported bug. That
   * clause touches no category, no amount and no transfer flag; it cannot move a dollar into or
   * out of any budget or report.
   *
   * A file-wide grep cannot tell those two halves apart, so it is made position-aware instead:
   * inside REVIEW_WHERE the reference is allowed, anywhere else in the file it is still a
   * failure. The rejected alternative was moving the SQL fragment into another module so the
   * literal name disappears from this file -- that would turn the guard green while changing
   * nothing about what engine.ts does, which is dressing up the check rather than passing it.
   */
  it('the categorizer reads the link table only inside REVIEW_WHERE, never anywhere else', () => {
    const source = read('src/lib/categorize/engine.ts');
    const start = source.indexOf('export const REVIEW_WHERE');
    expect(start).toBeGreaterThan(-1);
    // The definition ends at the first line that closes it at column 0 -- the same "top-level
    // declaration ends where the indentation returns" shape the rest of this file's greps use.
    const end = source.indexOf('\n);', start);
    expect(end).toBeGreaterThan(start);

    const inside = source.slice(start, end);
    // Two exemptions, both for lines that cannot read a table. The import: a symbol has to be
    // named to be used at all, and banning it there would only force an inline
    // `sql.raw('loan_payments')` that no tooling could follow. And comments: the clause below
    // explains itself in prose, and a rule that forbids DESCRIBING the code it governs makes the
    // code less clear, not safer -- MUST-13.1 above filters comment lines for the same reason.
    // What is left, and what this guard actually asserts, is that no executable line outside
    // REVIEW_WHERE reads the table.
    const outside = (source.slice(0, start) + source.slice(end))
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !/^import\b/.test(trimmed) && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
      })
      .join('\n');

    expect({ where: 'inside REVIEW_WHERE', hit: /loan_payments|loanPayments/.test(inside) })
      .toEqual({ where: 'inside REVIEW_WHERE', hit: true });
    expect({ where: 'elsewhere in engine.ts', hit: /loan_payments|loanPayments/.test(outside) })
      .toEqual({ where: 'elsewhere in engine.ts', hit: false });
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
