/**
 * script-src carries a per-request nonce (set by src/middleware.ts) so modern browsers
 * run only nonce-tagged scripts. 'unsafe-inline' stays alongside it purely as a legacy
 * fallback: CSP2+ browsers ignore 'unsafe-inline' whenever a nonce is present in the
 * same directive, so this only weakens the policy for browsers old enough to not
 * understand nonces at all.
 *
 * 'wasm-unsafe-eval' is required by the receipt scanner. Chromium enforces CSP on
 * WebAssembly compilation, so without it WebAssembly.instantiate throws and the scanner
 * never initialises on Android Chrome, which is its primary device. The token permits
 * WebAssembly compilation and nothing else: it does not re-enable eval or new Function,
 * which is exactly why it exists separately from 'unsafe-eval'.
 */
function buildCsp(nonce?: string): string {
  const scriptSrc = nonce
    ? `script-src 'self' 'nonce-${nonce}' 'unsafe-inline' 'wasm-unsafe-eval'`
    : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'";
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    // data: is required for the TOTP QR PNG rendered at enrollment. blob: is required for the
    // receipt scanner's before/after preview: both images are object URLs
    // (URL.createObjectURL) from scan.ts and ReceiptUploader.tsx, and Chromium matches 'self'
    // by scheme, so it refuses a blob: URL without this token even though the blob itself was
    // created same-origin.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * v1.12.1 (item AC / SEC-7, ruling P6). `options.https` is resolved by the caller from the real
 * request (src/proxy.ts), never guessed here.
 *
 * HSTS is CONDITIONAL and must stay conditional. The documented default deployment of this app is
 * plain HTTP on a home LAN; sending Strict-Transport-Security there would tell every browser in the
 * house to refuse http://192.168.x.x for a year, which is not a hardening, it is a brick. On a real
 * HTTPS connection it closes the gap SEC-7 describes from the browser side: the session cookie's
 * Secure flag depends on TRUST_PROXY being set, and an operator who put an HTTPS proxy in front
 * without setting it gets no Secure cookie and, until now, nothing else either.
 */
export function securityHeaders(nonce?: string, options?: { https?: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': buildCsp(nonce),
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    // camera=() stays even though the scanner ships: it costs nothing, because the file
    // input's capture="environment" handoff to the phone's camera app is not governed by
    // this policy, and it mechanically stops a future contributor from adding a live
    // WebRTC-based viewfinder without noticing why there is not one already.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  };
  if (options?.https === true) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}
