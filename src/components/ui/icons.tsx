/**
 * The one import site for `lucide-react` (ruling D2). Icons were a real gap: the hand-drawn set
 * in src/components/icons.tsx covers the nav rail and chrome (MUST-14.9 pins those exports) but
 * was never meant to grow a glyph for every category a household might invent, or for the
 * in/out arrows a ledger row needs -- hand-authoring that catalogue does not scale the way the
 * nav rail's dozen icons did. `lucide-react` is adopted for exactly that larger, open-ended set;
 * this file is where every one of its icons enters the app, so a later icon swap -- or a switch
 * away from lucide entirely -- is a change to one file instead of a search-and-replace across
 * every page that renders a chevron.
 *
 * Exported under house names rather than lucide's own (`MoneyInIcon`, not `ArrowDownLeft`): a
 * caller should ask for what the icon MEANS here, the same indirection the sibling hand-drawn
 * file already gives the nav rail. New content icons belong in THIS file from here on; the
 * hand-drawn file stays scoped to navigation and chrome and gains nothing new.
 */
import type { ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Baby,
  Banknote,
  Calendar,
  Car,
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  Clock,
  Filter,
  Gift,
  GraduationCap,
  HeartPulse,
  Home,
  Landmark,
  Music2,
  PawPrint,
  PiggyBank,
  Plane,
  Receipt,
  ShoppingBag,
  Sparkles,
  Tag,
  TriangleAlert,
  Upload,
  Utensils,
} from 'lucide-react';

/** What every exported glyph below actually is: a lucide icon component, typed generically so a
 *  caller can pass `className`, `strokeWidth`, etc. without this file re-declaring lucide's own
 *  prop surface. */
export type IconComponent = ComponentType<LucideProps>;

/* ---- Money direction -- ListRow's circled arrow (ruling: sign already in the amount, this is
   decorative, so ListRow marks it aria-hidden itself). ---- */
export const MoneyInIcon: IconComponent = ArrowDownLeft;
export const MoneyOutIcon: IconComponent = ArrowUpRight;

/* ---- Structural chrome the new component family shares ---- */
/** The "View breakdown" / "Hide breakdown" disclosure chevron (MetricCard's expandable footer,
 *  a category card's children). Rotation on open is the caller's className, not this file's. */
export const ExpandIcon: IconComponent = ChevronRight;
/** The chip-row disclosure ("Filters (N)", ruling D6's "+n" expander is plain text, not this). */
export const FilterIcon: IconComponent = Filter;
/** Import page and dashboard "Upload" section actions. */
export const UploadIcon: IconComponent = Upload;
/** The days-remaining pill (a warranty's expiry, a goal's target date, a bill's due date). */
export const CalendarIcon: IconComponent = Calendar;
export const ClockIcon: IconComponent = Clock;
/** Inside a week, the days-remaining pill goes warning-toned and gets this glyph (D5/Lane 3). */
export const WarningIcon: IconComponent = TriangleAlert;
export const AlertIcon: IconComponent = CircleAlert;
/** Review queue: a per-row confirm button, and the outline dot a row shows before it has one. */
export const ConfirmIcon: IconComponent = Check;
export const UnconfirmedIcon: IconComponent = Circle;
/** "Accept all suggestions" -- the bayes guesses the review queue is clearing in bulk. */
export const SuggestIcon: IconComponent = Sparkles;

/**
 * Maps a top-level category NAME to an icon. Categories are freeform rows a household creates
 * (src/db/seed.ts's SEED_CATEGORIES is only a starting point, not an enum), so this is keyword
 * matching against the names that seed list and its common synonyms actually use, not a lookup
 * table keyed on a fixed id. Checked in order and case-insensitively; the first match wins, and
 * a name nothing here recognises gets `Tag` -- a sensible "this is still a category" fallback
 * rather than a blank tile.
 */
const CATEGORY_ICON_RULES: { match: RegExp; icon: IconComponent }[] = [
  { match: /income|salary|paycheck|payroll/i, icon: Banknote },
  { match: /hous|rent|mortgage|utilit/i, icon: Home },
  { match: /grocer|food|dining|restaurant|coffee/i, icon: Utensils },
  { match: /transport|\bcar\b|gas|fuel|parking|transit/i, icon: Car },
  { match: /shop|cloth|electronic/i, icon: ShoppingBag },
  { match: /health|medical|dental|pharmacy|fitness/i, icon: HeartPulse },
  { match: /\bkids?\b|child|baby/i, icon: Baby },
  { match: /\bfees?\b|bank|interest/i, icon: Landmark },
  { match: /travel|flight|vacation/i, icon: Plane },
  { match: /education|tuition|school|student/i, icon: GraduationCap },
  { match: /gift|donat/i, icon: Gift },
  { match: /\bpets?\b/i, icon: PawPrint },
  { match: /subscript|entertainment|music|stream/i, icon: Music2 },
  { match: /saving|goal/i, icon: PiggyBank },
  { match: /insurance|warrant/i, icon: Receipt },
  { match: /personal/i, icon: Sparkles },
];

export function categoryIcon(name: string): IconComponent {
  return CATEGORY_ICON_RULES.find((rule) => rule.match.test(name))?.icon ?? Tag;
}
