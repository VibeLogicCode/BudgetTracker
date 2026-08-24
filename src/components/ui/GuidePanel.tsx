/**
 * A collapsible info panel: one question the reader can press, and the answer underneath.
 *
 * Ruling A6 — this markup was the `GuidePanel` inside the notification setup guides, and it
 * moved here the moment a second caller wanted it. The summary text is the only thing that
 * varies between callers, so it is the only prop that was added; the styling stays in one
 * place because two divergent info-panel styles in one app is the inconsistency this exists
 * to prevent, not a matter of taste.
 *
 * Plain `<details>` on purpose: the open/closed toggle is the browser's, so this renders
 * identically from a server component and needs no client bundle. Callers derive `open` from
 * something they already know — nothing here is stored, so there is no per-user flag and no
 * migration behind a panel.
 */
export function GuidePanel({
  summary,
  open,
  children,
}: {
  summary: string;
  open: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={open} className="rounded-md bg-info-soft px-3.5 py-3 text-sm text-info-soft-fg">
      <summary className="cursor-pointer font-semibold">{summary}</summary>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </details>
  );
}
