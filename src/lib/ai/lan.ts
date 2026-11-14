import { isPrivateIpv4, isPrivateIpv6 } from '@/lib/net/private-address';

/**
 * v1.64.0 (plan 2026-11-12, L2 and L3). Where the local AI helper may send a request, and how much it
 * may send or take back. PURE: no @/db, no @/lib/env, no node builtin (tests/ops/notify-egress), so a
 * client component and the settings form can share the same rule the network file enforces.
 *
 * Only an address on the household's own network is accepted: a private or loopback IPv4 literal
 * (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16), an IPv6 loopback, unique-local or link-local
 * literal, `localhost`, a one-word name (a compose service) or a name under `.local` or `.home.arpa`.
 * Everything else is refused, carrier NAT (100.64.0.0/10, Tailscale) included. A NAME can still
 * resolve anywhere, so src/lib/ai/client.ts re-checks every address a name resolves to on every
 * request (lanOnlyLookup) with isPrivateAddress below.
 *
 * No `://` literal exists anywhere under src/lib/ai/ (tests/ops/notify-egress): the one place the
 * scheme separator appears is the example in a sentence, and it is joined at run time below so the
 * guard never has to tell an example from a destination.
 */

/** The only two endpoints the app ever calls: the OpenAI-compatible ones Ollama 0.5+ and llama.cpp share. */
export const LOCAL_AI_PATHS = ['/v1/chat/completions', '/v1/models'] as const;
export type LocalAiPath = (typeof LOCAL_AI_PATHS)[number];

/** L3. 5 s to connect; 90 s for the whole answer, because a cold model load can take most of a minute. */
export const LOCAL_AI_CONNECT_TIMEOUT_MS = 5_000;
export const LOCAL_AI_ANSWER_TIMEOUT_MS = 90_000;
/** L3. A reply over 1 MB is refused, by its declared length or while it streams. */
export const LOCAL_AI_MAX_RESPONSE_BYTES = 1024 * 1024;
/** L3. A question over 64 KB is never sent. */
export const LOCAL_AI_MAX_REQUEST_BYTES = 64 * 1024;
/** The longest address the settings form takes. */
export const LOCAL_AI_MAX_ADDRESS_CHARS = 200;

const EXAMPLE_ADDRESS = ['http', '//192.168.1.50:11434'].join(':');

export const LOCAL_AI_ENTER_ADDRESS_ERROR = `Enter the model server's address, like ${EXAMPLE_ADDRESS}.`;
export const LOCAL_AI_LAN_ONLY_ERROR =
  'Only an address on your own network is allowed: a 10.x, 172.16-31.x or 192.168.x address, localhost, a one-word name, or a .local name.';
export const LOCAL_AI_NOTHING_AFTER_ERROR = "Enter only the server's address and port, with nothing after it.";

/** One DNS label: letters, digits, hyphen and underscore inside, never at an end. URL.hostname is lowercase. */
const LABEL = '[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?';
const SINGLE_LABEL_RE = new RegExp(`^${LABEL}$`);
const LAN_SUFFIX_RE = new RegExp(`^(?:${LABEL}\\.)+(?:local|home\\.arpa)$`);
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** An IPv6 address that carries an IPv4 one (::ffff:a.b.c.d and its hex form) is refused outright. */
function isMappedIpv6(address: string): boolean {
  const inner = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  return /^(?:0{0,4}:){0,5}:?ffff:/i.test(inner) || /^::(?:\d{1,3}\.){3}\d{1,3}$/.test(inner);
}

/**
 * True for an address a name resolved to (no brackets on IPv6) or an IP literal from a URL (with
 * them). Anything that is not a well-formed private IPv4 or IPv6 address is false.
 */
export function isPrivateAddress(address: string): boolean {
  if (typeof address !== 'string' || address.length === 0) return false;
  if (IPV4_RE.test(address)) return isPrivateIpv4(address);
  if (!address.includes(':')) return false;
  if (isMappedIpv6(address)) return false;
  return isPrivateIpv6(address);
}

/**
 * A URL.hostname the helper may talk to. An IP literal must be private; a name must be `localhost`,
 * one label, or end in `.local` / `.home.arpa`. A digits-only label never gets here as a name:
 * the URL parser has already read `3232235777` or `0xC0A80101` as the IPv4 address it spells.
 */
export function isLanHostname(hostname: string): boolean {
  if (typeof hostname !== 'string' || hostname.length === 0 || hostname.length > 253) return false;
  if (IPV4_RE.test(hostname)) return isPrivateIpv4(hostname);
  if (hostname.startsWith('[')) return isPrivateAddress(hostname);
  if (hostname === 'localhost') return true;
  // A name made only of digits and dots that is not an IPv4 literal is not a name anybody runs.
  if (/^[\d.]+$/.test(hostname)) return false;
  return SINGLE_LABEL_RE.test(hostname) || LAN_SUFFIX_RE.test(hostname);
}

export type NormalizedAddress = { ok: true; baseUrl: string } | { ok: false; error: string };

/**
 * The address an admin typed, as the origin the app will use (`/` and `/v1` dropped), or the
 * sentence that says why not. No user name or password, no query, no fragment, no other path.
 */
export function normalizeLocalAiBaseUrl(input: unknown): NormalizedAddress {
  if (typeof input !== 'string') return { ok: false, error: LOCAL_AI_ENTER_ADDRESS_ERROR };
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > LOCAL_AI_MAX_ADDRESS_CHARS) return { ok: false, error: LOCAL_AI_ENTER_ADDRESS_ERROR };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: LOCAL_AI_ENTER_ADDRESS_ERROR };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: LOCAL_AI_ENTER_ADDRESS_ERROR };
  // A user name or password would be sent to the server; this app sends no credential at all.
  if (parsed.username !== '' || parsed.password !== '' || trimmed.includes('@')) return { ok: false, error: LOCAL_AI_ENTER_ADDRESS_ERROR };
  // A bare `?` or `#` leaves search and hash empty, so the typed text is read too.
  if (parsed.search !== '' || parsed.hash !== '' || /[?#]/.test(trimmed)) return { ok: false, error: LOCAL_AI_NOTHING_AFTER_ERROR };
  if (!['/', '/v1', '/v1/'].includes(parsed.pathname)) return { ok: false, error: LOCAL_AI_NOTHING_AFTER_ERROR };
  if (!isLanHostname(parsed.hostname)) return { ok: false, error: LOCAL_AI_LAN_ONLY_ERROR };
  return { ok: true, baseUrl: parsed.origin };
}

/**
 * MUST-8.5's shape for this tree: called on the line immediately above every request call in
 * src/lib/ai/client.ts (tests/ops/notify-egress). Throws unless the full request URL is http(s), on a
 * LAN host, with no credential, query or fragment, and one of the two endpoints exactly.
 */
export function assertLocalAiUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('refusing a local AI request to a non-URL target');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('refusing a local AI request on a non-HTTP scheme');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('refusing a local AI request carrying userinfo');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('refusing a local AI request carrying a query or fragment');
  }
  if (!(LOCAL_AI_PATHS as readonly string[]).includes(parsed.pathname)) {
    throw new Error('refusing a local AI request to an unrecognized path');
  }
  if (!isLanHostname(parsed.hostname)) {
    throw new Error('refusing a local AI request to a host outside the local network');
  }
}

/** `192.168.1.50:11434` for a sentence or an audit detail: never the scheme, never anything else. */
export function addressLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '';
  }
}
