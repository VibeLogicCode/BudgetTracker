import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';

let adminId = 0;
vi.mock('@/lib/auth/session', () => ({ requireAdmin: vi.fn(async () => ({ id: adminId, username: 'admin', role: 'admin' as const })) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/backup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backup')>()),
  pruneBackups: () => [],
}));

import { setRetentionAction } from '@/app/(app)/settings/backups/actions';
import { listAudit } from '@/lib/audit';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function form(retention: string): FormData {
  const data = new FormData();
  data.set('retention', retention);
  return data;
}

describe('setRetentionAction audit row', () => {
  it('writes one set_retention row after the change, and none for a refused value', async () => {
    current = createSeededTestDb();
    adminId = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });

    expect((await setRetentionAction({}, form('0'))).error).toBeDefined();
    expect(listAudit()).toHaveLength(0);

    await setRetentionAction({}, form('14'));
    const rows = listAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'set_retention', entity: 'settings', entityId: 0, detail: 'retention 14', userId: adminId });
  });
});
