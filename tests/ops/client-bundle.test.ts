import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

/**
 * Skips blank lines and comments to find the first real statement -- same helper as
 * tests/ops/use-server-exports.test.ts, because Next only honours a directive prologue
 * ('use client' / 'use server') when it is the first statement in the file, and a leading blank
 * line or a license-header comment above it is common enough elsewhere in this codebase that the
 * check should not be fooled by one.
 */
function firstMeaningfulLine(source: string): string | null {
  let rest = source;
  while (rest.length > 0) {
    rest = rest.replace(/^[ \t\r\n]+/, '');
    if (rest.startsWith('//')) {
      const newline = rest.indexOf('\n');
      rest = newline === -1 ? '' : rest.slice(newline + 1);
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      rest = end === -1 ? '' : rest.slice(end + 2);
      continue;
    }
    break;
  }
  const newline = rest.indexOf('\n');
  const line = newline === -1 ? rest : rest.slice(0, newline);
  const trimmed = line.trim();
  return trimmed === '' ? null : trimmed;
}

function isUseClientFile(source: string): boolean {
  const line = firstMeaningfulLine(source);
  return line === "'use client';" || line === '"use client";' || line === "'use client'" || line === '"use client"';
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

interface ImportEdge {
  /** The raw module specifier text, e.g. '@/lib/networth', 'better-sqlite3', 'node:fs'. */
  specifier: string;
  /** False only when EVERY binding this statement pulls in is `type`-only (erased at compile
   *  time under isolatedModules) -- see parseImportEdges' docblock for the shapes recognised. */
  isValue: boolean;
}

/**
 * Regex-based import/re-export scanner, same style as tests/ops/constants.test.ts's source
 * checks -- not a full parser, and deliberately so (the brief for this guard asks for exactly
 * this: "parse imports with a regex the way the existing ops guards do"). It answers one
 * question per statement: does this force the TARGET module's full body to be evaluated (a
 * VALUE edge -- what next/webpack must bundle), or does it erase completely at compile time (a
 * `type`-only edge, which webpack never sees)? That is exactly the distinction that separates
 * this repo's actual bug (STALE_SNAPSHOT_DAYS/savingsRate, plain value imports) from every other
 * binding on the same import lines (all correctly `type`-only already).
 *
 * Handles every import/re-export shape actually used under src/ (surveyed while writing this
 * guard): `import type {...} from`, `import {..., type X, ...} from` (mixed), `import Default
 * from`, `import Default, {...} from`, `import * as ns from`, bare `import '...'`, and the
 * re-export forms `export {...} from`, `export type {...} from`, `export * from`. It does NOT
 * understand dynamic `import(...)` expressions -- none appear in src/'s own static import style
 * (confirmed by the same survey), so that is a known, stated gap rather than a silently assumed
 * one. A "statement" is found by scanning for `import`/`export` up to its next semicolon; every
 * real import/export in this codebase (Prettier-formatted) ends with one and contains no
 * semicolon of its own before that point. An unrecognised shape that still has a `from` clause
 * fails CLOSED (treated as a value edge) rather than being assumed safe.
 */
function parseImportEdges(source: string): ImportEdge[] {
  const clean = stripComments(source);
  const edges: ImportEdge[] = [];
  const statementRe = /\b(?:import|export)\b[^;]*?;/g;
  let match: RegExpExecArray | null;
  while ((match = statementRe.exec(clean))) {
    const stmt = match[0];

    // Bare side-effect import: `import '@/x';` -- no `from`, whole module still evaluated.
    const bareMatch = stmt.match(/^import\s*['"]([^'"]+)['"]/);
    if (bareMatch) {
      edges.push({ specifier: bareMatch[1], isValue: true });
      continue;
    }

    const fromMatch = stmt.match(/from\s*['"]([^'"]+)['"]/);
    if (!fromMatch) continue; // a local `export const/function/interface/...` -- not an import edge

    if (/^(?:import|export)\s+type\b/.test(stmt)) continue; // fully type-only -- erased, no edge

    const specifier = fromMatch[1];
    const hasDefaultOrNamespace =
      /^import\s+(?!type\b)[A-Za-z_$][\w$]*\s*(?:,|from)/.test(stmt) || /\*\s+as\s+[A-Za-z_$][\w$]*/.test(stmt);
    const braceMatch = stmt.match(/\{([\s\S]*)\}/);

    let isValue: boolean;
    if (hasDefaultOrNamespace) {
      isValue = true;
    } else if (braceMatch) {
      const specifiers = braceMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      isValue = specifiers.some((s) => !/^type\s/.test(s));
    } else if (/^export\s+\*\s+from/.test(stmt)) {
      isValue = true;
    } else {
      // No braces, no default/namespace binding, no `export *`, yet a `from` clause exists and
      // this is not the bare side-effect form (handled above): not a shape this scanner expects
      // to see under src/. Fail closed (treat as a value edge) rather than assume safety.
      isValue = true;
    }

    edges.push({ specifier, isValue });
  }
  return edges;
}

/** The exact modules/packages a client bundle must never be forced to resolve. */
const FORBIDDEN_EXACT = new Set(['@/db/client', '@/lib/env', 'better-sqlite3']);

function forbiddenReason(specifier: string): string | null {
  if (FORBIDDEN_EXACT.has(specifier)) return specifier;
  if (specifier.startsWith('node:')) return specifier;
  return null;
}

const sourceCache = new Map<string, string>();
function readSource(relativeFile: string): string {
  const cached = sourceCache.get(relativeFile);
  if (cached !== undefined) return cached;
  const text = fs.readFileSync(path.join(ROOT, relativeFile), 'utf8');
  sourceCache.set(relativeFile, text);
  return text;
}

/**
 * Maps a `@/...` specifier to the src/ file it names (tsconfig.json's one path alias, `"@/*":
 * ["./src/*"]`). Only `@/` is resolved: a relative (`./`, `../`) or bare-package specifier is
 * still checked by forbiddenReason() above but never walked further, because every internal
 * cross-module import actually used under src/ (surveyed while writing this guard -- hundreds of
 * import lines, all `@/`-qualified) goes through the `@/` alias. A relative import reaching one
 * of the forbidden targets would have to be written as e.g. `../../db/client`, which nothing
 * under src/ does today. If that ever changes, this resolver will not follow it -- a real,
 * stated gap, not a silent one.
 */
function resolveAtImport(specifier: string): string | null {
  if (!specifier.startsWith('@/')) return null;
  const rel = specifier.slice(2);
  const base = path.join(ROOT, 'src', rel);
  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return path.relative(ROOT, candidate).split(path.sep).join('/');
    }
  }
  return null;
}

