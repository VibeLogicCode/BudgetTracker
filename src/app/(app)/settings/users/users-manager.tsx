'use client';

import { Fragment, useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, inputClass, labelClass, selectClass } from '@/components/ui/form';
import { RowMenu, RowMenuButton, RowMenuForm } from '@/components/ui/RowMenu';
import { createUserAction, resetMfaAction, resetPasswordAction, setActiveAction, type UsersFormState } from './actions';
import type { UserRecord } from '@/lib/auth/users';

const initialState: UsersFormState = {};

const rowInput = 'field-control w-auto px-2 py-1 text-xs';
const rowButton = 'btn btn--secondary btn--sm';

export function UsersManager({ users }: { users: UserRecord[] }) {
  const [createState, create] = useActionState(createUserAction, initialState);
  const [rowState, rowAction] = useActionState(setActiveAction, initialState);
  const [pwState, resetPassword] = useActionState(resetPasswordAction, initialState);
  const [mfaState, resetMfa] = useActionState(resetMfaAction, initialState);
  /**
   * Which row (if any) has its password sub-row open. A password field must not live inside a
   * menu -- a menu closes on Escape, on an outside click and on scroll, all of which would
   * discard a half-typed credential -- so "Reset password…" opens the expandable row instead,
   * the pattern accounts-manager.tsx already uses for its editor.
   */
  const [resetting, setResetting] = useState<number | null>(null);

  const rowMessage = rowState.message ?? pwState.message ?? mfaState.message;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Users"
        description="Everyone who can sign in. Members see the whole household; admins can also change these settings."
      />

      <Card className="max-w-md">
        <CardHeader title="Add a user" description="They pick their own password the first time they sign in." />
        <CardBody>
          <form action={create} className="flex flex-col gap-4">
            <FormError message={createState.error} />
            {createState.message ? <Notice tone="success">{createState.message}</Notice> : null}
            <Field label="Name">
              <input name="name" placeholder="Alex" required className={inputClass} />
            </Field>
            <Field label="Username">
              <input name="username" placeholder="alex" required className={inputClass} />
            </Field>
            <Field label="Temporary password" hint="At least 10 characters.">
              <input name="password" placeholder="At least 10 characters" required className={inputClass} />
            </Field>
            <Field label="Role">
              <select name="role" defaultValue="member" className={selectClass}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
            <SubmitButton className="w-fit">Create user</SubmitButton>
          </form>
        </CardBody>
      </Card>

      <FormError message={rowState.error ?? pwState.error ?? mfaState.error} />
      {rowMessage ? <Notice tone="success">{rowMessage}</Notice> : null}

      <Card>
        <CardHeader title="Household" description={`${users.length} account${users.length === 1 ? '' : 's'}.`} />
        <TableWrap bare>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Username</th>
              <th scope="col">Role</th>
              <th scope="col">MFA</th>
              <th scope="col">Status</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <Fragment key={user.id}>
                <tr className="align-top">
                  <td className="font-medium text-ink">{user.name}</td>
                  <td className="font-mono text-xs text-muted">{user.username}</td>
                  <td>
                    <span className={user.role === 'admin' ? 'badge badge--accent' : 'badge badge--slate'}>{user.role}</span>
                  </td>
                  <td>
                    <span className={user.totpEnabled ? 'badge badge--green' : 'badge badge--muted'}>
                      {user.totpEnabled ? 'on' : 'off'}
                    </span>
                  </td>
                  <td>
                    <span className={user.isActive ? 'badge badge--green' : 'badge badge--muted'}>
                      {user.isActive ? 'active' : 'deactivated'}
                    </span>
                  </td>
                  {/* Three button-forms used to sit side by side here -- the widest actions cell
                      in the app, and the one that pushed this table past its card. */}
                  <td className="text-right">
                    <RowMenu label={`Actions for ${user.name}`}>
                      <RowMenuForm
                        action={rowAction}
                        fields={{ userId: String(user.id), active: user.isActive ? '0' : '1' }}
                      >
                        {user.isActive ? 'Deactivate' : 'Reactivate'}
                      </RowMenuForm>
                      <RowMenuButton onSelect={() => setResetting(user.id)}>Reset password…</RowMenuButton>
                      <RowMenuForm action={resetMfa} fields={{ userId: String(user.id) }}>
                        Reset MFA
                      </RowMenuForm>
                    </RowMenu>
                  </td>
                </tr>
                {resetting === user.id ? (
                  <tr>
                    <td colSpan={6} className="bg-surface-2">
                      <form
                        action={resetPassword}
                        onSubmit={() => setResetting(null)}
                        className="flex flex-wrap items-end gap-3 py-2"
                      >
                        <input type="hidden" name="userId" value={user.id} />
                        <div className="flex flex-col gap-1">
                          <span className={labelClass}>New password</span>
                          <input
                            name="password"
                            placeholder="At least 10 characters"
                            aria-label={`New password for ${user.name}`}
                            className={`w-52 ${rowInput}`}
                          />
                        </div>
                        <div className="flex gap-2">
                          <SubmitButton size="sm">Reset password</SubmitButton>
                          <button type="button" onClick={() => setResetting(null)} className={rowButton}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </TableWrap>
      </Card>
    </div>
  );
}
