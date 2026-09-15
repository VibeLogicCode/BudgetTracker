import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CSS = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');

/**
 * 2026-09-15. Every colour decision in this app is a token in globals.css, and the tokens were
 * tuned by hand with the ratios written into the comments beside them. This file recomputes them.
 *
 * WHY IT EXISTS. `$impeccable audit` measured the shipped values and found two systemic misses
 * that the hand-tuning had not caught, both for the same reason: the pairs that were checked were
 * text-on-surface and text-on-canvas, and nobody checked the third surface or the non-text cases.
 *   - `--subtle` on `--surface-2` was 4.32:1. That is every `.data-table thead th` in the app,
 *     plus the transactions day-group headers and the import wizard's inactive step chips.
 *   - `--line-strong` as a form-control border was 1.53:1 light / 1.77:1 dark, against a 3:1
 *     requirement for the visual boundary of a control (WCAG 1.4.11). That was every input,
 *     select and textarea in an app that is mostly forms.
 *
 * A comment claiming a ratio cannot fail when the value drifts. This can.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK: whether a pair is ever actually rendered together. It
 * asserts the pairs listed below, which were read off the real stylesheet and components. A new
 * pairing nobody adds here is still unguarded -- this is a regression net for the combinations
 * that exist, not a proof that every combination is safe.
 */
function token(name: string, theme: 'light' | 'dark', seen = new Set<string>()): string {
  // Light values live on `:root`, dark ones on `.dark`. Both blocks declare the same names, so the
  // block has to be sliced out before the lookup -- a bare search finds the light value twice.
  const start = theme === 'light' ? CSS.indexOf(':root {') : CSS.indexOf('.dark {');
  const block = CSS.slice(start, CSS.indexOf('\n}', start));
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(block);
  if (match === null) throw new Error(`no --${name} in the ${theme} block`);
  const value = match[1].trim();
  // A token may alias another rather than carry a hex -- in dark, the graphic fills simply track
  // their text twins (`--positive-solid: var(--positive)`), because on ink the AA-safe text
  // colours are already bright enough to work as fills. Follow the alias rather than fail to parse.
  const alias = /^var\(\s*--([\w-]+)\s*\)$/.exec(value);
  if (alias !== null) {
    if (seen.has(alias[1])) throw new Error(`--${name} aliases itself in the ${theme} block`);
    return token(alias[1], theme, new Set(seen).add(name));
  }
  if (!/^#[0-9a-fA-F]{3,8}$/.test(value)) throw new Error(`--${name} is not a flat colour: ${value}`);
  return value;
}

const channel = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

function luminance(hex: string): number {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** fg, bg, minimum, and what renders this pair -- so a failure names the screen, not two hexes. */
type Pair = [fg: string, bg: string, min: number, where: string];

/** WCAG 1.4.3: 4.5:1 for normal text. Every one of these is normal-size text somewhere. */
const TEXT: Pair[] = [
  ['ink', 'surface', 4.5, 'body text on a card'],
  ['ink', 'canvas', 4.5, 'body text on the page ground'],
  ['muted', 'surface', 4.5, 'secondary text on a card'],
  ['muted', 'canvas', 4.5, 'secondary text on the page ground'],
  ['muted', 'surface-2', 4.5, 'CardFooter text'],
  ['subtle', 'surface', 4.5, 'the .eyebrow label on a card'],
  ['subtle', 'canvas', 4.5, 'the version footer'],
  ['subtle', 'surface-2', 4.5, '.data-table thead th, transactions day headers, import step chips'],
  ['accent-text', 'surface', 4.5, 'a link on a card'],
  ['accent-text', 'canvas', 4.5, 'a link on the page ground'],
  ['accent-soft-fg', 'accent-soft', 4.5, 'the active nav item, .badge--accent'],
  ['positive-soft-fg', 'positive-soft', 4.5, '.badge--green'],
  ['negative-soft-fg', 'negative-soft', 4.5, '.badge--red'],
  ['warning-soft-fg', 'warning-soft', 4.5, '.badge--amber, the review count'],
  ['info-soft-fg', 'info-soft', 4.5, '.badge--blue, the page guide'],
  ['neutral-soft-fg', 'neutral-soft', 4.5, '.badge--slate'],
  ['positive', 'surface', 4.5, 'money in'],
  ['negative', 'surface', 4.5, 'money out'],
];

/**
 * WCAG 1.4.11: 3:1 for a control's visual boundary and for meaningful graphics. `--field-border`
 * is separate from `--line-strong` precisely because of this rule: a divider is decorative and has
 * no floor, a control's edge does, and one token cannot be both without over-darkening every rule
 * in the app.
 */
const NON_TEXT: Pair[] = [
  ['field-border', 'field-bg', 3, 'the edge of every input, select and textarea'],
  ['field-border', 'surface', 3, 'a control, or a secondary button, sitting directly on a card'],
  ['field-border', 'canvas', 3, 'a control on the page ground'],
  ['focus', 'canvas', 3, 'the focus ring on the page ground'],
  ['focus', 'surface', 3, 'the focus ring on a card'],
  ['positive-solid', 'surface', 3, 'a meter filled to a good value'],
  ['warning-solid', 'surface', 3, 'a meter near its limit'],
  ['negative-solid', 'surface', 3, 'a meter over its limit'],
];

/**
 * The placeholder is tuned DOWNWARD on purpose (globals.css explains it at length): a hint that
 * reads as strongly as a value makes an empty field look pre-filled. So it is bounded on BOTH
 * sides -- above a hairline so it stays legible, below `--subtle` so a typed value always wins.
 */
describe('placeholder text is quieter than a value, and louder than a border', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: sits between the hairline and --subtle`, () => {
      const placeholder = ratio(token('placeholder', theme), token('field-bg', theme));
      const subtle = ratio(token('subtle', theme), token('field-bg', theme));
      expect(placeholder).toBeGreaterThan(2.5);
      expect(placeholder).toBeLessThan(subtle);
    });
  }
});

describe('WCAG 1.4.3: text clears 4.5:1 in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const [fg, bg, min, where] of TEXT) {
      it(`${theme}: --${fg} on --${bg} (${where})`, () => {
        const value = ratio(token(fg, theme), token(bg, theme));
        expect({ pair: `${fg}/${bg}`, ratio: Number(value.toFixed(2)) }).toEqual({
          pair: `${fg}/${bg}`,
          ratio: expect.any(Number),
        });
        expect(value).toBeGreaterThanOrEqual(min);
      });
    }
  }
});

describe('WCAG 1.4.11: control boundaries and meaningful graphics clear 3:1 in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const [fg, bg, min, where] of NON_TEXT) {
      it(`${theme}: --${fg} on --${bg} (${where})`, () => {
        expect(ratio(token(fg, theme), token(bg, theme))).toBeGreaterThanOrEqual(min);
      });
    }
  }
});

/** Non-vacuity: the maths has to actually reject something, or the file guards nothing. */
describe('the ratio calculation is real', () => {
  it('scores the extremes correctly', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(ratio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('rejects the value that shipped: #6e6e88 on #efeff7 was 4.32', () => {
    expect(ratio('#6e6e88', '#efeff7')).toBeLessThan(4.5);
  });

  it('rejects the border that shipped: --line-strong on a field was 1.53', () => {
    expect(ratio('#cfcfe4', '#ffffff')).toBeLessThan(3);
  });
});