/**
 * BFS over the VALUE-import graph starting at a 'use client' file. Returns the human-readable
 * chain (the client file, then each further file the walk followed, ending in the exact
 * forbidden specifier text) the first time one of FORBIDDEN_EXACT/node: is reached, or null if
 * nothing reachable through `@/` value imports touches one. A `@/` value import this function
 * cannot resolve to a real file throws rather than being skipped -- see resolveAtImport's
 * docblock for what "cannot resolve" is scoped to mean here.
 */
function findViolationChain(clientFile: string): string[] | null {
  const visited = new Set<string>([clientFile]);
  const queue: { file: string; chain: string[] }[] = [{ file: clientFile, chain: [clientFile] }];

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    const edges = parseImportEdges(readSource(file)).filter((edge) => edge.isValue);

    for (const edge of edges) {
      const forbidden = forbiddenReason(edge.specifier);
      if (forbidden) return [...chain, forbidden];

      if (!edge.specifier.startsWith('@/')) continue; // relative/third-party leaf -- see resolveAtImport's docblock

      const resolved = resolveAtImport(edge.specifier);
      if (!resolved) {
        throw new Error(
          `client-bundle guard: cannot resolve '${edge.specifier}' (value-imported from ${file}) to a file under ` +
            'src/ -- teach resolveAtImport() this shape (or confirm it names a non-TS asset the guard should ' +
            'skip) rather than letting it pass unexamined.',
        );
      }
      if (visited.has(resolved)) continue;
      visited.add(resolved);
      queue.push({ file: resolved, chain: [...chain, resolved] });
    }
  }
  return null;
}

