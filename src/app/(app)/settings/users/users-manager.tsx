'use client';

import { Fragment, useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { AutoSaveCheckbox, AutoSaveSelect } from '@/components/ui/AutoSave';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, hintClass, inputClass, labelClass, selectClass } from '@/components/ui/form';
import { RowMenu, RowMenuButton, RowMenuForm } from '@/components/ui/RowMenu';
import {
  createPersonAction,
  createUserAction,
  resetMfaAction,
  resetPasswordAction,
  setActiveAction,
  setCanSignInAction,
  setVisibilityAction,
  type UsersFormState,
} from './actions';
import type { UserRecord } from '@/lib/auth/users';

const initialState: UsersFormState = {};

const rowInput = 'field-control w-auto px-2 py-1 text-xs';
const rowButton = 'btn btn--secondary btn--sm';

export function UsersManager({ users }: { users: UserRecord[] }) {
  const [createState, create] = useActionState(createUserAction, initialState);
  const [personState, createPerson] = useActionState(createPersonAction, initialState);
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

  /**
   * v1.12.1 (item AU / UX-6, ruling R5). Which row has a destructive confirmation open, and which
   * one. Deactivating locks a household member out and Reset MFA destroys every one of their
   * sessions; both used to go through on one tap of a ~26px menu item, while import undo,
   * forgetting a bank connection and deleting a receipt all asked first. This is the backups
   * page's inline panel, in the shape this table already uses for "Reset password…".
   */
  const [confirming, setConfirming] = useState<{ id: number; intent: 'deactivate' | 'mfa' } | null>(null);

  const rowMessage = rowState.message ?? pwState.message ?? mfaState.message;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Users"
        description="Everyone who can sign in. Members see the whole household; admins can also change these settings."
      />

      <div className="grid gap-6 sm:grid-cols-2">
        <Card>
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

        {/* v1.13.0 ruling R5. No password field at all -- createPersonWithoutLogin hashes 32
            random bytes nobody is ever told, and this person cannot sign in and cannot be made
            an admin (micro-ruling M1 blocks self+admin; a no-login person cannot be given a role
            other than 'member' at all, since no role-setting action exists in this app). */}
        <Card>
          <CardHeader
            title="Add a person without a login"
            description="For a child, a relative or a housemate who is never going to sign in."
          />
          <CardBody>
            <form action={createPerson} className="flex flex-col gap-4">
              <FormError message={personState.error} />
              {personState.message ? <Notice tone="success">{personState.message}</Notice> : null}
              <Field label="Name">
                <input name="name" placeholder="Robin" required className={inputClass} />
              </Field>
              <Field label="Username">
                <input name="username" placeholder="robin" required className={inputClass} />
              </Field>
              <p className={hintClass}>
                They will show up wherever you choose who a transaction was for. They cannot sign in and
                cannot be made an admin.
              </p>
              <SubmitButton className="w-fit">Add person</SubmitButton>
            </form>
          </CardBody>
        </Card>
      </div>

      <FormError message={rowState.error ?? pwState.error ?? mfaState.error} />
      {rowMessage ? <Notice tone="success">{rowMessage}</Notice> : null}

      <Card>
        <CardHeader title="Household" description={`${users.length} account${users.length === 1 ? '' : 's'}.`} />
        <TableWrap bare responsive>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Username</th>
              <th scope="col">Role</th>
              <th scope="col">Sees</th>
              <th scope="col">Sign-in</th>
              <th scope="col">MFA</th>
              <th scope="col">Status</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <Fragment key={user.id}>
                <tr className="align-top">
                  {/* v1.15.0 (responsive rows): the person's name is what tells one row from
                      another on this page, so it is the phone card's headline. */}
                  <td className="font-medium text-ink cell-stack-headline" data-label="Name">{user.name}</td>
                  <td className="font-mono text-xs text-muted" data-label="Username">{user.username}</td>
                  <td data-label="Role">
                    <span className={user.role === 'admin' ? 'badge badge--accent' : 'badge badge--slate'}>{user.role}</span>
                  </td>
                  <td data-label="Sees">
                    {/* v1.13.0 ruling R2, micro-ruling M1: an admin cannot be set 'self' --
                        setVisibilityAction refuses it server-side ("Make them a member first."),
                        surfaced here through the same auto-save error line every other row control
                        uses, rather than disabling the control (the refusal is the server's to
                        make, not a client-side guess at who counts as "an admin" this instant). */}
                    <AutoSaveSelect
                      name="visibility"
                      defaultValue={user.visibility}
                      options={[
                        { value: 'household', label: 'Household' },
                        { value: 'self', label: 'Only themselves' },
                      ]}
                      fields={{ userId: String(user.id) }}
                      ariaLabel={`What ${user.name} sees`}
                      action={(formData) => setVisibilityAction({}, formData)}
                    />
                  </td>
                  <td data-label="Sign-in">
                    {/* Item BI (ruling P11). A checkbox, not a select: it is a boolean, and the
                        row already auto-saves its visibility one cell to the left. Reversible,
                        single-row, refused server-side with a sentence -- the auto-save safety
                        rule's own definition. */}
                    <AutoSaveCheckbox
                      name="canSignIn"
                      defaultChecked={user.canSignIn}
                      fields={{ userId: String(user.id) }}
                      action={(formData) => setCanSignInAction({}, formData)}
                      label={`${user.name} can sign in`}
                      labelHidden
                    />
                  </td>
                  <td data-label="MFA">
                    <span className={user.totpEnabled ? 'badge badge--green' : 'badge badge--muted'}>
                      {user.totpEnabled ? 'on' : 'off'}
                    </span>
                  </td>
                  <td data-label="Status">
                    <span className={user.isActive ? 'badge badge--green' : 'badge badge--muted'}>
                      {user.isActive ? 'active' : 'deactivated'}
                    </span>
                  </td>
                  {/* Three button-forms used to sit side by side here -- the widest actions cell
                      in the app, and the one that pushed this table past its card. */}
                  <td className="text-right cell-stack-actions" data-label="">
                    <RowMenu label={`Actions for ${user.name}`}>
                      {user.isActive ? (
                        <RowMenuButton onSelect={() => setConfirming({ id: user.id, intent: 'deactivate' })}>
                          Deactivate
                        </RowMenuButton>
                      ) : (
                        // Reactivating is not destructive, so it keeps its one-tap form.
                        <RowMenuForm action={rowAction} fields={{ userId: String(user.id), active: '1' }}>
                          Reactivate
                        </RowMenuForm>
                      )}
                      <RowMenuButton onSelect={() => setResetting(user.id)}>Reset password…</RowMenuButton>
                      <RowMenuButton onSelect={() => setConfirming({ id: user.id, intent: 'mfa' })}>
                        Reset MFA
                      </RowMenuButton>
                    </RowMenu>
                  </td>
                </tr>
                {confirming?.id === user.id ? (
                  <tr>
                    {/* Spans every column, so it has no one header to echo (ruling S2). */}
                    <td colSpan={8} className="border-l-2 border-warning bg-warning-soft/40" data-label="">
                      <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                        <p className="text-ink">
                          {confirming.intent === 'deactivate' ? (
                            <>
                              Deactivate <strong className="font-semibold">{user.name}</strong>? They will not be able
                              to sign in, and every session they have open stops working.
                            </>
                          ) : (
                            <>
                              Reset two-factor for <strong className="font-semibold">{user.name}</strong>? Every one of
                              their sessions is signed out, and they sign in with just a password until they set it up
                              again.
                            </>
                          )}
                        </p>
                        <form
                          action={confirming.intent === 'deactivate' ? rowAction : resetMfa}
                          onSubmit={() => setConfirming(null)}
                          className="flex gap-2"
                        >
                          <input type="hidden" name="userId" value={user.id} />
                          {confirming.intent === 'deactivate' ? <input type="hidden" name="active" value="0" /> : null}
                          <SubmitButton size="sm" variant="danger">
                            {confirming.intent === 'deactivate' ? 'Deactivate' : 'Reset MFA'}
                          </SubmitButton>
                          <button type="button" onClick={() => setConfirming(null)} className={rowButton}>
                            Cancel
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ) : null}
                {resetting === user.id ? (
                  <tr>
                    <td colSpan={8} className="bg-surface-2" data-label="">
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
