import { describe, it, expect } from 'vitest';
import { isPrivateIpv4, isPrivateIpv6 } from '@/lib/net/private-address';

/**
 * v1.64.0 (plan 2026-11-12, A2). The predicates moved verbatim out of src/lib/update/egress.ts; its
 * Watchtower tests run untouched beside these. The cases below are the ones that suite proves through
 * assertWatchtowerUrl, plus the edges of each range.
 */
describe('isPrivateIpv4', () => {
  it('accepts loopback, the three private ranges and link-local', () => {
    for (const host of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.255', '192.168.1.9', '169.254.1.1']) {
      expect(isPrivateIpv4(host), host).toBe(true);
    }
  });

  it('refuses a public address and the edges just outside each range', () => {
    for (const host of ['8.8.8.8', '11.0.0.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '169.255.0.1', '100.64.0.1', '0.0.0.0']) {
      expect(isPrivateIpv4(host), host).toBe(false);
    }
  });

  it('refuses anything that is not four octets of 0-255', () => {
    for (const host of ['256.1.1.1', '10.1.1', 'example.com', '', '10.0.0.1.5']) {
      expect(isPrivateIpv4(host), host).toBe(false);
    }
  });
});

describe('isPrivateIpv6', () => {
  it('accepts loopback, unique-local and link-local, bracketed (a URL hostname) or bare (a resolved address)', () => {
    for (const host of ['[::1]', '::1', '[fd00::1]', '[fd12:3456::1]', 'fd12:3456::1', '[fc00::5]', '[fe80::1]', 'fe80::1']) {
      expect(isPrivateIpv6(host), host).toBe(true);
    }
  });

  it('refuses a global address', () => {
    for (const host of ['[2001:db8::1]', '[2606:4700::1]', '2001:db8::1', '[::]', '[ff02::1]']) {
      expect(isPrivateIpv6(host), host).toBe(false);
    }
  });
});