describe("a 'use client' file never value-imports the database/server module graph", () => {
  const clientFiles = walk('src').filter((file) => isUseClientFile(readSource(file)));

  it('finds at least the known client components (a scan that matches nothing proves nothing)', () => {
    expect(clientFiles.length).toBeGreaterThanOrEqual(30);
    expect(clientFiles).toContain('src/app/(app)/reports/reports-client.tsx');
  });

  // The real bug this guard exists for (client-bundle fix, 2026-08-23): reports-client.tsx
  // value-imported STALE_SNAPSHOT_DAYS from '@/lib/networth' and savingsRate from
  // '@/lib/reports'. Both modules import getDb from '@/db/client' at module scope for their
  // OTHER exports, so `next build` failed with "Module not found: Can't resolve 'fs'" --
  // webpack must resolve a value-imported module's own top-level imports before it can even
  // attempt to tree-shake the unused parts, and better-sqlite3 (required by @/db/client) pulls
  // in node:fs/node:crypto, which it cannot resolve for the browser. `tsc --noEmit` and the
  // whole vitest suite both passed anyway -- neither one bundles anything -- so this class of
  // defect only ever surfaces in `next build`, which .github/workflows/test.yml deliberately
  // does not run. This is the guard for it.
  it('no client file, directly or transitively through its own value imports, reaches @/db/client, better-sqlite3, @/lib/env or a node: builtin', () => {
    const offenders = clientFiles
      .map((file) => ({ file, chain: findViolationChain(file) }))
      .filter((result): result is { file: string; chain: string[] } => result.chain !== null)
      .map(
        ({ file, chain }) =>
          `${file}: ${chain.join(' -> ')} -- move the needed binding into a pure, client-safe module ` +
          '(see src/lib/networth-constants.ts, src/lib/savings-rate.ts, src/lib/warranty/constants.ts, ' +
          'src/lib/notify/events.ts or src/lib/env-tz.ts) and import it from there, not through the server module.',
      );
    expect(offenders).toEqual([]);
  });

  // Proves the regex classifier itself before trusting it against the real tree -- same
  // discipline as use-server-exports.test.ts's synthetic-fixture block, exercised directly
  // against parseImportEdges()/resolveAtImport()/forbiddenReason() rather than against a file on
  // disk, so this guard's own logic is proven independently of whatever the repo currently looks
  // like.
  describe('scanner correctness (synthetic fixtures, one per import shape)', () => {
    const value: Record<string, string> = {
      'a bare named import': `import { savingsRate } from '@/lib/reports';`,
      'a mixed named import, only some specifiers typed': `import { STALE_SNAPSHOT_DAYS, type NetWorthPoint } from '@/lib/networth';`,
      'a default import': `import Foo from '@/lib/foo';`,
      'a default + named import': `import Foo, { bar } from '@/lib/foo';`,
      'a namespace import': `import * as ns from '@/lib/foo';`,
      'a bare side-effect import': `import '@/lib/foo';`,
      're-export of a named value (export ... from)': `export { savingsRate } from '@/lib/reports';`,
      'export * from': `export * from '@/lib/reports';`,
      'a bare npm package import': `import Database from 'better-sqlite3';`,
      'a node: builtin import': `import fs from 'node:fs';`,
    };
    for (const [description, source] of Object.entries(value)) {
      it(`treats ${description} as a value edge`, () => {
        expect(parseImportEdges(source).some((edge) => edge.isValue)).toBe(true);
      });
    }

    const noValue: Record<string, string> = {
      'import type { ... }': `import type { NetWorthPoint } from '@/lib/networth';`,
      'export type { ... } from': `export type { NetWorthPoint } from '@/lib/networth';`,
      'every named specifier individually typed': `import { type A, type B } from '@/lib/foo';`,
      'a local export declaration (no module specifier at all)': `export const ROUTES = ['/a', '/b'];`,
      'a local export interface': `export interface Foo { id: number; name: string; }`,
    };
    for (const [description, source] of Object.entries(noValue)) {
      it(`does not treat ${description} as a value edge`, () => {
        expect(parseImportEdges(source).some((edge) => edge.isValue)).toBe(false);
      });
    }

    it('resolveAtImport maps the @/ alias to src/ exactly as tsconfig.json declares it', () => {
      expect(resolveAtImport('@/lib/networth')).toBe('src/lib/networth.ts');
      expect(resolveAtImport('@/db/client')).toBe('src/db/client.ts');
      expect(resolveAtImport('./relative')).toBeNull();
      expect(resolveAtImport('better-sqlite3')).toBeNull();
    });

    it('forbiddenReason matches @/lib/env exactly, not its client-safe sibling @/lib/env-tz', () => {
      expect(forbiddenReason('@/lib/env')).toBe('@/lib/env');
      expect(forbiddenReason('@/lib/env-tz')).toBeNull();
    });
  });
});
