'use client';

import { useActionState, useEffect, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill } from '@/components/ui/Pill';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Field, hintClass, inputClass, labelClass, selectClass } from '@/components/ui/form';
import { RowMenu, RowMenuButton, RowMenuForm } from '@/components/ui/RowMenu';
import { SettingsIcon } from '@/components/icons';
import { todayIso } from '@/lib/dates';
import { formatCents } from '@/lib/money';
// v1.31.0 F-03: moved to its own pure module so import-client.tsx's post-commit summary (also
// 'use client') can render the identical sentence without value-importing balance-reconcile.ts
// itself (which reaches @/db/client -- see discrepancy-message.ts's own docblock for why that
// matters). Imported (not just re-exported) because this file's own JSX below still calls it;
// re-exported by name so this file's callers, and its test, are unaffected by the move.
import { discrepancyMessage } from '@/lib/discrepancy-message';
export { discrepancyMessage };
import { createAccountAction, setAccountActiveAction, updateAccountAction, type AccountsFormState } from './actions';
// Type-only (ruling P4): this file is 'use client' and must never VALUE-import
// src/lib/balance-reconcile.ts, which reaches @/db/client to run reconcileAccount. `import
// type` erases at compile time, so only the shape of Discrepancy crosses into the client
// bundle -- page.tsx (a server component) is the only caller of reconcileAccount itself, and
// hands the results down as plain data through the `discrepancies` prop below.
import type { Discrepancy } from '@/lib/balance-reconcile';
// Type-only, same reasoning as Discrepancy above: AccountType is a plain string union with no
// runtime import of its own, but @/lib/accounts as a module also exports value-level functions
// that reach @/db/client, so only the type may cross into this client component.
import type { AccountType } from '@/lib/accounts';

export interface AccountRow {
  id: number;
  name: string;
  institution: string;
  type: AccountType;
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
   * discrepancyMessage, imported above from src/lib/discrepancy-message.ts), rendered directly
   * under the account, and nothing at all when the
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
 * Lane 4 (2026-08-30 one-design-language plan): the hero value MetricCard wants -- the balance
 * itself, signed exactly as stored (a credit card stays negative), or an em dash when no
 * snapshot has ever landed. Split out of the old table cell's one combined sentence so `value`
 * and `status` below can be two independent, independently-styled slots instead of one string.
 */
function balanceValue(account: AccountRow): string {
  return account.latestBalanceCents === null ? '—' : formatCents(account.latestBalanceCents);
}

/**
 * The staleness sentence MetricCard's `status` slot wants (spec: "the staleness sentence as
 * status"). Ruling R7 (v1.8.0 Task 5): the anchor date is provenance, not "today"'s label, once
 * movement has been folded in -- see latestBalanceMovedCents's own docblock above. The three
 * branches are unchanged from the table cell this replaces; only the leading amount is gone,
 * because `value` above already says it.
 */
function balanceStatus(account: AccountRow): string {
  if (account.latestBalanceCents === null) return 'no balance yet';
  if (account.latestBalanceMovedCents === 0) return `as of ${account.latestBalanceDate}`;
  return `now · from a balance recorded ${account.latestBalanceDate}`;
}

/**
 * The subtitle MetricCard wants -- "say something real about the card's contents" (that
 * component's own docblock), not a bare count. Institution, owner, the import mapping (or
 * SimpleFIN, for a synced account) and active/deactivated together are what the retired table's
 * five columns (Institution/Owner/Mapping/Source/Status) said about a row that were not already
 * the hero balance or the type Pill. Each piece is its own <span> -- not one joined string -- so
 * a test (or a screen reader's "find text") can still land on "TD Chequing/Debit" or "none" on
 * its own, exactly as it could when Mapping was its own table column.
 */
