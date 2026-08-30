/**
 * The card is the app's only container. Everything on a page is either a card
 * or a page header, which keeps the rhythm predictable across nine sections.
 *
 * `padded={false}` is for cards whose child bleeds to the edge — a table or a
 * chart — so the border radius clips it instead of floating inside a gutter.
 *
 * Padding tightened from `p-5 sm:p-6` to `p-4 sm:p-5` (the owner's "too much wasted space"
 * complaint) across every sub-component below; `.card` itself (globals.css) dropped its
 * box-shadow in the same pass, so a card's edge is carried by the hairline border alone.
 */
export function Card({
  children,
  className = '',
  as: Tag = 'section',
}: {
  children: React.ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article' | 'aside';
}) {
  return <Tag className={`card overflow-hidden ${className}`}>{children}</Tag>;
}

export function CardHeader({
  title,
  description,
  action,
  className = '',
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-4 sm:px-5 ${className}`}>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {description ? <p className="text-sm text-muted">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function CardBody({
  children,
  className = '',
  padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return <div className={`${padded ? 'px-4 pb-4 sm:px-5 sm:pb-5' : ''} ${className}`}>{children}</div>;
}

export function CardFooter({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`border-t border-line bg-surface-2/60 px-4 py-3 text-sm text-muted sm:px-5 ${className}`}>
      {children}
    </div>
  );
}
