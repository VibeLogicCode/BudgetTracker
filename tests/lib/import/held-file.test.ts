import { describe, it, expect } from 'vitest';
import { addBankHref, heldFileFromParams, importHeldFileHref } from '@/lib/import/held-file';

/** v1.55.2. The query a page receives, reduced to the file the import screen holds. */
describe('heldFileFromParams', () => {
  it('reads a staging id and filename', () => {
    expect(heldFileFromParams({ stagingId: 'abc', filename: 'march.csv' })).toEqual({ stagingId: 'abc', filename: 'march.csv' });
  });

  it('names no file when the id is missing, empty, or repeated', () => {
    expect(heldFileFromParams({})).toBeNull();
    expect(heldFileFromParams({ stagingId: '' })).toBeNull();
    expect(heldFileFromParams({ stagingId: ['a', 'b'], filename: 'march.csv' })).toBeNull();
  });

  it('falls back to a plain name when the filename is missing, blank, or repeated', () => {
    expect(heldFileFromParams({ stagingId: 'abc' })?.filename).toBe('statement.csv');
    expect(heldFileFromParams({ stagingId: 'abc', filename: '   ' })?.filename).toBe('statement.csv');
    expect(heldFileFromParams({ stagingId: 'abc', filename: ['a.csv', 'b.csv'] })?.filename).toBe('statement.csv');
  });

  it('caps the filename at 255 characters, as the preview route does', () => {
    expect(heldFileFromParams({ stagingId: 'abc', filename: 'x'.repeat(400) })?.filename).toHaveLength(255);
  });
});

describe('the links back to a held file', () => {
  it('encodes the filename so any character survives the round trip', () => {
    const href = addBankHref({ stagingId: 'abc', filename: 'jan & feb #2.csv' });
    const url = new URL(href, 'http://nas.local');
    expect(url.pathname).toBe('/import/wizard');
    expect(url.searchParams.get('filename')).toBe('jan & feb #2.csv');
    expect(new URL(importHeldFileHref({ stagingId: 'abc', filename: 'a.csv' }), 'http://nas.local').pathname).toBe('/import');
  });

  it('is the plain wizard when no file is held', () => {
    expect(addBankHref(null)).toBe('/import/wizard');
  });
});
