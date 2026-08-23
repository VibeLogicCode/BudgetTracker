'use client';

import { Fragment, useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, inputClass, labelClass, selectClass } from '@/components/ui/form';
import { SettingsIcon } from '@/components/icons';
import { todayIso } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import { createAccountAction, setAccountActiveAction, updateAccountAction, type AccountsFormState } from './actions';

export interface AccountRow {
  id: number;
  name: string;
  institution: string;
  type: 'chequing' | 'credit' | 'cash';
  ownerUserId: number | null;
  isActive: boolean;
  isSimplefinManaged: boolean;
  /**
   * v1.6.0 (spec 2026-08-22, MUST-5.1). importProfileName is resolved by page.tsx from the
   * FULL profile list, not the filtered `profiles` prop below -- a pin can point at a profile
   * that has since been deactivated or gone unreadable (Task 4's "dormant pin"), and it still
   * has to show its real name here, not "none". The editor's mapping SELECT adds the dormant
   * pin as its own extra option so it stays preselected (v1.7.0 Task 1b: a save aimed at name
   * or owner must not silently clear it) -- a genuinely NEW pick is still limited to what
   * `profiles` offers.
   */
  importProfileId: number | null;
  importProfileName: string | null;
  /**
   * v1.7.0 Task 6 (spec 2026-08-22): the newest row from account_balance_snapshots at or
   * before today, resolved by page.tsx via latestSnapshots() -- null means no snapshot exists
   * yet for this account (SimpleFIN has not synced a balance, and nobody has entered one by
   * hand). SIGNED exactly as recorded: a credit card's balance stays negative here.
   */
  latestBalanceCents: number | null;
  latestBalanceDate: string | null;
}

export interface PersonRow {
  id: number;
  name: string;
  isActive: boolean;
}

/** Active + readable only -- the same two conditions the import picker applies (Task 4,
 *  MUST-4.1) -- so the select here can never offer a mapping the import screen would refuse. */
export interface ProfileOption {
  id: number;
  name: string;
}

const initialState: AccountsFormState = {};

const rowInput = 'field-control w-auto px-2 py-1 text-xs';
const rowButton = 'btn btn--secondary btn--sm';

