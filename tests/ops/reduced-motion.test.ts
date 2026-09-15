import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CSS = fs.readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8');

/** Same walk() shape as the other ops guards. */
function walk(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

/**
 * 2026-09-15, from `$impeccable audit`: the reduced-motion block killed every animation in the app
 * with one `animation-duration: 0.01ms !important`, and two of the things it killed were not
 * decoration — the four loading skeletons and the AutoSave spinner. A frozen spinner reads as a
 * hung app; unpulsing skeletons read as a broken page. Reduced motion means less movement, not
 * less information.
 *
 * So there is one opt-out class, `.motion-keep`, and this file is what keeps it honest in both
 * directions: the exemption must still exist in the CSS, and every user of it must be a genuine
 * loading indicator rather than somebody's decorative flourish that wanted to survive.
 */
const MOTION_KEEP_ALLOWED: Record<string, string> = {
  'src/app/(app)/reports/loading.tsx':
    'the Reports route skeleton — frozen, it is two grey boxes that read as a broken page rather than a loading one',
  'src/app/(app)/transactions/loading.tsx':
    'the Transactions route skeleton — same reason; this is the page the household opens most',
  'src/components/ui/AutoSave.tsx':
    'the save-in-progress spinner — stopped at one frame it says "this app has hung", which is the opposite of its job',
  'src/components/ui/PageSkeleton.tsx':
    'the shared route skeleton behind every loading.tsx — a still one is indistinguishable from a page that finished loading badly, which is the whole thing it exists to rule out',
};

const files = walk('src');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/**
 * The repo's established stripComments pattern, and it earns its place here: the chart barrel
 * (src/components/charts/lazy.tsx) explains in a comment why its own skeleton is deliberately NOT
 * animated, and a raw text scan counted that explanation as a claim on the exemption. Punishing a
 * file for documenting the rule is how the documentation gets deleted.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('reduced motion drops decoration and keeps feedback', () => {
  it('still resets animation and transition for everything unexempted', () => {
    const block = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toContain('animation-duration: 0.01ms !important');
    expect(block).toContain('transition-duration: 0.01ms !important');
    expect(block).toContain('scroll-behavior: auto !important');
  });

  it('carves out exactly one exemption, by class', () => {
    const block = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toContain('*:not(.motion-keep)');
  });

  /**
   * The point of the guard. A future skeleton that forgets the class is a silent regression -- it
   * simply stops animating for the people who asked for reduced motion, and nobody sees it,
   * because the person who set that preference is rarely the person writing the component.
   */
  it('every spinner and skeleton in the app carries the exemption', () => {
    const missing: string[] = [];
    for (const file of files) {
      for (const line of read(file).split('\n')) {
        if (!/\banimate-(pulse|spin)\b/.test(line)) continue;
        if (!line.includes('motion-keep')) missing.push(`${file}: ${line.trim().slice(0, 80)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('nothing else claims the exemption', () => {
    const users = files.filter((file) => stripComments(read(file)).includes('motion-keep'));
    expect(users.sort()).toEqual(Object.keys(MOTION_KEEP_ALLOWED).sort());
  });

  it('every exemption states why it is feedback rather than decoration', () => {
    const thin = Object.entries(MOTION_KEEP_ALLOWED).filter(([, why]) => why.trim().length < 60);
    expect(thin.map(([file]) => file)).toEqual([]);
  });

  /** Non-vacuity: a scan that finds no animations would pass every check above while guarding nothing. */
  it('finds the indicators it is guarding', () => {
    const animated = files.filter((file) => /\banimate-(pulse|spin)\b/.test(read(file)));
    expect(animated.length).toBeGreaterThanOrEqual(3);
  });
});
