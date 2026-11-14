/** Raised when an answer is larger than the limit its caller set. The message never carries the body. */
export class ResponseTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`The answer was larger than ${maxBytes} bytes.`);
    this.name = 'ResponseTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/**
 * Reads at most `maxBytes` of a response body as text. A declared length past the limit is refused
 * before any byte is read, and a stream that runs past it is cancelled.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** readCapped, then JSON.parse. A body that is not JSON throws the parser's own SyntaxError. */
export async function readJsonCapped(response: Response, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readCapped(response, maxBytes));
}
