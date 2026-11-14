import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/** Same walk() shape as tests/ops/attribution-writers.test.ts. */
function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

/** The repo's established stripComments pattern: a docblock explaining the rule never trips it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * v1.63.0 (plan 2026-11-12, A7). A split part can belong to someone other than its transaction, and
 * EFFECTIVE_PERSON (src/lib/splits.ts) is the one rule for whose a joined row's money is. A file that
 * joins transaction_splits and then filters or groups on the TRANSACTION's person is counting each
 * part for the wrong person -- the exact shape every split-joined aggregate had before 0032, and the
 * one a new aggregate would most naturally be written in.
 *
 * So, in every src/ file that joins transaction_splits, no code (comments stripped) may write
 * `eq(transactions.attributedUserId`, `isNull(transactions.attributedUserId` or a `.groupBy(...)`
 * naming `transactions.attributedUserId`, outside the clause builders in splits.ts. Such a reader
 * uses partPersonClause / EFFECTIVE_PERSON, or personRowClause for a one-row-per-transaction read.
 *
 * An exemption is a function, with the argument (the attribution-writers shape), never a file.
 *
 * WHAT IT DOES NOT CATCH: a reader in a file that reads parts without joining them, a filter built
 * elsewhere and passed in, raw SQL spelling `attributed_user_id`, and `sql` fragments comparing the
 * column by hand. The behaviour is proved by tests/lib/split-aggregates.test.ts and the fixture
 * tests beside it; this file proves only that the obvious spelling has not come back.
 */
const EXEMPT: Record<string, string> = {
  'src/lib/budgets.ts#uncategorizedSpend':
    'it counts only rows with no category and no split parts (UNCATEGORIZED_WHERE leaves every split row ' +
    'out), and reads transactions alone with no split join. A part is the only place a person can differ ' +
    "from the transaction's, so on every row it counts the transaction's own person is exactly the part person.",
  'src/lib/transactions.ts#getTransaction':
    'it is the may-act gate, not a money read: the single-row actions and loans.ts refuse a self viewer ' +
    "when it returns null, and the transaction's own person decides who may act on a charge (plan A4, " +
    'transactionOwners unchanged). The row it returns is still read at the viewer share; the part-aware ' +
    'read is getTransactionShare, which uses personRowClause.',
};

const JOINS_SPLITS = /\.(?:leftJoin|innerJoin|rightJoin|fullJoin)\(\s*transactionSplits\b|\bjoin\s+(?:\$\{transactionSplits\}|transaction_splits)\b/;

/** Balanced-paren slice starting at the `(` that follows `at`, as attribution-writers reads `.set(...)`. */
function callArguments(source: string, at: number): string | null {
  const open = source.indexOf('(', at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/** Every offset at which `source` filters or groups on the transaction's own person. */
function parentPersonOffsets(source: string): number[] {
  const offsets: number[] = [];
  for (const match of source.matchAll(/\b(?:eq|isNull)\(\s*transactions\.attributedUserId\b/g)) offsets.push(match.index);
  for (const match of source.matchAll(/\.groupBy\s*\(/g)) {
    const args = callArguments(source, match.index);
    if (args !== null && /\btransactions\.attributedUserId\b/.test(args)) offsets.push(match.index);
  }
  return offsets.sort((a, b) => a - b);
}

const DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

function enclosingName(source: string, offset: number): string {
  let found = '<top level>';
  DECLARATION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DECLARATION.exec(source))) {
    if (match.index > offset) break;
    found = match[1];
  }
  return found;
}

/** `file#function` for every offender in the files that join transaction_splits. */
function offendersIn(files: string[], read: (file: string) => string): { joining: string[]; offenders: string[] } {
  const joining: string[] = [];
  const offenders = new Set<string>();
  for (const file of files) {
    const source = stripComments(read(file));
    if (!JOINS_SPLITS.test(source)) continue;
    joining.push(file);
    // splits.ts is where the clause builders live: they ARE the rule this guard points at.
    if (file === 'src/lib/splits.ts') continue;
    for (const offset of parentPersonOffsets(source)) offenders.add(`${file}#${enclosingName(source, offset)}`);
  }
  return { joining, offenders: [...offenders].sort() };
}

const files = walk('src');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const { joining, offenders } = offendersIn(files, read);

describe('a file that joins transaction_splits reads the part person, never the transaction person (v1.63.0)', () => {
  it('scans a real tree, and sees every known split-joined reader', () => {
    expect(files.length).toBeGreaterThan(100);
    for (const file of [
      'src/lib/reports.ts',
      'src/lib/budgets.ts',
      'src/lib/tax.ts',
      'src/lib/transactions.ts',
      'src/lib/predict/history.ts',
      'src/lib/month-checkin.ts',
    ]) {
      expect(joining).toContain(file);
    }
  });

  it('no split-joined file filters or groups on transactions.attributedUserId outside a stated exemption', () => {
    expect(offenders.filter((key) => EXEMPT[key] === undefined)).toEqual([]);
  });

  it('every exemption is a real offender, with an argument', () => {
    // An exemption for code that no longer offends is stale and would hide a real one later.
    expect(Object.keys(EXEMPT).filter((key) => !offenders.includes(key))).toEqual([]);
    expect(Object.entries(EXEMPT).filter(([, why]) => why.trim().length < 80)).toEqual([]);
  });

  /** Non-vacuity: a reconstructed offender is caught in each spelling, and a non-joining file is not read. */
  it('would catch the v1.62.0 shape in each spelling', () => {
    const fixture = (body: string) => `import { transactionSplits } from '@/db/schema';
export function spentBy(person: number) {
  return getDb()
    .select({ total: sql\`sum(\${EFFECTIVE_AMOUNT})\` })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    ${body}
    .all();
}
`;
    const scan = (source: string) => offendersIn(['src/lib/fixture.ts'], () => source).offenders;
    expect(scan(fixture('.where(eq(transactions.attributedUserId, person))'))).toEqual(['src/lib/fixture.ts#spentBy']);
    expect(scan(fixture('.where(isNull(transactions.attributedUserId))'))).toEqual(['src/lib/fixture.ts#spentBy']);
    expect(scan(fixture('.groupBy(sql`substr(${transactions.date}, 1, 7)`, transactions.attributedUserId)'))).toEqual([
      'src/lib/fixture.ts#spentBy',
    ]);
    // The rule's own spellings pass.
    expect(scan(fixture('.where(partPersonClause(person)).groupBy(EFFECTIVE_PERSON)'))).toEqual([]);
    // A comment is not code.
    expect(scan(fixture('// .where(eq(transactions.attributedUserId, person))'))).toEqual([]);
    // A file that never joins the parts has no part person to get wrong.
    expect(offendersIn(['src/lib/fixture.ts'], () => 'db.select().from(transactions).where(eq(transactions.attributedUserId, 4))').offenders).toEqual(
      [],
    );
  });
});
