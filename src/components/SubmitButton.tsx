'use client';

import { useFormStatus } from 'react-dom';
import { buttonClass, type ButtonSize, type ButtonVariant } from '@/components/ui/Button';

/**
 * The submit button for every server-action form. The pending state comes from
 * useFormStatus, so it works without the page having to thread a flag down —
 * and double-submit protection is a side effect of the disabled attribute
 * (several flows rely on that: the import wizard would orphan a staging id).
 */
export function SubmitButton({
  children,
  className = '',
  disabled = false,
  variant = 'primary',
  size = 'md',
  onClick,
  ariaLabel,
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** For a button whose visible words are deliberately short ("That's fine", one per row) and
   *  therefore say nothing on their own when read out of the row they sit in. */
  ariaLabel?: string;
  /** An ordinary click handler, fired before the form's own action starts — for the rare
   *  case (the Updates card's review panel) where something needs to happen at urgent
   *  priority rather than being deferred until the action settles. */
  onClick?: () => void;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      onClick={onClick}
      aria-label={ariaLabel}
      className={buttonClass(variant, size, className)}
    >
      {pending ? 'Working…' : children}
    </button>
  );
}
