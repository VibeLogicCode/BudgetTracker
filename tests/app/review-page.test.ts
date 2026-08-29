import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Review round (fold /review in): the review queue is a filter on Transactions now (ruling R1),
 * so this route does nothing but redirect (ruling R6) -- no auth check, no queue read, nothing
 * else. The old self-viewer-refusal test this file used to carry moved with the behaviour it
 * was testing: `/transactions?review=1` forces `reviewOnly` off for a self viewer server-side
 * (ruling R2), which is `tests/app/transactions-page.test.tsx`'s job now, not this one's.
 */
const redirected: string[] = [];
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    redirected.push(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

afterEach(() => {
  redirected.length = 0;
});

describe('ReviewPage', () => {
  it('redirects to /transactions?review=1, unconditionally', async () => {
    const { default: ReviewPage } = await import('@/app/(app)/review/page');
    expect(() => ReviewPage()).toThrow('NEXT_REDIRECT:/transactions?review=1');
    expect(redirected).toEqual(['/transactions?review=1']);
  });
});
