// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, cleanup } from '@testing-library/react';
import { HELP_ROUTINE, HELP_SECTIONS, type HelpSection } from '@/app/(app)/help/content';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contentSource = fs.readFileSync(path.join(root, 'src/app/(app)/help/content.tsx'), 'utf8');
const pageSource = fs.readFileSync(path.join(root, 'src/app/(app)/help/page.tsx'), 'utf8');
const globalCss = fs.readFileSync(path.join(root, 'src/app/globals.css'), 'utf8');

afterEach(cleanup);

/**
 * Comments stripped, in the idiom of tests/ops/balance-invariants.test.ts: the rules asserted
 * below are rules about what the page RENDERS, and a docblock that explains why <details> is
 * banned must be free to name it.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function textOf(node: React.ReactNode): string {
  const { container } = render(<>{node}</>);
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function section(id: string): HelpSection {
  const found = HELP_SECTIONS.find((entry) => entry.id === id);
  if (!found) throw new Error(`no help section with id "${id}" (have: ${HELP_SECTIONS.map((s) => s.id).join(', ')})`);
  return found;
}

/**
 * Guard-test contract with tests/ops/onboarding-coverage.test.ts (T9): one section per nav
 * section, and the href literal itself present in that section's own rendered output. The nine
 * are spelled out here rather than imported from NAV so that this file keeps asserting the same
 * nine after NAV grows a tenth (/help) entry that documents nothing.
 */
const SECTION_FOR_HREF: Record<string, string> = {
  '/dashboard': 'dashboard',
  '/transactions': 'transactions',
  '/review': 'review',
  '/import': 'import',
  '/budgets': 'budgets',
  '/goals': 'goals',
  '/warranties': 'coverage',
  '/reports': 'reports',
  '/settings': 'settings',
};

