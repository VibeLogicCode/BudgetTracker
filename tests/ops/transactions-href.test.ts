import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/** Same walk() shape as tests/ops/spend-where.test.ts and tests/ops/client-bundle.test.ts. */
function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

/** The repo's established comment-stripping helper, so a `/transactions?...` quoted in a docblock
 *  or a `//` comment -- filter-params.ts and transactions-client.tsx both discuss the audit URL in
 *  prose, and this file's own subjects explain themselves at length -- is never counted as a real
 *  occurrence. A guard that punishes explaining the code it governs gets its comments deleted. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * v1.31.0, controller-added alongside R-02 … R-05: `transactionsHref` (src/lib/transaction-links.ts)
 * is the ONE builder of `/transactions?…` links, and nothing structural stopped a fourth
 * hand-built copy appearing beside the three that were folded into it.
 *
 * WHY THIS PARTICULAR LITERAL IS WORTH A GUARD. Reports, the dashboard's Top merchants card, the
 * transactions row menu and the import screen's History row all want the same sentence -- "show me
 * the rows behind this number" -- and a hand-built querystring answers a DIFFERENT question than
 * the figure above it whenever it forgets a parameter. F-01's own docblock names the specific
 * failure: a link that drops `person` shows the household's rows to somebody who asked about one
 * person, or one person's rows to somebody who asked about the household. v1.30.0 shipped three
 * separate fixes for paths that forgot a person scope. During v1.31.0 a THIRD hand-built copy was
 * found (NeedsALookCard.tsx) and folded in. That is the defect shape this review lineage keeps
 * paying for: one idea implemented more than once with nothing tying the copies together.
 *
 * SHAPE: an INVERTED ALLOWLIST, the same design as tests/ops/spend-where.test.ts, and for the same
 * measured reason. A flat ban would fail today on eight files, and most of them are legitimate --
 * the review-queue mode switch (`?review=1`) carries no figure and has no scope to drop, the
 * transactions page rebuilds its OWN querystring from its own state, and the import audit contract
 * carries `source`/`group` parameters transactionsHref does not model. So every occurrence outside
 * transaction-links.ts must be named here WITH THE REASON READ OFF THE CODE, and a new one has to
 * be justified the same way or built through transactionsHref.
 *
 * WHAT IS SCANNED: every .ts/.tsx file under src/, with comments stripped. WHAT IS NOT, and this
 * matters more than the list itself:
 *   - tests/ and docs/ are outside the scan entirely. A test may hand-write any URL it likes; that
 *     is what a test of a link reader is for (tests/lib/transaction-links.test.ts round-trips
 *     every shape through readFilter).
 *   - any occurrence inside a comment, per stripComments above.
 *   - COPY. `src/app/(app)/help/content.tsx` quotes app URLs at the reader as text ("Where:
 *     /transactions?review=1") rather than navigating anywhere, so it is allowlisted rather than
 *     carved out by directory -- an allowlist entry is visible in this file, a directory exclusion
 *     is not.
 *   - src/app/(app)/transactions/filter-params.ts, the READER half of the audit contract, is not
 *     allowlisted and does not need to be: its only mention of the URL is in prose, so
 *     stripComments already accounts for it. (It was on the list for one draft; the stale-entry
 *     check below is what said so.)
 *   - a link built some OTHER way: a bare `/transactions` with no querystring, a path assembled
 *     from a variable, or a router push with a params object. This scan catches the shape a person
 *     re-introducing the defect would actually type, which is the same claim
 *     tests/ops/rule-attribution-honesty.test.ts's source-text backstop makes about itself, and it
 *     is a backstop for the same reason: the property that a link and its figure ask the same
 *     question is asserted in tests/lib/transaction-links.test.ts, not here.
 */
