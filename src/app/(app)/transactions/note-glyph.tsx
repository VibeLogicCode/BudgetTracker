/**
 * Owner report, second rejection (2026-08-30): the note indicator's glyph was `NoteIcon` from
 * src/components/ui/icons.tsx, which is lucide's `StickyNote` -- a page with a folded corner. That
 * reads as "here is a generic document", not "there is a note attached to this charge", which is
 * the one thing this glyph exists to say at a glance. src/components/ui/icons.tsx is held by
 * another lane right now (see the hard rule this task shipped under), and swapping what `NoteIcon`
 * points to there would also change it everywhere else that name is used -- so the replacement is
 * defined fresh here instead: a small speech-bubble with two lines of text inside it, the
 * conventional "comment/annotation" glyph, unmistakably different from a bare document icon.
 *
 * Drawn on the same 24-unit grid, `currentColor` stroke, 1.75 stroke width and round caps/joins
 * as every hand-authored icon in src/components/icons.tsx (that file's own docblock states the
 * convention this matches), so it sits at home next to them once it moves there -- which is where
 * it belongs, and should move the moment that file is not held by a concurrent lane. Moving it is
 * a one-file cut-and-paste: export the same function from icons.tsx instead, update the one import
 * site in transactions-client.tsx, delete this file.
 */
export interface NoteGlyphProps {
  className?: string;
}

export function NoteGlyph({ className }: NoteGlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ?? 'h-5 w-5'}
    >
      <path d="M4.5 5.5h13a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5H10l-4 3.3v-3.3H4.5A1.5 1.5 0 0 1 3 14.5v-7.5a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M7.5 9.5h9M7.5 12.5h5.5" />
    </svg>
  );
}
