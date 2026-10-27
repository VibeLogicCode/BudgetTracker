import type { ReactNode } from 'react';
import Link from 'next/link';
import { ExpandIcon } from '@/components/ui/icons';

const LOOK =
  'flex w-full items-center justify-between gap-2 text-left font-medium text-accent-text hover:underline min-h-11 sm:min-h-0';

/**
 * A card's footer action: full width, label left, chevron right. Pass `href` for a navigation,
 * or `onClick` for a button. `expanded` (when given) makes it a disclosure and rotates the
 * chevron; `opensDialog` marks a button that opens a dialog.
 */
export function CardActionRow({
  children,
  href,
  onClick,
  expanded,
  controls,
  opensDialog,
}: {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  expanded?: boolean;
  controls?: string;
  opensDialog?: boolean;
}) {
  const icon = (
    <ExpandIcon
      aria-hidden="true"
      className={`size-4 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`.trim()}
    />
  );
  if (href !== undefined) {
    return (
      <Link href={href} className={LOOK}>
        <span>{children}</span>
        {icon}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={LOOK}
      aria-expanded={expanded === undefined ? undefined : expanded}
      aria-controls={controls}
      aria-haspopup={opensDialog ? 'dialog' : undefined}
    >
      <span>{children}</span>
      {icon}
    </button>
  );
}
