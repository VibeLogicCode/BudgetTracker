'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
// A RELATIVE import, deliberately -- not '@/app/(app)/bills/actions'. The client-bundle guard
// (tests/ops/client-bundle.test.ts) walks `@/`-qualified value imports transitively looking for
// a path back to @/db/client et al.; actions.ts is a 'use server' file (Next elides its real
// body from the client bundle and leaves only a callable reference), but the guard's regex scan
// cannot see that distinction and would otherwise walk into its @/lib/env import and flag it. A
// relative specifier is deliberately outside what the guard resolves further (see
// resolveAtImport's docblock) -- the same reason every existing client component in this
// codebase reaches its sibling 'use server' actions.ts via '../actions', not the `@/` alias.
import { recordBillPaymentAction, type BillActionState } from '../app/(app)/bills/actions';

const initial: BillActionState = {};

/**
 * Task 11 (v1.13.0, ruling R8): the ONE bit of client interactivity the Coming-up card needs.
 * ComingUpCard itself stays a server component (it does no data fetching of its own -- everything
 * arrives as props), so this is a tiny client child rather than a reason to convert the whole card,
 * the same boundary-minimising move SubmitButton itself already makes.
 */
export function RecordPaymentForm({ installmentId }: { installmentId: number }) {
  const [state, dispatch] = useActionState(recordBillPaymentAction, initial);
  return (
    <form action={dispatch} className="flex flex-col items-end gap-1">
      <input type="hidden" name="installmentId" value={installmentId} />
      <SubmitButton className="btn btn--ghost btn--sm">Record payment</SubmitButton>
      <FormError message={state.error} />
    </form>
  );
}
