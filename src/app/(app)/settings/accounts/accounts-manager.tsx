'use client';

import { Fragment, useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, hintClass, inputClass, labelClass, selectClass } from '@/components/ui/form';
import { SettingsIcon } from '@/components/icons';
import { todayIso } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import { createAccountAction, setAccountActiveAction, updateAccountAction, type AccountsFormState } from './actions';
// Type-only (ruling P4): this file is 'use client' and must never VALUE-import
// src/lib/balance-reconcile.ts, which reaches @/db/client to run reconcileAccount. `import
// type` erases at compile time, so only the shape of Discrepancy crosses into the client
// bundle -- page.tsx (a server component) is the only caller of reconcileAccount itself, and
// hands the results down as plain data through the `discrepancies` prop below.
import type { Discrepancy } from '@/lib/balance-reconcile';

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
   * v1.7.0 Task 6 (spec 2026-08-22), resolved by page.tsx via latestSnapshots(). Since v1.8.0
   * (Task 4) that function no longer returns the raw stored snapshot -- it resolves through
   * balanceAsOf (src/lib/balance.ts), so this figure already includes movement (transactions
   * posted after the snapshot). null means no snapshot exists yet for this account (SimpleFIN
   * has not synced a balance, and nobody has entered one by hand). SIGNED exactly as resolved:
   * a credit card's balance stays negative here.
   */
  latestBalanceCents: number | null;
  /** The ANCHOR date -- the snapshot this balance is based on -- not "today", even though
   *  latestBalanceCents itself is current as of today. */
  latestBalanceDate: string | null;
  /**
   * Movement folded into latestBalanceCents since latestBalanceDate. 0 means the anchor
   * snapshot IS the balance for today, so "as of <that date>" is a truthful label; non-zero
   * means the figure is current and the date is only its provenance, which the two must not
   * be rendered as if they were the same thing. Defect fix, v1.8.0 review: routing this
   * column through balanceAsOf made the figure current while the date stayed the anchor's,
   * and the cell went on reading "<current figure> as of <old date>" -- a today number
   * wearing a July label, which is exactly what ruling R7 exists to prevent. null whenever
   * latestBalanceCents is null.
   */
  latestBalanceMovedCents: number | null;
  /**
   * v1.8.0 Task 5 (spec 2026-08-23), resolved by page.tsx via reconcileAccount()
   * (src/lib/balance-reconcile.ts). Ruling R7: reconciliation reports, it never corrects, so
   * this array IS the entire feature's UI surface -- one plain-language line per entry (see
   * discrepancyMessage below), rendered directly under the account, and nothing at all when the
   * array is empty. No badge and no nav count anywhere else in the app reflects this: it is a
   * diagnostic a household member reads when troubleshooting a number that looks wrong, not an
   * alert that demands attention.
   */
  discrepancies: Discrepancy[];
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

/**
 * The entire text of ruling R7's diagnostic (spec 2026-08-23, v1.8.0 Task 5): report the gap,
 * name both statement dates, and go no further -- never guess which transaction is missing, and
 * never say the account "lost" or "gained" money, since nothing here knows which side is wrong.
 * `deltaCents` is impliedCents - expectedCents (src/lib/balance-reconcile.ts's own docblock):
 * positive means this app's OWN imported transactions add up to MORE than the bank says the
 * account holds on `toDate` -- the statement reads LOWER than our rows account for -- and
 * negative is the exact mirror. Exported so tests can assert on the sentence directly rather
 * than re-deriving it from rendered DOM text.
 */
