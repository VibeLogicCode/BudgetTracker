// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';

/**
 * v1.13.1 fix round, review A (item 2 -- same class as item 1's dashboard leak).
 * GoalsPage passed listAttributablePeople() into GoalsClient's "Owner" dropdown unconditionally
 * -- no selfScoped gate. Unlike the dashboard case this one also RENDERS the roster in the DOM
 * as visible <option> elements, not just serializes it. canActOnOwner already refuses a self
 * viewer's attempt to set an owner other than themselves or "shared" server-side
 * (src/app/(app)/goals/actions.ts), so narrowing the dropdown to "Shared" + the viewer's own
 * name costs no functionality.
 */
const currentUser = vi.hoisted(() => ({
  value: {
    id: 0,
    name: '',
    username: '',
    role: 'member' as 'admin' | 'member',
    visibility: 'household' as 'household' | 'self',
  },
}));

vi.mock('@/lib/auth/session', () => ({ requireUser: async () => currentUser.value }));

afterEach(cleanup);

describe('GoalsPage (review A, item 2)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function renderPage() {
    const { default: GoalsPage } = await import('@/app/(app)/goals/page');
    return render(await GoalsPage({ searchParams: Promise.resolve({}) }));
  }

  it('does not offer another household member as a goal owner to a self viewer', async () => {
    t = createSeededTestDb();
    const child = insertTestUser(t.db, { name: 'Robin', username: 'robin', role: 'member' });
    insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    currentUser.value = { id: child, name: 'Robin', username: 'robin', role: 'member', visibility: 'self' };

    const { container } = await renderPage();
    expect(container.innerHTML).not.toContain('Alice');
  });

  it('still offers a household viewer the full roster of owners', async () => {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    insertTestUser(t.db, { name: 'Bob', username: 'bob', role: 'member' });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };

    const { container } = await renderPage();
    expect(container.innerHTML).toContain('Bob');
  });
});
