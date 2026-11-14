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

  it('records an undone bulk change (v1.62.0) with no migration', async () => {
    current = createTestDb();
    const user = await createUser({ name: 'Alex', username: 'alex', password: 'correct horse battery', role: 'admin' });
    appendAudit({
      userId: user.id,
      action: 'undo_bulk_action',
      entity: 'transactions',
      entityId: 12,
      detail: 'Undid: Categorized 12 transactions as Groceries (1 rule removed)',
      at: '2026-03-10T14:22:00.000Z',
    });
    expect(listAudit()[0]).toMatchObject({
      userName: 'Alex',
      action: 'undo_bulk_action',
      entity: 'transactions',
      entityId: 12,
      detail: 'Undid: Categorized 12 transactions as Groceries (1 rule removed)',
    });
  });

  it('records the two local AI actions (v1.64.0) with no migration', async () => {
    current = createTestDb();
    const user = await createUser({ name: 'Alex', username: 'alex', password: 'correct horse battery', role: 'admin' });
    appendAudit({
      userId: user.id,
      action: 'set_local_ai',
      entity: 'settings',
      entityId: 0,
      detail: 'Local AI on: test-model:1b at 192.168.1.50:11434',
      at: '2026-03-10T09:00:00.000Z',
    });
    appendAudit({
      userId: user.id,
      action: 'forget_ai_suggestions',
      entity: 'settings',
      entityId: 0,
      detail: 'Forgot 120 AI suggestions',
      at: '2026-03-10T09:05:00.000Z',
    });
    expect(listAudit().map((row) => [row.action, row.entity, row.entityId, row.detail, row.userName])).toEqual([
      ['forget_ai_suggestions', 'settings', 0, 'Forgot 120 AI suggestions', 'Alex'],
      ['set_local_ai', 'settings', 0, 'Local AI on: test-model:1b at 192.168.1.50:11434', 'Alex'],
    ]);
  });

  it('stores NULL when no detail is given', async () => {
    current = createTestDb();
    const user = await createUser({ name: 'Alice', username: 'alice', password: 'correct horse battery', role: 'admin' });
    appendAudit({ userId: user.id, action: 'delete_receipt', entity: 'warranty_receipts', entityId: 9 });
    expect(listAudit()[0]?.detail).toBeNull();
  });
});
