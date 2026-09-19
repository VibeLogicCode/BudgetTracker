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

/**
 * MUST-13.1 IS RETIRED, and this block is what replaces it.
 *
 * The old rule was "the interest rate is display only", held by a regex forbidding any arithmetic
 * on interestRateBps anywhere in src/lib/loans.ts. v1.47.0 computes interest, so that rule had to
 * go -- but the reason it existed did not. What it was really protecting was that a rate with no
 * stated period cannot be multiplied by anything without inventing the period, and that a figure
 * the app cannot stand behind must not be presented as though it could.
 *
 * MUST-13.1' says the same thing in the shape the feature now needs:
 *   interest is DERIVED, never stored; computed only in src/lib/loans/interest.ts; and shown only
 *   for a loan whose basis a person has set.
 *
 * WHAT THESE GUARDS DELIBERATELY DO NOT CATCH: whether the arithmetic is CORRECT. That is
 * tests/lib/loans/interest.test.ts and interest-simulation.test.ts, where every figure is
 * hand-computed. These four are about where the arithmetic is allowed to live.
 */
describe("MUST-13.1' G1: the rate is multiplied in exactly two places", () => {
  it('only interest.ts and the form boundary do arithmetic on the rate', () => {
    const offenders = srcFiles()
      .filter((file) => {
        const relative = path.relative(root, file).replace(/\\/g, '/');
        if (relative === 'src/lib/loans/interest.ts') return false;
        // readInterestRateBps parses a typed percentage into basis points. That is a unit
        // conversion at the edge, not an interest calculation.
        if (relative === 'src/app/(app)/warranties/actions.ts') return false;
        // formatRateBps: the single display division, which exists precisely so this guard has
        // one result to allow instead of three scattered through components.
        if (relative === 'src/lib/money.ts') return false;
        return true;
      })
      .flatMap((file) => {
        const relative = path.relative(root, file).replace(/\\/g, '/');
        return stripComments(fs.readFileSync(file, 'utf8'))
          .split('\n')
          .map((line, index) => ({ file: relative, line: line.trim(), number: index + 1 }))
          .filter((entry) => /interestRateBps\s*[*/+-]|[*/+-]\s*interestRateBps|interest_rate_bps\s*[*/+-]/.test(entry.line));
      });
    expect(offenders).toEqual([]);
  });
});

