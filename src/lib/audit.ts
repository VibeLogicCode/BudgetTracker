import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { auditLog, users } from '@/db/schema';
import { nowIso } from '@/lib/clock';

/**
 * v1.13.0 ruling R3: a minimal, append-only record of the three destructive operations a household
 * member can perform. There is deliberately NO update and NO delete in this module, and
 * tests/ops/visibility-invariants.test.ts greps the whole of src/ to keep it that way.
 *
 * This is NOT a security log. It stores no request body, no IP (sessions already carries that) and
 * no secret -- one short sentence at most. R3 says keep it small, and a log that grows a payload
 * column is a log that eventually holds a card number.
 */
export type AuditAction = 'delete_item' | 'delete_receipt' | 'undo_import';

export function appendAudit(input: {
  userId: number;
  action: AuditAction;
  entity: string;
  entityId: number;
  detail?: string | null;
  at?: string;
}): number {
  const row = getDb()
    .insert(auditLog)
    .values({
      at: input.at ?? nowIso(),
      userId: input.userId,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      detail: input.detail ?? null,
    })
    .returning({ id: auditLog.id })
    .get();
  return row.id;
}

export interface AuditRow {
  id: number;
  at: string;
  userId: number;
  userName: string;
  action: string;
  entity: string;
  entityId: number;
  detail: string | null;
}

/** Newest first. Read by the admin page at /settings/audit and by nothing else. */
export function listAudit(limit = 200): AuditRow[] {
  return getDb()
    .select({
      id: auditLog.id,
      at: auditLog.at,
      userId: auditLog.userId,
      userName: users.name,
      action: auditLog.action,
      entity: auditLog.entity,
      entityId: auditLog.entityId,
      detail: auditLog.detail,
    })
    .from(auditLog)
    .innerJoin(users, eq(users.id, auditLog.userId))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(Math.min(1000, Math.max(1, limit)))
    .all();
}
