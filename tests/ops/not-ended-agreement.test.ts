import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { warrantyItems } from '@/db/schema';
import { EXPIRING_SOON_DAYS, WARRANTY_STATUSES, warrantyStatus, type WarrantyStatus } from '@/lib/warranty/expiry';
import { STATUS_CASE_SQL, notEnded } from '@/lib/warranty/expiry-sql';
import { addDaysIso } from '@/lib/dates';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';

const ROOT = process.cwd();
const TODAY = '2026-09-04';
const NEW_MODULE = 'src/lib/warranty/expiry-sql.ts';
const SEARCH = 'src/lib/warranty/search.ts';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/**
 * R25 (v1.32.0), successor to v1.31.0's M-2 guard. "This item has not ended" used to be written
 * THREE times: `warrantyStatus()` in TypeScript, `STATUS_CASE_SQL` as a raw SQL CASE (both in
 * src/lib/warranty/expiry.ts) and `notEnded()` as a drizzle predicate in src/lib/recurring.ts.
 * The old version of this file extracted recurring.ts's predicate from its own SOURCE TEXT and
 * executed it, because there was no other way to test the shipped predicate without restating it.
 *
 * IT IS NOW WRITTEN TWICE, and this file says so rather than repeating a reason that stopped
 * being true. Controller ruling V2 put the SQL ladder in ONE new server-only leaf module,
 * src/lib/warranty/expiry-sql.ts, which renders it two ways -- the raw `i.`-aliased CASE the list
 * query splices into its text, and the composable drizzle predicate -- from one definition of
 * each condition. `notEnded()` is now literally `not` of the ladder's `expired` arm rather than
 * the same boundary written again with the inequality turned around. The source-text extraction
 * is gone with it: both renderings are imported and executed here, which is stricter than reading
 * them out of a file, and the whole class of "the regex no longer finds the function" is retired.
 *
 * WHAT CANNOT BE COLLAPSED, and why the count is two rather than one. `warrantyStatus()` answers
 * about a row already in memory; the ladder builds a WHERE clause. Neither can be generated from
 * the other without a SQL-expression interpreter in TypeScript, which would be a much larger
 * thing to own than the duplication it removed. So the TypeScript stays, and the mechanism that
 * ties it to the SQL is this file executing all of it on the dates where an off-by-one lives: the
 * day before expiry, the expiry date itself, the day after, and both edges of the expiring
 * window. Lifetime and no-end-date items are seeded too, because they are the other edge.
 *
 * WHY THE SQL LIVES IN A SEPARATE MODULE AT ALL -- and a correction. The stated reason has always
 * been that `'use client'` components value-import expiry.ts (StatusBadge among them) and
 * tests/ops/client-bundle.test.ts "would fail" if expiry.ts pulled in @/db/schema. That was
 * checked while doing this work, by adding exactly that import and running that guard: IT STAYS
 * GREEN. It walks to @/db/client, better-sqlite3, @/lib/env and node: builtins, and schema.ts
 * reaches none of them -- it imports drizzle-orm and nothing else. (Adding `@/db/client` to
 * expiry.ts does fail it, loudly, naming StatusBadge's chain -- the guard works; @/db/schema is
 * simply outside what it looks for.) The separation is still right, because shipping the whole
 * schema and drizzle's SQL builder to the browser to render a badge is the MUST-2.1 hazard even
 * when it does not break `next build`. It is just not guarded by that file, so it is guarded
 * below, by name, with a positive control.
 *
 * WHAT THIS FILE STILL CANNOT CATCH. A not-ended predicate written somewhere else entirely is
 * invisible to it. src/lib/notify/evaluate/coming-due.ts is the nearest neighbour -- it filters
 * `is_lifetime = 0` with its own expiry-window comparison -- but it answers a different question
 * (what falls due inside a notification window), so it is deliberately not folded in here.
 */

interface Row {
  id: number;
  label: string;
  expiryDate: string | null;
  isLifetime: boolean;
  /** What warrantyStatus() must say about this row -- written down per case, not computed. */
  expected: WarrantyStatus;
}