describe("MUST-13.1' G2: the engine stays pure", () => {
  const engine = () => read('src/lib/loans/interest.ts');

  /** It is handed its inputs. A module that can reach the database can be asked to store a result. */
  it('reaches no database', () => {
    // stripComments, because the module's own docblock EXPLAINS that it imports nothing from
    // '@/db' -- punishing a file for documenting the rule is how the documentation gets deleted.
    expect(stripComments(engine())).not.toMatch(/@\/db|getDb/);
  });

  /**
   * It is handed "today" too. A pure function of its inputs is one a test can pin to a hand-computed
   * figure, which is the only reason those figures mean anything.
   */
  it('reads no clock', () => {
    // `new Date(iso)` with an argument is pure -- it is how a date string is parsed. What is banned
    // is asking the environment what time it is now.
    expect(stripComments(engine())).not.toMatch(/new Date\(\)|Date\.now\(|todayIso\(/);
  });

  /**
   * Ruling P4, unchanged: the caller re-signs into the loan's frame with loanSignedDelta before
   * anything arrives, so the engine never learns which way a loan points. A direction literal here
   * would be a second place that convention lives.
   */
  it('never spells the direction', () => {
    expect(stripComments(engine())).not.toMatch(/'lent'|"lent"/);
  });
});

describe("MUST-13.1' G3: interest never becomes a writer", () => {
  /**
   * Nothing may write a balance from an ESTIMATE. The permitted writers are the five that existed
   * before v1.47.0, plus setLoanAnchor (the single human-balance writer, ruling R2) and
   * postDueInterest (v1.48.0, ledger spec P2).
   *
   * postDueInterest is allowed for the reason this release exists: what it adds to the balance has
   * stopped being an estimate. It is a row in loan_postings, written once for a period that has
   * closed, and the balance is recovered by replaying those rows rather than by re-deriving
   * anything. The check below holds it to that -- it must recomputeBalance and write what came
   * back, never a figure of its own.
   *
   * An eighth writer would mean something had gone back to storing a derived number.
   */
  it('the balance writers are the known five, setLoanAnchor and postDueInterest', () => {
    const source = stripComments(read('src/lib/loans.ts'));
    // link, recomputeLoanBalance, unassignTransactionFromLoan, reverseLoanLinksForTransactions,
    // setLoanAnchor, postDueInterest.
    const writes = source.split('.set({ currentBalanceCents').length - 1;
    expect(writes).toBe(6);
    expect(source).toContain('export function setLoanAnchor');
    expect(source).toContain('export function postDueInterest');
  });

  /** The posting path stores what the replay returned, never a figure it worked out itself. */
  it('postDueInterest writes only what recomputeBalance handed back', () => {
    const source = stripComments(read('src/lib/loans.ts'));
    const body = source.slice(source.indexOf('export function postDueInterest'));
    const fn = body.slice(0, body.indexOf('\nexport '));
    expect(fn).toContain('recomputeBalance(tx, itemId');
    expect(fn).toContain('.set({ currentBalanceCents: balance })');
    // No arithmetic on the way into the column.
    expect(/currentBalanceCents:\s*[^b]/.test(fn.replace('currentBalanceCents: balance', ''))).toBe(false);
  });

  /** The engine never learns the column exists. */
  it('the ledger engine never mentions a stored balance at all', () => {
    const engine = read('src/lib/loans/ledger.ts');
    for (const forbidden of ['currentBalanceCents', 'current_balance_cents', 'warrantyItems']) {
      expect({ forbidden, present: engine.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  /** Ruling I15: the payment is the spend; counting interest inside it would double-count. */
  it('interest never reaches a category, a budget or a transaction', () => {
    const engine = read('src/lib/loans/interest.ts');
    for (const forbidden of ['categories', 'budgets', 'transactions', 'Fees > Interest']) {
      expect({ forbidden, present: engine.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });
});

describe("MUST-13.1' G4: the copy no longer claims the app does no interest maths", () => {
  /**
   * Five places said so in as many words, and a stale docblock is treated as a defect in this
   * repo. They were rewritten in the same commit that made them false.
   */
  it('nothing still says the rate is display only', () => {
    /*
      The specific stale sentences, not every use of the words "display only" -- a receipt's stored
      filename and the payoff fraction are both display-only and always were, so a blanket scan
      would force those comments to be reworded for no reason and would go on doing it forever.
    */
    const claims: [file: string, claim: RegExp][] = [
      ['src/db/schema.ts', /interest_rate_bps is DISPLAY ONLY/],
      ['src/lib/loans.ts', /MUST-13\.1: interest_rate_bps is DISPLAY ONLY/],
      ['src/lib/warranty/items.ts', /interestRateBps is basis points and is DISPLAY ONLY/],
      ['src/app/(app)/warranties/[id]/warranty-detail-client.tsx', /does no interest math/],
      ['src/app/(app)/warranties/new/new-warranty-client.tsx', /does no interest math/],
    ];
    for (const [file, claim] of claims) {
      expect({ file, stale: claim.test(read(file)) }).toEqual({ file, stale: false });
    }
  });
});

describe('MUST-13.2: loan payments are invisible to every spend calculation', () => {
  it('budgets never reads the link table at all', () => {
    const source = read('src/lib/budgets.ts');
    expect({ file: 'src/lib/budgets.ts', hit: /loan_payments|loanPayments/.test(source) }).toEqual({
      file: 'src/lib/budgets.ts',
      hit: false,
    });
  });

  /**
   * v1.21.0 (2026-08-30 plan, item 8a; revised the next day after a coordinator review flagged
   * the FIRST version) narrowed reports.ts from an absolute ban to a SECOND position-aware
   * carve-out -- the same shape engine.ts's REVIEW_WHERE exemption just below already uses, and
   * for the same reason: a flat grep cannot tell "quietly filtering a car payment out of spend"
   * from "correctly excluding a loan disbursement that was never spend to begin with", so the
   * position has to carry the distinction a plain string match cannot.
   *
   * Task 1 (C-02, 2026-09-02 review) moved `NOT_PRINCIPAL_MOVEMENT` OUT of reports.ts and into
   * its own leaf module, src/lib/spend-where.ts, precisely so budgets.ts (and predict/history.ts,
   * tax.ts, insights.ts, notify/evaluate/anomalies.ts) could compose the same rule without
   * importing reports.ts at all. reports.ts is therefore now exactly like budgets.ts above: it
   * reads `SPEND_ROW_WHERE` by NAME (an import, not the table) and never touches the link table
   * directly. The position-aware carve-out this test used to apply to reports.ts now applies to
   * spend-where.ts instead -- same reasoning, moved with the code.
   *
   * What MUST-13.2 protects, restated, is still absolute: repaying a debt the household OWES --
   * a car payment, money that leaves and is never seen again -- must count as ordinary spend, in
   * every budget and every report, forever. Nothing below touches that.
   *
   * What changed: item 8a established that not every transaction touching a loan IS spend. Of
   * the four ways money can move against a loan, three convert cash into a receivable or a
   * receivable into cash -- lending money out, being repaid, and borrowing -- and none of those
   * change how much the household earned or consumed; only the fourth, repaying a loan the
   * household itself owes, is real consumption. `NOT_PRINCIPAL_MOVEMENT` (src/lib/spend-where.ts)
   * is the ONE place allowed to read the link table, and it exists to compute exactly that
   * three-way exclusion, as a correlated SQL predicate rather than a materialized id list -- see
   * its own docblock for the full classification, why it is correlated (not a JS-side scan
   * repeated at every rangeClauses call site, and no unbounded bind parameters), and the
   * MUST-11.16 tie-break it derives carefully (an existential OR, not the universal-quantifier
   * NOT EXISTS that reads almost the same but gets that tie-break backwards). A car payment
   * (money out, an 'owed' loan) always fails its exclusion test and stays counted; no other
   * place may read this table to decide what counts as spend.
   */
  it('reports.ts never reads the link table at all -- it composes NOT_PRINCIPAL_MOVEMENT by name, via SPEND_ROW_WHERE', () => {
    const source = read('src/lib/reports.ts');
    expect({ file: 'src/lib/reports.ts', hit: /loan_payments|loanPayments/.test(source) }).toEqual({
      file: 'src/lib/reports.ts',
      hit: false,
    });
  });

  it('spend-where.ts reads the link table only inside NOT_PRINCIPAL_MOVEMENT, never anywhere else', () => {
    const source = read('src/lib/spend-where.ts');
    const start = source.indexOf('const NOT_PRINCIPAL_MOVEMENT');
    expect(start).toBeGreaterThan(-1);

    // NOT_PRINCIPAL_MOVEMENT is `const NAME: SQL = sql\`...\`;` -- one tagged template, not a
    // function body (brace-counting) or a top-level `and(...)` call (REVIEW_WHERE's own "\n);"
    // search below). Its own SQL text contains no backtick, so the next backtick after the
    // template's OPENING one is unambiguously its closing one.
    const openBacktick = source.indexOf('`', start);
    expect(openBacktick).toBeGreaterThan(-1);
    const closeBacktick = source.indexOf('`', openBacktick + 1);
    expect(closeBacktick).toBeGreaterThan(openBacktick);
    const end = closeBacktick + 1;

    const inside = source.slice(start, end);
    // Same two exemptions REVIEW_WHERE's own check below applies, for the same reasons: the
    // import (a symbol must be named to be used at all) and comments (a rule that forbids
    // DESCRIBING the code it governs makes the code less clear, not safer).
    const outside = (source.slice(0, start) + source.slice(end))
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !/^import\b/.test(trimmed) && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
      })
      .join('\n');

    expect({ where: 'inside NOT_PRINCIPAL_MOVEMENT', hit: /loan_payments|loanPayments/.test(inside) }).toEqual({
      where: 'inside NOT_PRINCIPAL_MOVEMENT',
      hit: true,
    });
    expect({ where: 'elsewhere in spend-where.ts', hit: /loan_payments|loanPayments/.test(outside) }).toEqual({
      where: 'elsewhere in spend-where.ts',
      hit: false,
    });
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