function AccountSubtitle({ account, people }: { account: AccountRow; people: PersonRow[] }) {
  const ownerLabel = account.ownerUserId === null ? 'Joint' : (people.find((p) => p.id === account.ownerUserId)?.name ?? 'Joint');
  const mappingLabel = account.isSimplefinManaged ? 'SimpleFIN' : (account.importProfileName ?? 'none');
  const statusLabel = account.isActive ? 'active' : 'deactivated';
  return (
    <span className="flex flex-wrap items-center gap-1">
      {account.institution === '' ? null : (
        <>
          <span>{account.institution}</span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <span>{ownerLabel}</span>
      <span aria-hidden="true">·</span>
      <span>{mappingLabel}</span>
      <span aria-hidden="true">·</span>
      <span>{statusLabel}</span>
    </span>
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
  // Ruling R10: savings and asset are new enough that the select needs a one-line explanation
  // right under it, and only the one that applies to what is currently picked.
  const [newAccountType, setNewAccountType] = useState<AccountType>('chequing');
  /**
   * 2026-08-30 Settings disclosure sweep: v1.16.0's own rule ("Content is always visible. A
   * form that creates something sits behind a button" -- CHANGELOG 1.16.0, the Quick add / Add
   * rule / Add receipt folds) reached Goals next and then a read-only audit of Settings, which
   * is what this toggle answers. Closed by default, same as every other disclosure the rule has
   * produced so far.
   */
  const [addAccountOpen, setAddAccountOpen] = useState(false);

  // A failed create must not leave its own form collapsed -- FormError below renders INSIDE
  // this card's form, so a closed card would swallow the very message the person needs to see.
  // Keyed on the createState object itself (the same idiom warranty-detail-client.tsx's own
  // M10/edit-close effects use): useActionState hands back a new object only when
  // createAccountAction actually ran, so this fires exactly once per real submission and never
  // fights someone who closes the card afterwards while the same stale error still sits in state.
  useEffect(() => {
    if (createState.error) setAddAccountOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createState]);

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
    <div className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        eyebrow="Settings"
        title="Bank accounts"
        description="Every import needs an account to land in. Add one per bank account you export a CSV from (or plan to link to SimpleFIN). Accounts are deactivated, never deleted — the transactions and import history that point at them have to keep working."
      />

      <div id="add-account">
        <Card className="max-w-md">
          <CardHeader
            title="Add an account"
            action={
              // The title already reads as the action, so the toggle's label matches it exactly
              // -- the same "Add rule" / "Close" shape warranty-detail-client.tsx's Payment
              // matching card uses. 44px floor (global constraint) via min-h-11, same as there.
              <button
                type="button"
                className="btn btn--secondary btn--sm min-h-11 sm:min-h-0"
                aria-expanded={addAccountOpen}
                aria-controls="add-account-body"
                onClick={() => setAddAccountOpen((open) => !open)}
              >
                {addAccountOpen ? 'Close' : 'Add an account'}
              </button>
            }
          />
          {/* Hidden via the real `hidden` attribute, never conditionally unmounted -- ruling
              U2/U3's reasoning (budgets-client.tsx EditRow, managers-client.tsx CategoryRow):
              a form that vanished from the DOM on collapse would turn a future test that reads
              its option lists on a closed render into a false negative for no reason connected
              to what it is actually testing. Nothing in this file's own suite reaches into this
              particular form today, but every other disclosure in the app keeps this contract,
              and there is no upside to this one being the exception. */}
          <div id="add-account-body" hidden={!addAccountOpen}>
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
                <Field
                  label="Type"
                  hint={
                    newAccountType === 'savings'
                      ? 'Savings — like a chequing account, but left out of safe-to-spend.'
                      : newAccountType === 'asset'
                        ? 'Asset — a house, a TFSA or an RRSP. You type the balance in; it takes no transactions and no imports.'
                        : undefined
                  }
                >
                  <select
                    name="type"
                    value={newAccountType}
                    onChange={(e) => setNewAccountType(e.target.value as AccountType)}
                    className={selectClass}
                  >
                    <option value="chequing">Chequing</option>
                    <option value="credit">Credit</option>
                    <option value="cash">Cash</option>
                    <option value="savings">Savings</option>
                    <option value="asset">Asset</option>
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
          </div>
        </Card>
      </div>

      <FormError message={rowError} />
      {rowMessage ? <Notice tone="success">{rowMessage}</Notice> : null}

      <div className="flex flex-col gap-3">
        <SectionHeader title={`Accounts (${accounts.length})`} />
        {accounts.length === 0 ? (
          <Card>
            <EmptyState
              icon={SettingsIcon}
              title="No accounts yet. Add the first one above."
              action={
                // Opens the disclosure as well as scrolling to it -- with zero accounts this is
                // the very first thing a person clicks, and a collapsed card at the far end of
                // the anchor would be a dead end.
                <a
                  href="#add-account"
                  className="btn btn--primary btn--sm"
                  onClick={() => setAddAccountOpen(true)}
                >
                  Add an account
                </a>
              }
            />
          </Card>
        ) : (
          // Lane 4 (2026-08-30 one-design-language plan): a MetricCard grid, one card per
          // account -- the same `grid gap-4 md:grid-cols-2 lg:grid-cols-3` Budgets and Goals
          // use. The table this replaces needed a `fixed minWidth="60.5rem"` colgroup to fit
          // nine columns; a card has no row of columns to widen in the first place.
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {accounts.map((account) => (
              <MetricCard
                key={account.id}
                title={account.name}
                subtitle={<AccountSubtitle account={account} people={people} />}
                pill={
                  <Pill tone="neutral" className="capitalize">
                    {account.type}
                  </Pill>
                }
                value={balanceValue(account)}
                status={balanceStatus(account)}
                action={
                  <RowMenu label={`Actions for ${account.name}`}>
                    <RowMenuButton onSelect={() => openEditor(account)}>Update account</RowMenuButton>
                    <RowMenuForm
                      action={setActive}
                      fields={{ accountId: String(account.id), active: account.isActive ? '0' : '1' }}
                    >
                      {account.isActive ? 'Deactivate' : 'Reactivate'}
                    </RowMenuForm>
                  </RowMenu>
                }
              >
                {/* v1.8.0 Task 5 (spec 2026-08-23), ruling R7: diagnostic, not an alert -- one
                    plain-language line per discrepancy, no badge, no icon, nothing rendered at
                    all when the account is clean. */}
                {account.discrepancies.length > 0 ? (
                  <ul className="flex flex-col gap-1 rounded-md bg-warning-soft/50 px-3 py-2 text-xs text-warning-soft-fg">
                    {account.discrepancies.map((discrepancy) => (
                      <li key={`${discrepancy.fromDate}-${discrepancy.toDate}`}>{discrepancyMessage(discrepancy)}</li>
                    ))}
                  </ul>
                ) : null}
                {editing !== null && editing.id === account.id ? (
                  <form
                    action={update}
                    onSubmit={() => setEditing(null)}
                    className="flex flex-wrap items-end gap-3 border-t border-line pt-3"
                  >
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
                ) : null}
              </MetricCard>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