/** One row per way an item can sit relative to today, with the boundary dates in the middle. */
function seedItems(): Row[] {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { username: 'expiry' });
  const type = current.sqlite
    .prepare(
      "insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Streaming', 1, 'subscription', ?) returning id",
    )
    .get(TODAY) as { id: number };

  const cases: Omit<Row, 'id'>[] = [
    { label: 'ended yesterday', expiryDate: addDaysIso(TODAY, -1), isLifetime: false, expected: 'expired' },
    { label: 'ends today', expiryDate: TODAY, isLifetime: false, expected: 'expiring' },
    { label: 'ends tomorrow', expiryDate: addDaysIso(TODAY, 1), isLifetime: false, expected: 'expiring' },
    {
      label: 'ends on the expiring-soon edge',
      expiryDate: addDaysIso(TODAY, EXPIRING_SOON_DAYS),
      isLifetime: false,
      expected: 'expiring',
    },
    {
      label: 'ends the day after that edge',
      expiryDate: addDaysIso(TODAY, EXPIRING_SOON_DAYS + 1),
      isLifetime: false,
      expected: 'active',
    },
    { label: 'ended long ago', expiryDate: addDaysIso(TODAY, -400), isLifetime: false, expected: 'expired' },
    { label: 'no end date recorded', expiryDate: null, isLifetime: false, expected: 'unknown' },
    { label: 'open ended', expiryDate: null, isLifetime: true, expected: 'lifetime' },
  ];

  // warranty_months and expiry_date are NULL together or set together (a CHECK constraint on the
  // table, and MUST-3.6: the expiry is computed at write time from the term, never derived on read).
  const insert = current.sqlite.prepare(
    `insert into warranty_items (name, purchase_date, warranty_months, expiry_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
     values (?, '2024-01-15', ?, ?, ?, ?, ?, ?, ?) returning id`,
  );
  return cases.map((entry) => {
    const row = insert.get(
      entry.label,
      entry.expiryDate === null ? null : 12,
      entry.expiryDate,
      entry.isLifetime ? 1 : 0,
      userId,
      type.id,
      TODAY,
      TODAY,
    ) as { id: number };
    return { id: row.id, ...entry };
  });
}

/** Every id the SHIPPED drizzle predicate keeps -- the query, not a restatement of it. */
function liveByPredicate(): Set<number> {
  const db = (current as TestDb).db;
  return new Set(
    db
      .select({ id: warrantyItems.id })
      .from(warrantyItems)
      .where(notEnded(TODAY))
      .all()
      .map((row) => row.id),
  );
}

/** Every row's status according to a CASE expression, bound today-then-soon as its docblock says. */
function statusesByCase(caseSql: string): Map<number, string> {
  const soon = addDaysIso(TODAY, EXPIRING_SOON_DAYS);
  const rows = (current as TestDb).sqlite
    .prepare(`select i.id as id, ${caseSql} as status from warranty_items i`)
    .all(TODAY, soon) as { id: number; status: string }[];
  return new Map(rows.map((row) => [row.id, row.status]));
}

