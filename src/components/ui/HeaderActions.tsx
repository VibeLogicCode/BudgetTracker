'use client';

import { buttonClass } from '@/components/ui/Button';
import { RowMenu, RowMenuButton, RowMenuForm } from '@/components/ui/RowMenu';

/** A click handler, or a form posting `fields` to `action` (a server action dispatcher). */
export type HeaderAction =
  | { key: string; label: string; title?: string; onSelect: () => void }
  | {
      key: string;
      label: string;
      title?: string;
      action: (formData: FormData) => void | Promise<unknown>;
      fields: Record<string, string>;
    };

/** One look for every header action, whichever kind it is. */
const BUTTON_CLASS = buttonClass('secondary', 'sm', 'min-h-11 sm:min-h-0');

function ActionButton({ action }: { action: HeaderAction }) {
  if ('onSelect' in action) {
    return (
      <button type="button" className={BUTTON_CLASS} title={action.title} onClick={action.onSelect}>
        {action.label}
      </button>
    );
  }
  const { action: submit, fields } = action;
  return (
    <form
      action={(formData: FormData) => {
        void submit(formData);
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button type="submit" className={BUTTON_CLASS} title={action.title}>
        {action.label}
      </button>
    </form>
  );
}

/**
 * v1.59.0. A section card's header actions in one style. One action stays a button at every
 * width, because a menu of one is worse than a button (RowMenu's own rule). More than one is a row
 * of buttons from `sm:` up and, on a phone, one "Actions" menu holding the same actions, so the
 * header never wraps into a stack of buttons. Each width renders its set once: CSS hides the other.
 */
export function HeaderActions({ menuLabel, actions }: { menuLabel: string; actions: HeaderAction[] }) {
  if (actions.length === 0) return null;
  if (actions.length === 1) return <ActionButton action={actions[0]} />;
  return (
    <>
      <div className="hidden flex-wrap items-center justify-end gap-2 sm:flex">
        {actions.map((action) => (
          <ActionButton key={action.key} action={action} />
        ))}
      </div>
      <div className="sm:hidden">
        <RowMenu label={menuLabel} trigger="Actions">
          {actions.map((action) =>
            'onSelect' in action ? (
              <RowMenuButton key={action.key} onSelect={action.onSelect}>
                {action.label}
              </RowMenuButton>
            ) : (
              <RowMenuForm key={action.key} action={action.action} fields={action.fields}>
                {action.label}
              </RowMenuForm>
            ),
          )}
        </RowMenu>
      </div>
    </>
  );
}
