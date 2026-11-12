import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MODULE = 'src/lib/zod.ts';
const SELF = 'tests/ops/zod-v4-only.test.ts';

/** Same walk() shape as tests/ops/amount-bounds.test.ts, widened to the script extensions. */
function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(relative);
    return /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) ? [relative] : [];
  });
}

/** The repo's stripComments pattern: a comment that names a zod 3 API to explain a change is fine. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * v1.60.1, zod 4. src/lib/zod.ts installs zod 3's English as zod 4's global error map and turns
 * off the JIT. Both live in `z.config`, which is process-global per zod copy, so a file that
 * imported 'zod' directly would still get the map in any test that loaded @/lib/zod somewhere
 * else, and the message parity tests could never notice it. This scan is what holds every file to
 * the one module.
 *
 * WHAT IT DOES NOT CATCH: a specifier built at runtime (`require('z' + 'od')`), or a zod 3 API
 * reached through a name this text scan cannot see. tests/lib/zod-compat.test.ts and
 * tests/lib/zod-messages.test.ts prove the messages; this file proves only where zod comes from.
 */
const files = [...walk('src'), ...walk('scripts'), ...walk('tests')].filter((file) => file !== SELF);
const sources = new Map(files.map((file) => [file, stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'))]));

/** Any static import, re-export, dynamic import or require of the module named `name`. */
function importsModule(source: string, name: RegExp): boolean {
  const specifier = new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s+)(['"\`])${name.source}\\1`);
  return specifier.test(source);
}

const BARE_ZOD = /zod/;
const ZOD_SUBPATH = /zod\/[^'"`]*/;
const WRAPPER = /@\/lib\/zod/;

/** zod 3 APIs that zod 4 removed or deprecated, and the zod 3 spelling of an issue list. */
const ZOD3_TOKENS = [
  /\berrorMap\b/,
  /\binvalid_type_error\b/,
  /\brequired_error\b/,
  /\bZodIssueCode\b/,
  /\bnativeEnum\b/,
  /\bdeepPartial\b/,
  /\bnonstrict\b/,
  /\bformErrors\b/,
  /\bZodEffects\b/,
  /\bZodTypeAny\b/,
  /\bctx\.path\b/,
  /\.error\.errors\b/,
];

/** A string format written as a method on z.string(); zod 4 spells it z.email(), z.guid() and so on. */
const METHOD_FORMAT = /(?<!\bz)\.(email|uuid|url|ip|cidr)\(/;

describe('zod 4: one import, no zod 3 API (v1.60.1)', () => {
  it('nothing imports zod except src/lib/zod.ts', () => {
    const offenders = files.filter((file) => file !== MODULE && importsModule(sources.get(file)!, BARE_ZOD));
    expect(offenders).toEqual([]);
  });

  it('nothing imports a zod subpath (zod/v3, zod/v4, zod/mini, zod/locales, ...)', () => {
    const offenders = files.filter((file) => importsModule(sources.get(file)!, ZOD_SUBPATH));
    expect(offenders).toEqual([]);
  });

  it('no zod 3 API remains', () => {
    const offenders = files.flatMap((file) =>
      ZOD3_TOKENS.filter((token) => token.test(sources.get(file)!)).map((token) => `${file}: ${token.source}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no string format is written as a method in a file that uses zod', () => {
    const offenders = files.filter((file) => {
      const source = sources.get(file)!;
      const usesZod = importsModule(source, WRAPPER) || importsModule(source, BARE_ZOD);
      return usesZod && METHOD_FORMAT.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it('src/lib/zod.ts installs the zod 3 message map and runs jitless', () => {
    const source = sources.get(MODULE)!;
    expect(source).toMatch(/jitless:\s*true/);
    expect(source).toMatch(/\bcustomError\b/);
  });

  it('the scan sees every schema file in src (a scan that matches nothing proves nothing)', () => {
    const importers = files.filter((file) => file.startsWith('src/') && file !== MODULE && importsModule(sources.get(file)!, WRAPPER));
    expect(importers.length).toBeGreaterThanOrEqual(39);
  });
});