describe('R25: the two remaining expressions of the expiry rule answer the same on every boundary', () => {
  it('warrantyStatus(), STATUS_CASE_SQL and notEnded() agree, status for status, row for row', () => {
    const rows = seedItems();
    const liveIds = liveByPredicate();
    const statuses = statusesByCase(STATUS_CASE_SQL);

    const disagreements = rows
      .map((row) => ({
        label: row.label,
        // The TypeScript original, the raw CASE rendering, and the drizzle rendering. The first
        // two are compared as FULL statuses, not merely expired/not: both are the same five-arm
        // ladder, so anything weaker would let a lifetime item quietly read as unknown.
        typescript: warrantyStatus({ expiryDate: row.expiryDate, isLifetime: row.isLifetime }, TODAY),
        caseSql: statuses.get(row.id),
        notEndedTs: warrantyStatus({ expiryDate: row.expiryDate, isLifetime: row.isLifetime }, TODAY) !== 'expired',
        notEndedPredicate: liveIds.has(row.id),
      }))
      .filter((row) => row.typescript !== row.caseSql || row.notEndedTs !== row.notEndedPredicate);

    expect(
      disagreements,
      'The expiry rule no longer means the same thing in TypeScript and in SQL. The TypeScript is ' +
        'warrantyStatus() (src/lib/warranty/expiry.ts); the SQL is ONE ladder in ' +
        'src/lib/warranty/expiry-sql.ts, rendered as STATUS_CASE_SQL and as notEnded(). Because ' +
        'notEnded() is `not` of that ladder\'s `expired` arm, a difference here is a real ' +
        "off-by-one against MUST-3.14's inclusive boundary -- and the Recurring card would then " +
        'count an ended contract as tracked, which is the one row that card exists to surface.',
    ).toEqual([]);
  });

  it('every row lands where the case list says it should, and every declared status is exercised', () => {
    const rows = seedItems();
    const statuses = statusesByCase(STATUS_CASE_SQL);

    // Without this the agreement above could be three ways of being wrong together.
    for (const row of rows) {
      expect(warrantyStatus({ expiryDate: row.expiryDate, isLifetime: row.isLifetime }, TODAY), row.label).toBe(
        row.expected,
      );
      expect(statuses.get(row.id), `${row.label} (STATUS_CASE_SQL)`).toBe(row.expected);
    }

    // And the ladder is exercised end to end: a CASE missing an arm, or ordered wrongly, cannot
    // hide behind rows that never reach it.
    expect([...new Set(statuses.values())].sort()).toEqual([...WARRANTY_STATUSES].sort());
  });

  it('the coverage boundary is inclusive of the expiry date itself, in both renderings (MUST-3.14)', () => {
    const rows = seedItems();
    const liveIds = liveByPredicate();
    const statuses = statusesByCase(STATUS_CASE_SQL);
    const endsToday = rows.find((row) => row.label === 'ends today') as Row;
    const endedYesterday = rows.find((row) => row.label === 'ended yesterday') as Row;

    expect(liveIds.has(endsToday.id)).toBe(true);
    expect(statuses.get(endsToday.id)).not.toBe('expired');
    expect(liveIds.has(endedYesterday.id)).toBe(false);
    expect(statuses.get(endedYesterday.id)).toBe('expired');

    // Not vacuous: both partitions are non-empty, so an "agrees" drawn from empty sets could not
    // have passed the comparison above.
    expect(rows.filter((row) => liveIds.has(row.id)).length).toBeGreaterThan(0);
    expect(rows.filter((row) => !liveIds.has(row.id)).length).toBeGreaterThan(0);
  });

  it('an off-by-one in the SQL ladder is caught, not tolerated (positive control)', () => {
    // Nothing above proves the comparison can FAIL. Here the shipped CASE is deliberately
    // weakened from `< ?` to `<= ?` -- the one plausible typo against an inclusive boundary --
    // and both the status comparison and the not-ended comparison must move off warrantyStatus().
    const rows = seedItems();
    const broken = STATUS_CASE_SQL.replace('< ?', '<= ?');
    expect(broken, 'STATUS_CASE_SQL no longer contains the strict comparison this control mutates').not.toBe(
      STATUS_CASE_SQL,
    );

    const shipped = statusesByCase(STATUS_CASE_SQL);
    const mutated = statusesByCase(broken);
    const endsToday = rows.find((row) => row.label === 'ends today') as Row;

    expect(shipped.get(endsToday.id)).toBe('expiring');
    expect(mutated.get(endsToday.id)).toBe('expired');
    expect(warrantyStatus({ expiryDate: endsToday.expiryDate, isLifetime: false }, TODAY)).toBe('expiring');

    // Stated as the guard's own assertion would state it: the mutated ladder disagrees with the
    // TypeScript on at least one row, so the comparison in the first test discriminates.
    const disagreeing = rows.filter(
      (row) => warrantyStatus({ expiryDate: row.expiryDate, isLifetime: row.isLifetime }, TODAY) !== mutated.get(row.id),
    );
    expect(disagreeing.map((row) => row.label)).toEqual(['ends today']);
  });

  it('a missing bound value throws rather than silently matching nothing', () => {
    // renderDrizzle's failure mode if a bind is ever added to the ladder and not supplied: SQL
    // NULL compares as unknown, the predicate matches no rows, and a "tracked" badge quietly
    // disappears from every row. Proven here through the one public entry point that binds.
    expect(() => notEnded(undefined as unknown as string)).toThrow(/no value bound/);
  });
});

/**
 * The regex import scanner and BFS below are a deliberately small copy of
 * tests/ops/client-bundle.test.ts's, narrowed to one question: can a `'use client'` file reach a
 * NAMED module? That guard cannot answer this one -- @/db/schema is not on its forbidden list and
 * it does not follow bare packages -- and widening a guard that is already load-bearing for a
 * different rule is how a guard's stated reason becomes false. So ruling V2's rule gets its own
 * mechanism here, where the ruling is, rather than a sentence in a docblock.
 */
function walk(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

const sourceCache = new Map<string, string>();
function readSource(file: string): string {
  const cached = sourceCache.get(file);
  if (cached !== undefined) return cached;
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  sourceCache.set(file, text);
  return text;
}

function isUseClientFile(source: string): boolean {
  const head = source.replace(/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/, '').trimStart();
  return /^['"]use client['"];?/.test(head);
}

/** Value-import specifiers only: `import type` / `export type` erase before webpack sees them. */
function valueSpecifiers(source: string): string[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out: string[] = [];
  for (const match of clean.matchAll(/\b(?:import|export)\b[^;]*?;/g)) {
    const stmt = match[0];
    const from = stmt.match(/from\s*['"]([^'"]+)['"]/) ?? stmt.match(/^import\s*['"]([^'"]+)['"]/);
    if (!from) continue;
    if (/^(?:import|export)\s+type\b/.test(stmt)) continue;
    const braces = stmt.match(/\{([\s\S]*)\}/);
    if (braces && !/^import\s+(?!type\b)[A-Za-z_$][\w$]*\s*(?:,|from)/.test(stmt) && !/\*\s+as\s+/.test(stmt)) {
      const named = braces[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (named.length > 0 && named.every((s) => /^type\s/.test(s))) continue;
    }
    out.push(from[1]);
  }
  return out;
}

function resolveAtImport(specifier: string): string | null {
  if (!specifier.startsWith('@/')) return null;
  const base = path.join(ROOT, 'src', specifier.slice(2));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(candidate)) return path.relative(ROOT, candidate).split(path.sep).join('/');
  }
  return null;
}

/** The chain from `start` to `target` through value imports, or null if there is none. */
function chainTo(start: string, target: string): string[] | null {
  const seen = new Set([start]);
  const queue: { file: string; chain: string[] }[] = [{ file: start, chain: [start] }];
  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    for (const specifier of valueSpecifiers(readSource(file))) {
      const resolved = resolveAtImport(specifier);
      if (resolved === null || seen.has(resolved)) continue;
      if (resolved === target) return [...chain, resolved];
      seen.add(resolved);
      queue.push({ file: resolved, chain: [...chain, resolved] });
    }
  }
  return null;
}

