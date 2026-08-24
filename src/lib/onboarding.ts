import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accounts, imports } from '@/db/schema';
import { reviewQueueCount } from '@/lib/categorize/engine';

/**
 * What "set up" means, in one place (spec 2026-08-23, ruling A4).
 *
 * Progress is DERIVED here rather than written down anywhere -- no per-user flag, no
 * "first steps" document, no column recording which steps a household finished. That is
 * the whole reason the Dashboard card is preferred over prose: a checklist that runs
 * count(*) at render time cannot disagree with the database, so it cannot go stale when
 * someone deletes their only account or restores a backup taken before their first import.
 *
 * The queries count rather than list, in the idiom of reviewQueueCount() and
 * countMatchingMerchant(): the card needs existence, not rows, and listAccounts() /
 * listImportHistory() would load and join whole result sets to answer a boolean.
 */
export interface OnboardingStep {
  key: 'account' | 'import' | 'review';
  title: string;
  body: string;
  href: string;
  cta: string;
}

/**
 * Copy lives beside the signals so a reader changing what a step means sees the sentence
 * the household will read for it. Nothing here states a number a household should hit --
 * these are mechanics and order of operations only (ruling A2).
 */
const STEPS: readonly OnboardingStep[] = [
  {
    key: 'account',
    title: 'Add a bank account',
    body: 'Every import lands in an account, so this comes first. One row per real-world account — chequing, credit card, cash.',
    href: '/settings/accounts',
    cta: 'Add an account',
  },
  {
    key: 'import',
    title: 'Import your first statement',
    body: 'Download a CSV from your bank and drop it in. Built-in profiles cover several Canadian banks; any other bank works through the same mapping wizard.',
    href: '/import',
    cta: 'Start an import',
  },
  {
    key: 'review',
    title: 'Clear the review queue',
    body: 'The categorizer flags anything it was unsure about. Accept or correct each one and it remembers that merchant next time.',
    href: '/review',
    cta: 'Open Review',
  },
];

function hasAnyAccount(): boolean {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(accounts)
    .get();
  return (row?.c ?? 0) > 0;
}

function hasAnyImport(): boolean {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(imports)
    .get();
  return (row?.c ?? 0) > 0;
}

/**
 * The steps still undone, in dependency order. An empty array means setup is complete,
 * which is how the card knows to render nothing.
 *
 * `review` is done only when the queue is empty AND something has been imported. Without
 * that second condition an untouched database -- which trivially has an empty queue --
 * would report the last step as finished before any data existed, so a new household would
 * be shown a checklist that was already two-thirds green and told nothing about Review.
 */
export function onboardingSteps(): OnboardingStep[] {
  const accountDone = hasAnyAccount();
  const importDone = hasAnyImport();
  const reviewDone = importDone && reviewQueueCount() === 0;
  const done: Record<OnboardingStep['key'], boolean> = {
    account: accountDone,
    import: importDone,
    review: reviewDone,
  };
  return STEPS.filter((step) => !done[step.key]);
}