const ALLOWED_HAND_BUILT: Record<string, string> = {
  'src/app/(app)/dashboard/page.tsx':
    "the review-queue callout and its inline repeat, both the fixed '/transactions?review=1' -- a mode " +
    'switch to the review queue, not a link behind a figure, so there is no range or person to carry',
  'src/app/(app)/help/content.tsx':
    "help COPY: <Where path=\"/transactions?review=1\"> prints the URL for the reader to look at; this " +
    'file navigates nowhere and computes no figure',
  'src/app/(app)/import/import-client.tsx':
    "two: the '/transactions?review=1' mode switch, and the fixed audit contract " +
    "'/transactions?import=<id>&source=rule&group=category' -- source and group are parameters " +
    'transactionsHref deliberately does not model (see its TransactionsLinkTarget union), and the ' +
    'contract is asserted verbatim by tests/lib/import/rules-audit.test.ts',
  'src/app/(app)/review/page.tsx':
    "a one-line redirect('/transactions?review=1'): /review IS the review queue under another URL, " +
    'and a redirect target is not a figure link',
  'src/app/(app)/transactions/transactions-client.tsx':
    "builds its OWN page's querystring from its own filter state (hrefWithParams) plus the " +
    "'/transactions?review=1' toggle -- this is the page linking to itself with the filters it is " +
    'already showing, which is where the scope comes FROM rather than something to re-derive',
  'src/app/(app)/warranties/[id]/warranty-detail-client.tsx':
    "three merchant searches hand-built as '?q=' and '?search=' from a warranty's linked transaction " +
    'and its instalment rows; a genuine fourth-copy candidate to fold into transactionsHref, left ' +
    'alone here only because another lane held this file open at the time (reported, not fixed)',
  'src/components/app-shell/nav.ts':
    "REVIEW_NAV_HREF, the single definition of the review link the nav and AppShell both compare " +
    'against; a nav destination, not a figure',
  'src/components/RuleReviewCard.tsx':
    'the same fixed audit contract as import-client.tsx (import id + source=rule + group=category), ' +
    'shown on the card that offers the rule-review pass',
};

const HAND_BUILT = /['"`]\/transactions\?/g;

describe('a hand-built `/transactions?` querystring appears only in transaction-links.ts or an argued allowlist', () => {
  const files = walk('src');
  const countsByFile = new Map<string, number>();
  for (const file of files) {
    const matches = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8')).match(HAND_BUILT);
    if (matches && matches.length > 0) countsByFile.set(file, matches.length);
  }

  it('finds at least the known occurrences (a scan that matches nothing proves nothing)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(countsByFile.get('src/lib/transaction-links.ts')).toBe(1);
    expect(countsByFile.size).toBeGreaterThanOrEqual(Object.keys(ALLOWED_HAND_BUILT).length);
  });

  it('appears only in transaction-links.ts or an allowlisted file, each with a stated reason', () => {
    const offenders: string[] = [];
    for (const [file, count] of countsByFile) {
      if (file === 'src/lib/transaction-links.ts') continue;
      if (Object.prototype.hasOwnProperty.call(ALLOWED_HAND_BUILT, file)) continue;
      offenders.push(
        `${file} (${count} occurrence${count === 1 ? '' : 's'}): a link behind a figure is built by ` +
          'transactionsHref(scope, target) from @/lib/transaction-links, which makes the range and the ' +
          'person impossible to forget -- a hand-built querystring that drops `person` answers a ' +
          'different question than the number beside it. If this is not a figure link (a fixed mode ' +
          'switch, help copy, a page linking to itself), add it to ALLOWED_HAND_BUILT with the reason.',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry still names a file that has one, and carries a real reason', () => {
    // A stale entry is how an allowlist rots into a list of files somebody once mentioned.
    const stale = Object.keys(ALLOWED_HAND_BUILT)
      .filter((file) => !countsByFile.has(file))
      .sort();
    expect(stale, 'this file no longer hand-builds a /transactions? link -- drop the entry').toEqual([]);
    const unexplained = Object.entries(ALLOWED_HAND_BUILT)
      .filter(([, why]) => why.trim().length < 60)
      .map(([file]) => file);
    expect(unexplained).toEqual([]);
  });

  it('the detector fails on the defect, reconstructed', () => {
    // Non-vacuity: a typo in the regex, or a stripComments that swallowed the file, would leave
    // every assertion above passing forever while protecting nothing. The fourth copy is rebuilt
    // here in the three spellings somebody would actually type.
    const template = 'const href = `/transactions?category=${String(row.categoryId)}&range=${range.preset}`;';
    const quoted = "const href = '/transactions?q=' + encodeURIComponent(merchant);";
    const jsx = '<Link href={`/transactions?import=${id}`}>View rows</Link>';
    for (const bad of [template, quoted, jsx]) {
      expect(stripComments(bad).match(HAND_BUILT)).toHaveLength(1);
    }

    // ...and prose about the link is not the link.
    expect(stripComments("// '/transactions?person=' was hand-built here until v1.31.0.").match(HAND_BUILT)).toBeNull();
    expect(
      stripComments(['/**', " * The reader for '/transactions?category=5'.", ' */', 'export const x = 1;'].join('\n')).match(HAND_BUILT),
    ).toBeNull();
    // ...nor is a bare path, nor another route that merely starts the same way.
    expect(stripComments("<Link href='/transactions'>All</Link>").match(HAND_BUILT)).toBeNull();
    expect(stripComments("const href = '/transactions/123';").match(HAND_BUILT)).toBeNull();
  });
});