describe('ruling V2: the SQL ladder module is server-only, and nothing client-side reaches it', () => {
  const clientFiles = walk('src').filter((file) => isUseClientFile(readSource(file)));

  it('finds the client components at all (a scan that matches nothing proves nothing)', () => {
    expect(clientFiles.length).toBeGreaterThanOrEqual(30);
    expect(clientFiles).toContain('src/app/(app)/warranties/warranties-client.tsx');
  });

  it('POSITIVE CONTROL: the same walk does find expiry.ts, which client components legitimately import', () => {
    // expiry.ts is the pure, client-safe half and IS reached from the client -- so a non-empty
    // answer here proves the walker follows real edges and would report a violation below rather
    // than being an assertion about an empty list it can never fill.
    //
    // Worth pinning the TRANSITIVE one specifically: StatusBadge.tsx carries no directive of its
    // own (it is a plain shared component), so a walker that only looked at direct imports of
    // `'use client'` files would miss it entirely -- and it is the deepest chain into expiry.ts
    // this app has.
    const reached = clientFiles
      .map((file) => ({ file, chain: chainTo(file, 'src/lib/warranty/expiry.ts') }))
      .filter((result): result is { file: string; chain: string[] } => result.chain !== null);
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.map((r) => r.file)).toContain('src/app/(app)/warranties/warranties-client.tsx');
    expect(reached.find((r) => r.file === 'src/app/(app)/warranties/[id]/warranty-detail-client.tsx')?.chain).toEqual([
      'src/app/(app)/warranties/[id]/warranty-detail-client.tsx',
      'src/components/warranty/StatusBadge.tsx',
      'src/lib/warranty/expiry.ts',
    ]);
  });

  it(`no 'use client' file reaches ${NEW_MODULE}, directly or through its own value imports`, () => {
    const offenders = clientFiles
      .map((file) => ({ file, chain: chainTo(file, NEW_MODULE) }))
      .filter((result): result is { file: string; chain: string[] } => result.chain !== null)
      .map(
        ({ chain }) =>
          `${chain.join(' -> ')} -- ${NEW_MODULE} imports @/db/schema and drizzle's SQL builder; a client ` +
          'component that reaches it ships both to the browser (MUST-2.1). Take the pure half from ' +
          'src/lib/warranty/expiry.ts instead, which is exactly why the two are separate files.',
      );
    expect(offenders).toEqual([]);
  });

  it('and the pure half never imports the schema back (the dependency runs one way)', () => {
    const specifiers = valueSpecifiers(readSource('src/lib/warranty/expiry.ts'));
    expect(specifiers).not.toContain('@/db/schema');
    expect(specifiers).not.toContain('drizzle-orm');
    expect(specifiers).not.toContain(NEW_MODULE.replace('src/', '@/').replace(/\.ts$/, ''));
  });
});

describe('STATUS_CASE_SQL still fits the raw query it is spliced into', () => {
  it('is aliased the way searchWarrantyItems aliases warranty_items', () => {
    // The old docblock said "assumes warranty_items is aliased `i`" and left it at that. The
    // splice is a real coupling between two files, so it is checked instead of assumed: if
    // search.ts renames the alias, the CASE's `i.` columns become "no such column" at runtime on
    // the warranties list -- a page that 500s, found by a person rather than by a test.
    expect(readSource(SEARCH)).toContain('from warranty_items i ');
    expect(STATUS_CASE_SQL).toContain('i.is_lifetime');
    expect(STATUS_CASE_SQL).toContain('i.expiry_date');
  });

  it('binds exactly two positional parameters, today then soon', () => {
    expect(STATUS_CASE_SQL.split('?')).toHaveLength(3);
    expect(STATUS_CASE_SQL.indexOf('< ?')).toBeLessThan(STATUS_CASE_SQL.indexOf('<= ?'));
  });
});
