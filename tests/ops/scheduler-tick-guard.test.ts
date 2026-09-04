import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE_PATH = path.join(process.cwd(), 'src/lib/scheduler.ts');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

/**
 * O-03. The defect this guard exists for: runNotifyTick's dormancy bail -- two DATABASE reads
 * (hasAnyEnabledTarget(), countPendingOutbox()) -- used to sit ABOVE its own try, so a throw
 * there (a locked database, a full disk, a corrupted page) propagated out of the cron callback
 * uncaught. This is the THIRD time this exact shape of bug has shown up in this file --
 * runUpdateTick and runSimplefinTick each carry their own comment recording the identical fix.
 * Rather than trust the next edit to remember that history, this is the reusable version: a
 * source scan, in the style of tests/ops/client-bundle.test.ts (not a full parser, deliberately
 * -- every exported run*Tick/run*Job in this file follows the same
 * `export function runXxx(now: Date = new Date()): void { ... }` shape, so a small, honest regex
 * walk is enough).
 *
 * The rule: nothing between a tick's opening brace and its first `try {` may CALL anything --
 * the one thing every tick is allowed there is the `ticking` single-flight boolean, checked
 * and/or assigned, never called. A call there can throw; the boolean check cannot.
 */

/** Control-flow keywords read as an identifier immediately followed by `(`, exactly the shape a
 *  real call has (`if (x)`, `while (x)`) -- excluded by name rather than mistaken for a call. */
const CONTROL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'typeof',
  'instanceof',
  'do',
  'else',
  'in',
  'of',
  'yield',
  'await',
]);

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every `identifier(` in `span` whose identifier is not a control-flow keyword -- i.e. every
 *  real call. An empty result is the only shape MUST-6.3/6.4 (and the update/simplefin ticks'
 *  own equivalent gates) allow before the try. */
function callsIn(span: string): string[] {
  const clean = stripComments(span);
  const calls: string[] = [];
  const re = /([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(clean))) {
    if (!CONTROL_KEYWORDS.has(match[1])) calls.push(match[1]);
  }
  return calls;
}

/**
 * Walks from the `(` right after the function name to ITS matching `)` -- a plain depth
 * counter, because every tick's default parameter (`now: Date = new Date()`) nests its own
 * parentheses, which a non-greedy `\(.*?\)` regex would stop inside of instead of at the
 * signature's real close. Returns the index of the function's own opening brace, found just
 * after that matching `)` (skipping the return-type annotation in between, e.g. `): void {`).
 */
function bodyBraceIndex(text: string, nameStart: number): number {
  const parenOpen = text.indexOf('(', nameStart);
  let depth = 0;
  let i = parenOpen;
  for (; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  const brace = text.indexOf('{', i);
  if (brace === -1) {
    throw new Error(`scheduler tick guard: no opening brace found after the signature at index ${nameStart}`);
  }
  return brace;
}

interface TickFn {
  name: string;
  bodyStart: number;
}

function findTickFunctions(text: string): TickFn[] {
  const fns: TickFn[] = [];
  const re = /export function (run\w*(?:Tick|Job))\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    fns.push({ name: match[1], bodyStart: bodyBraceIndex(text, match.index) });
  }
  return fns;
}

describe("O-03: a scheduler tick's pre-try section never calls anything that can throw", () => {
  const tickFns = findTickFunctions(source);

  // A scan matching nothing proves nothing (same discipline as client-bundle.test.ts's own
  // sanity check) -- pin the exact set so a future tick added to this file is caught by name,
  // not silently skipped by a regex that stopped matching.
  it('finds exactly the five exported ticks (a scan that matches nothing proves nothing)', () => {
    expect(tickFns.map((f) => f.name).sort()).toEqual(
      ['runCanadianPackUpdateTick', 'runNightlyTick', 'runNotifyTick', 'runSimplefinTick', 'runUpdateTick'].sort(),
    );
  });

  for (const { name, bodyStart } of tickFns) {
    it(`${name}: nothing but the single-flight boolean check runs before its try`, () => {
      const nextFn = source.indexOf('export function run', bodyStart + 1);
      const bound = nextFn === -1 ? source.length : nextFn;
      const tryAt = source.indexOf('try {', bodyStart);
      expect(tryAt, `${name}: no 'try {' found in its body`).toBeGreaterThan(-1);
      expect(tryAt, `${name}: 'try {' found past the next exported function -- the scan window is wrong`).toBeLessThan(
        bound,
      );

      const span = source.slice(bodyStart + 1, tryAt);
      const calls = callsIn(span);
      expect(
        calls,
        `${name}: a scheduler tick's pre-try section must not call anything that can throw -- a throw there ` +
          'escapes the cron callback. Move it inside the try, as runNightlyJob and runNotifyTick already do.',
      ).toEqual([]);
    });
  }

  describe('scanner correctness (synthetic fixtures)', () => {
    it('callsIn finds a real call but not an `if (identifier)` single-flight check', () => {
      expect(callsIn('if (ticking) return;\n  ticking = true;\n')).toEqual([]);
      expect(callsIn('if (!hasAnyEnabledTarget() && countPendingOutbox() === 0) return;\n')).toEqual([
        'hasAnyEnabledTarget',
        'countPendingOutbox',
      ]);
    });

    it('bodyBraceIndex skips a default parameter\'s own nested parentheses', () => {
      const fixture = 'export function runFoo(now: Date = new Date()): void {\n  try {\n  } catch {}\n}';
      const brace = bodyBraceIndex(fixture, fixture.indexOf('export function runFoo'));
      expect(fixture.slice(brace, brace + 1)).toBe('{');
      expect(fixture.slice(brace)).toMatch(/^\{\s*try \{/);
    });
  });
});