export function AccountsManager({
  accounts,
  people,
  profiles,
  // v1.7.0 Task 6 (spec 2026-08-22): page.tsx always passes today's date computed server-side
  // (todayIso()), the same way goals-client.tsx's `today` prop works, so a save that does not
  // touch the balance date still submits a real value. The fallback below only matters for
  // callers that omit it (mainly tests unrelated to this feature): it is read once, inside the
  // editor panel, which itself only ever exists after a client click -- never in the initial
  // server-rendered markup -- so there is no hydration mismatch to protect against here.
  today = todayIso(),
}: {
  accounts: AccountRow[];
  people: PersonRow[];
  profiles: ProfileOption[];
  today?: string;
}) {
  const [createState, create] = useActionState(createAccountAction, initialState);
  const [activeState, setActive] = useActionState(setAccountActiveAction, initialState);
  const [updateState, update] = useActionState(updateAccountAction, initialState);
  // v1.7.0 Task 1b: one row's editor open at a time, same show-one-at-a-time shape as
  // transactions-client.tsx's rename modal. owner/profile are the STRING form values the
  // selects below need ('' for Joint/None), not the raw nullable ids.
  const [editing, setEditing] = useState<{ id: number; name: string; owner: string; profile: string } | null>(null);

  const rowError = activeState.error ?? updateState.error;
  const rowMessage = activeState.message ?? updateState.message;

  const openEditor = (account: AccountRow) =>
    setEditing({
      id: account.id,
      name: account.name,
      owner: account.ownerUserId === null ? '' : String(account.ownerUserId),
      profile: account.importProfileId === null ? '' : String(account.importProfileId),
    });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Bank accounts"
        description="Every import needs an account to land in. Add one per bank account you export a CSV from (or plan to link to SimpleFIN). Accounts are deactivated, never deleted — the transactions and import history that point at them have to keep working."
      />

      <Card className="max-w-md">
        <CardHeader title="Add an account" />
        <CardBody>
          <form action={create} className="flex flex-col gap-4">
            <FormError message={createState.error} />
            {createState.message ? <Notice tone="success">{createState.message}</Notice> : null}
            <Field label="Name">
              <input name="name" placeholder="Joint Chequing" required className={inputClass} />
            </Field>
            <Field label="Institution (optional)">
              <input name="institution" placeholder="TD" className={inputClass} />
            </Field>
            <Field label="Type">
              <select name="type" defaultValue="chequing" className={selectClass}>
                <option value="chequing">Chequing</option>
                <option value="credit">Credit</option>
                <option value="cash">Cash</option>
              </select>
            </Field>
            <Field label="Owner">
              <select name="owner" defaultValue="" className={selectClass}>
                <option value="">Joint (household)</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </Field>
            <SubmitButton className="w-fit">Add account</SubmitButton>
          </form>
        </CardBody>
      </Card>

      <FormError message={rowError} />
      {rowMessage ? <Notice tone="success">{rowMessage}</Notice> : null}

      <Card>
        <CardHeader title="Accounts" description={`${accounts.length} account${accounts.length === 1 ? '' : 's'}.`} />
        {accounts.length === 0 ? (
          <EmptyState icon={SettingsIcon} title="No accounts yet. Add the first one above." />
        ) : (
          <TableWrap bare>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Institution</th>
                <th scope="col">Type</th>
                <th scope="col">Owner</th>
                <th scope="col">Mapping</th>
                <th scope="col">Balance</th>
                <th scope="col">Source</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <Fragment key={account.id}>
                  <tr className="align-top">
                    <td className="font-medium text-ink">{account.name}</td>
                    <td className="text-muted">{account.institution === '' ? '—' : account.institution}</td>
                    <td className="text-muted capitalize">{account.type}</td>
                    <td className="text-muted">
                      {account.ownerUserId === null ? 'Joint' : (people.find((p) => p.id === account.ownerUserId)?.name ?? 'Joint')}
                    </td>
                    <td className="text-muted">
                      {account.isSimplefinManaged ? '—' : account.importProfileName ?? 'none'}
                    </td>
                    <td className="text-muted">
                      {account.latestBalanceCents === null
                        ? 'no balance yet'
                        : `${formatCents(account.latestBalanceCents)} as of ${account.latestBalanceDate}`}
                    </td>
                    <td>
                      <span className={account.isSimplefinManaged ? 'badge badge--blue' : 'badge badge--slate'}>
                        {account.isSimplefinManaged ? 'SimpleFIN' : 'CSV'}
                      </span>
                    </td>
                    <td>
                      <span className={account.isActive ? 'badge badge--green' : 'badge badge--muted'}>
                        {account.isActive ? 'active' : 'deactivated'}
                      </span>
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => openEditor(account)} className={rowButton}>
                          Update account
                        </button>
                        <form action={setActive}>
                          <input type="hidden" name="accountId" value={account.id} />
                          <input type="hidden" name="active" value={account.isActive ? '0' : '1'} />
                          <button type="submit" className={rowButton}>
                            {account.isActive ? 'Deactivate' : 'Reactivate'}
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                  {editing !== null && editing.id === account.id ? (
                    <tr>
                      <td colSpan={9} className="bg-surface-2">
                        <form action={update} onSubmit={() => setEditing(null)} className="flex flex-wrap items-end gap-3 py-2">
                          <input type="hidden" name="accountId" value={account.id} />
                          <div className="flex flex-col gap-1">
                            <span className={labelClass}>Name</span>
                            <input
                              name="name"
                              defaultValue={editing.name}
                              aria-label={`Name for ${account.name}`}
                              className={`w-36 ${rowInput}`}
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <span className={labelClass}>Owner</span>
                            <select
                              name="owner"
                              defaultValue={editing.owner}
                              aria-label={`Owner of ${account.name}`}
                              className={rowInput}
                            >
                              <option value="">Joint</option>
                              {people.map((person) => (
                                <option key={person.id} value={person.id}>
                                  {person.name}
                                </option>
                              ))}
                            </select>
                          </div>
                          {account.isSimplefinManaged ? null : (
                            <div className="flex flex-col gap-1">
                              <span className={labelClass}>Import mapping</span>
                              <select
                                name="profile"
                                defaultValue={editing.profile}
                                aria-label={`Mapping for ${account.name}`}
                                className={rowInput}
                              >
                                <option value="">None</option>
                                {profiles.map((profile) => (
                                  <option key={profile.id} value={profile.id}>
                                    {profile.name}
                                  </option>
                                ))}
                                {/* Dormant pin (spec 2026-08-22 v1.6.0): a pin pointing at a
                                    profile that is no longer offered (deactivated or gone
                                    unreadable) still needs an <option> to preselect, or saving
                                    this editor for an unrelated field would silently clear it. */}
                                {editing.profile !== '' && !profiles.some((p) => String(p.id) === editing.profile) ? (
                                  <option value={editing.profile}>{account.importProfileName}</option>
                                ) : null}
                              </select>
                            </div>
                          )}
                          {/* v1.7.0 Task 6 (spec 2026-08-22): two fields riding this same
                              submit, not a fourth button or a second form. Balance always
                              opens BLANK regardless of the account's latest snapshot -- typing
                              nothing here must leave that snapshot alone, which only works if
                              blank is the starting value, not the current balance echoed back. */}
                          <div className="flex flex-col gap-1">
                            <span className={labelClass}>Balance</span>
                            <input
                              name="balance"
                              placeholder="e.g. 1234.56"
                              aria-label={`Balance for ${account.name}`}
                              className={`w-28 ${rowInput}`}
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <span className={labelClass}>Balance date</span>
                            <input
                              type="date"
                              name="asOfDate"
                              defaultValue={today}
                              aria-label={`Balance date for ${account.name}`}
                              className={rowInput}
                            />
                          </div>
                          <div className="flex gap-2">
                            <SubmitButton size="sm">Save</SubmitButton>
                            <button type="button" onClick={() => setEditing(null)} className={rowButton}>
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
        )}
      </Card>
    </div>
  );
}
