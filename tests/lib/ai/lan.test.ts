import { describe, it, expect } from 'vitest';
import {
  LOCAL_AI_ENTER_ADDRESS_ERROR,
  LOCAL_AI_LAN_ONLY_ERROR,
  LOCAL_AI_NOTHING_AFTER_ERROR,
  LOCAL_AI_PATHS,
  addressLabel,
  assertLocalAiUrl,
  isLanHostname,
  isPrivateAddress,
  normalizeLocalAiBaseUrl,
} from '@/lib/ai/lan';

/** v1.64.0 (plan 2026-11-12, A3 and L2). Only an address on the household's own network. */
describe('normalizeLocalAiBaseUrl', () => {
  it('accepts private literals, loopback, link-local, one-word, .local and .home.arpa names, as the origin only', () => {
    const cases: [string, string][] = [
      ['http://192.168.1.50:11434', 'http://192.168.1.50:11434'],
      ['http://10.0.0.5', 'http://10.0.0.5'],
      ['http://172.16.0.1:8080', 'http://172.16.0.1:8080'],
      ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
      ['http://localhost:11434', 'http://localhost:11434'],
      ['http://[::1]:11434', 'http://[::1]:11434'],
      ['http://[fd12::1]:11434', 'http://[fd12::1]:11434'],
      ['http://169.254.10.1', 'http://169.254.10.1'],
      ['http://ollama:11434', 'http://ollama:11434'],
      ['http://gpu-box.local:11434', 'http://gpu-box.local:11434'],
      ['https://gpu-box.home.arpa', 'https://gpu-box.home.arpa'],
      ['  http://192.168.1.50:11434/  ', 'http://192.168.1.50:11434'],
      ['http://192.168.1.50:11434/v1', 'http://192.168.1.50:11434'],
      ['http://192.168.1.50:11434/v1/', 'http://192.168.1.50:11434'],
      ['HTTP://GPU-BOX.LOCAL:11434', 'http://gpu-box.local:11434'],
    ];
    for (const [input, baseUrl] of cases) {
      expect(normalizeLocalAiBaseUrl(input), input).toEqual({ ok: true, baseUrl });
    }
  });

  it('reads a decimal, octal or hex host as the address it spells, and judges that', () => {
    expect(normalizeLocalAiBaseUrl('http://3232235777:11434')).toEqual({ ok: true, baseUrl: 'http://192.168.1.1:11434' });
    expect(normalizeLocalAiBaseUrl('http://0xC0A80101')).toEqual({ ok: true, baseUrl: 'http://192.168.1.1' });
    expect(normalizeLocalAiBaseUrl('http://0300.0250.1.1')).toEqual({ ok: true, baseUrl: 'http://192.168.1.1' });
    // 134744072 is 8.8.8.8, and 0x64400001 is 100.64.0.1.
    expect(normalizeLocalAiBaseUrl('http://134744072')).toEqual({ ok: false, error: LOCAL_AI_LAN_ONLY_ERROR });
    expect(normalizeLocalAiBaseUrl('http://0x64400001')).toEqual({ ok: false, error: LOCAL_AI_LAN_ONLY_ERROR });
  });

  it('refuses public addresses, carrier NAT, the unspecified address, mapped IPv6 and public names', () => {
    for (const input of [
      'http://8.8.8.8',
      'http://172.32.0.1',
      'http://100.64.0.1',
      'http://100.100.100.100:11434',
      'http://0.0.0.0:11434',
      'http://[2001:db8::1]',
      'http://[::ffff:8.8.8.8]',
      'http://[::ffff:192.168.1.5]',
      'http://[::]:11434',
      'http://example.com',
      'http://ollama.example.com',
      'http://gpu-box.local.example.com',
      'http://12.34',
    ]) {
      expect(normalizeLocalAiBaseUrl(input), input).toEqual({ ok: false, error: LOCAL_AI_LAN_ONLY_ERROR });
    }
  });

  it('refuses another scheme, user info, and anything that is not a URL', () => {
    for (const input of [
      'ftp://192.168.1.5',
      'file:///etc/passwd',
      'http://user@192.168.1.5',
      'http://user:pass@192.168.1.5:11434',
      'http://192.168.1.5@8.8.8.8',
      'example.com',
      '192.168.1.50:11434',
      'not a url',
      '',
      '   ',
      `http://ollama:11434/${'a'.repeat(200)}`,
      42,
      null,
    ]) {
      expect(normalizeLocalAiBaseUrl(input), String(input)).toEqual({ ok: false, error: LOCAL_AI_ENTER_ADDRESS_ERROR });
    }
  });

  it('refuses a query, a fragment and any path but / and /v1', () => {
    for (const input of [
      'http://192.168.1.50:11434?x=1',
      'http://192.168.1.50:11434/?',
      'http://192.168.1.50:11434#top',
      'http://192.168.1.50:11434/api',
      'http://192.168.1.50:11434/v1/chat/completions',
      'http://192.168.1.50:11434/v2',
    ]) {
      expect(normalizeLocalAiBaseUrl(input), input).toEqual({ ok: false, error: LOCAL_AI_NOTHING_AFTER_ERROR });
    }
  });

  it('says the example address in full, though no scheme-separator literal exists in the tree', () => {
    expect(LOCAL_AI_ENTER_ADDRESS_ERROR).toBe("Enter the model server's address, like http://192.168.1.50:11434.");
    expect(LOCAL_AI_NOTHING_AFTER_ERROR).toBe("Enter only the server's address and port, with nothing after it.");
  });
});

