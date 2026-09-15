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
 *
 * 2026-09-15, `$impeccable critique` P1. This used `bg-info-soft` / `text-info-soft-fg` — byte for
 * byte the treatment `Notice tone="info"` uses for a real statement about the household's DATA
 * ("Viewing March 2026. Net worth still reflects today"). It renders at the top of nine pages,
 * closed, permanently. Two things went wrong at once: info-blue stopped meaning "something is
 * true about your money" and started meaning wallpaper, so the genuine banner beside it got
 * skipped; and the guide copy, which is some of the best writing in the product, was dressed as
 * the thing readers are trained to dismiss.
 *
 * It is a quiet panel on `--surface` now. `--info-soft` is reserved for statements about data.
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
    <details open={open} className="rounded-md border border-line bg-surface px-3.5 py-3 text-sm text-muted">
      <summary className="cursor-pointer font-medium text-ink">{summary}</summary>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </details>
  );
}