describe('the help page: part 1, the routine', () => {
  it('is one flat section with an id and a title', () => {
    expect(HELP_ROUTINE.id).toBeTruthy();
    expect(HELP_ROUTINE.title).toBeTruthy();
  });

  it('states the four steps in dependency order', () => {
    const copy = textOf(HELP_ROUTINE.body);
    const needles = [
      'Once a month, download a statement from each bank',
      'Import each file',
      'Clear whatever Review flags',
      'Then look at Budgets',
    ];
    let cursor = -1;
    for (const needle of needles) {
      const at = copy.indexOf(needle);
      expect(at, needle).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('labels itself as a suggestion, not a requirement (ruling A2)', () => {
    expect(textOf(HELP_ROUTINE.body)).toContain('one suggested rhythm, not a requirement');
  });

  it('explains what a CSV is, for a reader who has never seen one', () => {
    expect(textOf(HELP_ROUTINE.body)).toContain('A CSV file is a plain text file of rows and columns');
  });

  it('gives no financial advice: no amount, no percentage, no savings target (ruling A2)', () => {
    const copy = textOf(HELP_ROUTINE.body);
    expect(copy).not.toMatch(/\$\s?\d/);
    expect(copy).not.toMatch(/\d\s?%/);
    expect(copy).not.toMatch(/you should (spend|save|budget|aim)/i);
  });
});

describe('the help page: part 2, the feature index', () => {
  it('has one section per nav section, with unique ids', () => {
    const ids = HELP_SECTIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [href, id] of Object.entries(SECTION_FOR_HREF)) {
      expect(section(id), href).toBeTruthy();
    }
  });

  it('renders the href literal inside its own section (T9 greps for these)', () => {
    for (const [href, id] of Object.entries(SECTION_FOR_HREF)) {
      expect(textOf(section(id).body), `${href} in section ${id}`).toContain(href);
    }
  });

  it('every section has a title and a body that says something', () => {
    for (const entry of HELP_SECTIONS) {
      expect(entry.title, entry.id).toBeTruthy();
      expect(textOf(entry.body).length, entry.id).toBeGreaterThan(200);
    }
  });
});

describe('the help page covers the features no screen advertises', () => {
  const all = () => textOf(<>{[HELP_ROUTINE, ...HELP_SECTIONS].map((s) => <div key={s.id}>{s.body}</div>)}</>);

  const cases: [string, RegExp][] = [
    ['sharing packs', /Sharing packs/],
    ['the cardholder column', /cardholder column/],
    ['deactivating a mapping instead of deleting it', /deactivated instead of deleted/],
    ['statement balances', /statement balance/i],
    ['a balance as a snapshot plus movement', /newest balance figure on or before that date, plus every transaction/],
    ['receipt text being searchable', /every word printed on/],
    ['OCR running on the server with no internet', /no internet connection at all/],
    ['SimpleFIN being optional', /SimpleFIN/],
    ['CSV import working without it', /CSV import always works without it/],
    ['nightly backups', /nightly/],
    ['where a restore can be verified', /shows the outcome of the last restore/],
  ];

  for (const [label, pattern] of cases) {
    it(`names ${label}`, () => {
      expect(all()).toMatch(pattern);
    });
  }
});

describe('the help page covers the v1.13.0 household features', () => {
  const all = () => textOf(<>{[HELP_ROUTINE, ...HELP_SECTIONS].map((s) => <div key={s.id}>{s.body}</div>)}</>);

  const cases: [string, RegExp][] = [
    ['a self-scoped member sees only their own records', /Only their own records/],
    ['what a self view excludes', /No account balances, no\s*net worth, no household totals/],
    ['the self view is not a second household', /needs its own container/],
    ['a person who cannot sign in', /person only/i],
    ['the audit log', /audit log/i],
    ['quick add', /Quick add/],
    ['quick add remembers the last account', /remembers whichever one you used last/],
    ['the Needs a look card', /Needs a look/],
    ['notes are searched, not just descriptions', /search box reads notes as well as descriptions/],
    ['Record payment on a bill installment', /Record payment/],
    ['OFX\\/QFX files', /OFX and QFX files/],
    ['the RBC, BMO and CIBC presets are unverified', /rather than\s*checked against a real file yet/],
    ['savings accounts are left out of safe-to-spend', /left out of safe-to-spend/],
    ['asset accounts count toward net worth', /counts toward net worth/],
    ['the sinking-fund line on a linked budget category', /sinking fund/],
  ];

  for (const [label, pattern] of cases) {
    it(`names ${label}`, () => {
      expect(all()).toMatch(pattern);
    });
  }
});

describe('the help page obeys the standing content rules', () => {
  it('ruling A8: uses no <details> anywhere, so Print-to-PDF needs nothing forced open', () => {
    expect(code(contentSource)).not.toContain('<details');
    expect(code(pageSource)).not.toContain('<details');
    const { container } = render(<>{HELP_SECTIONS.map((s) => <div key={s.id}>{s.body}</div>)}</>);
    expect(container.querySelectorAll('details')).toHaveLength(0);
  });

  it('renders no anchor to any external address (the guides.tsx rule)', () => {
    const { container } = render(
      <>{[HELP_ROUTINE, ...HELP_SECTIONS].map((s) => <div key={s.id}>{s.body}</div>)}</>,
    );
    for (const anchor of container.querySelectorAll('a')) {
      expect(anchor.getAttribute('href') ?? '').toMatch(/^[#/]/);
    }
  });

  it('ruling A1: never tells a reader to contact anyone instead of documenting something', () => {
    expect(code(contentSource)).not.toMatch(/contact the (author|maintainer|developer)/i);
    expect(code(contentSource)).not.toMatch(/(file|open|raise) an issue/i);
    expect(code(contentSource)).not.toMatch(/github/i);
  });
});

describe('the help page layout', () => {
  it('renders the routine and every section from content.tsx', () => {
    expect(pageSource).toContain('HELP_ROUTINE');
    expect(pageSource).toContain('HELP_SECTIONS');
  });

  it('carries a sticky table of contents linking each section id', () => {
    expect(pageSource).toMatch(/sticky/);
    expect(pageSource).toMatch(/href=\{`#\$\{/);
    expect(pageSource).toMatch(/id=\{/);
  });
});

describe('the print stylesheet', () => {
  const block = globalCss.slice(globalCss.indexOf('@media print'));

  it('exists at all', () => {
    expect(globalCss).toContain('@media print');
  });

  it('hides the nav rail, the sticky header, the mobile menu button and the version footer', () => {
    expect(block).toContain('aside');
    expect(block).toContain('header');
    expect(block).toContain('footer');
    expect(block).toContain('mobile-nav');
  });
});
