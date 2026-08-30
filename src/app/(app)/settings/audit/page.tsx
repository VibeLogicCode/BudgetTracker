import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/session';
import { listAudit } from '@/lib/audit';
import { SettingsIcon } from '@/components/icons';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

const ACTION_LABEL: Record<string, string> = {
  delete_item: 'Deleted an item',
  delete_receipt: 'Deleted a receipt',
  undo_import: 'Undid an import',
};

/**
 * v1.13.0 ruling R3. Read-only, admin-only, and deliberately small: three kinds of destructive
 * action, who did each one and when. It is not a security log and it holds no request data -- see
 * the docblock on src/lib/audit.ts for why that boundary is where it is.
 */
export default async function AuditPage() {
  await requireAdmin();
  const rows = listAudit();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Audit log"
        description="Every deletion and every undone import, with who did it."
      />
      <Card>
        <CardHeader title="Recent activity" description="Newest first. Nothing here can be edited or removed." />
        {rows.length === 0 ? (
          <EmptyState
            icon={SettingsIcon}
            title="Nothing to show"
            action={
              <Link href="/settings" className="btn btn--secondary btn--sm">
                Back to Settings
              </Link>
            }
          >
            Nobody has deleted anything yet.
          </EmptyState>
        ) : (
          <TableWrap bare className="border-t border-line" responsive>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
                <th scope="col">Which</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap" data-label="When">{row.at.slice(0, 16).replace('T', ' ')}</td>
                  <td data-label="Who">{row.userName}</td>
                  <td data-label="What">{ACTION_LABEL[row.action] ?? row.action}</td>
                  {/* v1.15.0 (responsive rows): "Which" names the specific thing this row is
                      about -- an item, an import, an entity#id -- which is what actually tells
                      one deletion apart from another when When/Who/What repeat across rows. No
                      cell-stack-amount: nothing here is money. */}
                  <td className="cell-stack-headline" data-label="Which">{row.detail ?? `${row.entity} #${row.entityId}`}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
