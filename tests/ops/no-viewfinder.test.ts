import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { securityHeaders } from '@/lib/auth/security-headers';

const ROOT = process.cwd();

function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

/** The one detector, named once, so the planted control below tests the SAME predicate the scan
 *  runs rather than a second copy of it -- a control that agrees with a broken detector is worth
 *  nothing (v1.31.0 item M-4). */
function opensACamera(source: string): boolean {
  return source.includes('getUserMedia') || source.includes('mediaDevices');
}

describe('MUST-8.1 / MUST-8.3 / AC11 / risk R14: there is no viewfinder', () => {
  // Re-enabled by Task 11: the doc comment in src/components/warranty/ReceiptUploader.tsx
  // that used to read "No native app, no getUserMedia, no canvas." was reworded once that
  // task wired in jscanify's canvas crop (making "no canvas" untrue) and no longer contains
  // either banned substring, so the scan below now passes for real rather than vacuously.
  const files = walk('src');

  /**
   * v1.31.0 item M-4: the positive control this guard shipped without. The check below asserts an
   * empty offender list built from a directory walk over a hardcoded relative path; a moved or
   * renamed src/, or an extension test that stops matching, empties the list and leaves the
   * assertion green while scanning nothing. "It passes" and "it works" have to be different
   * observations, so the walk is required to find the tree and the detector is shown catching the
   * thing it exists to catch.
   */
  it('the scan is not vacuous: the tree is walked and the detector is live', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('src/components/warranty/ReceiptUploader.tsx');
    expect(opensACamera("const stream = await navigator.mediaDevices.getUserMedia({ video: true });")).toBe(true);
    expect(opensACamera("<input type=\"file\" accept=\"image/*\" capture=\"environment\" />")).toBe(false);
  });

  it('getUserMedia and mediaDevices appear nowhere under src/', () => {
    const offenders = files.filter((file) => opensACamera(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('Permissions-Policy still denies the camera', () => {
    expect(securityHeaders()['Permissions-Policy']).toContain('camera=()');
  });

  it('the file input still hands off to the phone camera app', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/components/warranty/ReceiptUploader.tsx'), 'utf8');
    expect(source).toContain('capture="environment"');
    expect(source).toContain('accept="image/*,application/pdf"');
  });
});
