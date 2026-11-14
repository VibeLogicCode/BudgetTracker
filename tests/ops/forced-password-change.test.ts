import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * v1.64.1: the forced password change is a boundary for every action and route. It holds because
 * there are only three ways to read a session's person, and each decides what a flagged person
 * reaches:
 *
 *   - requireUser() / requireAdmin() send a flagged person to /change-password;
 *   - userFromRequest() answers a flagged person as signed out;
 *   - requireUserForPasswordChange() hands them back, and only the change-password page and its
 *     action use it.
 *
 * validateSession() returns a flagged person too, so outside src/lib/auth/session.ts only sign-out
 * may call it. This guard keeps each of those true, and checks that every route and every server
 * action module actually goes through one of the readers.
 */
const ROOT = process.cwd();
const SESSION_MODULE = 'src/lib/auth/session.ts';

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(rel, found);
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(rel);
  }
  return found;
}

const FILES = sourceFiles('src');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function callers(name: string): string[] {
  const call = new RegExp(`\\b${name}\\s*\\(`);
  return FILES.filter((file) => file !== SESSION_MODULE && call.test(read(file))).sort();
}

describe('v1.64.1: the forced password change is a boundary for every action and route', () => {
  it('finds the source tree it checks', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain('src/app/api/auth/logout/route.ts');
  });

  it('only sign-out reads a session through validateSession', () => {
    expect(callers('validateSession')).toEqual(['src/app/api/auth/logout/route.ts']);
  });

  it('only the change-password page and its action obtain a flagged person', () => {
    expect(callers('requireUserForPasswordChange')).toEqual([
      'src/app/(auth)/change-password/actions.ts',
      'src/app/(auth)/change-password/page.tsx',
    ]);
  });

  it('nothing reads the current person any other way', () => {
    expect(callers('getCurrentUser')).toEqual([]);
    expect(read(SESSION_MODULE)).not.toMatch(/export\s+(async\s+)?function\s+getCurrentUser\b/);
  });

  it('every route under src/app/api, except health and sign-out, reads its person through userFromRequest', () => {
    const routes = FILES.filter((file) => file.startsWith('src/app/api/') && /\/route\.ts$/.test(file));
    expect(routes.length).toBeGreaterThan(20);
    const exempt = ['src/app/api/health/route.ts', 'src/app/api/auth/logout/route.ts'];
    const missing = routes.filter((file) => !exempt.includes(file) && !/\buserFromRequest\s*\(/.test(read(file)));
    expect(missing).toEqual([]);
  });

  it('every server action module, except sign-in and first-run setup, goes through requireUser or requireAdmin', () => {
    const modules = FILES.filter((file) => file.startsWith('src/app/') && /^\s*['"]use server['"]/m.test(read(file).split('\n').slice(0, 3).join('\n')));
    expect(modules.length).toBeGreaterThan(15);
    const exempt = ['src/app/(auth)/login/actions.ts', 'src/app/(auth)/setup/actions.ts'];
    const missing = modules.filter(
      (file) => !exempt.includes(file) && !/\b(requireUser|requireAdmin|requireUserForPasswordChange)\s*\(/.test(read(file)),
    );
    expect(missing).toEqual([]);
  });
});
