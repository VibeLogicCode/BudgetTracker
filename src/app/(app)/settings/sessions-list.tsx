'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { TableWrap } from '@/components/ui/Table';
import { signOutSessionAction, type ProfileFormState } from './actions';

const initial: ProfileFormState = {};

/**
 * F-09's row shape, built by page.tsx from listSessionsForUser() plus the pieces only the page
 * knows: whether this row is the device the request is coming from, and whether TRUST_PROXY
 * makes `ip` a fact worth showing at all. `id` is sessions.tokenHash -- see the docblock on
 * listSessionsForUser (src/lib/auth/session.ts) for why that is safe to hand to this component
 * and, from here, to a hidden form field.
 */
export interface SessionRowView {
  id: string;
  device: string;
  ip: string | null;
  lastSeenAt: string;
  isCurrent: boolean;
}

function formatWhen(iso: string): string {
  // Same "YYYY-MM-DD HH:MM" truncation the audit log, backups and updates cards already use
  // (settings/audit/page.tsx, backups-client.tsx, updates-client.tsx) -- one house style for a
  // timestamp nobody needs to the second.
  return iso.slice(0, 16).replace('T', ' ');
}

function SessionRow({ row, showIp }: { row: SessionRowView; showIp: boolean }) {
  const [state, action] = useActionState(signOutSessionAction, initial);

  return (
    <tr>
      <td data-label="Device" className="cell-stack-headline">
        {row.device}
        {row.isCurrent ? (
          <span className="ml-2 inline-flex items-center rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-soft-fg">
            This device
          </span>
        ) : null}
      </td>
      {showIp ? (
        <td data-label="IP" className="tabnum whitespace-nowrap">
          {row.ip ?? 'Unknown'}
        </td>
      ) : null}
      <td data-label="Last seen" className="whitespace-nowrap text-muted">
        {formatWhen(row.lastSeenAt)}
      </td>
      <td data-label="Sign out">
        <form action={action} className="flex flex-col items-start gap-1">
          <input type="hidden" name="sessionId" value={row.id} />
          <SubmitButton variant="secondary" size="sm" className="min-h-11 sm:min-h-0">
            Sign out
          </SubmitButton>
          <FormError message={state.error} />
        </form>
      </td>
    </tr>
  );
}

/**
 * F-09 (v1.31.0), Settings -> Sessions. `showIp` is decided by the page from TRUST_PROXY, not by
 * this component -- when it is false the IP column (header AND cells) is omitted outright rather
 * than printed as "unknown" or, worse, a proxy's own address mistaken for the member's. Showing a
 * wrong fact is worse than showing none, the same rule three v1.30.0 fixes and reconcileAccount's
 * discrepancy card already rest on.
 */
export function SessionsList({ sessions, showIp }: { sessions: SessionRowView[]; showIp: boolean }) {
  return (
    <TableWrap bare responsive>
      <thead>
        <tr>
          <th scope="col">Device</th>
          {showIp ? <th scope="col">IP</th> : null}
          <th scope="col">Last seen</th>
          <th scope="col"></th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((row) => (
          <SessionRow key={row.id} row={row} showIp={showIp} />
        ))}
      </tbody>
    </TableWrap>
  );
}
