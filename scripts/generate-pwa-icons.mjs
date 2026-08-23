#!/usr/bin/env node
/**
 * Renders the PWA icons from a hand-drawn mark: a rounded-square background in the app's
 * accent color with a dollar-in-circle glyph on top. The glyph is built entirely from SVG
 * shapes (circle + line + curve paths), never a <text> element — text rendering depends on
 * fonts installed on whatever machine happens to run this script, and would come out
 * differently (or not at all) elsewhere. sharp is already a dependency (receipt pipeline);
 * it rasterizes SVG via librsvg under the hood, so no new dependency is needed here.
 *
 * Run with `node scripts/generate-pwa-icons.mjs`. Output is committed to public/icons/, so
 * this only needs to be re-run by hand if the mark or the accent color ever changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'public', 'icons');

// Copied verbatim from the LIGHT theme in src/app/globals.css (`:root`) — do not invent new
// colors here. --accent is the fill; --accent-fg is the color already paired with it
// everywhere else in the app for content sitting on an accent-filled surface (e.g.
// `.btn--primary { color: var(--accent-fg) }`), so it is the correct glyph color too.
const ACCENT = '#4b49d6';
const ACCENT_FG = '#ffffff';

/**
 * The dollar-in-circle mark, authored in a 100x100 unit box centered on (50,50).
 *
 * - `cornerRadius` rounds the background square. It is 0 for the full-bleed variants
 *   (maskable, apple-touch): the OS applies its own shape mask to those, and a
 *   self-rounded background would then show as a visibly smaller shape floating inside
 *   that mask instead of filling it.
 * - `ringRadius` sets how large the circle+glyph sit inside the box. The maskable variant
 *   passes a radius scaled to ~80% of the normal one, which is the inset Android's
 *   adaptive-icon "safe zone" wants so a circular launcher mask does not clip the glyph.
 */
function markSvg({ size, cornerRadius, ringRadius }) {
  const strokeWidth = ringRadius * 0.14;
  const vHalf = ringRadius * 0.84;
  // The dollar glyph below is authored for ringRadius === 32; `s` scales it (and its stroke)
  // proportionally for any other ringRadius (currently only the ~80% maskable inset).
  const s = ringRadius / 32;
  const dx = (x) => 50 + (x - 50) * s;
  const dy = (y) => 50 + (y - 50) * s;

  // A minimal two-bowl "S" stroke: the classic dollar-sign squiggle. Stroked (not filled)
  // with round caps/joins so it reads as one continuous glyph rather than a filled outline
  // that would need exact closure.
  const dollarCurve =
    `M ${dx(60)} ${dy(36)} ` +
    `C ${dx(60)} ${dy(26)} ${dx(40)} ${dy(26)} ${dx(40)} ${dy(36)} ` +
    `C ${dx(40)} ${dy(46)} ${dx(60)} ${dy(54)} ${dx(60)} ${dy(64)} ` +
    `C ${dx(60)} ${dy(74)} ${dx(40)} ${dy(74)} ${dx(40)} ${dy(64)}`;
  const dollarSpine = `M ${dx(50)} ${dy(50 - vHalf)} L ${dx(50)} ${dy(50 + vHalf)}`;
  // A full circle drawn as two arcs (a single SVG arc command cannot close 360 degrees).
  const ring = `M ${50 - ringRadius} 50 A ${ringRadius} ${ringRadius} 0 1 0 ${50 + ringRadius} 50 A ${ringRadius} ${ringRadius} 0 1 0 ${50 - ringRadius} 50 Z`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">
  <rect x="0" y="0" width="100" height="100" rx="${cornerRadius}" fill="${ACCENT}" />
  <path d="${ring}" fill="none" stroke="${ACCENT_FG}" stroke-width="${strokeWidth}" />
  <path d="${dollarSpine}" fill="none" stroke="${ACCENT_FG}" stroke-width="${strokeWidth}" stroke-linecap="round" />
  <path d="${dollarCurve}" fill="none" stroke="${ACCENT_FG}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />
</svg>`;
}

const REGULAR_RING_RADIUS = 32;
const MASKABLE_RING_RADIUS = REGULAR_RING_RADIUS * 0.8; // ~80% inset, per the safe-zone note above

const targets = [
  { file: 'icon-192.png', size: 192, cornerRadius: 22, ringRadius: REGULAR_RING_RADIUS },
  { file: 'icon-512.png', size: 512, cornerRadius: 22, ringRadius: REGULAR_RING_RADIUS },
  { file: 'maskable-512.png', size: 512, cornerRadius: 0, ringRadius: MASKABLE_RING_RADIUS },
  // Apple applies its own corner mask to whatever square icon it is given, so this ships
  // full-bleed too (Apple's own guidance: do not pre-round apple-touch-icon).
  { file: 'apple-touch-icon.png', size: 180, cornerRadius: 0, ringRadius: MASKABLE_RING_RADIUS },
];

fs.mkdirSync(outDir, { recursive: true });

for (const target of targets) {
  const svg = markSvg(target);
  const outPath = path.join(outDir, target.file);
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  console.log(`wrote ${outPath} (${fs.statSync(outPath).size} bytes, ${target.size}x${target.size})`);
}
