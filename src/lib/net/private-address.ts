/**
 * v1.64.0. The private-address predicates, in one place. PURE: no import of any kind, so a pure
 * module may use it and tests/ops/notify-egress.test.ts holds it to that.
 *
 * Moved verbatim from src/lib/update/egress.ts, where the Watchtower guard used them privately. The
 * local AI guard (src/lib/ai/lan.ts) applies the same two predicates to the address an admin types
 * and to every address a name resolves to, so there is one definition of "on your own network" in
 * the app. Each takes a URL.hostname: an IPv4 literal bare, an IPv6 literal in brackets (a resolved
 * IPv6 address, which has none, is accepted too).
 */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isPrivateIpv4(hostname: string): boolean {
  const match = IPV4.exec(hostname);
  if (match === null) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return true; //             127.0.0.0/8
  if (a === 10) return true; //              10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  return false;
}

export function isPrivateIpv6(hostname: string): boolean {
  // URL.hostname keeps the brackets ON for an IPv6 literal (and lowercases it), unlike a
  // dotted hostname or an IPv4 literal, which never carry brackets.
  if (hostname === '[::1]') return true;
  const inner = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (inner === '::1') return true;
  // fc00::/7 is fc.. or fd..; fe80::/10 is fe8./fe9./fea./feb.
  if (/^f[cd][0-9a-f]{0,2}:/i.test(inner)) return true;
  if (/^fe[89ab][0-9a-f]?:/i.test(inner)) return true;
  return false;
}
