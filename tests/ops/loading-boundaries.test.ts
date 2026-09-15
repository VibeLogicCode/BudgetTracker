import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const APP = 'src/app';

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.tsx$/.test(entry.name) ? [relative] : [];
  });
}

/**
 * 2026-09-15. A `loading.tsx` MUST NOT sit above a route that calls `notFound()`.
 *
 * THE DEFECT THIS EXISTS TO STOP, because it shipped and CI caught it. v1.42.0 added
 * `warranties/loading.tsx` to give that page a skeleton. A `loading.tsx` wraps its whole segment
 * — INCLUDING every child route — in a Suspense boundary, so Next starts streaming the shell
 * immediately and the HTTP status is committed as 200 before the page body runs. `warranties/[id]`
 * calls `notFound()` for an id that does not exist, and that call still renders the not-found UI
 * but can no longer set the status: `/warranties/999999` went from 404 to 200.
 *
 * Nothing about that is visible on screen, which is exactly why it needs a test. It is visible to
 * a crawler, a monitor, a link checker, and anything that treats 200 as "this page exists". The
 * boot-and-request smoke test caught it; this catches it earlier and explains why.
 *
 * THE FIX IS NOT "make the skeleton smarter". A segment either streams or it can 404 — the two
 * cannot both be true for the same request, because the status has to go out with the first byte.
 * A route with a `notFound()` child gets no skeleton; if one is ever genuinely needed, it belongs
 * on the SIBLING segments that cannot 404, not on the shared parent.
 */
const files = walk(APP);
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** Every directory holding a `loading.tsx`, as a posix path under src/app. */
const loadingDirs = files.filter((f) => f.endsWith('/loading.tsx')).map((f) => path.posix.dirname(f));

/** Every directory holding a page that calls `notFound()`. */
const notFoundDirs = files
  .filter((f) => f.endsWith('/page.tsx') && /\bnotFound\(\)/.test(read(f)))
  .map((f) => path.posix.dirname(f));

describe('a streaming boundary never swallows a 404', () => {
  it('finds both halves of the question (a scan that matches nothing proves nothing)', () => {
    expect(loadingDirs.length).toBeGreaterThan(0);
    expect(notFoundDirs.length).toBeGreaterThan(0);
  });

  it('no loading.tsx sits at or above a route that calls notFound()', () => {
    const offenders: string[] = [];
    for (const notFoundDir of notFoundDirs) {
      for (const loadingDir of loadingDirs) {
        // At the same segment, or an ancestor of it: both cases put the notFound() page inside
        // that Suspense boundary.
        if (notFoundDir === loadingDir || notFoundDir.startsWith(`${loadingDir}/`)) {
          offenders.push(`${loadingDir}/loading.tsx streams ${notFoundDir}/page.tsx, whose notFound() can no longer set the status`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /** Non-vacuity: the containment test has to actually fire on the pairing that shipped. */
  it('would catch the pairing that shipped in v1.42.0', () => {
    // `string`, not the inferred literal types -- comparing two different literals is a type error
    // rather than a test, which is the compiler correctly pointing out that a hard-coded pair
    // proves nothing about the predicate. This exercises the predicate itself.
    const covers = (loadingDir: string, pageDir: string): boolean =>
      pageDir === loadingDir || pageDir.startsWith(`${loadingDir}/`);

    expect(covers('src/app/(app)/warranties', 'src/app/(app)/warranties/[id]')).toBe(true);
    expect(covers('src/app/(app)/warranties', 'src/app/(app)/warranties')).toBe(true);
    // And does not fire on a sibling, or on a directory that merely shares a prefix.
    expect(covers('src/app/(app)/warranties', 'src/app/(app)/budgets')).toBe(false);
    expect(covers('src/app/(app)/warrant', 'src/app/(app)/warranties/[id]')).toBe(false);
  });
});
