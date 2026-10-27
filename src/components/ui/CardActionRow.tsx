import type { ReactNode } from 'react';
import Link from 'next/link';
import { ExpandIcon } from '@/components/ui/icons';

const LOOK = 'items-center text-left font-medium text-accent-text hover:underline min-h-11 sm:min-h-0';
const ROW = `flex w-full justify-between gap-2 ${LOOK}`;
const INLINE = `inline-flex gap-0.5 ${LOOK}`;

/**
 * A card's footer action: full width, label left, chevron right. Pass `href` for a navigation,
 * or `onClick` for a button. `expanded` (when given) makes it a disclosure and rotates the
 * chevron; `opensDialog` marks a button that opens a dialog. `inline` keeps the same look at the
 * width of its label, chevron right after it, for an action that ends a line of text.
 */
export function CardActionRow({
  children,
  href,
  onClick,
  expanded,
  controls,
  opensDialog,
  inline = false,
}: {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  expanded?: boolean;
  controls?: string;
  opensDialog?: boolean;
  inline?: boolean;
}) {
  const look = inline ? INLINE : ROW;
  const icon = (
    <ExpandIcon
      aria-hidden="true"
      className={`size-4 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`.trim()}
    />
  );
  if (href !== undefined) {
    return (
      <Link href={href} className={look}>
        <span>{children}</span>
        {icon}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={look}
      aria-expanded={expanded === undefined ? undefined : expanded}
      aria-controls={controls}
      aria-haspopup={opensDialog ? 'dialog' : undefined}
    >
      <span>{children}</span>
      {icon}
    </button>
  );
}
