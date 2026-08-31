'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardBody } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import { createGoalAction, type GoalActionState } from '../actions';

const initial: GoalActionState = {};

/**
 * v1.20.0: goal creation moves off /goals onto its own route, mirroring /warranties/new
 * exactly (see warranties/new/new-warranty-client.tsx) -- pressing "Add goal" used to reveal a
 * disclosure BELOW the whole goal gallery on the same page, which is the one idiom this page's
 * own family of "create a thing" flows was supposed to have stopped using. This form is the
 * disclosure's old contents, moved verbatim: the Card and every field are unchanged, only the
 * page around them is new.
 *
 * Success handling matches createWarrantyAction's shape rather than reinventing one: this form
 * has no in-place notice of its own because createGoalAction now redirects to /goals on success
 * (see actions.ts) instead of returning a message there is nowhere left to show it -- the
 * created goal's own card is the confirmation, the same way landing on a warranty's detail page
 * is. `state.error` is the only thing this component reads back, for the same reason
 * new-warranty-client.tsx's does: a validation refusal needs somewhere to be shown, and this
 * page is the only page still mounted when one happens.
 */
export function NewGoalClient({ people }: { people: { id: number; name: string }[] }) {
  const [state, action] = useActionState(createGoalAction, initial);

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        title="New goal"
        description="Name it, give it a target, and it starts tracking pace on the first contribution."
        actions={
          <Link href="/goals" className="btn btn--ghost btn--sm">
            Cancel
          </Link>
        }
      />
      <FormError message={state.error} />

      <Card className="max-w-md">
        <CardBody>
          <form action={action} className="flex flex-col gap-4">
            <Field label="Name">
              <input name="name" placeholder="Trip to Japan" required className={inputClass} />
            </Field>
            <Field label="Target amount">
              <input name="target" inputMode="decimal" placeholder="5000" required className={inputClass} />
            </Field>
            <Field label="Target date (optional)">
              <input type="date" name="targetDate" className={inputClass} />
            </Field>
            <Field label="Owner">
              <select name="owner" className={selectClass}>
                <option value="shared">Shared</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>{person.name}</option>
                ))}
              </select>
            </Field>
            <SubmitButton className="w-fit">Create goal</SubmitButton>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
