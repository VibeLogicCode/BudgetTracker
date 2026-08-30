// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { appendAudit } from '@/lib/audit';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';

/**
 * v1.13.0 ruling R3. AuditPage is requireAdmin()-gated and read-only, so this follows the same
 * render-the-real-page-with-a-seeded-db pattern tests/app/budgets-page.test.tsx uses for its own
 * viewer-scoped page.
 */
const currentUser = vi.hoisted(() => ({
  value: { id: 0, name: '', username: '', role: 'admin' as 'admin' | 'member', visibility: 'household' as const },
}));

vi.mock('@/lib/auth/session', () => ({
  requireUser: async () => currentUser.value,
  requireAdmin: async () => currentUser.value,
}));

let current: TestDb | null = null;
afterEach(() => {
  cleanup();
  current?.cleanup();
  current = null;
});

describe('AuditPage', () => {
  it('shows an empty state, with a way back to Settings, when nothing has ever been deleted', async () => {
    current = createSeededTestDb();
    const adminId = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
    currentUser.value = { id: adminId, name: 'Admin', username: 'admin', role: 'admin', visibility: 'household' };

    const { default: AuditPage } = await import('@/app/(app)/settings/audit/page');
    render(await AuditPage());

    expect(screen.getByText(/nobody has deleted anything yet/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /back to settings/i })).toBeTruthy();
  });

  it('lists a deletion, newest first, with who did it and a readable label for the action', async () => {
    current = createSeededTestDb();
    const adminId = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
    currentUser.value = { id: adminId, name: 'Admin', username: 'admin', role: 'admin', visibility: 'household' };

    appendAudit({
      userId: adminId,
      action: 'delete_item',
      entity: 'warranty_items',
      entityId: 42,
      detail: 'Deleted "Old Fridge"',
      at: '2026-08-20T10:00:00.000Z',
    });
    appendAudit({
      userId: adminId,
      action: 'undo_import',
      entity: 'imports',
      entityId: 7,
      at: '2026-08-21T10:00:00.000Z',
    });

    const { default: AuditPage } = await import('@/app/(app)/settings/audit/page');
    render(await AuditPage());

    expect(screen.getByText('Deleted "Old Fridge"')).toBeTruthy();
    expect(screen.getByText('Deleted an item')).toBeTruthy();
    expect(screen.getByText('Undid an import')).toBeTruthy();
    expect(screen.getAllByText('Admin').length).toBeGreaterThan(0);

    // Newest first: undo_import (Aug 21) renders before delete_item (Aug 20).
    const rows = screen.getAllByRole('row');
    const bodyText = rows.map((row) => row.textContent ?? '').join('\n');
    expect(bodyText.indexOf('Undid an import')).toBeLessThan(bodyText.indexOf('Deleted an item'));
  });

  it('falls back to the raw action string for an action label it does not recognize', async () => {
    current = createSeededTestDb();
    const adminId = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
    currentUser.value = { id: adminId, name: 'Admin', username: 'admin', role: 'admin', visibility: 'household' };

    // audit_log.action is free text by design (no CHECK constraint) -- appendAudit's own type
    // only allows the three known actions, so a future/unknown one is written straight to the
    // database the way a not-yet-supported release would.
    current.sqlite
      .prepare(
        `insert into audit_log (at, user_id, action, entity, entity_id, detail)
         values ('2026-08-22T10:00:00.000Z', ?, 'archive_bill', 'warranty_items', 99, null)`,
      )
      .run(adminId);

    const { default: AuditPage } = await import('@/app/(app)/settings/audit/page');
    render(await AuditPage());

    expect(screen.getByText('archive_bill')).toBeTruthy();
  });

  it('the Which cell carries cell-stack-headline (v1.15.0, ruling S3)', async () => {
    current = createSeededTestDb();
    const adminId = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
    currentUser.value = { id: adminId, name: 'Admin', username: 'admin', role: 'admin', visibility: 'household' };
    appendAudit({
      userId: adminId,
      action: 'delete_item',
      entity: 'warranty_items',
      entityId: 42,
      detail: 'Deleted "Old Fridge"',
      at: '2026-08-20T10:00:00.000Z',
    });

    const { default: AuditPage } = await import('@/app/(app)/settings/audit/page');
    render(await AuditPage());

    // "Which" (the specific item/import a row is about) is what tells one deletion apart
    // from another when When/Who/What repeat, so it is the phone card's headline -- the
    // last <td> in the row.
    const row = screen.getAllByRole('row')[1];
    const cells = row.querySelectorAll('td');
    expect(cells[cells.length - 1].className).toContain('cell-stack-headline');
  });
});
