import type { ReactNode } from 'react';
import { ExpandIcon } from '@/components/ui/icons';

/**
 * One look for every disclosure: accent text, a chevron pointing right at rest and down when
 * open. `DisclosureSummary` is for a native `<details>` (the caller's element carries
 * `group/disclosure` so the chevron can follow its `open` state); `DisclosureButton` is the same
 * look for a controlled toggle.
 */
const LOOK = 'flex items-center gap-1.5 cursor-pointer font-medium text-accent-text hover:underline';

export function DisclosureSummary({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <summary className={`list-none [&::-webkit-details-marker]:hidden ${LOOK} ${className}`.trim()}>
      <ExpandIcon aria-hidden="true" className="size-4 shrink-0 transition-transform group-open/disclosure:rotate-90" />
      {children}
    </summary>
  );
}

export function DisclosureButton({
  open,
  onToggle,
  controls,
  label,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  controls?: string;
  /** The accessible name when the button is icon-only. */
  label?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={label}
      className={`${LOOK} min-h-11 sm:min-h-0`}
    >
      <ExpandIcon
        aria-hidden="true"
        className={`size-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`.trim()}
      />
      {children}
    </button>
  );
}
