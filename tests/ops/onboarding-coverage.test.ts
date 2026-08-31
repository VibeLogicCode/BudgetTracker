import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV } from '@/components/app-shell/nav';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(root, rel));

/**
 * The three guards in this file are the only reason the onboarding content of spec
 * 2026-08-23 cannot rot. Every other test in this release covers a file someone chose to
 * write a fixture for; these cover the whole of a *set* -- every EmptyState call site,
 * every NAV entry -- which is the one shape a fixture-driven test can never enforce (the
 * argument tests/ops/balance-invariants.test.ts makes for itself).
 *
 * Grep guards rather than rendering tests, and no expected count anywhere: a hardcoded
 * "21 call sites" would turn a 22nd uncovered call site into a passing assertion about
 * yesterday's codebase.
 */

/**
 * The help page is the only route excluded from guards 2 and 3, and the reason is
 * structural, not editorial: it would otherwise have to document itself in its own feature
 * index and carry a panel explaining what a help page is. Ruling A7's "no allowlist" still
 * stands -- this is one route excluded for a stated reason, not a set of pages someone
 * judged self-evident. Anything added here needs the same kind of justification.
 */
const GUIDE_EXEMPT_HREFS = ['/help'] as const;

const guardedNav = NAV.filter(
  (item) => !(GUIDE_EXEMPT_HREFS as readonly string[]).includes(item.href),
);

/** Every `.tsx` under src/, so a new call site in a new file is in scope the day it lands. */
function tsxFiles(relDir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, relDir), { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...tsxFiles(rel));
    else if (entry.name.endsWith('.tsx')) out.push(rel);
  }
  return out;
}

/**
 * The props region of one JSX element: from `<Name` to the `>` or `/>` that ends its
 * opening tag, tracking bracket depth and quoting so a `>` inside `action={<Link ...>}`
 * does not end the scan early.
 *
 * Reading only the opening tag is deliberate. Scanning to `</EmptyState>` instead would
 * pass an EmptyState whose *children* happen to mention `action=`, which is the failure
 * mode that makes a guard read as coverage while guarding nothing.
 */
function openingTag(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

/**
 * file:line for every `<EmptyState` whose opening tag carries neither `action=` nor `noAction=`.
 *
 * This spec's own ruling was "because every kind has a correct action, the guard test needs no
 * allowlist" -- and it still doesn't: `noAction` (added by the 2026-08-30 one-design-language
 * plan when it converted seven hand-rolled empty boxes to this component; see EmptyState.tsx's
 * own docblock) is not an allowlist of exempt FILES, it is a second, equally explicit prop a call
 * site must opt INTO, one at a time, with a written reason `emptyStatesWithWeakNoActionReason`
 * below checks is real. An omission is still a failure here -- only a literal `action=` or
 * `noAction=` on the tag satisfies this guard, never a missing prop that merely happens not to
 * be `action`.
 */
function emptyStatesWithoutActionOrReason(): string[] {
  const offenders: string[] = [];
  for (const file of tsxFiles('src')) {
    const source = read(file);
    // The component itself declares the prop; only call sites are call sites.
    if (file.endsWith('components/ui/EmptyState.tsx')) continue;
    const pattern = /<EmptyState(?=[\s/>])/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const tag = openingTag(source, match.index);
      if (!/\baction\s*=/.test(tag) && !/\bnoAction\s*=/.test(tag)) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${file}:${line}`);
      }
    }
  }
  return offenders;
}

/**
 * file:line for every `<EmptyState` whose `noAction=` string is under 30 characters -- guards
 * against the escape hatch above rotting into a one-word rubber stamp ("n/a", "none") instead of
 * the sentence a reviewer can actually judge. 30 is not a precise number, only long enough that
 * "no action" (10 chars) and similar non-answers cannot pass while a real sentence can.
 */
function emptyStatesWithWeakNoActionReason(): string[] {
  const offenders: string[] = [];
  for (const file of tsxFiles('src')) {
    const source = read(file);
    if (file.endsWith('components/ui/EmptyState.tsx')) continue;
    const pattern = /<EmptyState(?=[\s/>])/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const tag = openingTag(source, match.index);
      const reason = /\bnoAction\s*=\s*"([^"]*)"/.exec(tag);
      if (reason && reason[1].trim().length < 30) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${file}:${line}`);
      }
    }
  }
  return offenders;
}

/**
 * The files a nav href's guide could legitimately live in: the route's `page.tsx`, plus
 * whatever local modules it imports. PageGuide sits in the client component for seven of
 * the nine guided routes and in `page.tsx` for the other two, so resolving the imports is
 * the only version of this guard that does not hardcode today's split -- and a route that
 * moves its guide from server to client component, or renames its client file, must not
 * need this test edited.
 */
function guideCandidates(href: string): string[] {
  // v1.14.1: a NAV href may now carry a query string (`/transactions?review=1`, the filter that
  // replaced the /review page). The guide it must carry is the one on the page the path names,
  // so resolve the path half and let the filter inherit its page's guide.
  const dir = `src/app/(app)${href.split('?')[0]}`;
  const pageFile = `${dir}/page.tsx`;
  if (!exists(pageFile)) return [];
  const files = [pageFile];
  const source = read(pageFile);
  const pattern = /from\s+['"](\.\.?\/[^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const resolved = `${path.posix.normalize(path.posix.join(dir, match[1]))}.tsx`;
    if (exists(resolved)) files.push(resolved);
  }
  return files;
}

