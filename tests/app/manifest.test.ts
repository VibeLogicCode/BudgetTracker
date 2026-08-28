import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import manifest from '@/app/manifest';

const repoRoot = process.cwd();

/**
 * Pulls a `--token: #hex;` value out of the LIGHT (`:root`) block of globals.css, so this test
 * reads the same source of truth the manifest is supposed to copy from. If a future edit moves
 * the token's hex value and nobody updates src/app/manifest.ts to match, this fails instead of
 * silently drifting — the whole reason Task 17 was told not to invent new colors.
 */
function lightToken(name: string): string {
  const css = fs.readFileSync(path.join(repoRoot, 'src/app/globals.css'), 'utf8');
  const rootStart = css.indexOf(':root');
  const darkStart = css.indexOf('.dark {');
  expect(rootStart).toBeGreaterThanOrEqual(0);
  expect(darkStart).toBeGreaterThan(rootStart);
  const lightBlock = css.slice(rootStart, darkStart);
  const match = lightBlock.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`--${name} not found in the :root block of src/app/globals.css`);
  return match[1];
}

describe('src/app/manifest.ts (GET /manifest.webmanifest)', () => {
  it('returns the required PWA fields', () => {
    const result = manifest();
    expect(result.name).toBe('Budget Tracker');
    expect(result.short_name).toBe('Budget');
    expect(result.display).toBe('standalone');
    expect(result.start_url).toBe('/dashboard');
  });

  it('lists all four generated icon files', () => {
    const result = manifest();
    const srcs = (result.icons ?? []).map((icon) => icon.src);
    expect(srcs).toHaveLength(4);
    expect(srcs).toEqual(
      expect.arrayContaining([
        '/icons/icon-192.png',
        '/icons/icon-512.png',
        '/icons/maskable-512.png',
        '/icons/apple-touch-icon.png',
      ]),
    );
  });

  it('has exactly one maskable icon entry, and it is the 512 maskable file', () => {
    const result = manifest();
    const maskable = (result.icons ?? []).filter((icon) => icon.purpose === 'maskable');
    expect(maskable).toHaveLength(1);
    expect(maskable[0]?.src).toBe('/icons/maskable-512.png');
  });

  it('background_color and theme_color equal globals.css’s --canvas token (light), not an invented color', () => {
    const canvas = lightToken('canvas');
    const result = manifest();
    expect(result.background_color).toBe(canvas);
    expect(result.theme_color).toBe(canvas);
  });

  it('every icon file it references actually exists in public/ (catches a forgotten regeneration)', () => {
    const result = manifest();
    for (const icon of result.icons ?? []) {
      const onDisk = path.join(repoRoot, 'public', icon.src.replace(/^\//, ''));
      expect(fs.existsSync(onDisk), `${icon.src} is listed in the manifest but missing from public/`).toBe(true);
    }
  });

  it('v1.13.0 ruling R7: exactly one shortcut, pointing at the quick-add anchor', () => {
    expect(manifest().shortcuts).toEqual([
      { name: 'Add a transaction', short_name: 'Add', url: '/transactions#quick-add' },
    ]);
  });
});
