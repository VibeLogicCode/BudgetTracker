import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { securityHeaders } from '@/lib/auth/security-headers';

const csp = (nonce?: string) => securityHeaders(nonce)['Content-Security-Policy'];

describe("MUST-8.9 / AC11: script-src gains 'wasm-unsafe-eval' and nothing else", () => {
  it("contains 'wasm-unsafe-eval' with and without a nonce", () => {
    expect(csp()).toContain("'wasm-unsafe-eval'");
    expect(csp('abc123')).toContain("'wasm-unsafe-eval'");
  });

  it("never contains the far broader 'unsafe-eval'", () => {
    for (const policy of [csp(), csp('abc123')]) {
      expect(policy).not.toMatch(/(?<!wasm-)'unsafe-eval'/);
    }
  });

  it('adds the token to script-src, not to some other directive', () => {
    const scriptSrc = csp('abc123')
      .split('; ')
      .find((directive) => directive.startsWith('script-src '));
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
  });

  it('the nonce branch still works', () => {
    expect(csp('abc123')).toContain("'nonce-abc123'");
    expect(csp()).not.toContain('nonce-');
  });

  it('every other directive is untouched', () => {
    const policy = csp('abc123');
    for (const directive of [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      // img-src deliberately gained blob: (B6): the scanner's before/after preview renders
      // both images from URL.createObjectURL, and Chromium matches 'self' by scheme, so it
      // blocks blob: URLs without this token even though 'self' data: is otherwise unchanged.
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ]) {
      expect(policy).toContain(directive);
    }
  });

  it('the reason the token is there is written down beside it', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/auth/security-headers.ts'), 'utf8');
    expect(source).toMatch(/WebAssembly/);
    expect(source).toMatch(/does not re-enable/);
  });
});

describe('v1.12.1: HSTS only on a real HTTPS connection (item AC / SEC-7, ruling P6)', () => {
  // v1.12.1 fix round 1: the absence assertion, tested alone, passed against the PRE-FIX
  // securityHeaders() too -- that code never emitted HSTS under any input, so "absent by
  // default" was true before this feature existed and proved nothing about the fix. Pairing it
  // with the { https: true } case in the same test means a regression that stops sending HSTS
  // at all (not just a regression that sends it unconditionally) fails this test.
  it('is absent by default and present only when https is true, because the documented default is plain HTTP on a LAN', () => {
    expect(securityHeaders()['Strict-Transport-Security']).toBeUndefined();
    expect(securityHeaders('abc123')['Strict-Transport-Security']).toBeUndefined();
    expect(securityHeaders(undefined, { https: true })['Strict-Transport-Security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(securityHeaders('abc123', { https: true })['Strict-Transport-Security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  it('adds nothing else and removes nothing when the flag is on', () => {
    const plain = securityHeaders('abc123');
    const secure = securityHeaders('abc123', { https: true });
    for (const [key, value] of Object.entries(plain)) expect(secure[key]).toBe(value);
    expect(Object.keys(secure).length).toBe(Object.keys(plain).length + 1);
  });
});