describe('Guard 1 (spec 2026-08-23, Component 6): every EmptyState offers an action', () => {
  it('finds the call sites at all -- an empty scan would make this guard vacuous', () => {
    let total = 0;
    for (const file of tsxFiles('src')) {
      total += (read(file).match(/<EmptyState(?=[\s/>])/g) ?? []).length;
    }
    // Deliberately a floor, not the current count: an added call site must not fail here,
    // it must fail the assertion below, with its own file:line.
    expect(total).toBeGreaterThan(15);
  });

  it('every <EmptyState call site in src/ passes action= or noAction= (2026-08-30 plan: the explicit no-action exception)', () => {
    expect(emptyStatesWithoutActionOrReason()).toEqual([]);
  });

  it('every noAction= carries a real written reason, not a rubber-stamp placeholder', () => {
    expect(emptyStatesWithWeakNoActionReason()).toEqual([]);
  });

  it('scanner correctness: the opening-tag parser catches a missing action and is not fooled by children', () => {
    // The same self-check discipline as tests/ops/balance-invariants.test.ts's synthetic
    // fixtures -- prove the parser fires before trusting it with the real tree.
    const withAction = `<EmptyState icon={Icon} title="x" action={<Link href="/a">go</Link>}>body</EmptyState>`;
    expect(/\baction\s*=/.test(openingTag(withAction, 0))).toBe(true);

    const bare = `<EmptyState icon={Icon} title="x">body</EmptyState>`;
    expect(/\baction\s*=/.test(openingTag(bare, 0))).toBe(false);
    expect(/\bnoAction\s*=/.test(openingTag(bare, 0))).toBe(false);

    // An action= belonging to a child element must NOT satisfy the parent.
    const childOnly = `<EmptyState icon={Icon} title="x"><Thing action={y} /></EmptyState>`;
    expect(/\baction\s*=/.test(openingTag(childOnly, 0))).toBe(false);

    // noAction= alone (no action=) must satisfy the "carries one or the other" guard.
    const withReason = `<EmptyState title="x" noAction="A real, specific, thirty-plus character reason." />`;
    expect(/\baction\s*=/.test(openingTag(withReason, 0))).toBe(false);
    expect(/\bnoAction\s*=/.test(openingTag(withReason, 0))).toBe(true);
  });
});

/**
 * Whole-path-segment match for `href` inside `content`: neither edge of the match may sit
 * adjacent to a word character, `-`, or `/`, so `/settings/goals` does not satisfy `/goals`
 * (leading boundary) any more than `/settings` used to satisfy `/settings` by matching inside
 * `/settings/accounts` (trailing boundary, ruling P20's original fix). Shared by the guard and
 * its own self-check so the two cannot drift into testing different regexes.
 */
const documented = (href: string, content: string) =>
  new RegExp(`(?<![\\w-])${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w\\-/])`).test(content);

describe('Guard 2 (ruling A7): every nav section is documented in the help page', () => {
  it('guards every NAV entry except the stated exemption', () => {
    expect(guardedNav.length).toBe(NAV.length - GUIDE_EXEMPT_HREFS.length);
    expect(guardedNav.map((item) => item.href)).not.toContain('/help');
  });

  it('each non-exempt NAV href appears as a WHOLE PATH SEGMENT in the help feature index', () => {
    const content = read('src/app/(app)/help/content.tsx');
    // Item B (ruling P20). This was content.includes(item.href), so /settings was satisfied six
    // times over by /settings/accounts and friends -- and a future /report or /budget route
    // would have been silently satisfied by the already-documented /reports or /budgets, which
    // is the one failure this guard exists to prevent.
    const undocumented = guardedNav.filter((item) => !documented(item.href, content));
    expect(undocumented.map((item) => `${item.href} (${item.label})`)).toEqual([]);
  });

  it('does not accept a strict prefix as documentation (the failure this guard is for)', () => {
    expect(documented('/report', '<Where path="/reports">Reports —</Where>')).toBe(false);
    expect(documented('/reports', '<Where path="/reports">Reports —</Where>')).toBe(true);
  });

  it('does not accept a strict suffix as documentation either (the leading-boundary case)', () => {
    // /settings/goals contains /goals as a trailing segment; without the leading boundary
    // (?<![\w-]) that would satisfy a NAV entry for /goals that is documented nowhere.
    expect(documented('/goals', '/settings/goals')).toBe(false);
    expect(documented('/goals', '<Where path="/goals">Goals —</Where>')).toBe(true);
  });
});

describe('Guard 3 (ruling A7): every nav section renders a PageGuide', () => {
  it('each non-exempt NAV href has a page.tsx or a local module it imports rendering <PageGuide', () => {
    const missing: string[] = [];
    for (const item of guardedNav) {
      const candidates = guideCandidates(item.href);
      expect(candidates.length, `${item.href} has no page.tsx under src/app/(app)`).toBeGreaterThan(0);
      if (!candidates.some((file) => read(file).includes('<PageGuide'))) {
        missing.push(`${item.href} (searched ${candidates.join(', ')})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
