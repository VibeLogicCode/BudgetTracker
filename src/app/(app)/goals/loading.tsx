import { PageSkeleton } from '@/components/ui/PageSkeleton';

/** 2026-09-15: see PageSkeleton's docblock for why a force-dynamic route needs one at all. */
export default function Loading() {
  return <PageSkeleton label="Loading your goals…" cards={2} />;
}