describe('isLanHostname and isPrivateAddress', () => {
  it('judges names and literals', () => {
    expect(isLanHostname('ollama')).toBe(true);
    expect(isLanHostname('my_ollama')).toBe(true);
    expect(isLanHostname('gpu-box.local')).toBe(true);
    expect(isLanHostname('a.b.home.arpa')).toBe(true);
    expect(isLanHostname('gpu-box.lan')).toBe(false);
    expect(isLanHostname('-bad')).toBe(false);
    expect(isLanHostname('.local')).toBe(false);
    expect(isLanHostname('')).toBe(false);
  });

  it('checks a resolved address with no brackets, refusing mapped and public ones', () => {
    for (const address of ['127.0.0.1', '192.168.1.5', '10.0.0.5', '::1', 'fd12::1', 'fe80::1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '100.64.0.1', '::ffff:192.168.1.5', '::ffff:c0a8:105', '0:0:0:0:0:ffff:808:808', '2001:db8::1', 'gpu-box.local', '']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe('assertLocalAiUrl', () => {
  it('passes the two endpoints on a LAN host', () => {
    expect(LOCAL_AI_PATHS).toEqual(['/v1/chat/completions', '/v1/models']);
    for (const path of LOCAL_AI_PATHS) {
      expect(() => assertLocalAiUrl(`http://192.168.1.50:11434${path}`)).not.toThrow();
      expect(() => assertLocalAiUrl(`https://gpu-box.local${path}`)).not.toThrow();
    }
  });

  it('refuses any other path, a query, user info, a public host and a non-URL', () => {
    for (const url of [
      'http://192.168.1.50:11434/api/chat',
      'http://192.168.1.50:11434/v1/models/',
      'http://192.168.1.50:11434/v1/embeddings',
      'http://192.168.1.50:11434/',
      'http://192.168.1.50:11434/v1/models?x=1',
      'http://192.168.1.50:11434/v1/models#x',
      'http://u:p@192.168.1.50:11434/v1/models',
      'http://8.8.8.8/v1/models',
      'http://evil.example.com/v1/models',
      'ftp://192.168.1.50/v1/models',
      'not a url',
    ]) {
      expect(() => assertLocalAiUrl(url), url).toThrow(/refusing a local AI request/);
    }
  });

  it('names a server by host and port only', () => {
    expect(addressLabel('http://192.168.1.50:11434')).toBe('192.168.1.50:11434');
    expect(addressLabel('https://gpu-box.local')).toBe('gpu-box.local');
    expect(addressLabel('nope')).toBe('');
  });
});