export function discrepancyMessage(discrepancy: Discrepancy): string {
  const { fromDate, toDate, deltaCents } = discrepancy;
  const direction = deltaCents > 0 ? 'lower' : 'higher';
  const amount = formatCents(Math.abs(deltaCents));
  return (
    `Your statement balance for ${toDate} is ${amount} ${direction} than your imported transactions account for ` +
    `— an import is probably missing rows between ${fromDate} and ${toDate}.`
  );
}

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

      <div id="add-account">
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
      </div>

      <FormError message={rowError} />
      {rowMessage ? <Notice tone="success">{rowMessage}</Notice> : null}

      <Card>
        <CardHeader title="Accounts" description={`${accounts.length} account${accounts.length === 1 ? '' : 's'}.`} />
        {accounts.length === 0 ? (
          <EmptyState
            icon={SettingsIcon}
            title="No accounts yet. Add the first one above."
            action={
              <a href="#add-account" className="btn btn--primary btn--sm">
                Add an account
              </a>
            }
          />
        ) : (
          <TableWrap bare fixed minWidth="67rem">
            {/* Nine columns, two of which carry controls, so auto sizing was handing the width
                to the Balance sentence ("... now · from a balance recorded <date>") and leaving
                Actions to stack its two buttons over a column of dead space. The widths below
                total 67rem, which is what the shell leaves once max-w-6xl loses its gutters --
                narrower viewports scroll the wrapper instead of squeezing a button. */}
            <colgroup>
              {/* Account and institution names are member-typed; longer ones wrap rather than
                  truncate, so nothing is hidden. Institution's floor is its own heading. */}
              <col style={{ width: '8rem' }} />
              <col style={{ width: '7.5rem' }} />
              <col style={{ width: '4.5rem' }} />
              <col style={{ width: '5.5rem' }} />
              <col style={{ width: '6.5rem' }} />
              {/* The widest read-only cell: a two-clause balance sentence, happy to wrap. */}
              <col style={{ width: '11rem' }} />
              {/* Badges never wrap (.badge is nowrap), so these two need room for the longest
                  label -- "SimpleFIN" and "deactivated" -- or the chip spills into its neighbour. */}
              <col style={{ width: '7rem' }} />
              <col style={{ width: '7.5rem' }} />
              {/* Room for the widest button ("Update account") on its own line. */}
              <col style={{ width: '9.5rem' }} />
            </colgroup>
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
                        : account.latestBalanceMovedCents === 0
                          ? `${formatCents(account.latestBalanceCents)} as of ${account.latestBalanceDate}`
                          : `${formatCents(account.latestBalanceCents)} now · from a balance recorded ${account.latestBalanceDate}`}
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
                  {/* v1.8.0 Task 5 (spec 2026-08-23), ruling R7: diagnostic, not an alert -- one
                      plain-language line per discrepancy, no badge, no icon, nothing rendered
                      at all when the account is clean. */}
                  {account.discrepancies.length > 0 ? (
                    <tr>
                      <td colSpan={9} className="bg-warning-soft/50">
                        <ul className="flex flex-col gap-1 px-1 py-2 text-xs text-warning-soft-fg">
                          {account.discrepancies.map((discrepancy) => (
                            <li key={`${discrepancy.fromDate}-${discrepancy.toDate}`}>{discrepancyMessage(discrepancy)}</li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ) : null}
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
                              blank is the starting value, not the current balance echoed back.
                              v1.8.0 ruling R9: a credit account asks for the amount OWED (a
                              positive figure) and updateAccountAction negates it on write --
                              chequing/cash keep the plain "Balance" label and store the sign
                              exactly as typed, including negative for an overdrawn account. */}
                          <div className="flex flex-col gap-1">
                            <span className={labelClass}>{account.type === 'credit' ? 'Amount currently owed' : 'Balance'}</span>
                            <input
                              name="balance"
                              placeholder="e.g. 1234.56"
                              aria-label={
                                account.type === 'credit'
                                  ? `Amount currently owed on ${account.name}`
                                  : `Balance for ${account.name}`
                              }
                              className={`w-28 ${rowInput}`}
                            />
                            {account.type === 'credit' ? (
                              <span className={hintClass}>What you owe on this card right now. We store it as a negative balance.</span>
                            ) : null}
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
