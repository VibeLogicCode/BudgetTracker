import { describe, it, expect, afterEach } from 'vitest';
import { appendAudit, listAudit } from '@/lib/audit';
import { createUser } from '@/lib/auth/users';
import { createTestDb, type TestDb } from '../helpers/db';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('audit_log (ruling R3)', () => {
  it('appends a row and reads it back with the actor name', async () => {
    current = createTestDb();
    const user = await createUser({ name: 'Alice', username: 'alice', password: 'correct horse battery', role: 'admin' });
    const id = appendAudit({
      userId: user.id,
      action: 'delete_item',
      entity: 'warranty_items',
      entityId: 42,
      detail: 'Property tax',
      at: '2026-08-27T10:00:00.000Z',
    });
    expect(id).toBeGreaterThan(0);
    expect(listAudit()).toEqual([
      {
        id,
        at: '2026-08-27T10:00:00.000Z',
        userId: user.id,
        userName: 'Alice',
        action: 'delete_item',
        entity: 'warranty_items',
        entityId: 42,
        detail: 'Property tax',
      },
    ]);
  });

  it('lists newest first and honours the limit', async () => {
    current = createTestDb();
    const user = await createUser({ name: 'Alice', username: 'alice', password: 'correct horse battery', role: 'admin' });
    for (const [n, at] of [[1, '2026-08-25T00:00:00.000Z'], [2, '2026-08-26T00:00:00.000Z'], [3, '2026-08-27T00:00:00.000Z']] as const) {
      appendAudit({ userId: user.id, action: 'undo_import', entity: 'imports', entityId: n, at });
    }
    expect(listAudit(2).map((row) => row.entityId)).toEqual([3, 2]);
  });

  it('stores NULL when no detail is given', async () => {
    current = createTestDb();
    const user = await createUser({ name: 'Alice', username: 'alice', password: 'correct horse battery', role: 'admin' });
    appendAudit({ userId: user.id, action: 'delete_receipt', entity: 'warranty_receipts', entityId: 9 });
    expect(listAudit()[0]?.detail).toBeNull();
  });
});
