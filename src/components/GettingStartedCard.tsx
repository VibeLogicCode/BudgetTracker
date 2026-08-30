import Link from 'next/link';
import type { OnboardingStep } from '@/lib/onboarding';
import { Card, CardFooter, CardHeader } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';

/**
 * SELF-HIDING, in the manner of LoansCard: the dashboard renders it unconditionally and it is
 * absent once `onboardingSteps()` returns nothing. That is the whole of the dismiss story
 * (ruling A9) -- three completable steps and a card that goes away when they are done, rather
 * than a per-user flag and the migration one would cost.
 *
 * Props-only and dumb on purpose. Every signal is counted in src/lib/onboarding.ts, so this
 * component cannot disagree with the database and cannot re-derive a step the caller filtered
 * out. Undone steps arrive already in dependency order; the order here is the caller's.
 *
 * WHY THE HANDOFF IS A PERMANENT FOOTER AND NOT A FINAL STATE. Budgets, goals and coverage are
 * where this app's value is, and the card has to name them before it disappears for good. It
 * cannot do that after the last step: the finished card renders nothing, so a "you're done"
 * state would be a state no household ever sees. Shown alongside whatever steps remain, the
 * sentence is read during setup instead -- while there is still a card to read it in.
 */
export function GettingStartedCard({ steps }: { steps: OnboardingStep[] }) {
  if (steps.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Getting started"
        description="Do these in order — each one needs the one above it. This card goes away on its own once they are done."
      />
      {/* Ruling D1: ListRow (Lane 0) -- title + meta + a trailing control is exactly this row's
          shape, the same one every other never-a-table list on this page is converting to. */}
      <ol className="border-t border-line text-sm">
        {steps.map((step) => (
          <ListRow
            key={step.key}
            title={step.title}
            meta={step.body}
            trailing={
              <Link href={step.href} className="btn btn--secondary btn--sm">
                {step.cta}
              </Link>
            }
          />
        ))}
      </ol>
      <CardFooter>
        After that, budgets, goals and coverage are what to explore next —{' '}
        <Link href="/help" className="font-medium text-accent-text underline underline-offset-2">
          Help
        </Link>{' '}
        walks through each of them.
      </CardFooter>
    </Card>
  );
}
