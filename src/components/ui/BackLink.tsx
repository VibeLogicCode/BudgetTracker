import type { ReactNode } from 'react';
import Link from 'next/link';
import { BackIcon } from '@/components/ui/icons';

const LOOK =
  'self-start inline-flex items-center gap-1.5 font-medium text-accent-text hover:underline min-h-11 sm:min-h-0';

/** A link back up the page hierarchy; the arrow is an icon, so the name is just the label. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} data-back className={LOOK}>
      <BackIcon aria-hidden="true" className="size-4 shrink-0" />
      {children}
    </Link>
  );
}

/** The same look for a back step that is an action, not a navigation. */
export function BackButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button type="button" data-back onClick={onClick} disabled={disabled} className={`${LOOK} disabled:opacity-60`}>
      <BackIcon aria-hidden="true" className="size-4 shrink-0" />
      {children}
    </button>
  );
}
