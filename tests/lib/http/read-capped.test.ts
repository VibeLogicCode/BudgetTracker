import { describe, it, expect } from 'vitest';
import { ResponseTooLargeError, readCapped, readJsonCapped } from '@/lib/http/read-capped';

describe('readCapped', () => {
  it('reads a body within the limit', async () => {
    expect(await readCapped(new Response('hello'), 10)).toBe('hello');
    expect(await readJsonCapped(new Response('{"a":1}'), 100)).toEqual({ a: 1 });
  });

  it('refuses a streamed body past the limit', async () => {
    await expect(readCapped(new Response('x'.repeat(50)), 10)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('refuses a declared length past the limit without reading', async () => {
    const response = new Response('{}', { headers: { 'Content-Length': '999' } });
    await expect(readJsonCapped(response, 10)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});
