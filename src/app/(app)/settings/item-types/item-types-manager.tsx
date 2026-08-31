'use client';

import { useActionState, useEffect, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { WarrantiesIcon } from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import { AutoSaveSelect, AutoSaveTextInput } from '@/components/ui/AutoSave';
import {
  createItemTypeAction,
  deleteItemTypeAction,
  renameItemTypeAction,
  setKindAction,
  type ItemTypesFormState,
} from './actions';
import type { ItemTypeWithUsage } from '@/lib/warranty/types';
import { ITEM_KINDS, ITEM_KIND_LABELS } from '@/lib/warranty/constants';

const initialState: ItemTypesFormState = {};

const rowInput = 'field-control w-auto px-2 py-1 text-xs';
const rowButton = 'btn btn--secondary btn--sm';

/** Bound for the auto-save controls. Type immutability on saved ITEMS is enforced server-side
 *  and is unaffected: this renames the TYPE and changes the TYPE's kind. */
const saveItemTypeName = (formData: FormData) => renameItemTypeAction({}, formData);
const saveItemTypeKind = (formData: FormData) => setKindAction({}, formData);

export function ItemTypesManager({ types }: { types: ItemTypeWithUsage[] }) {
  const [createState, create] = useActionState(createItemTypeAction, initialState);
  const [deleteState, remove] = useActionState(deleteItemTypeAction, initialState);
  /**
   * 2026-08-30 Settings disclosure sweep: v1.16.0's own rule ("Content is always visible. A
   * form that creates something sits behind a button" -- CHANGELOG 1.16.0, the Quick add / Add
   * rule / Add receipt folds) reached Goals next and then a read-only audit of Settings, which
   * is what this toggle answers. Closed by default, same as every other disclosure the rule has
   * produced so far.
   */
  const [addTypeOpen, setAddTypeOpen] = useState(false);

  // A failed create must not leave its own form collapsed -- FormError below renders INSIDE
  // this card's form, so a closed card would swallow the very message the person needs to see.
  // Keyed on the createState object itself (the same idiom warranty-detail-client.tsx's own
  // M10/edit-close effects use): useActionState hands back a new object only when
  // createItemTypeAction actually ran, so this fires exactly once per real submission and never
  // fights someone who closes the card afterwards while the same stale error still sits in state.
  useEffect(() => {
    if (createState.error) setAddTypeOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createState]);

  const rowError = deleteState.error;
  const rowMessage = deleteState.message;

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        eyebrow="Settings"
        title="Item types"
        description={
          <>
            The list members choose from when they record an item. Each type has a{' '}
            <strong className="font-semibold text-ink">kind</strong> — warranty, subscription, contract or loan —
            which changes the wording on those items (for example, a subscription shows a{' '}
            <strong className="font-semibold text-ink">cancel by</strong> date instead of an expiry date), and the
            dashboard reminds you before the period ends.
          </>
        }
      />

      <div id="add-type">
        <Card className="max-w-md">
          <CardHeader
            title="Add a type"
            action={
              // The title already reads as the action, so the toggle's label matches it exactly
              // -- the same "Add rule" / "Close" shape warranty-detail-client.tsx's Payment
              // matching card uses. 44px floor (global constraint) via min-h-11, same as there.
              <button
                type="button"
                className="btn btn--secondary btn--sm min-h-11 sm:min-h-0"
                aria-expanded={addTypeOpen}
                aria-controls="add-type-body"
                onClick={() => setAddTypeOpen((open) => !open)}
              >
                {addTypeOpen ? 'Close' : 'Add a type'}
              </button>
            }
          />
          {/* Hidden via the real `hidden` attribute, never conditionally unmounted -- ruling
              U2/U3's reasoning (budgets-client.tsx EditRow, managers-client.tsx CategoryRow):
              this exact form's own regression test (the 5b "exactly one [name=kind] control"
              lesson, below in item-types-manager.test.tsx) reads its <select> straight out of
              the DOM, and unmounting on collapse would have turned that test into a false
              negative for a reason that has nothing to do with what it is checking. */}
          <div id="add-type-body" hidden={!addTypeOpen}>
            <CardBody>
              <form action={create} className="flex flex-col gap-4">
                <FormError message={createState.error} />
                {createState.message ? <Notice tone="success">{createState.message}</Notice> : null}
                <Field label="Type name">
                  <input name="name" placeholder="Appliance" required maxLength={60} className={inputClass} />
                </Field>
                <Field label="Kind">
                  {/*
                    A plain <select> -- FormData.get() only ever returns one value for this key
                    either way, but a <select> also sidesteps the hidden-input-shadowing bug a
                    checkbox had here (see the create-form regression tests): there is exactly one
                    control and exactly one value, chosen, never inferred from absence.
                  */}
                  <select name="kind" defaultValue="warranty" className={selectClass}>
                    {ITEM_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {ITEM_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </Field>
                <SubmitButton className="w-fit">Add type</SubmitButton>
              </form>
            </CardBody>
          </div>
        </Card>
      </div>

      <FormError message={rowError} />
      {rowMessage ? <Notice tone="success">{rowMessage}</Notice> : null}

      <Card>
        <CardHeader title="Types" description={`${types.length} type${types.length === 1 ? '' : 's'}.`} />
        {types.length === 0 ? (
          <EmptyState
            icon={WarrantiesIcon}
            title="No item types yet"
            action={
              // Opens the disclosure as well as scrolling to it -- with zero types this is the
              // very first thing a person clicks, and a collapsed card at the far end of the
              // anchor would be a dead end.
              <a
                href="#add-type"
                className="btn btn--primary btn--sm"
                onClick={() => setAddTypeOpen(true)}
              >
                Add a type
              </a>
            }
          >
            Add one above — Appliance, Electronics and Subscription are a good start.
          </EmptyState>
        ) : (
          <TableWrap bare responsive>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Kind</th>
                <th scope="col" className="text-right">Items using it</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {types.map((type) => (
                <tr key={type.id} className="align-top">
                  {/* v1.15.0 (responsive rows): the type name is what tells one row from another
                      on this page, so it is the phone card's headline. No cell-stack-amount:
                      usageCount is a count of items, not money. */}
                  <td className="font-medium text-ink cell-stack-headline" data-label="Name">
                    <AutoSaveTextInput
                      name="name"
                      defaultValue={type.name}
                      fields={{ typeId: String(type.id) }}
                      action={saveItemTypeName}
                      ariaLabel={`Rename ${type.name}`}
                      maxLength={60}
                      className={`w-36 ${rowInput}`}
                    />
                  </td>
                  <td data-label="Kind">
                    <AutoSaveSelect
                      name="kind"
                      defaultValue={type.kind}
                      options={ITEM_KINDS.map((kind) => ({ value: kind, label: ITEM_KIND_LABELS[kind] }))}
                      fields={{ typeId: String(type.id) }}
                      action={saveItemTypeKind}
                      ariaLabel={`Kind of ${type.name}`}
                      className={rowInput}
                    />
                  </td>
                  <td className="tabnum text-right text-muted" data-label="Items using it">{type.usageCount}</td>
                  <td data-label="Actions">
                    <form action={remove}>
                      <input type="hidden" name="typeId" value={type.id} />
                      <button
                        type="submit"
                        disabled={type.usageCount > 0}
                        title={type.usageCount > 0 ? `${type.usageCount} item(s) use this type` : undefined}
                        className={rowButton}
                      >
                        Delete
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
