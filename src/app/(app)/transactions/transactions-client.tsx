'use client';

import Link from 'next/link';
import { Fragment, useActionState, useEffect, useState } from 'react';
import { FormError } from '@/components/FormError';
import { QuickAddTransaction } from '@/components/QuickAddTransaction';
import { SubmitButton } from '@/components/SubmitButton';
import { CheckIcon, TransactionsIcon } from '@/components/icons';
import { Card, CardBody, CardFooter } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill } from '@/components/ui/Pill';
import { PillNav, type PillNavOption } from '@/components/ui/PillNav';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { Field, inputClass, labelClass, selectClass } from '@/components/ui/form';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { AutoSaveSelect } from '@/components/ui/AutoSave';
import { RowMenu, RowMenuButton, RowMenuForm, RowMenuLink } from '@/components/ui/RowMenu';
// Lane 0 (ruling D2/D1): the one import site for these glyphs is src/components/ui/icons.tsx --
// see its own docblock. ConfirmIcon/UnconfirmedIcon are the per-row confirm button's two states
// (item 5), MoneyInIcon/MoneyOutIcon are the review card's own circled direction arrow (item 4,
// the same pair ListRow uses so a person sees one money-direction vocabulary everywhere),
// SuggestIcon marks "Accept all suggestions" as the bulk sibling of the per-row Bayes guess, and
// FilterIcon (fix round) is the glyph on the filter disclosure button that replaced the old
// "Filters (N)" text button -- see that button's own comment below for why. That file's own
// NoteIcon (lucide's StickyNote) is NOT used here any more -- the owner's second rejection of the
// note indicator was that it reads as a generic document, not "a note exists"; see note-glyph.tsx
// for its hand-drawn replacement and why it could not simply be swapped in-place there instead.
import { categoryIcon, ConfirmIcon, FilterIcon, MoneyInIcon, MoneyOutIcon, SuggestIcon, UnconfirmedIcon } from '@/components/ui/icons';
import { NoteGlyph } from './note-glyph';
import { RowDialog } from '@/components/ui/RowDialog';
import { categoryOptionGroups, categoryOptions, type CategoryLike, type CategoryOptionGroup } from '@/lib/category-order';
import { type ResolvedRange } from '@/lib/date-range';
import type { LoanLink } from '@/lib/loans';
import { absCents, formatCents, parseAmountToCents, sumCents } from '@/lib/money';
// F-01 (v1.31.0): the same builder Reports and the dashboard link their figures with. Reaching
// for it here rather than writing `?q=${encodeURIComponent(...)}` inline is the whole point of
// the module -- see its docblock on why a second, hand-built definition is the defect shape.
import { transactionsHref } from '@/lib/transaction-links';
import type { SplitRow } from '@/lib/splits';
import type {
  CategorizationSource,
  CategoryGroupPage,
  CategoryGroupRow,
  SortDirection,
  TransactionPage,
  TransactionRow,
  TransactionSort,
} from '@/lib/transactions';
import { LOAN_DIRECTIONS, LOAN_DIRECTION_LABELS } from '@/lib/warranty/constants';
import {
  acceptAllGuessesAction,
  acceptGuessAction,
  applyToAllMatchingAction,
  assignToLoanAction,
  bulkAssignToLoanAction,
  bulkCategorizeAction,
  // v1.26.0 Lane 3a item 4: the two group-header actions -- see their own docblocks in actions.ts
  // for why each posts the page's filter rather than a list of rendered row ids.
  bulkConfirmGroupAction,
  bulkNoteAction,
  bulkRecategorizeGroupAction,
  bulkTransferAction,
  createLoanFromTransactionAction,
  renameTransactionAction,
  saveNoteAction,
  saveSplitsAction,
  setAttributionAction,
  setCategoryAction,
  setRowTransferAction,
  unassignFromLoanAction,
  type ActionState,
} from './actions';

// The table's own <colgroup> below carries one <col> per column: checkbox, date, account,
// description, amount, category, person, kebab. The note sub-row spans all of them, read off
// here rather than hardcoded a second time at the point of use.
const COLUMN_COUNT = 8;

interface Option { id: number; name: string; parentId?: number | null; isArchived?: boolean }
interface LoanOption { id: number; name: string }

/** Draft state for one row of the split editor. Amounts are kept as the raw dollar text the
 *  person is typing (parsed with parseAmountToCents only at remainder/submit time) so a
 *  half-typed value like "12." never gets silently rewritten under someone's cursor. */
interface SplitPartDraft {
  categoryId: string;
  amount: string;
  note: string;
}

const blankSplitPart = (): SplitPartDraft => ({ categoryId: '', amount: '', note: '' });

const initial: ActionState = {};

/**
 * v1.16.0 Lane C item 3. The root below used to carry `data-page-width="wide"` in BOTH modes,
 * bumping the shell's `main` to a 96rem cap for the review filter too -- so the guide and the
 * filter card ran to 96rem while the card list a few lines down stayed capped at `max-w-4xl`
 * (ruling S5(a)), a visible edge mismatch on any screen wide enough to show both. The fix has two
 * halves: the root only emits the wide marker OUTSIDE review mode now (see its own comment below),
 * and everything from here down to the pager sits inside this one container in review mode, so
 * every edge lines up with the card list's own cap instead of each element picking its own.
 *
 * A plain Fragment outside review mode, not a `<div>` with a conditional class: a Fragment adds no
 * DOM node at all, which is what keeps "outside review mode nothing about the layout may change"
 * literally true rather than merely "true modulo one extra wrapping div that happens to carry no
 * width class".
 */
function ReviewWidth({ active, children }: { active: boolean; children: React.ReactNode }) {
  return active ? <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 sm:gap-5">{children}</div> : <>{children}</>;
}

/**
 * Card-density fix (2026-08-30, coordinator's screenshot review): the card's own category/person
 * selects used to carry their own bespoke `CARD_FIELD_CLASS` (`w-full`, stretching to fill a
 * two-column grid cell -- see git history) and `REVIEW_PICKER_CLASS` (a separate dense class the
 * apply-to-all editor used, now gone entirely now that that editor is a dialog with room to use
 * the plain `selectClass` instead, per applyAllDialog's own comment). Both are deleted: "a
 * category picker is no more usable at 400px than at 200px, it just pushes the card apart" is the
 * coordinator's own diagnosis, and the fix is not a THIRD bespoke class -- it is to stop bespoke-
 * sizing this control at all and let every AutoSaveSelect on this page default to the same
 * `AUTO_SAVE_CONTROL` the desktop table row's own category/person selects already use (neither
 * passes a `className` today). One dense, natural-width, 44px-floored control class for every
 * per-row select on this page, table or card, review or not.
 */

/**
 * The auto-save controls take `(formData) => Promise<{ error?: string }>`. Both actions are
 * declared `(prevState, formData)` for useActionState, so the first argument is bound here --
 * once, at module level, rather than in a closure whose identity changes on every render.
 */
const saveCategory = (formData: FormData) => setCategoryAction({}, formData);
const saveAttribution = (formData: FormData) => setAttributionAction({}, formData);

/**
 * v1.19.0 Lane 2 item 3 (date grouping): `row.date` is a plain ISO date (`YYYY-MM-DD`, no time
 * component). `new Date('2026-08-29')` alone parses that as UTC midnight, which prints as Aug 28
 * evening in any timezone west of UTC -- appending a local midnight time first (the same fix
 * src/components/ComingUpCard.tsx already applies to its own display-only date math) keeps the
 * browser reading it back as the same calendar day it displays elsewhere on this page. This file
 * is a 'use client' component, not src/lib/**, so `new Date()` here is the ordinary display-
 * formatting case that ruling's ban was never about.
 */
function formatDayHeader(date: string): string {
  return new Date(`${date}T00:00:00`)
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    .toUpperCase();
}

/** Rows arrive already sorted by date (desc outside review mode, asc inside it -- listTransactions'
 *  own ORDER BY), so "is this the first row of a new day" is just a comparison against the
 *  previous element, never a full grouping pass that would have to preserve that same order back. */
function startsNewDay(rows: TransactionRow[], index: number): boolean {
  return index === 0 || rows[index - 1].date !== rows[index].date;
}

/**
 * F-02 (v1.31.0, owner's question: "how much went on the Visa this month?"). The "N transactions"
 * text every footer on this page already showed answered a count, never a sum -- this appends the
 * sum, as TWO figures rather than one net.
 *
 * `absCents` on both: `outCents` arrives negative (it is a sum of negative rows) and `inCents`
 * arrives non-negative, so printing them raw would read "-$4,812.30 out", a double negative no
 * plain-language footer should carry -- "out"/"in" already say the direction, the same way `Money`
 * itself only adds colour, never a redundant sign, when a caller already states the direction in
 * words.
 *
 * Never netted into one figure. See TransactionPage.outCents/inCents's own doc comment
 * (src/lib/transactions.ts) for why: a `transfers=all` view of a credit card counts the payment TO
 * the card as money in, and netting it against the same period's spending would make that payment
 * vanish into a smaller "spent" number instead of showing up as the money it plainly is.
 */
function outInWords(outCents: number, inCents: number): string {
  return `${formatCents(absCents(outCents))} out · ${formatCents(absCents(inCents))} in`;
}

/**
 * F-02. The flat-list pager text, byte-identical across review mode, the mobile card list and the
 * desktop table -- ONE function so the three copies (each width/mode's own footer, see the render
 * branches below) cannot drift the way a hand-repeated string invites. `page.total` is already the
 * WHOLE filtered set's count (listTransactions' own doc comment); `outCents`/`inCents` are that
 * same set's two sums, computed over the identical `where`.
 */
function pageFooterWords(page: TransactionPage): string {
  return `Page ${page.page} of ${page.pageCount} — ${page.total} transaction${page.total === 1 ? '' : 's'} · ${outInWords(page.outCents, page.inCents)}`;
}

/** Chip filters (ruling D6) show roughly this many top-level categories before folding the rest
 *  behind a "+n" expander -- see the chip row's own comment below for why a flat list this long
 *  never needs a scrollbar the way the design reference's does. */
const VISIBLE_CHIP_COUNT = 8;

/**
 * "This page's current querystring, with exactly one param changed" -- `current` is
 * `currentQuery`, the querystring page.tsx already parsed from the request and handed down as a
 * prop (see that prop's own comment), so every OTHER active filter (account, person, date range,
 * search, uncategorized-only, transfer view, and `review=1` itself) survives the click untouched.
 * `page` is dropped too: changing what is being filtered belongs back on page 1, not wherever
 * pagination happened to be. `value === null` deletes the key entirely rather than writing an
 * empty/default value into the querystring, so the "no filter" link stays a bare `/transactions`
 * (or whatever else is active) instead of growing a param nobody would ever type by hand.
 *
 * Shared by the category chips (categoryChipHref, just below) and the transfer-view control
 * further down this file -- the same generalization
 * src/app/(app)/settings/merchant-rules/merchant-rules-client.tsx's own chipHref already applied
 * to ITS chips (see that function's own comment: "copy the idiom, not invent a second one").
 *
 * Bug fix (owner report, categoryChipHref's original defect): this used to read
 * `window.location.search`, captured into a `useState('')` an effect filled in on mount.
 * Server-side (and for one render on the client, before that effect ever ran) that state is
 * empty, so the FIRST paint of every chip pointed at a bare `/transactions?category=N` -- account,
 * person, dates, search, uncategorized-only, transfer view and `review=1` all stripped. Clicking
 * a chip from the review queue before hydration landed on plain Transactions with no filters,
 * which is exactly what was reported. Sourcing the href from what the SERVER already knows means
 * the first server-rendered HTML is correct, with no hydration effect required to fix it up after.
 */
function filterHref(current: string, key: string, value: string | null): string {
  const params = new URLSearchParams(current);
  if (value === null) params.delete(key);
  else params.set(key, value);
  // v1.26.0 Lane 3a: `gpage` joins `page` here for the identical reason -- changing what is being
  // filtered belongs back at the start of whichever pager is in play, and a group page number left
  // behind by a filter change points at a page of clusters that no longer exists (the household
  // would land on an empty grouped view and read it as "the rules did nothing"). `key` itself is
  // exempt from the reset so the GROUP PAGER's own links, which are `filterHref(..., 'gpage', n)`,
  // are not silently emptied by the very line meant to reset them.
  for (const reset of ['page', 'gpage']) if (reset !== key) params.delete(reset);
  const query = params.toString();
  return query.length > 0 ? `/transactions?${query}` : '/transactions';
}

/** One chip's destination href, changing only the `category` param -- see filterHref's own
 *  docblock for the reasoning this and every other filter-preserving link on this page shares. */
function categoryChipHref(current: string, categoryId: string | null): string {
  return filterHref(current, 'category', categoryId);
}

/**
 * v1.24.0 Lane A item 2 (owner report: "currently once i apply a trasnfer its hard to find that
 * data again"). The three states TransactionFilter.transferView understands
 * (src/lib/transactions.ts), paired with the `transfers` query value each one navigates to.
 * `'all'` clears the param entirely (filterHref's own null-means-delete contract) rather than
 * writing `transfers=all`. `'none'` keeps writing `transfers=0` -- the value existing bookmarked
 * links already use -- rather than some new spelling that would orphan them.
 */
const TRANSFER_VIEW_OPTIONS: { value: 'all' | 'only' | 'none'; label: string; param: string | null }[] = [
  { value: 'all', label: 'All', param: null },
  { value: 'only', label: 'Transfers only', param: 'only' },
  { value: 'none', label: 'No transfers', param: '0' },
];

/**
 * v1.25.0 Lane R item R1 (deferred from v1.20.0). The review queue mixes a row the classifier
 * GUESSED (source = 'bayes', a category to confirm or correct) with a row it had no idea about
 * (categoryId null, a category to pick from scratch) -- REVIEW_SUGGESTED_WHERE/
 * REVIEW_UNCATEGORIZED_WHERE (src/lib/categorize/engine.ts) narrow REVIEW_WHERE to each. Same
 * `{ value, label, param }` shape as TRANSFER_VIEW_OPTIONS just above, on purpose: both feed the
 * same filterHref (this file's own generalization of that idiom, see its doc comment) and now
 * the same PillNav rendering, only the query key (`queue` vs `transfers`) differs.
 *
 * Only ever rendered in review mode (`reviewMode`, below) -- `?queue=` composes with `?review=1`,
 * never stands in for it, the same way REVIEW_SUGGESTED_WHERE/REVIEW_UNCATEGORIZED_WHERE only
 * ever narrow REVIEW_WHERE inside buildWhere (src/lib/transactions.ts), never stand alone.
 */
const QUEUE_CHIP_OPTIONS: { value: '' | 'suggested' | 'uncategorized'; label: string; param: string | null }[] = [
  { value: '', label: 'All', param: null },
  { value: 'suggested', label: 'Suggested', param: 'suggested' },
  { value: 'uncategorized', label: 'Not categorized', param: 'uncategorized' },
];

/**
 * v1.26.0 Lane 3a item 1. `?sort=` / `?dir=`, same `{ value, label, param }` shape as
 * TRANSFER_VIEW_OPTIONS/QUEUE_CHIP_OPTIONS above so all four rows feed the same filterHref and the
 * same PillNav -- only the query key differs.
 *
 * "Default" is a real, first-class option rather than an absence someone has to guess at, and its
 * `param: null` DELETES `?sort=` (filterHref's null-means-delete contract). That matters more here
 * than for the other rows: `sort` absent is the ONLY value that leaves this page's ordering exactly
 * as it has always been -- newest first, or oldest first while working the review queue
 * (TransactionFilter.sort's own doc comment, src/lib/transactions.ts) -- and `?sort=date&dir=desc`
 * is NOT the same thing (it would override the queue's own oldest-first order). So there has to be
 * a way back to it, and it has to be a deletion, not a spelling.
 *
 * A leftover `?dir=` after clicking Default is left in the URL on purpose. filterHref changes one
 * param per link by design (its own docblock), and a direction with no sort is inert at every layer
 * -- orderByFor returns the default branch before it ever reads `direction`, and readFilter
 * (filter-params.ts) does not even put it on the filter object. Chaining two edits into one href to
 * tidy a param that changes nothing would mean a second href helper, which this page deliberately
 * does not have.
 */
const SORT_OPTIONS: { value: '' | TransactionSort; label: string; param: string | null }[] = [
  { value: '', label: 'Default', param: null },
  { value: 'date', label: 'Date', param: 'date' },
  { value: 'amount', label: 'Amount', param: 'amount' },
  { value: 'category', label: 'Category', param: 'category' },
];

/**
 * v1.26.0 Lane 3a item 1. The direction row's labels, per sort field. "Ascending/Descending" is
 * accurate and tells a person nothing. Category's pair says A-Z rather than "first/last" because an
 * alphabetical run is what it is -- and neither label mentions the uncategorized rows, which sort
 * LAST in both directions by design (TransactionFilter.direction's own doc comment), so no label
 * here can promise otherwise.
 *
 * Amount says "Highest"/"Lowest", NOT "Largest"/"Smallest", and the difference is not stylistic.
 * `amount_cents` is SIGNED -- spending is negative -- so descending puts a $1 coffee above a $900
 * rent payment and income above everything. "Largest first" would be read as "largest spend
 * first", which is what `dir=asc` actually does, and a label that names the opposite of what the
 * click delivers is worse than a dry one. Highest and lowest are literally true of a signed column
 * in both directions.
 */
const DIRECTION_LABELS: Record<TransactionSort, Record<SortDirection, string>> = {
  date: { desc: 'Newest first', asc: 'Oldest first' },
  amount: { desc: 'Highest first', asc: 'Lowest first' },
  category: { asc: 'A–Z', desc: 'Z–A' },
};

/**
 * v1.26.0 Lane 3a item 3. `?source=`, the filter the audit view exists for: REVIEW_WHERE
 * (src/lib/categorize/engine.ts) is `category IS NULL OR source = 'bayes'`, so a rule-assigned row
 * never enters the review queue and, before this release, no surface on this page could show what
 * the rules had decided. "Rules" is the first non-All option for that reason.
 *
 * Labels name what a person did, or did not do -- "By hand", "Nothing yet" -- rather than the
 * column's own values ('manual', 'none'), which are names for the database's benefit. "Guesses"
 * matches the wording the row badges and the review queue already use for the classifier.
 *
 * The clear-the-filter option is "Any", not "All", and that is not a synonym chosen for variety:
 * the transfer-view row a few lines up this card already has an option labelled "All", so a second
 * "All" would put two identically-named pills on one card with different meanings -- ambiguous to
 * read, and ambiguous to name in a test or to a screen reader walking the two `<nav>` landmarks.
 * "Set by: Any" also reads as the sentence the label makes, which "Set by: All" does not.
 */
const SOURCE_FILTER_OPTIONS: { value: '' | CategorizationSource; label: string; param: string | null }[] = [
  { value: '', label: 'Any', param: null },
  { value: 'rule', label: 'Rules', param: 'rule' },
  { value: 'bayes', label: 'Guesses', param: 'bayes' },
  { value: 'manual', label: 'By hand', param: 'manual' },
  { value: 'none', label: 'Nothing yet', param: 'none' },
];

/**
 * v1.26.0 Lane 3a item 2. `?group=category`. Two options, one param, same shape as everything
 * above -- and a mode switch rather than a filter, which is why it reads "List" / "By category"
 * instead of naming what is being kept.
 */
const GROUP_VIEW_OPTIONS: { value: '' | 'category'; label: string; param: string | null }[] = [
  { value: '', label: 'List', param: null },
  { value: 'category', label: 'By category', param: 'category' },
];

/**
 * v1.26.0 Lane 3a item 3. What each row's badge says about where its category came from.
 *
 * THIS IS INFORMATION, NOT A WARNING, and the styling says so: `badge--muted` is this app's one
 * quiet badge (transparent, dashed outline, `--subtle` text -- globals.css, where its own comment
 * describes it as the tone that "never gets mistaken for a status the app actually determined").
 * Fifty amber rows after an import get ignored exactly the way fifty red ones would, which is the
 * same reasoning bankBadgeButton's docblock already records for declining a colour warning there.
 *
 * KEPT DISTINGUISHABLE FROM THE RENAME BADGE, which is the real hazard: this row can already carry
 * a badge whose text is the single word `rule`, and that one means "a rename rule replaced the
 * merchant TEXT" -- a different rule kind, about a different column, with a different consequence.
 * Three separate things keep them apart, so no one of them has to carry it alone:
 *   - WORDING. "set by rule" names the act (something was set) and reads as a sentence fragment
 *     about the category; the rename badge is a bare noun, `rule`. Neither string is a prefix or
 *     substring of the other, so a test (and a person scanning) can tell them apart by text alone.
 *   - TONE. The rename badge is `badge--blue` -- filled, `--info-soft` -- and every one of these is
 *     `badge--muted`, outlined and unfilled. Filled versus outlined is the strongest non-colour
 *     difference the badge vocabulary has, so this survives a colour-blind reader and a greyscale
 *     screenshot.
 *   - AFFORDANCE. The rename badge is a BUTTON that opens the bank-text dialog (bankBadgeButton);
 *     these are plain `<span>`s with nothing to activate. So they differ in the accessibility tree
 *     too, not merely in appearance: one is announced as a button with a name, the other as text.
 *
 * `none` maps to null -- no badge at all. A row with nothing yet has an empty category select
 * sitting beside it saying the identical thing, and an outlined chip reading "set by nothing" is a
 * badge that exists to describe an absence the reader is already looking at.
 */
const SOURCE_BADGE_LABELS: Record<CategorizationSource, string | null> = {
  rule: 'set by rule',
  bayes: 'set by guess',
  manual: 'set by hand',
  none: null,
};

export function TransactionsClient({
  page,
  accounts,
  categories,
  people,
  today,
  range = null,
  loanOptions = [],
  loanLinks = {},
  splits = {},
  defaultAccountId = null,
  selfScoped = false,
  reviewMode = false,
  reviewCount = 0,
  matchingCounts = {},
  renameRules = {},
  groups = null,
  currentQuery = '',
}: {
  page: TransactionPage;
  accounts: Option[];
  categories: CategoryLike[];
  people: Option[];
  today: string;
  range?: ResolvedRange | null;
  /** v1.3.1: loans with a balance still owed. Empty for a household with none (MUST-14.9). */
  loanOptions?: LoanOption[];
  loanLinks?: Record<number, LoanLink[]>;
  /** v1.7.0 Task 4: existing splits for the rows on this page, keyed by transaction id. A
   *  row absent from this map (or mapped to an empty array) has never been split. */
  splits?: Record<number, SplitRow[]>;
  /** v1.13.0 ruling R7: quick-add's own default account for this person (users.last_account_id). */
  defaultAccountId?: number | null;
  /** v1.13.0 ruling R2: a self viewer's own id already forces the person filter server-side
   *  (page.tsx), so the pill that would let them ask for someone else is not rendered at all. */
  selfScoped?: boolean;
  /**
   * Review round (fold /review in): true when `?review=1` narrowed this page to the review
   * queue -- always `false` for a self viewer (ruling R2, forced server-side in page.tsx, never
   * re-derived here). Swaps the table for the card list (ruling R5), turns on the review-only
   * kebab items ("Accept <category>", "Apply a category to all N…"), the review teaching
   * PageGuide and the review empty state.
   */
  reviewMode?: boolean;
  /** reviewQueueCount(), for the "Needs review (N)" chip -- always passed, even when
   *  `reviewMode` is false or the viewer is self-scoped; the CLIENT decides whether to render
   *  the chip (never for a self viewer, ruling R2), not the caller. */
  reviewCount?: number;
  /** Review-mode-only, keyed by transaction id: how many OTHER transactions share this row's
   *  merchant (Lane 1's countMatchingMerchant). Empty outside review mode -- the "Apply a
   *  category to all N matching…" kebab item never appears for a table row. */
  matchingCounts?: Record<number, number>;
  /**
   * v1.26.0 Lane 1 (owner report: "shows amazon i dont know what orignal entry was so maybe its
   * wrong maybe its not"). Keyed by transaction id, only for a row whose display_source is
   * 'rename' AND whose current rename rule could actually be resolved (page.tsx's own doc
   * comment on this prop has the "why absent, not null" reasoning) -- what bankTextDialog (below)
   * needs to show the "Rule: contains AMAZON → "Amazon"" line and its Edit/Delete links. Empty
   * outside review of a rename, the same "extra data about this page's rows" shape loanLinks/
   * splits already use above.
   */
  renameRules?: Record<number, { pattern: string; matchType: string; renameTo: string; ruleId: number }>;
  /**
   * v1.26.0 Lane 3a item 2. groupTransactionsByCategory's page of clusters (src/lib/transactions.ts)
   * for the SAME filter the row list above was built from -- `null` whenever `?group=category` is
   * off, which is also how this component decides which view to render. One value, not a `groups`
   * plus a `groupMode` boolean that could disagree with it.
   *
   * Every group here carries its FULL count and subtotal, across every row page it spans (that
   * function's own doc comment). That is what lets a group header state a number the bulk actions
   * below can honour -- and it is why they post the page's filter rather than the ids of rendered
   * rows, which are not the same set (see bulkConfirmGroupAction's docblock, actions.ts).
   */
  groups?: CategoryGroupPage | null;
  /**
   * Bug fix (owner report, category chips silently dropping every other filter): the querystring
   * this request arrived with, already parsed by page.tsx (readFilter's own `params`) and handed
   * down as a plain string rather than re-derived from `window.location.search` on the client.
   * categoryChipHref (above) and `activeCategoryChip` (below) are the only two things that read
   * this -- everything else on this page already gets its filter values as typed props (`range`,
   * `selfScoped`, etc.), not by re-parsing a querystring a second time. Defaults to '' so a caller
   * that hands nothing still renders (every existing test in this file that never mentions chips),
   * at the cost of "All" being the only chip that would render correctly for it -- exactly the
   * same fallback the deleted `currentSearch` state used to have before its effect ever ran.
   */
  currentQuery?: string;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [renaming, setRenaming] = useState<{ id: number; current: string; merchant: string } | null>(null);
  const [splitting, setSplitting] = useState<{
    id: number;
    /** Owner report (item 1): the modal dialog names the transaction it is editing (merchant,
     *  date, amount) in its own header, so a person is never left wondering which row Split…
     *  was for once the row itself is out of view behind the backdrop. Captured here, at open
     *  time, rather than re-looked-up from `page.rows` on every render of the dialog. */
    merchant: string;
    date: string;
    amountCents: number;
    parts: SplitPartDraft[];
  } | null>(null);
  // Unify-the-editors task (2026-08-30): the backdrop, focus trap, Escape handling, body-scroll
  // lock and opener-focus-restore this state used to need its OWN ref pair and two effects for
  // (see git history) now live once, generically, in RowDialog -- see that component's own
  // docblock. This state is only the split form's own DATA any more (which row, its parts, the
  // remainder math), not its dialog chrome.
  // Mirrors `renaming` exactly (ruling R13): one nullable slot of state, so opening the note
  // sub-row on a different row always replaces whichever one was already open.
  const [noting, setNoting] = useState<{ id: number; current: string } | null>(null);
  /**
   * v1.26.0 Lane 1. Mirrors `noting` exactly: one nullable slot, so opening the bank-text dialog
   * (bankTextDialog, below) on a different row always replaces whichever one was already open. A
   * plain row id rather than a small captured object -- unlike renaming/splitting, nothing here
   * needs to remember a value from the moment the dialog opened; bankTextDialog looks its row up
   * fresh from `page.rows` (findRow, below) every render, the same way renameDialog/noteDialog/
   * newLoanDialog/applyAllDialog already do.
   */
  const [bankTextRow, setBankTextRow] = useState<number | null>(null);
  // Addendum A, ruling A1: mirrors `noting` exactly -- one nullable slot, so opening the
  // "Assign to loan…" sub-row on a different row always replaces whichever one was open.
  //
  // Review round: `name` is carried in this state (a CONTROLLED input below), not left as an
  // uncontrolled DOM value, because React resets an action-bound form's uncontrolled fields
  // to their defaults once the action settles -- on a refusal just as much as a success. Without
  // this, the very name a person typed when the refusal happened would vanish from the input
  // the instant the action's promise resolved, even though the form itself stays open.
  //
  // Backlog BY: `itemId` is this same editor's own "Assign to" select, carried in state for the
  // same reason `name` already is -- an existing-loan choice must survive a refusal exactly like
  // a typed name does. '' means "New loan…" (the name/direction fields below apply); any other
  // value is an existing loan's id, and Save posts straight to assignToLoanAction instead.
  const [newLoan, setNewLoan] = useState<{ id: number; name: string; itemId: string } | null>(null);
  /**
   * v1.25.0 Lane R item R3. The two new bulk actions' own dialog state -- one nullable slot
   * each, the same "one editor, replacing whichever was open" shape `newLoan`/`noting` already
   * use above, scoped to the whole `selected` array rather than one row. `bulkLoan.itemId` is a
   * CONTROLLED select (same reason newLoan.itemId is, above): it drives the dialog's own
   * changed/skipped preview live as a person picks a different loan, before Save is ever
   * pressed. `''` only while `loanOptions` is empty (the bulk action itself is not offered then,
   * see the bulk-actions list below), so a real open always seeds a real id.
   */
  const [bulkLoan, setBulkLoan] = useState<{ itemId: string } | null>(null);
  /** Mirrors `bulkLoan` immediately above: one nullable slot for the bulk note dialog. */
  const [bulkNoting, setBulkNoting] = useState(false);
  /**
   * v1.26.0 Lane 3a item 4. The two group-header actions' dialog state -- one nullable slot each,
   * the same "one editor, replacing whichever was open" shape `bulkLoan`/`bulkNoting` already use,
   * scoped to one CLUSTER rather than to the `selected` array. The whole CategoryGroupRow is
   * captured (not just its id) because the dialog has to state the group's name, its true row count
   * and its subtotal, and those are exactly the numbers the header the person just clicked showed
   * them -- re-deriving them from `groups` on every render would let the dialog and the header
   * disagree if the group page ever changed underneath it. `recatGroup.categoryId` is a CONTROLLED
   * select for the same reason bulkLoan.itemId is: it drives the dialog's own live sentence about
   * where the group is going, before Save is ever pressed.
   */
  const [confirmGroup, setConfirmGroup] = useState<CategoryGroupRow | null>(null);
  const [recatGroup, setRecatGroup] = useState<{ group: CategoryGroupRow; categoryId: string } | null>(null);
  const [attrState, attrAction] = useActionState(setAttributionAction, initial);
  const [bulkCatState, bulkCatAction] = useActionState(bulkCategorizeAction, initial);
  const [bulkTfrState, bulkTfrAction] = useActionState(bulkTransferAction, initial);
  const [bulkLoanState, bulkLoanAction] = useActionState(bulkAssignToLoanAction, initial);
  const [bulkNoteState, bulkNoteFormAction] = useActionState(bulkNoteAction, initial);
  // v1.26.0 Lane 3a item 4: one instance each, for the same reason acceptState and acceptAllState
  // are kept apart below -- two different server functions, and a confirm in flight must not be
  // able to show a recategorize's error (or vice versa).
  const [confirmGroupState, confirmGroupFormAction] = useActionState(bulkConfirmGroupAction, initial);
  const [recatGroupState, recatGroupFormAction] = useActionState(bulkRecategorizeGroupAction, initial);
  const [renameState, renameAction] = useActionState(renameTransactionAction, initial);
  const [assignState, assignLoan] = useActionState(
    (_prev: ActionState, formData: FormData) => assignToLoanAction(formData),
    initial,
  );
  const [unassignState, unassignLoan] = useActionState(
    (_prev: ActionState, formData: FormData) => unassignFromLoanAction(formData),
    initial,
  );
  const [splitState, splitAction] = useActionState(saveSplitsAction, initial);
  const [noteState, noteAction] = useActionState(saveNoteAction, initial);
  const [newLoanState, newLoanAction] = useActionState(createLoanFromTransactionAction, initial);
  // Review round (fold /review in): ruling R4's per-row transfer toggle, offered on every row in
  // both modes.
  const [rowTransferState, rowTransferAction] = useActionState(setRowTransferAction, initial);
  // Review-mode-only actions (inventory #5/#7).
  const [acceptState, acceptAction] = useActionState(acceptGuessAction, initial);
  const [applyAllState, applyAllAction] = useActionState(applyToAllMatchingAction, initial);
  // v1.19.0 Lane 2 item 5: "Accept all suggestions" -- a separate useActionState instance from
  // acceptState above (a different server function, acceptAllGuessesAction), even though both
  // ultimately run the same per-row guard. Keeping them apart means one row's plain Accept and
  // the bulk button never fight over the same pending/error state while both could plausibly be
  // in flight from two different clicks.
  const [acceptAllState, acceptAllAction] = useActionState(acceptAllGuessesAction, initial);
  // One nullable slot of state, the same shape `noting`/`newLoan` already use: opening the
  // "Apply a category to all N…" editor on a different row replaces whichever one was open.
  const [applyAllRow, setApplyAllRow] = useState<number | null>(null);

  // Ruling S7 (v1.15.0): below `sm` the filter controls sit behind a "Filters" disclosure so
  // they do not compete with the rows they filter for a phone's limited height (same reason as
  // Quick add, ruling S6, just below). Open by default whenever the URL already carries a
  // filter, so someone refining a search they just ran finds it open rather than having to
  // discover the button first. Both start at "nothing filtered" and are corrected in the effect
  // below -- `window.location` does not exist during the server render, and reading it here, in
  // the render body, would print the server's "closed, no count" markup and then flip the
  // instant the effect ran on the client, which is exactly what a hydration mismatch is. Note
  // this file does NOT use next/navigation's useSearchParams() for this (unlike AppShell.tsx's
  // own `review` check): tests/app/transactions-page.test.tsx renders the real server page with
  // no app-router provider in place, and that hook throws outside one.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activeFilterCount, setActiveFilterCount] = useState(0);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const count = [
      params.get('account'),
      params.get('category'),
      params.get('person'),
      params.get('q'),
      params.get('uncat'),
      // v1.24.0 Lane A item 2: 'only' counts as active too, not just the old checkbox's '0' --
      // same rule category's own chip already follows two lines up (an always-visible control
      // still counts here and still opens the disclosure, exactly like `category` does).
      params.get('transfers') === '0' || params.get('transfers') === 'only' ? params.get('transfers') : null,
      params.get('range') || params.get('from') || params.get('to') ? '1' : null,
      // Fix round (owner report, phone screenshot): the audit bar (View/Sort/Set by) and the
      // review queue's chip row read their own filter off these four params the same way the
      // seven above already do, and this task made three of those rows fold below `sm` when
      // they're at default -- so this count has to know about all four now, or the funnel reads
      // "no filters" while one of THOSE rows is quietly filtering, which is the exact bug this
      // task exists to close. 'group' and 'source' are plain presence checks, same as `person`/`q`
      // above -- there is no "default value" spelling for either to exclude. 'sort' and 'queue'
      // are checked against their real values only, mirroring activeSort's/activeQueueChip's own
      // parses below, so a hand-edited junk value can't inflate the count.
      params.get('group'),
      params.get('source'),
      params.get('sort') === 'date' || params.get('sort') === 'amount' || params.get('sort') === 'category'
        ? params.get('sort')
        : null,
      params.get('queue') === 'suggested' || params.get('queue') === 'uncategorized' ? params.get('queue') : null,
    ].filter((value) => value !== null && value !== '').length;
    if (count > 0) {
      setActiveFilterCount(count);
      setFiltersOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Chip filters: whether the "+n" expander has been opened, revealing the rest of the top-level
  // chips inline. Never collapses back on its own -- the same one-way disclosure every other
  // expand-only control in this file (Filters, Quick add) uses.
  const [chipsExpanded, setChipsExpanded] = useState(false);

  // Review mode's own progress bar ("N/M confirmed", item 5). `page.total` under the review
  // filter IS the count of rows still waiting (ruling R1: review=1 composes with whatever other
  // filters are active, so this already matches what THIS filtered view would report anywhere
  // else on this page) -- it only ever shrinks as a row gets confirmed away. There is no server
  // column for "how many were in the queue when this session started" (this task touches no
  // src/lib file), so the ceiling is tracked client-side instead: it starts at today's count and
  // is raised, never lowered, if a fresh import grows the queue back up mid-session -- Math.max
  // is what keeps a growing queue from making "confirmed" read as more than 100%.
  const [queueCeiling, setQueueCeiling] = useState(page.total);
  useEffect(() => {
    setQueueCeiling((prev) => Math.max(prev, page.total));
  }, [page.total]);

  // v1.19.0 Lane 2 item 5: how many of THIS page's rows the progress bar counts as done, and
  // which of them "Accept all suggestions" would cover. Scoped to page.rows, not the whole
  // household queue: the review filter already paginates at 50 (listTransactions' own pageSize),
  // and a client component has nothing past what its own props were handed.
  const confirmedCount = Math.max(0, queueCeiling - page.total);
  const queueConfirmedPct = queueCeiling > 0 ? (confirmedCount / queueCeiling) * 100 : 100;
  const acceptAllIds = page.rows.filter((row) => row.source === 'bayes' && row.categoryId !== null).map((row) => row.id);

  const label = (id: number | null) => {
    if (id === null) return 'Uncategorized';
    const category = categories.find((c) => c.id === id);
    if (!category) return 'Uncategorized';
    const parent = category.parentId ? categories.find((c) => c.id === category.parentId) : undefined;
    return parent ? `${parent.name} › ${category.name}` : category.name;
  };

  // Filters, bulk actions and new entries must only ever assign a live category, and
  // categoryOptions() excludes archived categories itself -- so all five category selects in
  // this file now share one ordering helper (Task 6, v1.8.0) rather than each mapping the flat
  // creation-order list on its own. That sharing IS the fix: the original report was that one
  // screen showed `Kids, Fees, Fees > Bank Fees, Kids > Education`, and a per-call-site loop is
  // exactly how a future new category reintroduces that on one select only.
  //
  // The per-row select below additionally appends the ARCHIVED categories, flat and disabled,
  // after the grouped live ones. That coverage is deliberate: a row already carrying a category
  // that was archived after the fact must still have a real <option> for it, or the browser's
  // initial selection cannot match, the select falls back to "Uncategorized", and an untouched
  // "save" click clears (and untrains) a legitimate historical categorization.
  const groupedCategories = categoryOptions(categories);

  // Backlog BZ: the same rows as groupedCategories, arranged for an <optgroup> instead of NBSP
  // indentation -- a parent WITH children becomes a group named after it (itself included as
  // the group's first option), a childless top-level category stays a plain option.
  const categoryGroups: CategoryOptionGroup[] = categoryOptionGroups(categories);
  // AutoSaveSelect's own option shape (src/components/ui/AutoSave.tsx): a group is
  // { label, options }, a childless category is passed through directly.
  const categorySelectOptions = categoryGroups.map((group) =>
    group.label === null
      ? { value: String(group.options[0].id), label: group.options[0].label }
      : { label: group.label, options: group.options.map((opt) => ({ value: String(opt.id), label: opt.label })) },
  );
  // The same groups, rendered as real <option>/<optgroup> elements for the two plain selects
  // in this file that still need one (the apply-to-all editor, the splits editor).
  function categoryOptGroups(groups: CategoryOptionGroup[]) {
    return groups.map((group) =>
      group.label === null ? (
        <option key={group.options[0].id} value={group.options[0].id}>{group.options[0].label}</option>
      ) : (
        <optgroup key={`group-${group.label}`} label={group.label}>
          {group.options.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </optgroup>
      ),
    );
  }

  // Chip filters (ruling D6): `group.options[0]` is ALWAYS the top-level category itself, grouped
  // or not (categoryOptionGroups' own contract) -- so mapping every group down to its first option
  // is exactly "every top-level category, active, in the same order every other picker on this
  // page already uses", with no second sort to keep in sync. The long tail (a specific child, once
  // there are more than a handful) stays reachable through the ordinary Category select inside the
  // Filters(N) disclosure below, which still lists every child under its parent optgroup.
  const topLevelChips = categoryGroups.map((group) => group.options[0]);
  const visibleChips = chipsExpanded ? topLevelChips : topLevelChips.slice(0, VISIBLE_CHIP_COUNT);
  const hiddenChipCount = topLevelChips.length - visibleChips.length;
  const activeCategoryChip = new URLSearchParams(currentQuery).get('category') ?? '';

  // v1.24.0 Lane A item 2: same "read it off currentQuery, not window.location" idiom as
  // activeCategoryChip just above, and the same backwards-compatible parse readFilter (page.tsx)
  // applies server-side -- `transfers=0` is 'none', `transfers=only` is 'only', anything else
  // (absent, or a stale/hand-edited value) is 'all'.
  const transfersParam = new URLSearchParams(currentQuery).get('transfers');
  const activeTransferView: 'all' | 'only' | 'none' =
    transfersParam === 'only' ? 'only' : transfersParam === '0' ? 'none' : 'all';

  // v1.25.0 Lane R item R1: same "read it off currentQuery" idiom as activeTransferView just
  // above. Anything but the two real values (absent, or a hand-edited junk value) is '', the
  // QUEUE_CHIP_OPTIONS "All" entry -- server-side readFilter (page.tsx) falls back the same way.
  const queueParam = new URLSearchParams(currentQuery).get('queue');
  const activeQueueChip: '' | 'suggested' | 'uncategorized' =
    queueParam === 'suggested' ? 'suggested' : queueParam === 'uncategorized' ? 'uncategorized' : '';

  /**
   * v1.26.0 Lane 1 item 4 (the owner's actual workflow -- auditing fifty rows after an import,
   * which per-row clicking does not scale to). Same "read it off currentQuery" idiom as
   * activeQueueChip/activeTransferView just above -- absent, or a hand-edited junk value, both
   * mean off; only the literal '1' turns it on. TABLE-only: the card list already shows a
   * rule-renamed row's bank text unconditionally (transactionCard's own fix, item 1 of this same
   * task), so this has nothing to add there -- see the toggle link's own comment beside TableWrap
   * below for where it is read.
   */
  const bankTextOn = new URLSearchParams(currentQuery).get('bank') === '1';

  /**
   * v1.26.0 Lane 3a. The four new params' active values, read off `currentQuery` -- the same
   * "the SERVER already knows the filter, do not re-derive it from window.location" idiom
   * activeTransferView/activeQueueChip/bankTextOn above all follow, and the same fall-back-rather-
   * than-refuse rule: a hand-edited junk value reads as the default option, never as a refusal or
   * an empty page. The parse deliberately MIRRORS filter-params.ts's own readers rather than
   * importing them -- that module reaches readEnv()/todayIso() for the date range and belongs to
   * the server; what is shared between the two sides is the URL CONTRACT, and each side reads the
   * two or three params it actually renders from.
   *
   * `activeGroupView` comes from the `groups` PROP, not from the querystring, on purpose: the prop
   * is null exactly when page.tsx decided the grouped view is off, so reading it here means the
   * pill's active state and the view actually rendered cannot disagree -- a URL parse could say
   * "grouped" while the data said otherwise.
   */
  const sortParam = new URLSearchParams(currentQuery).get('sort');
  const activeSort: '' | TransactionSort =
    sortParam === 'date' || sortParam === 'amount' || sortParam === 'category' ? sortParam : '';
  const activeDirection: SortDirection = new URLSearchParams(currentQuery).get('dir') === 'asc' ? 'asc' : 'desc';
  const sourceParam = new URLSearchParams(currentQuery).get('source');
  const activeSource: '' | CategorizationSource =
    sourceParam === 'rule' || sourceParam === 'bayes' || sourceParam === 'manual' || sourceParam === 'none'
      ? sourceParam
      : '';
  const activeGroupView: '' | 'category' = groups !== null ? 'category' : '';
  /** `?import=<id>`. Shown as a dismissible chip (below) rather than only being honoured silently:
   *  a batch nobody can see they are inside is a batch they cannot get out of, and the import audit
   *  link (`/transactions?import=<id>&source=rule&group=category`) is the one filter on this page a
   *  person arrives at without having clicked a control for it. Digits only, so a junk value falls
   *  back to "no import filter" and the chip is simply absent -- matching what readFilter does with
   *  it server-side. */
  const importParam = new URLSearchParams(currentQuery).get('import');
  const activeImportId = importParam !== null && /^\d+$/.test(importParam) ? importParam : null;

  // Fix round (owner report, phone screenshot): six stacked control rows sat above the data at
  // every width, because ruling S7's disclosure (`filtersOpen`, above) only ever gated the four
  // selects -- this helper extends the SAME idea to the rest of the rows below it, without
  // touching the one ruling S7 already covers.
  //
  // Below `sm`, a row shows when EITHER the disclosure is open OR that row's own filter is not at
  // its default -- never unconditionally hidden. Folding the audit bar (View/Sort/Set by) and the
  // transfer/queue row behind the funnel regardless of state was the obvious fix, and it was
  // considered and REJECTED here for the reason the audit bar's own comment (below) gives in full:
  // the dashboard's import-audit link (`?import=<id>&source=rule&group=category`) lands a phone
  // user directly inside a filtered batch, and a row that is unconditionally hidden leaves them no
  // way back out except discovering "Filters" first -- which someone who has never opened this
  // page has no reason to go looking for. Keying visibility to "is this row doing something"
  // instead means the row that matters is exactly the row that stays on screen, whichever one
  // that turns out to be.
  //
  // `sm:flex` keeps every row exactly as visible as it is today at `sm` and up; this only changes
  // what happens below it. CSS class, never a conditional unmount -- same reason the disclosure's
  // own fields give a few hundred lines down: a hidden row's inputs/links stay in the DOM, so
  // what the form submits (or what a link points at) never depends on whether the row happens to
  // be on screen at this particular width.
  const rowVisibility = (rowIsActive: boolean) => `${filtersOpen || rowIsActive ? 'flex' : 'hidden'} sm:flex`;

  const toggle = (id: number) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  // v1.7.0 bulk-guard fix: Categorize and Mark transfer both silently skip a split
  // transaction now (its money already lives in transaction_splits, not this row's own
  // category/transfer flag -- see the guard in src/lib/categorize/engine.ts). Selection
  // itself stays open to a split row on purpose, because bulk ATTRIBUTION is still valid on
  // one (ruling 1: attribution is whole-transaction) -- this count only powers a cheap
  // heads-up in the toolbar below, never a disabled checkbox.
  const selectedSplitCount = selected.filter((id) => (splits[id] ?? []).length > 0).length;
  // manualEntryAction's own message/error surfaces inside QuickAddTransaction now (it owns its
  // own useActionState instance), so this banner no longer merges it in. noteState IS merged in,
  // the same as renaming/splitting: the sub-row's own form closes on submit (setNoting(null)),
  // before the action settles, so the top banner is the only place its result is ever seen.
  // Review round: newLoanState now goes FIRST in both chains, not last. The new-loan sub-row
  // stays open across a refusal (below) instead of closing on submit like every other editor on
  // this page, so its own message/error can still be the freshest thing that happened by the
  // time this renders again -- putting it last let a STALE message from an earlier, unrelated
  // action (assignState, say) mask a fresh create's own result.
  // Review round (fold /review in): applyAllState goes right after newLoanState, for the same
  // reason -- its own inline editor (below) must stay open on a refusal and show ITS OWN fresh
  // error, which a stale message further down this chain could otherwise mask. acceptState and
  // rowTransferState are plain one-off actions with no editor of their own, so they join the
  // rest of that set at the end, the same as assignState/unassignState. acceptAllState (item 5)
  // joins them there too, for the same reason -- it has no editor of its own to protect either.
  // v1.25.0 Lane R item R3: bulkLoanState/bulkNoteState join the splitState/noteState group --
  // both new dialogs close on submit (bulkLoanDialog/bulkNoteDialog's own onSubmit, below), the
  // same as split/note, not stay-open-on-refusal like newLoanState/applyAllState -- so the top
  // banner is the only place either one's result is ever seen, and their position here does not
  // need to protect an inline error the dialog itself no longer shows.
  const notice =
    newLoanState.message ?? applyAllState.message ??
    attrState.message ?? bulkCatState.message ?? bulkTfrState.message ??
    renameState.message ?? assignState.message ?? unassignState.message ?? splitState.message ?? noteState.message ??
    bulkLoanState.message ?? bulkNoteState.message ??
    // v1.26.0 Lane 3a item 4: the two group actions join this same group -- both dialogs close on
    // submit (groupConfirmDialog/groupRecategorizeDialog's own onSubmit), so the top banner is the
    // only place either one's result is ever seen, exactly like the two v1.25.0 bulk dialogs above.
    confirmGroupState.message ?? recatGroupState.message ??
    acceptState.message ?? acceptAllState.message ?? rowTransferState.message;
  const error =
    newLoanState.error ?? applyAllState.error ??
    attrState.error ?? bulkCatState.error ?? bulkTfrState.error ??
    renameState.error ?? assignState.error ?? unassignState.error ?? splitState.error ?? noteState.error ??
    bulkLoanState.error ?? bulkNoteState.error ??
    confirmGroupState.error ?? recatGroupState.error ??
    acceptState.error ?? acceptAllState.error ?? rowTransferState.error;

  // Review round: unlike renaming/noting/splitting (which close their own form onSubmit right
  // away, before the action even settles), the new-loan editor must stay open on a REFUSAL --
  // closing unconditionally discarded whatever name a person had just typed the moment they hit
  // a refusal (lent + incoming money, already linked, a blank name), leaving only the top banner
  // to explain why. So this closes it only on the action's own success, the same idiom
  // warranty-detail-client.tsx uses for its edit form: keyed on the newLoanState object itself,
  // which useActionState only replaces when the action actually ran, so this fires exactly once
  // per real create rather than on every render while the editor is open.
  useEffect(() => {
    if (newLoanState.message && !newLoanState.error) {
      setNewLoan(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newLoanState]);

  // Backlog BY: the same editor now also posts an EXISTING-loan choice to assignToLoanAction
  // (assignState), so it must close on that action's own success too, for the same reason as
  // newLoanState just above -- a refusal (no loan picked, already linked at the DB layer) must
  // leave the editor open with the choice still made.
  useEffect(() => {
    if (assignState.message && !assignState.error) {
      setNewLoan(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignState]);

  // Same idiom as newLoan above: the "Apply a category to all N…" editor stays open on a
  // refusal (a rule someone else in the household owns) so its own inline error is visible
  // where the person is looking, and closes only on the action's own success.
  useEffect(() => {
    if (applyAllState.message && !applyAllState.error) {
      setApplyAllRow(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyAllState]);

  // Opens this row's split editor, prefilled from its existing parts (or two blank parts for
  // a fresh split) -- the same "one editor, one nullable slot of state" shape `renaming` uses,
  // so opening a different row's editor always replaces whichever one was already open.
  const openSplitEditor = (row: TransactionRow) => {
    const existing = splits[row.id] ?? [];
    setSplitting({
      id: row.id,
      merchant: row.normalizedMerchant,
      date: row.date,
      amountCents: row.amountCents,
      parts:
        existing.length > 0
          ? existing.map((part) => ({
              categoryId: String(part.categoryId),
              amount: (Math.abs(part.amountCents) / 100).toFixed(2),
              note: part.note ?? '',
            }))
          : [blankSplitPart(), blankSplitPart()],
    });
  };

  const updateSplitPart = (index: number, patch: Partial<SplitPartDraft>) => {
    setSplitting((prev) => (prev ? { ...prev, parts: prev.parts.map((part, i) => (i === index ? { ...part, ...patch } : part)) } : prev));
  };
  const addSplitPart = () => {
    setSplitting((prev) => (prev ? { ...prev, parts: [...prev.parts, blankSplitPart()] } : prev));
  };
  const removeSplitPart = (index: number) => {
    setSplitting((prev) => (prev ? { ...prev, parts: prev.parts.filter((_, i) => i !== index) } : prev));
  };

  // Amounts are always typed as a plain positive dollar figure -- the parent's own sign is
  // applied here rather than asked of the person, so splitting a $50 expense means typing
  // "30.00" and "20.00", never "-30.00". parseAmountToCents (not hand-rolled parsing) does the
  // actual decimal-to-cents conversion; an unparsable/blank amount counts as 0 toward the
  // remainder rather than blocking every other keystroke with an error.
  const splitSign = splitting !== null && splitting.amountCents < 0 ? -1 : 1;
  const draftPartCents = (part: SplitPartDraft): number => {
    const parsed = parseAmountToCents(part.amount);
    return parsed === null ? 0 : Math.abs(parsed) * splitSign;
  };
  // A blank row added by "Add a part" and never given a category is dropped rather than
  // submitted (and left out of the remainder math below) -- it was never really a part.
  const activeSplitParts = splitting ? splitting.parts.filter((part) => part.categoryId !== '') : [];
  const splitPartsPayload = activeSplitParts.map((part) => ({
    categoryId: Number(part.categoryId),
    amountCents: draftPartCents(part),
    note: part.note.trim() === '' ? null : part.note.trim(),
  }));
  const splitRemainderCents = splitting ? splitting.amountCents - sumCents(activeSplitParts.map(draftPartCents)) : 0;

  /**
   * Owner report (item 2), THIRD pass -- the first two both shipped and were both rejected from
   * the same screenshot review. Attempt 1: nothing on the row said a note existed at all. Attempt
   * 2 (`ml-1.5 inline-flex h-11 w-11 ... bg-info-soft`, kept in git history) fixed that but broke
   * two other things the screenshot called out: the merchant `<strong>`/`<span>` this renders
   * beside is plain inline content, not a flex container -- so a 44px-square inline-flex box could
   * not always fit the remaining width of the line it was on, and an inline box that does not fit
   * does not shrink, it wraps WHOLE onto the next line, which read as "the icon is on its own row
   * below the merchant name". And a solid `bg-info-soft` PILL, sized the same as the row's other
   * badges (renamed/rule/transfer/loan), competed with them and with the amount for attention
   * instead of reading as a quiet marker.
   *
   * This pass fixes both by decoupling "how much room this claims in the text flow" from "how big
   * a target a thumb can hit":
   *  - The glyph's own box is `h-3.5 w-3.5` (14px) at EVERY width, the same size a badge's own
   *    icon uses elsewhere on this row -- small enough that it behaves like any other inline
   *    glyph for wrapping purposes, on the table row's flex-with-gap layout and the card's plain
   *    inline layout alike, and it never resizes at `sm:`, so there is no breakpoint-dependent
   *    layout shift to reason about.
   *  - The 44px touch target is a `before:` pseudo-element positioned `absolute -inset-[15px]`
   *    (14 + 15*2 = 44), not a literal padding-plus-negative-margin box: a real child/padding box
   *    that size would itself be what participates in the surrounding flex `gap` (the table row's
   *    merchant cell is `flex ... gap-1.5`) and could still overlap or shrink that gap unpredictably.
   *    An absolutely positioned pseudo-element is taken out of flow entirely -- it paints (nothing,
   *    since it carries no background) beyond the button's own edges without the button's OWN box,
   *    which is what the line height and the flex gap actually measure, growing at all. Reset to
   *    `inset-0` (no expansion) at `sm:` and up, where a mouse pointer does not need the floor.
   *  - Tone: plain `text-info` (no background pill) at rest, an `--info` value chosen because it
   *    reads as "annotation", not as spending-direction (Money's own positive/negative colouring)
   *    or as one of the other badge tones already busy on this row -- against this app's own
   *    `--surface` card background it computes (standard WCAG relative-luminance formula, the
   *    same one this codebase's own placeholder-contrast test already grades colours by) to
   *    roughly 5.7:1 in the light theme and 8.5:1 in the dark theme, both comfortably past the
   *    3:1 floor a non-text/icon control needs and past the 4.5:1 a body of text would. A soft
   *    `hover:bg-info-soft`/`hover:text-info-soft-fg` circle (the SAME pairing attempt 2 used,
   *    proven for contrast already) appears only on hover/focus, so the resting state stays quiet.
   *
   * `title` still carries the note text (the same hover/assistive-tech affordance the bank-text
   * `title` on the merchant span already uses), and the accessible name still NAMES the row so two
   * rows sharing a merchant are tellable apart -- reworded from "Note on X" to "Edit note for X"
   * (this is a button that opens the editor, not a label describing a fact) at the coordinator's
   * suggestion; the tests below were updated for the new wording, not loosened. Clicking it opens
   * the SAME `noting` state the row menu's Note… item already writes to -- one note-editing path,
   * not a second one bolted on beside it -- and, since this is now a real modal (Task A) rather
   * than an inline sub-row, `event.currentTarget.focus()` runs before that state is set: a plain
   * <button> is not wrapped by RowMenu's own close()-then-refocus idiom, and neither a real
   * browser's click-to-focus behaviour for a <button> (Safari notably has none) nor Testing
   * Library's `fireEvent.click` can be relied on to have already done this, but RowDialog's own
   * "whoever has focus when I mount is the opener" contract (see its docblock) needs it to be true
   * regardless.
   */
  function noteIndicator(row: TransactionRow) {
    if (!row.notes) return null;
    return (
      <button
        type="button"
        onClick={(event) => {
          event.currentTarget.focus();
          setNoting({ id: row.id, current: row.notes ?? '' });
        }}
        title={row.notes}
        aria-label={`Edit note for ${row.normalizedMerchant}`}
        className="relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full align-middle text-info before:absolute before:-inset-[15px] before:content-[''] hover:bg-info-soft hover:text-info-soft-fg sm:before:inset-0"
      >
        <NoteGlyph className="h-3.5 w-3.5" />
      </button>
    );
  }

  /**
   * v1.26.0 Lane 1 (owner's screenshot: a row reading "Amazon" with a small blue `rule` badge --
   * "shows amazon i dont know what orignal entry was so maybe its wrong maybe its not"). A
   * `contains` rename rule can fire on text that is not the brand at all, so a clean display name
   * alone never lets the household tell a correct rename from a wrong one -- the bank's own
   * wording used to live only in a `title`, invisible on a phone and to a keyboard user.
   *
   * This is the fix for BOTH the table row and the card (transactionCard, below carry exactly the
   * same control set, per that function's own docblock): every badge that already means "this
   * row's own name replaced what the bank sent" -- 'renamed' (display_source = 'manual'), 'rule'
   * (display_source = 'rename'), and the existing per-loan name badge when display_source =
   * 'loan' -- becomes its own control, rather than a fourth glyph being added beside it. Mechanics
   * copied from noteIndicator immediately above, not reinvented: `before:absolute
   * before:-inset-[15px]` grows the badge to a ~44px touch target without the badge's own box (or
   * the flex `gap-1.5` these badges sit in) growing to match, `title` stays a hover bonus never
   * the only route, and the accessible name states what activating it does, the same
   * "Edit note for X" shape noteIndicator's own label uses. Deliberately NOT a colour warning
   * (the owner's own yellow suggestion, declined by the coordinator): a rename is a normal event
   * on this page, and the badge already carries "something changed here" without needing to look
   * alarming to say it -- fifty amber-bordered rows after one import would be ignored exactly the
   * way fifty red ones would.
   */
  function bankBadgeButton(row: TransactionRow, label: React.ReactNode, key?: string) {
    return (
      <button
        key={key}
        type="button"
        onClick={(event) => {
          event.currentTarget.focus();
          setBankTextRow(row.id);
        }}
        title={`Bank text: ${row.rawDescription}`}
        aria-label={`Why ${row.normalizedMerchant} shows this name`}
        className="badge badge--blue relative before:absolute before:-inset-[15px] before:content-[''] sm:before:inset-0"
      >
        {label}
      </button>
    );
  }

  /**
   * v1.26.0 Lane 3a item 3. Where THIS row's category came from -- the badge that makes a silent
   * rule decision visible on the row it was made about. SOURCE_BADGE_LABELS (above this component)
   * carries the wording, the tone, and the full argument for why this cannot be confused with the
   * blue `rule` RENAME badge sitting a few pixels away from it.
   *
   * Rendered on BOTH renderers (the table row and transactionCard), the rule transactionCard's own
   * docblock sets for this file: a control or a fact added to one and not the other is how a
   * feature goes missing on a phone. It REPLACES the table row's old amber `guess` badge rather
   * than sitting beside it -- that badge said `source === 'bayes'` in a second vocabulary and an
   * alarm-adjacent tone, so keeping it would have meant two chips making the same claim about one
   * column, one of them shouting. The review card's own "guessed <category> (margin 0.82)" line is
   * NOT touched: it carries the confidence figure, which is information this badge does not have
   * and a triage queue specifically wants.
   */
  function sourceBadge(row: TransactionRow) {
    const label = SOURCE_BADGE_LABELS[row.source];
    if (label === null) return null;
    return <span className="badge badge--muted">{label}</span>;
  }

  /**
   * v1.19.0 Lane 2 item 5: the per-row confirm button, review-mode-only. Disabled while the row
   * has no category (icons.tsx's own UnconfirmedIcon -- the outline dot a row shows before it has
   * one), enabled once it does (ConfirmIcon). Enabled state is gated on `categoryId`, never on
   * `source`: unlike the kebab's own "Accept <category>" item (bayes guesses only, see rowMenu
   * below), a row someone categorized by hand through the select just below still deserves a
   * one-click way to mark it done, and acceptGuessAction's own guard already refuses cleanly (`no
   * guess to accept`) if this were ever submitted for a row with nothing to confirm -- the
   * `disabled` attribute here is a courtesy that stops that request from being sent at all, not a
   * second copy of that guard.
   */
  function confirmButton(row: TransactionRow) {
    const hasCategory = row.categoryId !== null;
    const Icon = hasCategory ? ConfirmIcon : UnconfirmedIcon;
    return (
      <form action={acceptAction}>
        <input type="hidden" name="transactionId" value={row.id} />
        <button
          type="submit"
          disabled={!hasCategory}
          aria-label={
            hasCategory
              ? `Confirm ${row.categoryName ?? 'category'} for ${row.normalizedMerchant}`
              : `Choose a category before confirming ${row.normalizedMerchant}`
          }
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted enabled:hover:bg-positive-soft enabled:hover:text-positive-soft-fg disabled:opacity-40 sm:h-8 sm:w-8"
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      </form>
    );
  }

  /**
   * Review round (fold /review in): the ONE row menu, shared by the table row (`<tr>`) and the
   * review card list (`<li>`) below -- the Goal this release is built around ("every feature
   * built for Transactions is automatically available while reviewing") is exactly what a
   * second, hand-maintained copy of this menu would quietly stop being true for. Rename…,
   * Note…, Split…, Create warranty and every loan item are unchanged from the table's own menu;
   * the transfer toggle (ruling R4) is new on every row in both modes; Accept/Apply-to-all are
   * new and review-mode-only (inventory #5/#7).
   */
  function rowMenu(row: TransactionRow) {
    // Backlog BX: matchingCounts is populated for every row IN review mode (page.tsx) and empty
    // outside it -- so a MISSING entry (rather than a low one) is exactly "we're outside review
    // mode and never counted", and gets the generic label instead of a real number.
    const matchingCount = matchingCounts[row.id];
    const hasMatchingCount = matchingCount !== undefined;
    return (
      <RowMenu
        label={`Actions for ${row.displayDescription ?? row.rawDescription} on ${row.date}, ${formatCents(row.amountCents)}`}
      >
        <RowMenuButton
          onSelect={() =>
            setRenaming({
              id: row.id,
              current: row.displayDescription ?? row.rawDescription,
              merchant: row.normalizedMerchant,
            })
          }
        >
          Rename…
        </RowMenuButton>
        <RowMenuButton onSelect={() => setNoting({ id: row.id, current: row.notes ?? '' })}>
          Note…
        </RowMenuButton>
        {/* F-01 (v1.31.0). The row-side twin of the Reports and dashboard drill-downs: from a
            figure, "show me the rows behind this"; from a row, "show me the rest of them".
            Offered on every row, transfers included -- a transfer has a merchant like anything
            else, and this item only reads.

            NOT on the merchant name itself, which stays a <span> (below, around the
            displayDescription cell): that text is truncated, and already carries the rename
            affordance and the "why this name" disclosure, so a link there would compete with two
            controls for the same tap on a phone. The kebab is where this row's actions live.

            `range: null` is deliberate and this is the ONE call site that means it -- "all" is
            the whole request. Every other link in the app carries the window its figure was
            summed over, and transaction-links.ts spells `range` out with no default precisely so
            that this choice reads as a decision here rather than an omission.
            `person: null` for the same reason: "all" includes everyone the viewer can see, and
            /transactions is itself viewer-scoped server-side (scopeFor), so a self-scoped member
            following this still only ever reaches their own rows. */}
        <RowMenuLink href={transactionsHref({ range: null, person: null }, { kind: 'merchant', merchant: row.normalizedMerchant })}>
          Show all from this merchant
        </RowMenuLink>
        {/* Ruling R4: offered on EVERY row, both directions -- not gated on reviewMode, and not
            gated on row.isTransfer either, since it is the control that flips that very flag.
            setRowTransferAction (Lane 1) reads `isTransfer` off the form, so this one item works
            both ways depending on the row's current state. */}
        <RowMenuForm
          action={rowTransferAction}
          fields={{ transactionId: String(row.id), isTransfer: row.isTransfer ? '0' : '1' }}
        >
          {row.isTransfer ? 'Not a transfer' : 'Mark as transfer'}
        </RowMenuForm>
        {row.isTransfer ? null : (
          <>
            <RowMenuButton onSelect={() => openSplitEditor(row)}>Split…</RowMenuButton>
            <RowMenuLink href={`/warranties/new?transactionId=${row.id}`}>Create warranty</RowMenuLink>
          </>
        )}
        {row.isTransfer
          ? null
          : (loanLinks[row.id] ?? []).map((link) => (
              <RowMenuForm
                key={`unassign-${link.id}`}
                action={unassignLoan}
                fields={{ transactionId: String(row.id), itemId: String(link.itemId) }}
                confirm={`Unassign this transaction from ${link.itemName}? That loan's balance moves back to what it was.`}
              >
                {`Unassign from ${link.itemName}`}
              </RowMenuForm>
            ))}
        {/* Backlog BY: one item, not one per loan -- it opens the same inline editor as before,
            now extended with a select for an existing loan (Save -> assignToLoanAction) or
            "New loan…" (Save -> createLoanFromTransactionAction, unchanged). */}
        {row.isTransfer ? null : (
          <RowMenuButton onSelect={() => setNewLoan({ id: row.id, name: '', itemId: '' })}>
            Assign to loan…
          </RowMenuButton>
        )}
        {/* Review-mode-only, inventory #5: only when the categorizer itself guessed this row and
            nobody has confirmed it yet. */}
        {reviewMode && row.source === 'bayes' && row.categoryId !== null ? (
          <RowMenuForm action={acceptAction} fields={{ transactionId: String(row.id) }}>
            {`Accept ${row.categoryName}`}
          </RowMenuForm>
        ) : null}
        {/* Backlog BX: offered on every row, not gated on reviewMode any more. Inside review
            mode (inventory #7) matchingCounts is real and gates on >1, same as before -- outside
            it there is nothing to gate on (matchingCounts is never populated there), so the item
            is offered with a merchant-named label instead and the server counts on submit. */}
        {hasMatchingCount ? (
          matchingCount > 1 ? (
            <RowMenuButton onSelect={() => setApplyAllRow(row.id)}>
              {`Apply a category to all ${matchingCount} matching…`}
            </RowMenuButton>
          ) : null
        ) : (
          <RowMenuButton onSelect={() => setApplyAllRow(row.id)}>
            {`Apply this category to every "${row.normalizedMerchant}"…`}
          </RowMenuButton>
        )}
      </RowMenu>
    );
  }

  /**
   * Unify-the-editors task (2026-08-30) -- see RowDialog's own docblock for the shell all four of
   * the functions below (plus the split form further down) now share. Every one of them renders
   * ONCE, at the top level of this component's return, alongside the split dialog -- not per row,
   * and not duplicated between the table and the card list the way an inline sub-row anchored at
   * its own row used to have to be. (The "Fix round item CB" / "coordinator fix" docblocks these
   * functions used to carry -- preserved in git history -- describe exactly that duplication, and
   * the dead-editor bug it caused whenever a control existed on only one of the two branches.) A
   * dialog's own `fixed inset-0` backdrop makes WHERE in the DOM it is mounted irrelevant to where
   * it appears on screen, so there is no "table branch" copy and "card branch" copy left to keep
   * in sync -- each function below looks its target row up by id from `page.rows` instead, the
   * same page data every other control on this file already reads from.
   */
  const findRow = (id: number) => page.rows.find((row) => row.id === id);

  /** Owner report (item 1): names the row it acts on ("Rename Coffee run"), the copy pattern the
   *  note dialog below established first. Nothing about what this SUBMITS changed from the
   *  inline sub-row it replaces -- same hidden field, same `scope` radios, same renameAction,
   *  same validation; only the shell around it did. */
  function renameDialog() {
    if (!renaming) return null;
    return (
      <RowDialog
        dialogId="rename-dialog"
        key={renaming.id}
        title={`Rename ${renaming.current}`}
        onClose={() => setRenaming(null)}
      >
        <form action={renameAction} onSubmit={() => setRenaming(null)} className="flex flex-col gap-3">
          <input type="hidden" name="transactionId" value={renaming.id} />
          <Field label="Display name" hint="Leave it empty to go back to the bank's wording.">
            <input name="displayName" defaultValue={renaming.current} autoFocus className={inputClass} />
          </Field>
          <fieldset className="flex flex-col gap-1.5">
            <legend className={labelClass}>Apply to</legend>
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="radio" name="scope" value="one" defaultChecked className="accent-accent" /> This transaction only
            </label>
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="radio" name="scope" value="all" className="accent-accent" /> All matching{' '}
              <code className="rounded bg-surface-2 px-1 font-mono text-xs text-ink">{renaming.merchant}</code> + future imports
              (creates a rename rule)
            </label>
          </fieldset>
          <div className="flex gap-2">
            <SubmitButton className="w-fit">Save name</SubmitButton>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </div>
        </form>
      </RowDialog>
    );
  }

  /** Ruling R13: NOT an auto-save (v1.11.0's rule) -- a free-text field that saves on blur loses
   *  a half-typed sentence, which is the one thing a note must never do. Title names the row
   *  ("Note for SQ *UNKNOWN VENDOR 8841"), the exact copy pattern the owner's report asked to
   *  keep; the field's own label is plain "Note" now that the dialog's title already says whose. */
  function noteDialog() {
    if (!noting) return null;
    const row = findRow(noting.id);
    if (!row) return null;
    const desc = row.displayDescription ?? row.rawDescription;
    return (
      <RowDialog dialogId="note-dialog" key={noting.id} title={`Note for ${desc}`} onClose={() => setNoting(null)}>
        <form action={noteAction} onSubmit={() => setNoting(null)} className="flex flex-col gap-3">
          <input type="hidden" name="transactionId" value={row.id} />
          <Field label="Note">
            <textarea name="notes" defaultValue={noting.current} rows={3} autoFocus className={inputClass} />
          </Field>
          <div className="flex gap-2">
            <SubmitButton className="w-fit">Save note</SubmitButton>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNoting(null)}>
              Cancel
            </button>
          </div>
        </form>
      </RowDialog>
    );
  }

  /**
   * Backlog BY: this is ALSO the existing-loan assign form, not just the new-loan one.
   * `newLoan.itemId` is the "Assign to" select's own value: '' means "New loan…" (the
   * name/direction fields below apply, posting to createLoanFromTransactionAction); any other
   * value is an existing loan's id, and Save posts straight to assignToLoanAction instead. One
   * <form>, whose `action` picks the right dispatcher at submit time -- the fields either action
   * reads (transactionId always; loanName/loanDirection or itemId depending on the choice) are
   * exactly what's rendered below. Title names the row being assigned.
   */
  function newLoanDialog() {
    if (!newLoan) return null;
    const row = findRow(newLoan.id);
    if (!row) return null;
    const desc = row.displayDescription ?? row.rawDescription;
    const isNew = newLoan.itemId === '';
    return (
      <RowDialog
        dialogId="new-loan-dialog"
        key={newLoan.id}
        title={`Assign ${desc} to a loan`}
        onClose={() => setNewLoan(null)}
      >
        <form
          action={(formData: FormData) => {
            if (isNew) newLoanAction(formData);
            else assignLoan(formData);
          }}
          className="flex flex-col gap-3"
          data-testid="new-loan-form"
        >
          <input type="hidden" name="transactionId" value={row.id} />
          {/* Shown INLINE, under the form a refusal leaves open, not only through the top banner
              (that still gets it too, via `error` above) -- the person is looking here, not at
              the top of the page. Whichever action was actually posted owns this message. */}
          <FormError message={isNew ? newLoanState.error : assignState.error} />
          <Field label="Assign to">
            <select
              name="itemId"
              value={newLoan.itemId}
              onChange={(e) => setNewLoan({ ...newLoan, itemId: e.target.value })}
              className={selectClass}
            >
              {loanOptions.map((loan) => (
                <option key={loan.id} value={String(loan.id)}>{loan.name}</option>
              ))}
              <option value="">New loan…</option>
            </select>
          </Field>
          {isNew ? (
            <>
              <Field label="Loan name" hint="Who the loan is with — a name you will recognise later.">
                <input
                  name="loanName"
                  value={newLoan.name}
                  onChange={(e) => setNewLoan({ ...newLoan, name: e.target.value })}
                  required
                  maxLength={80}
                  autoFocus
                  className={inputClass}
                />
              </Field>
              <Field label="Direction">
                <select name="loanDirection" defaultValue="lent" className={selectClass}>
                  {LOAN_DIRECTIONS.map((direction) => (
                    <option key={direction} value={direction}>{LOAN_DIRECTION_LABELS[direction]}</option>
                  ))}
                </select>
              </Field>
            </>
          ) : (
            // 2026-08-30 fix: offered only on the EXISTING-loan path (Save -> assignToLoanAction),
            // which is the one action wired to read it -- the new-loan path just above posts to
            // createLoanFromTransactionAction instead, which this fix does not touch. Defaults ON:
            // money lent out and money repaid moves an asset between pockets, not spending, so the
            // common case is that a loan payment should also leave spending -- a person who wants
            // the payment counted as ordinary spending can still untick it.
            //
            // v1.27.0 item 1 (the owner's report). The copy used to stop at "(keeps it out of
            // spending)", which was true and incomplete: ticking it ALSO wrote a household-wide
            // exact transfer rule for the merchant, so one reimbursement filed against a work loan
            // silently taught the app to flag every future purchase from that shop. The rule write
            // is gone (assignToLoanAction now passes learnRule: false), and the copy says so
            // rather than leaving a person to infer it -- the per-row "Mark as transfer" control
            // one menu away DOES learn a rule and says "learned an exact rule" when it does, so
            // "this one only" is the difference a person actually needs told.
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" name="alsoTransfer" value="1" defaultChecked className="accent-accent" />
                Also keep this out of spending (marks it a transfer)
              </label>
              <p className="pl-6 text-xs text-muted">
                This transaction only. No rule is created, so other purchases from this merchant are unaffected.
              </p>
            </div>
          )}
          <div className="flex gap-2">
            <SubmitButton className="w-fit">Save</SubmitButton>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNewLoan(null)}>
              Cancel
            </button>
          </div>
        </form>
      </RowDialog>
    );
  }

  /** Backlog BX. Title names the merchant every matching transaction shares. The select drops the
   *  dense `REVIEW_PICKER_CLASS` row-control sizing (gone now -- grep confirms nothing else used
   *  it) for the ordinary `selectClass`: this control used to have to fit beside a row's own
   *  kebab, and now has a whole dialog to itself. */
  function applyAllDialog() {
    if (applyAllRow === null) return null;
    const row = findRow(applyAllRow);
    if (!row) return null;
    const matchingCount = matchingCounts[row.id];
    const hasMatchingCount = matchingCount !== undefined;
    return (
      <RowDialog
        dialogId="apply-all-dialog"
        key={row.id}
        title={`Apply a category to every "${row.normalizedMerchant}"`}
        onClose={() => setApplyAllRow(null)}
      >
        <p className="text-sm text-ink">
          {hasMatchingCount ? (
            <>Every &quot;{row.normalizedMerchant}&quot; — {matchingCount} transactions, plus future imports</>
          ) : (
            <>Every &quot;{row.normalizedMerchant}&quot;, plus future imports</>
          )}
        </p>
        <p className="text-sm text-muted">
          Only for merchants that are always one category (coffee shop, streaming). Walmart, Amazon, e-transfers: use
          the category picker on the row instead.
        </p>
        {/* Shown inline, under the editor a refusal leaves open, not only through the top banner
            (that still gets it too, via `error` above) -- the same idiom the new-loan editor
            already uses. */}
        <FormError message={applyAllState.error} />
        <form action={applyAllAction} className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input type="hidden" name="normalizedMerchant" value={row.normalizedMerchant} />
          <select
            name="categoryId"
            defaultValue={row.categoryId ?? ''}
            aria-label={
              hasMatchingCount
                ? `Category for all ${matchingCount} matching ${row.normalizedMerchant} — every transaction`
                : `Category for every ${row.normalizedMerchant} — every transaction`
            }
            className={selectClass}
          >
            <option value="">{hasMatchingCount ? `Choose for all ${matchingCount}…` : 'Choose a category…'}</option>
            {categoryOptGroups(categoryGroups)}
          </select>
          <SubmitButton variant="secondary" size="sm" className="w-fit">
            {hasMatchingCount ? `Apply to all ${matchingCount} matching + create rule` : 'Apply to all matching + create rule'}
          </SubmitButton>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setApplyAllRow(null)}>
            Cancel
          </button>
        </form>
      </RowDialog>
    );
  }

  /**
   * v1.26.0 Lane 1. What bankBadgeButton's touch target (above) promises: the bank's own wording
   * in full, PLUS which of the three display_source values put a different name here and what to
   * do about it -- "seeing the bank text answers half the question; the other half is what to do
   * about it" (this task's own brief). 'rename' is the reported case; 'manual' and 'loan' get the
   * same shell with their own honest wording rather than a copy of the rule case's, since neither
   * one WAS a rule -- the plain per-row rename path and applyLoanDescription (src/lib/loans.ts,
   * read for the wording, not called: MUST-13.2's boundary keeps this file out of that lane) both
   * write display_source themselves, with no rule row behind either.
   *
   * The "Rule: …" line and its Edit/Delete links only ever appear when `renameRules` (page.tsx's
   * own prop, see its doc comment) actually resolved one. A rule can be edited or deleted after it
   * renamed a row, so a MISSING entry is treated exactly like "the rule list was never available"
   * -- bank text still shows, the attribution does not (this task's brief: never invent a rule
   * attribution that could name the wrong rule).
   *
   * "Rename just this one" posts through the SAME `renaming` state/renameDialog the row's own
   * kebab "Rename…" item already opens (setRenaming, above) -- not a second rename path -- closing
   * this dialog first so the two never render stacked at once. Edit/Delete both link to the same
   * filtered Settings → Merchant rules URL: two labels because a person arrives with one of two
   * different intents, one destination because that page's own inline edit form and delete dialog
   * (v1.24.0) are what the destination is FOR -- duplicating either here is exactly what this
   * task's brief says not to do.
   */
  function bankTextDialog() {
    if (bankTextRow === null) return null;
    const row = findRow(bankTextRow);
    if (!row || row.displaySource === null) return null;
    const rule = row.displaySource === 'rename' ? renameRules[row.id] : undefined;
    const heading =
      row.displaySource === 'rename'
        ? 'Renamed by a rule'
        : row.displaySource === 'manual'
          ? 'Renamed by the household'
          : 'Named by a linked loan';
    return (
      <RowDialog dialogId="bank-text-dialog" key={row.id} title={heading} onClose={() => setBankTextRow(null)}>
        {/* Selectable and in full, per this task's brief -- the same `code` chip styling
            renameDialog's own "All matching <code>X</code>" line already uses, not a new look. */}
        <p className="text-sm text-ink">
          Bank text: <code className="select-all rounded bg-surface-2 px-1 font-mono text-xs text-ink">{row.rawDescription}</code>
        </p>
        {row.displaySource === 'rename' ? (
          rule ? (
            <p className="text-sm text-muted">{`Rule: ${rule.matchType} ${rule.pattern} → "${rule.renameTo}"`}</p>
          ) : (
            <p className="text-sm text-muted">Which rule set this name could not be determined.</p>
          )
        ) : row.displaySource === 'manual' ? (
          <p className="text-sm text-muted">Someone in the household typed this name in by hand.</p>
        ) : (
          <p className="text-sm text-muted">A loan this transaction is linked to set this description automatically.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={(event) => {
              event.currentTarget.focus();
              setBankTextRow(null);
              setRenaming({ id: row.id, current: row.displayDescription ?? row.rawDescription, merchant: row.normalizedMerchant });
            }}
          >
            Rename just this one
          </button>
          {rule ? (
            <>
              <Link
                href={`/settings/merchant-rules?kind=rename&q=${encodeURIComponent(rule.pattern)}`}
                className="btn btn--secondary btn--sm"
              >
                Edit the rule
              </Link>
              <Link
                href={`/settings/merchant-rules?kind=rename&q=${encodeURIComponent(rule.pattern)}`}
                className="btn btn--secondary btn--sm"
              >
                Delete the rule
              </Link>
            </>
          ) : null}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setBankTextRow(null)}>
            Close
          </button>
        </div>
      </RowDialog>
    );
  }

  /**
   * Refactor lane (2026-08-30): THE single row card. Before this task, this component's contents
   * existed twice -- once written for the review queue's own `<li>`, and completely separately as
   * the table's `<tr>`/`<td>` markup below -- and every control added to one silently never
   * reached the other: the note and loan editors worked only in the table branch until the "fix
   * round (item CB)" comments above patched that, the person picker existed only on the table row
   * until an hour before this task, and ListRow (src/components/ui/ListRow.tsx) fits one shape and
   * not the other. Two renderers for one dataset was the actual defect each of those was a
   * symptom of, not the layouts themselves.
   *
   * THE RULE FOR WHOEVER ADDS THE NEXT FEATURE TO A ROW: there is exactly one card renderer now,
   * used by the review queue at every width (ruling R5) AND by Transactions below `sm` (rendered
   * inside the `sm:hidden` <ul> near the end of this file's `return`). If you are about to write a
   * second one -- a bespoke review-only card, a bespoke mobile-only card -- stop: extend THIS
   * function instead, or the drift this docblock describes starts over. The desktop table
   * (Transactions at `sm` and up, `hidden` below it) is the one deliberate exception, kept because
   * a ledger scanned down a column is what a table is for -- but it is fed from the same
   * `page.rows` and must carry exactly the same control set as this card: nothing here that is
   * missing there, or vice versa.
   *
   * Review mode's own addition is scoped to exactly one control -- the per-row confirm button
   * (confirmButton, called only when `reviewMode`) -- everything else this function renders (the
   * checkbox/bulk-toolbar hookup, the money-direction glyph, every badge, both pickers, and the
   * row menu) is identical markup regardless of mode. The four editor DIALOGS (rename, note,
   * assign-to-loan, apply-to-all) are no longer part of this function's own control set at all --
   * unify-the-editors task, same date -- they render once, at the top level of this component's
   * return, looked up by row id; see renameDialog/noteDialog/newLoanDialog/applyAllDialog's own
   * shared docblock. The only OTHER place `reviewMode` is read below is the category field's
   * placeholder/archived-option treatment, which already branched on it on the table row before
   * this task (ruling R3): review's placeholder stays disabled on purpose (nothing is pre-selected
   * -- a guess waiting for a decision must never look like "Uncategorized" already chosen), while
   * plain Transactions keeps "Uncategorized" as a legitimate resting state, archived categories
   * and all.
   *
   * Coordinator fix (2026-08-30, card-density task): a screenshot comparison against the older
   * build showed this card losing badly on density, for three concrete reasons, each fixed below:
   *   1. The kebab and review mode's confirm button used to render on a TRAILING line all their
   *      own (`flex items-center justify-end gap-1`) -- a full line of card height holding two
   *      small right-aligned controls and nothing else, the single biggest waste. The kebab acts
   *      on the WHOLE row, which is why it now sits on the row's own identity line, opposite the
   *      amount (Line 1 below) -- exactly where a table row's own kebab already sits, at the far
   *      right of ITS row rather than on a row of its own beneath it. The confirm button moves to
   *      Line 3, beside the controls it actually reports on, rather than being orphaned with it.
   *   2. Both selects used to stretch to fill a two-column grid cell (`w-full`) -- a category
   *      picker is no more usable at 400px than at 200px, it just pushes the card apart. Neither
   *      passes a `className` any more, so both fall back to AutoSaveSelect's own default,
   *      AUTO_SAVE_CONTROL -- the SAME natural-width, capped, 44px-floored control the desktop
   *      table row's category/person selects already use un-customised.
   *   3. Each label used to sit on its own line ABOVE its select, costing a second line per
   *      control. Line 3 below puts each label INLINE beside its own control instead (the older
   *      layout's own idiom, which lost nothing) -- and note-indicator moves from beside the
   *      merchant name to Line 2 (the date/account meta line), quiet company for already-small
   *      muted text instead of crowding a bold merchant name that already shares its line with the
   *      amount and the kebab. This is a CARD-only change: the desktop table row's own
   *      `noteIndicator(row)` call, beside the merchant name in its Description cell, is
   *      untouched -- that row has no width problem to solve and no trailing-line-of-controls
   *      problem either, so nothing about it needed to move.
   *
   * Three lines, one purpose each, is the resulting shape: identity (checkbox, merchant, amount,
   * kebab), meta (date, account, note), controls (category, person, confirm). Below `sm`, Line 3
   * is `flex flex-wrap`, not the two-column `grid` it used to be -- a grid forces exactly two
   * equal columns that stretch to fill a row a narrow phone does not have room for; flex-wrap lets
   * each label+control pair keep AUTO_SAVE_CONTROL's own natural width and wrap onto a second
   * control line instead of being squeezed into a share of the row it does not fit, which is
   * exactly the mistake a previous pass made on mobile that this one does not repeat.
   */
  function transactionCard(row: TransactionRow) {
    // Row rhythm (item 4): only meaningful alongside the guessed-category badge just below.
    const GuessCategoryIcon = row.categoryName ? categoryIcon(row.categoryName) : null;
    const rowSplits = splits[row.id] ?? [];
    const categoryFieldOptions = reviewMode
      ? [{ value: '', label: 'Choose for this one…', disabled: true }, ...categorySelectOptions]
      : [
          { value: '', label: 'Uncategorized' },
          ...categorySelectOptions,
          ...categories
            .filter((c) => c.isArchived)
            .map((c) => ({ value: String(c.id), label: `${label(c.id)} (archived)`, disabled: true })),
        ];
    return (
      <li className="card flex flex-col gap-2 p-3 sm:gap-3 sm:p-4">
        {/* Line 1 (identity): checkbox, money-direction glyph, merchant + badges, amount, kebab. */}
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          {/* Checkbox (bulk toolbar): card-only until this task -- review's own queue had no way
              to bulk-select at all. The bulk toolbar just below this component's return is already
              mode-agnostic (nothing in it checks reviewMode), so giving every card a checkbox is
              the one line that was missing to make it usable from review too. */}
          <label className="flex h-11 w-11 shrink-0 items-center justify-center sm:h-4 sm:w-4">
            <input
              type="checkbox"
              checked={selected.includes(row.id)}
              onChange={() => toggle(row.id)}
              aria-label={`Select transaction ${row.id}`}
              className="accent-accent"
            />
          </label>
          {/* Row rhythm (item 4): the circled money-direction glyph. Decorative rhythm, not a
              control, so -- unlike everything else in this function -- it stays card-only exactly
              as it was before this task; the desktop table already says the same thing through
              Money's own sign colouring, so the "same control set" rule does not reach it. */}
          <span
            aria-hidden="true"
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              row.amountCents > 0 ? 'bg-positive-soft text-positive-soft-fg' : 'bg-surface-2 text-muted'
            }`}
          >
            {row.amountCents > 0 ? <MoneyInIcon className="h-4 w-4" /> : <MoneyOutIcon className="h-4 w-4" />}
          </span>
          {/* Ruling S5(b): `min-w-0 flex-1` lets a long merchant name wrap instead of pushing the
              amount beside it onto its own line. */}
          <span className="min-w-0 flex-1 text-sm">
            <strong
              className="font-semibold text-ink"
              title={row.displayDescription ? `Bank text: ${row.rawDescription}` : undefined}
            >
              {row.displayDescription ?? row.normalizedMerchant}
            </strong>
            {/* v1.26.0 Lane 1 item 1 (owner report: "shows amazon i dont know what orignal entry
                was so maybe its wrong maybe its not"). A rule-renamed row shows the bank text
                UNCONDITIONALLY -- a `contains` rule can fire on text that is not the brand at
                all, and a card is where this app asks a person to VERIFY a row, so the bank's own
                wording belongs on screen with no interaction, not behind the existing heuristic
                just below (kept, unchanged, for every other row: it already covers the ordinary
                "the merchant text needed cleaning up" case this task was never about). Muted, not
                bold, so it never competes with the merchant name on the line above it. */}
            {row.displaySource === 'rename' ||
            row.normalizedMerchant !== row.rawDescription.trim().replace(/\s+/g, ' ').normalize('NFC').toUpperCase() ? (
              <>
                {' '}
                <span className="text-muted">— {row.rawDescription}</span>
              </>
            ) : null}
            {/* v1.26.0 Lane 1 item 2: the SAME badge-button treatment as the table row below --
                bankBadgeButton's own docblock explains why this is the shared control set both
                renderers must carry (transactionCard's own top-of-function docblock), not a
                table-only afterthought. */}
            {row.displaySource === 'manual' ? (
              <span className="ml-1.5 inline-flex">{bankBadgeButton(row, 'renamed')}</span>
            ) : null}
            {row.displaySource === 'rename' ? (
              <span className="ml-1.5 inline-flex">{bankBadgeButton(row, 'rule')}</span>
            ) : null}
            {/* Same control set as the table row (below): a transfer badge, absent from this card
               before this task even though the table always carried one. */}
            {row.isTransfer ? <span className="badge badge--slate ml-1.5">transfer</span> : null}
            {(loanLinks[row.id] ?? []).map((link) =>
              row.displaySource === 'loan' ? (
                <span key={`loan-badge-${link.id}`} className="ml-1.5 inline-flex">
                  {bankBadgeButton(row, link.itemName)}
                </span>
              ) : (
                <span key={`loan-badge-${link.id}`} className="badge badge--blue ml-1.5">{link.itemName}</span>
              ),
            )}
          </span>
          {/* Amount + kebab grouped together so the two stay adjacent at the row's trailing edge
              (coordinator fix: the kebab moved here from its own trailing line -- see this
              function's own docblock, point 1). */}
          <span className="flex shrink-0 items-center gap-1">
            <Money cents={row.amountCents} className="text-base font-semibold" />
            {rowMenu(row)}
          </span>
        </div>
        {/* Line 2 (meta): date, account, the note indicator (coordinator fix, point 3 -- CARD
            only; the desktop table row keeps noteIndicator(row) beside its merchant name,
            unchanged), and the guessed-category badge. */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-subtle">
          <span className="tabnum">{row.date}</span>
          <span aria-hidden="true">·</span>
          <span>{row.accountName}</span>
          {noteIndicator(row)}
          {/* v1.26.0 Lane 3a item 3: the same badge the table row carries (sourceBadge's own
              docblock: both renderers or neither), on the card's META line rather than beside the
              merchant name -- "where this category came from" is context for the row, the same
              weight as its date and account, not part of its headline. */}
          {sourceBadge(row)}
          {/* Ruling S5(c): no "uncategorized" fallback badge -- every card in a queue defined as
              "not categorized yet" carried it, which made it noise rather than information. */}
          {row.source === 'bayes' && row.categoryName ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="badge badge--amber">
                {GuessCategoryIcon ? <GuessCategoryIcon aria-hidden="true" className="mr-1 inline h-3 w-3" /> : null}
                guessed {row.categoryName} (margin {row.confidence?.toFixed(2)})
              </span>
            </>
          ) : null}
        </div>
        {/* Line 3 (controls): category, person -- each label inline beside its own control, both
            at AUTO_SAVE_CONTROL's natural capped width, never stretched -- and review mode's
            confirm button, inline next to the controls it reports on. `flex flex-wrap`, not a
            grid: see this function's own docblock, point 2/3, for why. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-2 sm:pt-3">
          <span className="flex items-center gap-1.5">
            <span className="shrink-0 text-[0.6875rem] font-medium text-muted">This transaction only</span>
            {/* v1.7.0 Task 4: a split transaction has no ONE category -- same rule as the table
                row, now honoured here too (never checked from this card before this task). */}
            {rowSplits.length > 0 ? (
              <span className="badge badge--blue w-fit">{`Split · ${rowSplits.length} parts`}</span>
            ) : (
              <AutoSaveSelect
                name="categoryId"
                defaultValue={row.categoryId === null ? '' : String(row.categoryId)}
                options={categoryFieldOptions}
                fields={reviewMode ? { transactionId: String(row.id), teach: '1' } : { transactionId: String(row.id) }}
                action={saveCategory}
                ariaLabel={
                  reviewMode
                    ? `Category for ${row.normalizedMerchant} — this transaction only`
                    : `Category for transaction ${row.id}`
                }
              />
            )}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="shrink-0 text-[0.6875rem] font-medium text-muted">Person</span>
            {selfScoped ? (
              <span className="text-xs text-muted">{row.attributedUserName ?? 'Household'}</span>
            ) : (
              <AutoSaveSelect
                name="attributedUserId"
                defaultValue={row.attributedUserId === null ? '' : String(row.attributedUserId)}
                options={[
                  { value: '', label: 'Household' },
                  ...people.map((person) => ({ value: String(person.id), label: person.name })),
                ]}
                fields={{ ids: String(row.id) }}
                action={saveAttribution}
                ariaLabel={`Person for transaction ${row.id}`}
              />
            )}
          </span>
          {/* The one thing review mode adds beyond this card's shared control set. */}
          {reviewMode ? confirmButton(row) : null}
        </div>
      </li>
    );
  }

  /**
   * v1.25.0 Lane R item R3. The bulk toolbar's actions -- Categorize, Attribute, Mark transfer,
   * Assign to loan, Note -- as ONE list, not five hand-copied blocks. The first three existed
   * before this task, written inline in the toolbar's own JSX; Assign to loan and Note are the
   * two this task adds, and bolting them on as two more inline blocks beside the other three is
   * exactly the copy-and-diverge this refactor exists to stop. The toolbar below renders this
   * list with one `.map()` (`{bulkActions.map((action) => <Fragment key={action.key}>...`), so a
   * future sixth bulk action is one entry pushed onto this array, not a sixth hand-copied form.
   *
   * Each entry owns its own markup rather than sharing one generic shape: the five controls are
   * not shape-compatible (three post a plain form directly; the two new ones open a RowDialog
   * confirm first, since a page-level action across a multi-row SELECTION is exactly the case
   * RowDialog's own docblock says belongs in one, not an inline disclosure). What is shared is
   * WHERE they render and IN WHAT ORDER -- one list the toolbar walks once -- not their internal
   * form fields, which stayed byte-for-byte what they were before this task for the first three.
   *
   * Conditionally present entries (`attribute` when not self-scoped, `assign-loan` when the
   * household has a loan to offer) are filtered out of the array itself, the same "decide once,
   * here" rule the array's existence is for -- not a per-entry `hidden` flag the renderer has to
   * re-check.
   */
  const bulkActions: { key: string; node: React.ReactNode }[] = [
    {
      key: 'categorize',
      node: (
        <form action={bulkCatAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="ids" value={selected.join(',')} />
          <select name="categoryId" aria-label="Category for the selected transactions" className={selectClass}>
            {groupedCategories.map((opt) => (
              <option key={opt.id} value={opt.id}>{'  '.repeat(opt.depth) + opt.label}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-accent-soft-fg">
            <input type="checkbox" name="createRules" defaultChecked className="accent-accent" /> create rules
          </label>
          <SubmitButton>Categorize</SubmitButton>
        </form>
      ),
    },
    // Item BO: for a self viewer every choice here returns NOT_YOURS_ERROR, so it is not
    // rendered at all rather than shown-but-ineffective -- the same rule as the person filter
    // in the disclosure fields above.
    ...(selfScoped
      ? []
      : [
          {
            key: 'attribute',
            node: (
              <form action={attrAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="ids" value={selected.join(',')} />
                <select name="attributedUserId" aria-label="Person for the selected transactions" className={selectClass}>
                  <option value="">Household/unattributed</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <SubmitButton>Attribute</SubmitButton>
              </form>
            ),
          },
        ]),
    {
      key: 'transfer',
      node: (
        <form action={bulkTfrAction} className="flex items-center gap-2">
          <input type="hidden" name="ids" value={selected.join(',')} />
          <input type="hidden" name="isTransfer" value="1" />
          <SubmitButton variant="secondary">Mark transfer</SubmitButton>
        </form>
      ),
    },
    // MUST-14.9: empty for a household with no loans (or none with a balance still owed) --
    // the bulk action disappears entirely then, the same rule the per-row loanOptions-driven
    // controls already follow (page.tsx's own doc comment on the prop).
    ...(loanOptions.length > 0
      ? [
          {
            key: 'assign-loan',
            node: (
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setBulkLoan({ itemId: String(loanOptions[0].id) })}
              >
                Assign to loan…
              </button>
            ),
          },
        ]
      : []),
    {
      key: 'note',
      node: (
        <button type="button" className="btn btn--secondary" onClick={() => setBulkNoting(true)}>
          Note…
        </button>
      ),
    },
  ];

  /**
   * v1.25.0 Lane R item R3. Bulk assign-to-loan's own confirm dialog -- a page-level decision
   * over a multi-row SELECTION (RowDialog's own docblock: exactly the case that belongs in a
   * dialog, not an inline disclosure). The changed/skipped preview below is computed CLIENT-SIDE
   * from `loanLinks`, a prop page.tsx already hands down for every row on this page (no new
   * query): a selected row already linked to the chosen loan counts toward `skipped`, recomputed
   * live as the loan select changes, so the count on screen is always for the loan actually
   * about to be posted. This preview only reflects the ONE thing it can see from here (an
   * existing link to this same loan) -- assignTransactionToLoan (src/lib/loans.ts) can also
   * refuse a row for reasons this page has no client-side signal for (a zero-amount transaction,
   * a row that already pays a bill installment), which bulkAssignToLoan (src/lib/transactions.ts)
   * still counts into ITS OWN `skipped` when the write actually runs -- so the toast after Save
   * is the authoritative count; this dialog's number is a best-effort preview, not a guarantee,
   * the same honesty gap between "eligible" and "wouldChange" previewRerun already accepts
   * elsewhere in this app (src/lib/categorize/engine.ts).
   *
   * Closes on submit (`onSubmit`), the same eager-close idiom noteDialog/renameDialog use, not
   * newLoanDialog/applyAllDialog's stay-open-on-refusal -- a refusal here has no typed draft
   * worth preserving (only a <select>), so the top banner (bulkLoanState.error, merged into
   * `error` above) is where a refusal is seen, same as split/note.
   */
  function bulkLoanDialog() {
    if (!bulkLoan) return null;
    const alreadyLinked = selected.filter((id) =>
      (loanLinks[id] ?? []).some((link) => String(link.itemId) === bulkLoan.itemId),
    ).length;
    const willChange = selected.length - alreadyLinked;
    return (
      <RowDialog
        dialogId="bulk-assign-loan-dialog"
        title={`Assign ${selected.length} transaction${selected.length === 1 ? '' : 's'} to a loan`}
        onClose={() => setBulkLoan(null)}
      >
        <form action={bulkLoanAction} onSubmit={() => setBulkLoan(null)} className="flex flex-col gap-3">
          <input type="hidden" name="ids" value={selected.join(',')} />
          <Field label="Loan">
            <select
              name="itemId"
              value={bulkLoan.itemId}
              onChange={(e) => setBulkLoan({ itemId: e.target.value })}
              autoFocus
              className={selectClass}
            >
              {loanOptions.map((loan) => (
                <option key={loan.id} value={String(loan.id)}>{loan.name}</option>
              ))}
            </select>
          </Field>
          <p className="text-sm text-ink">
            {willChange} transaction{willChange === 1 ? '' : 's'} will be linked.
            {alreadyLinked > 0
              ? ` ${alreadyLinked} ${alreadyLinked === 1 ? 'is' : 'are'} already linked to this loan and will be left unchanged.`
              : ''}
          </p>
          <div className="flex gap-2">
            <SubmitButton disabled={willChange === 0} className="w-fit">Assign</SubmitButton>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setBulkLoan(null)}>
              Cancel
            </button>
          </div>
        </form>
      </RowDialog>
    );
  }

  /**
   * v1.25.0 Lane R item R3. Bulk note's own confirm dialog -- mirrors bulkLoanDialog immediately
   * above. Nothing here can be "skipped" (bulkSetNotes, src/lib/transactions.ts, writes every
   * selected id unconditionally -- see that function's own doc comment for why a note carries
   * none of the split guard's risk), so the count stated is simply how many rows will change,
   * with no skip clause to compute or word.
   */
  function bulkNoteDialog() {
    if (!bulkNoting) return null;
    return (
      <RowDialog
        dialogId="bulk-note-dialog"
        title={`Note for ${selected.length} transaction${selected.length === 1 ? '' : 's'}`}
        onClose={() => setBulkNoting(false)}
      >
        <form action={bulkNoteFormAction} onSubmit={() => setBulkNoting(false)} className="flex flex-col gap-3">
          <input type="hidden" name="ids" value={selected.join(',')} />
          <Field label="Note">
            <textarea name="notes" rows={3} autoFocus className={inputClass} />
          </Field>
          <p className="text-sm text-ink">
            This note will be set on all {selected.length} selected transaction{selected.length === 1 ? '' : 's'},
            replacing any note already there.
          </p>
          <div className="flex gap-2">
            <SubmitButton className="w-fit">Save note</SubmitButton>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setBulkNoting(false)}>
              Cancel
            </button>
          </div>
        </form>
      </RowDialog>
    );
  }

  /**
   * v1.26.0 Lane 3a item 2. One group header's destination: the SAME filtered list, drilled into
   * that one cluster. `{ ...filter, categoryId: group.categoryId, categoryExact: true }` is what
   * groupTransactionsByCategory's own doc comment (src/lib/transactions.ts) prescribes for a
   * drill-down, spelled here as the two URL params readFilter turns back into exactly that.
   *
   * `exact=1` is load-bearing and not decoration: a cluster keyed by a PARENT category holds only
   * the money filed DIRECTLY on that parent (which is why its label reads "<name> — not in a
   * sub-category"), and a plain `?category=<id>` means the parent AND its children -- so without
   * `exact` a parent group's link would land on a longer list than the header counted, and the
   * household would read the difference as the app losing track.
   *
   * `group` is dropped, so the link lands on the flat LIST rather than a grouped view of one group.
   * That is this task's expand-vs-link decision made concrete: a group header is a link, and no
   * group ever fetches its own rows. Expanding N groups inline would mean N row queries on every
   * render of this page -- fine on a seeded test database, and exactly the thing that is slow on
   * real history -- and every one of those queries would have to be paginated separately while the
   * header above it already states the cluster's FULL count, which is two numbers on one screen
   * that can disagree. The disclosure below therefore reveals the group's ACTIONS, never its rows.
   *
   * Composed rather than chained: three params change (category, exact, group), and filterHref
   * changes one per call by design. So the first two are applied to a copy of the querystring and
   * the result is handed to filterHref as its `current` -- which still owns the last edit, the
   * page/gpage reset and the path building. Same shape as categoryChipHref above (a named wrapper
   * over the one href helper), not a second href helper.
   */
  function groupDrillHref(group: CategoryGroupRow): string {
    const params = new URLSearchParams(currentQuery);
    if (group.categoryId === null) {
      params.set('category', 'uncategorized');
      // No id to be exact about, and a stale `?exact=1` left on would be a param claiming
      // something about a filter that has no category id in it at all.
      params.delete('exact');
    } else {
      params.set('category', String(group.categoryId));
      params.set('exact', '1');
    }
    return filterHref(params.toString(), 'group', null);
  }

  /**
   * v1.26.0 Lane 3a item 2 (owner: "if rules set category grocier i can just scoll and look at all
   * the groceries 1 shot whiel receiving rather then by just date"). The grouped view: one row per
   * category cluster, largest absolute total first (groupTransactionsByCategory already returns
   * them in that order -- no second sort here, which is what stops the screen and the data layer
   * from ever disagreeing about which cluster is most worth checking).
   *
   * A native `<details>`, not a React-state disclosure. Three reasons, in order of weight: this page
   * has NO client-side router (MonthNav.tsx's own docblock -- every filter is a real navigation), so
   * per-group open state kept in React would be wiped by the very group-pager click that needs it
   * most; `<details>` needs no JavaScript at all, so the summary line works on the first paint the
   * server sends; and its content is a real part of the accessibility tree with a real
   * expanded/collapsed state, which a `hidden`-classed div toggled by a button is not unless
   * somebody remembers aria-expanded.
   *
   * The PAGER SAYS GROUPS, spelled out as a range. "Page 2 of 3" under a list of categories reads as
   * rows to anybody who has used the rest of this page, and getting that wrong here is worse than
   * usual: the household is trying to judge how much the rules did, so a number they misread as
   * rows is a number that misleads them about the size of the batch. `groupCount` and `totalCount`
   * are both from CategoryGroupPage, which computes them over the WHOLE filtered set rather than
   * the visible page.
   */
  function groupList(groupPage: CategoryGroupPage) {
    if (groupPage.groupCount === 0) {
      return (
        <Card as="div">
          <EmptyState
            icon={TransactionsIcon}
            title="Nothing matches these filters"
            action={
              <Link href="/transactions" className="btn btn--secondary btn--sm">
                Clear filters
              </Link>
            }
          >
            No transactions in this view, so there are no categories to group them under.
          </EmptyState>
        </Card>
      );
    }
    const firstShown = (groupPage.page - 1) * groupPage.pageSize + 1;
    const lastShown = Math.min(groupPage.groupCount, groupPage.page * groupPage.pageSize);
    return (
      <Card as="div">
        {/* `data-category-groups`, the same "name the list so a query can find exactly it" idiom
            `data-transaction-cards` already uses on the card lists below. Load-bearing rather than
            decorative: PageGuide is itself a <details>/<summary> ("What is this page for?"), so an
            unscoped `summary` query on this page finds the guide too -- which is precisely the kind
            of near-miss that makes a test pass while asserting the wrong element. */}
        <ul data-category-groups>
          {groupPage.groups.map((group) => (
            <li key={group.categoryId ?? 'uncategorized'} className="border-b border-line last:border-b-0">
              <details>
                {/* Left on `display: list-item` (no `flex` on the summary itself) so the browser's
                    own disclosure triangle survives -- Chrome drops the marker the moment a summary
                    becomes a flex container, and a disclosure with no marker is one nobody knows to
                    click. The flex layout lives on the span INSIDE it instead. */}
                <summary className="min-h-11 cursor-pointer px-4 py-3 marker:text-subtle sm:min-h-0 sm:px-5">
                  <span className="inline-flex w-[calc(100%-1.5rem)] flex-wrap items-baseline justify-between gap-x-3 gap-y-1 align-middle">
                    <span className="font-medium text-ink">{group.categoryName}</span>
                    <span className="flex items-baseline gap-3 text-sm text-muted">
                      <span className="tabnum">
                        {group.count} transaction{group.count === 1 ? '' : 's'}
                      </span>
                      <Money cents={group.totalCents} className="font-semibold" />
                    </span>
                  </span>
                </summary>
                <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-2/60 px-4 py-3 sm:px-5">
                  <Link href={groupDrillHref(group)} className="btn btn--secondary btn--sm">
                    {`See all ${group.count} in the list`}
                  </Link>
                  {/* The uncategorized cluster has no category to confirm -- confirmCategory needs a
                      real category id, and "these are all correct" about nothing is not a sentence.
                      Recategorize IS offered for it (and is one of the more useful things here:
                      everything the rules had no opinion about, filed in one go). */}
                  {group.categoryId !== null ? (
                    <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConfirmGroup(group)}>
                      These are all correct
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    // Opens with NO destination chosen (`categoryId: ''`), deliberately. Seeding the
                    // first category in the list would pre-arm a move of every row in this cluster
                    // into a category nobody picked, one stray Enter away; seeding the group's OWN
                    // category would make the default a no-op behind a button that says "Move all
                    // 37". So the dialog asks, and its Save stays disabled until it is answered --
                    // the same "Choose a category" opening state the split editor's own part
                    // selects use.
                    onClick={() => setRecatGroup({ group, categoryId: '' })}
                  >
                    Recategorize the group…
                  </button>
                </div>
              </details>
            </li>
          ))}
        </ul>
        <CardFooter>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>
              {/* F-02: the same two-figure suffix the flat list's own footer carries
                  (pageFooterWords), over CategoryGroupPage's split-aware outCents/inCents -- see
                  that field's own doc comment for why this is NOT `groups.reduce` over each
                  cluster's net. */}
              {`Groups ${firstShown}–${lastShown} of ${groupPage.groupCount} — ${groupPage.totalCount} transaction${groupPage.totalCount === 1 ? '' : 's'} in this view · ${outInWords(groupPage.outCents, groupPage.inCents)}`}
            </span>
            {/* Real links, not a client-side pager: `?gpage=` is the group page, and filterHref
                leaves every other active filter alone (its own docblock) while resetting the ROW
                page, which a grouped view has no use for. */}
            {groupPage.page > 1 ? (
              <Link href={filterHref(currentQuery, 'gpage', String(groupPage.page - 1))} className="btn btn--secondary btn--sm">
                Previous groups
              </Link>
            ) : null}
            {groupPage.page < groupPage.pageCount ? (
              <Link href={filterHref(currentQuery, 'gpage', String(groupPage.page + 1))} className="btn btn--secondary btn--sm">
                Next groups
              </Link>
            ) : null}
          </span>
        </CardFooter>
      </Card>
    );
  }

  /**
   * v1.26.0 Lane 3a item 4, dialog one: "These are all correct".
   *
   * A page-level decision over a whole cluster, which is exactly the case RowDialog's own docblock
   * says belongs in a dialog rather than an inline disclosure -- there is no single row left to
   * anchor it to, and the wording has to be read before agreeing.
   *
   * IT STATES THE GROUP'S TRUE COUNT, and the write honours it. `group.count` is the cluster's full
   * size across every row page (CategoryGroupRow's own doc comment), and the form posts the page's
   * filter plus which cluster -- not the ids of rendered rows, of which there may be none at all in
   * this view -- so bulkConfirmGroupAction recomputes the same set server-side. That is the trap
   * this feature could most easily have fallen into: a dialog promising 34 and a write reaching the
   * 12 that happened to be on screen.
   *
   * Cancel writes nothing, because there is nothing to write until the form is submitted: both
   * buttons below simply close the dialog, and no state anywhere else on this page has been touched
   * by opening it.
   */
  function groupConfirmDialog() {
    if (!confirmGroup) return null;
    const count = confirmGroup.count;
    const noun = count === 1 ? 'transaction' : 'transactions';
    return (
      <RowDialog
        dialogId="group-confirm-dialog"
        title={`Confirm ${count} ${noun} in ${confirmGroup.categoryName}`}
        description={<Money cents={confirmGroup.totalCents} />}
        onClose={() => setConfirmGroup(null)}
      >
        <form action={confirmGroupFormAction} onSubmit={() => setConfirmGroup(null)} className="flex flex-col gap-3">
          <input type="hidden" name="scope" value={currentQuery} />
          <input
            type="hidden"
            name="groupCategoryId"
            value={confirmGroup.categoryId === null ? '' : String(confirmGroup.categoryId)}
          />
          <p className="text-sm text-ink">
            {`All ${count} ${noun} stay in ${confirmGroup.categoryName} and are marked set by hand, so a
            future rule run leaves ${count === 1 ? 'it' : 'them'} alone. Nothing else about ${count === 1 ? 'it' : 'them'} changes.`}
          </p>
          <p className="text-sm text-muted">
            {`This is the whole group of ${count}, not only what is on screen. A split transaction is left
            alone and the message afterwards says how many were.`}
          </p>
          <div className="flex gap-2">
            <SubmitButton className="w-fit">{`Confirm all ${count}`}</SubmitButton>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmGroup(null)}>
              Cancel
            </button>
          </div>
        </form>
      </RowDialog>
    );
  }

  /**
   * v1.26.0 Lane 3a item 4, dialog two: "Recategorize the group". Mirrors groupConfirmDialog
   * immediately above -- same posted scope, same whole-group promise, same Cancel-writes-nothing --
   * plus the two things a move needs that a confirmation does not: where the rows are going, and
   * whether the correction should teach a rule so the next import files them the same way.
   *
   * The target select is CONTROLLED (`recatGroup.categoryId`) for the same reason bulkLoanDialog's
   * loan select is: it drives the sentence below it live, so the destination named in the copy is
   * always the one about to be posted rather than whatever was picked first.
   */
  function groupRecategorizeDialog() {
    if (!recatGroup) return null;
    const { group, categoryId } = recatGroup;
    const count = group.count;
    const noun = count === 1 ? 'transaction' : 'transactions';
    const targetLabel = groupedCategories.find((option) => String(option.id) === categoryId)?.label ?? null;
    return (
      <RowDialog
        dialogId="group-recategorize-dialog"
        title={`Recategorize ${count} ${noun} in ${group.categoryName}`}
        description={<Money cents={group.totalCents} />}
        onClose={() => setRecatGroup(null)}
      >
        <form action={recatGroupFormAction} onSubmit={() => setRecatGroup(null)} className="flex flex-col gap-3">
          <input type="hidden" name="scope" value={currentQuery} />
          <input type="hidden" name="groupCategoryId" value={group.categoryId === null ? '' : String(group.categoryId)} />
          <Field label="Move them to">
            <select
              name="categoryId"
              value={categoryId}
              onChange={(event) => setRecatGroup({ group, categoryId: event.target.value })}
              autoFocus
              className={selectClass}
            >
              {/* The unchosen state is a real option rather than an empty controlled value with no
                  matching <option> -- a select whose value matches nothing renders as though the
                  first category were selected in some browsers, which is exactly the pre-armed
                  destination this dialog is avoiding. Same leading option the split editor uses. */}
              <option value="">Choose a category</option>
              {categoryOptGroups(categoryGroups)}
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink">
            {/* Defaults ON, unlike the confirm dialog which creates no rules at all -- a
                recategorize is the household telling the app something new, and the pack rule that
                misfiled this cluster will misfile the next import the same way unless the
                correction teaches one. Still a checkbox, not forced: a one-off correction should
                not have to become a standing household rule. */}
            <input type="checkbox" name="createRules" defaultChecked className="accent-accent" />
            {' create rules, so the next import files these the same way'}
          </label>
          <p className="text-sm text-ink">
            {targetLabel === null
              ? `Pick a category to move all ${count} ${noun} into.`
              : `All ${count} ${noun} move from ${group.categoryName} to ${targetLabel}.`}
          </p>
          <p className="text-sm text-muted">
            {`This is the whole group of ${count}, not only what is on screen. A split transaction is left
            alone and the message afterwards says how many were.`}
          </p>
          <div className="flex gap-2">
            <SubmitButton disabled={categoryId === ''} className="w-fit">{`Move all ${count}`}</SubmitButton>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRecatGroup(null)}>
              Cancel
            </button>
          </div>
        </form>
      </RowDialog>
    );
  }

  return (
    // data-page-width: this table needs more than the shell's 6xl reading cap (see globals.css).
    // v1.16.0 Lane C item 3: NOT emitted at all in review mode -- the review filter is one
    // narrow column (ReviewWidth below), not the wide table, so bumping `main` to 96rem there
    // was exactly the mismatch this task fixes, not something review mode also needs.
    // Lane 0 shell tightening: gap-6 -> gap-4 sm:gap-5, the same page-level stack gap every other
    // page converts to this release, landing everywhere at once (Lane 0's own docblock).
    <div data-page-width={reviewMode ? undefined : 'wide'} className="flex flex-col gap-4 sm:gap-5">
      {/* v1.24.0 Lane A item 1 (owner report: "Review page still says trasaction. can we change
          that its confusing?"). The review queue is a FILTER on this page, not a separate page --
          the PageGuide right below already branches on reviewMode for exactly that reason -- so
          the header has to say which one a person is looking at instead of always saying
          "Transactions" regardless of which filter narrowed the list underneath it. */}
      <PageHeader
        title={reviewMode ? 'Needs review' : 'Transactions'}
        description={
          reviewMode
            ? 'Transactions the rules could not settle on their own. Pick a category to clear each one.'
            : 'Every line from every account, with what it was spent on.'
        }
      />

      <ReviewWidth active={reviewMode}>
      {/* Review round (fold /review in): review mode gets the review page's own three teaching
          paragraphs instead of the ordinary Transactions guide -- ported verbatim from
          review-client.tsx, only "this screen" -> "this filter" since it is no longer a
          separate page. Guard 3 (tests/ops/onboarding-coverage.test.ts) only greps this file's
          SOURCE for the literal `<PageGuide`, so having exactly one branch of a conditional
          render it still satisfies that guard. */}
      {reviewMode ? (
        <PageGuide>
          <p>
            Every import runs each new transaction past the categorizer. Anything it could not
            place with confidence waits here instead of being filed under a guess, so this filter
            is the one place where a wrong category is a decision you made rather than one the
            app made quietly.
          </p>
          <p>
            Accepting a guess or correcting it does two things: it files that transaction, and it
            teaches the categorizer what that merchant is. The same merchant arrives already
            sorted next time. The count beside a row is every transaction with that merchant,
            plus future imports, and offers to apply your choice to all of them at once.
          </p>
          <p>
            This queue is not a one-time setup step. It empties, then refills the next time you
            import a statement, so clearing it is part of the monthly routine rather than
            something you finish once.
          </p>
        </PageGuide>
      ) : (
        <PageGuide>
          <p>
            Every line from every imported statement lands here. The filters above compose rather
            than replace one another, so a date range, an account, a category, a person and a
            search term all narrow the same list at once — and the address bar keeps whatever you
            picked, so a filtered view can be bookmarked or shared.
          </p>
          <p>
            One charge can belong to more than one category. Open a row and split it into parts,
            and each part counts towards its own category in Budgets and Reports instead of the
            whole amount landing on the first one.
          </p>
          <p>
            An imported amount is fixed here. You can rename the merchant, change the category,
            attribute the row to a person or mark it a transfer, but the figure itself comes from
            the statement — if that is wrong, undo the import on the Import page and bring the
            corrected file in again.
          </p>
        </PageGuide>
      )}

      {/* Ruling S6: a triage queue has no business showing a create form -- review mode hides
          Quick add entirely instead of merely collapsing it. Outside review mode it renders
          collapsed by default (the `collapsible` prop): on a phone this was ~600px of form
          sitting above the first data row of a page whose job is reading rows. */}
      {reviewMode ? null : (
        <QuickAddTransaction
          variant="page"
          collapsible
          accounts={accounts}
          categories={categories}
          people={people}
          today={today}
          defaultAccountId={defaultAccountId}
        />
      )}

      <FormError message={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {/*
        Owner report (item 1): this used to be a plain Card rendered wherever `splitting` happened
        to sit in the JSX (the very top of the page) -- so pressing Split… appeared to do nothing
        until a person scrolled up to find it, and once there they had lost sight of which row it
        belonged to. Unify-the-editors task (2026-08-30): the dimmed/blurred backdrop, role=dialog/
        aria-modal, the focus trap, Escape, body-scroll lock and focus-restore-to-trigger all now
        live once in RowDialog (see its own docblock) rather than being hand-wired here -- this is
        the shell's first and original caller. The FORM inside is byte-for-byte what it was before
        this task -- same fields, same action (splitAction), same validation (Save stays disabled
        until the remainder is exactly zero) and the same error surface (FormError/`error` in the
        top banner) -- only the shell around it changed. `key={splitting.id}` forces a fresh
        RowDialog instance (fresh opener capture, fresh initial focus) when one row's editor is
        replaced by another's without passing through `null` in between -- see RowDialog's own
        docblock on why a plain `splitting !== null` boolean would not refire for that case.
      */}
      {splitting ? (
        <RowDialog
          dialogId="split-dialog"
          key={splitting.id}
          title={`Split ${splitting.merchant}`}
          description={
            <>
              {`${splitting.date} · ${formatCents(splitting.amountCents)} — `}
              Divide this transaction across more than one category. The parts must add up to the full amount.
            </>
          }
          onClose={() => setSplitting(null)}
        >
          <form action={splitAction} onSubmit={() => setSplitting(null)} className="flex flex-col gap-4">
            <input type="hidden" name="txnId" value={splitting.id} />
            <input type="hidden" name="parts" value={JSON.stringify(splitPartsPayload)} />
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2 text-xs font-medium text-muted">
                <span className="w-44">Category</span>
                <span className="w-24">Amount</span>
                <span className="flex-1">Note</span>
              </div>
              {splitting.parts.map((part, index) => (
                <div key={index} className="flex flex-wrap items-center gap-2">
                  <select
                    value={part.categoryId}
                    onChange={(e) => updateSplitPart(index, { categoryId: e.target.value })}
                    aria-label={`Category for part ${index + 1}`}
                    className={`${selectClass} w-44`}
                  >
                    <option value="">Choose a category</option>
                    {/* Backlog BZ: an <optgroup> per parent instead of the flat NBSP-indented
                        list -- categoryOptGroups() already excludes archived categories,
                        matching this select's own live-category-only rule. */}
                    {categoryOptGroups(categoryGroups)}
                  </select>
                  <input
                    value={part.amount}
                    onChange={(e) => updateSplitPart(index, { amount: e.target.value })}
                    placeholder="0.00"
                    inputMode="decimal"
                    aria-label={`Amount for part ${index + 1}`}
                    className={`${inputClass} w-24`}
                  />
                  <input
                    value={part.note}
                    onChange={(e) => updateSplitPart(index, { note: e.target.value })}
                    placeholder="Note (optional)"
                    aria-label={`Note for part ${index + 1}`}
                    className={`${inputClass} flex-1 min-w-[10rem]`}
                  />
                  <button
                    type="button"
                    onClick={() => removeSplitPart(index)}
                    disabled={splitting.parts.length <= 2}
                    className="btn btn--ghost btn--sm px-2 text-xs"
                  >
                    Remove part
                  </button>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={addSplitPart} className="btn btn--secondary btn--sm">
                Add a part
              </button>
              <span className="text-sm text-muted">Remaining to assign: {formatCents(splitRemainderCents)}</span>
            </div>
            <div className="flex gap-2">
              <SubmitButton disabled={splitRemainderCents !== 0}>Save split</SubmitButton>
              <button type="button" onClick={() => setSplitting(null)} className="btn btn--secondary">
                Cancel
              </button>
            </div>
          </form>
          <form action={splitAction} onSubmit={() => setSplitting(null)}>
            <input type="hidden" name="txnId" value={splitting.id} />
            <input type="hidden" name="parts" value="[]" />
            <SubmitButton variant="secondary">Remove split</SubmitButton>
          </form>
        </RowDialog>
      ) : null}

      {/* The remaining four row editors, unified onto the same RowDialog shell -- see
          renameDialog/noteDialog/newLoanDialog/applyAllDialog's own shared docblock for why each
          renders here, once, rather than per row. */}
      {renameDialog()}
      {noteDialog()}
      {newLoanDialog()}
      {applyAllDialog()}
      {/* v1.26.0 Lane 1: same "rendered once here, looked up by row id" reasoning as the four row
          editors just above -- see bankTextDialog's own doc comment for why this is one dialog
          shell reused across all three display_source values rather than a copy of the rule
          case's wording. */}
      {bankTextDialog()}
      {/* v1.25.0 Lane R item R3: the two bulk-action confirm dialogs, same "rendered once here"
          reasoning as the four row editors just above -- see bulkLoanDialog/bulkNoteDialog's own
          doc comments (above transactionCard's return) for why each is a dialog rather than an
          inline disclosure. */}
      {bulkLoanDialog()}
      {bulkNoteDialog()}
      {/* v1.26.0 Lane 3a item 4: the two group-header confirms, same "rendered once here, told
          which group by one nullable slot of state" reasoning as every dialog above -- see
          groupConfirmDialog/groupRecategorizeDialog's own docblocks for why each states the
          cluster's full count and posts the page's filter rather than the rendered rows' ids. */}
      {groupConfirmDialog()}
      {groupRecategorizeDialog()}

      <Card as="div">
        <CardBody className="pt-5">
          <form method="get" className="flex flex-col gap-3">
            {/* Ruling R1: `review=1` is a filter like any other on this form, so re-submitting
                it (changing the account, say) must not silently drop out of the review queue --
                carried forward as a hidden field rather than a visible control, the same way
                every OTHER already-applied value on this GET form has no widget of its own
                either. */}
            {reviewMode ? <input type="hidden" name="review" value="1" /> : null}
            {/* v1.24.0 Lane A item 2: same reasoning as `review` just above -- the transfer-view
                control (below) is a set of plain <a> links, not a form field, so re-submitting
                THIS form (changing the account, say) would otherwise silently reset it back to
                'all'. Only rendered when it differs from the default, same as `review`. */}
            {activeTransferView !== 'all' ? (
              <input type="hidden" name="transfers" value={activeTransferView === 'only' ? 'only' : '0'} />
            ) : null}
            {/* v1.25.0 Lane R item R1: same reasoning as `transfers` just above -- the queue chip
                row (below) is a set of plain <a> links via PillNav, not a form field. */}
            {activeQueueChip !== '' ? <input type="hidden" name="queue" value={activeQueueChip} /> : null}
            {/* v1.26.0 Lane 3a: same reasoning as `transfers`/`queue` above, for the five params
                this release adds -- all five are set by plain <a> links (the pill rows below, and
                the import-batch chip), none of them is a field on this GET form, so re-submitting
                the form to change the account would otherwise silently drop the grouped view, the
                sort and the whole audit batch. `gpage` is deliberately NOT carried: changing a
                filter belongs back on the first page of groups, which is exactly what filterHref
                does to it for a link and what its absence does here for a submit. */}
            {activeGroupView !== '' ? <input type="hidden" name="group" value={activeGroupView} /> : null}
            {activeSort !== '' ? <input type="hidden" name="sort" value={activeSort} /> : null}
            {activeSort !== '' ? <input type="hidden" name="dir" value={activeDirection} /> : null}
            {activeSource !== '' ? <input type="hidden" name="source" value={activeSource} /> : null}
            {activeImportId !== null ? <input type="hidden" name="import" value={activeImportId} /> : null}
            {/* Fix round (owner ask): one row, at every width, replaces the old "Filters (N)"
                text button that only showed below `sm` plus a field block that was simply always
                visible at `sm` and up -- two different shapes for the same fields depending on
                viewport. Now there is one shape everywhere: the filter icon plus the merchant
                search field, both reachable regardless of width, with the rest of the fields
                (account, person, dates, uncategorized only) behind the icon -- transfer view
                (below) moved OUT from behind it, v1.24.0 Lane A item 2, see that control's own
                comment for why. */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                // 44px square on a touch-sized viewport (the tap-target floor this file already
                // applies elsewhere, e.g. confirmButton above), stepping down to a mouse-sized
                // 32px at `sm` and up -- `relative` so the count badge below can pin to a corner.
                className="btn btn--secondary relative h-11 w-11 shrink-0 p-0 sm:h-8 sm:w-8"
                aria-expanded={filtersOpen}
                aria-controls="transactions-filter-fields"
                // The accessible name carries the same "Filters" / "Filters (N)" text the old
                // button used to show, since an icon alone has no name of its own to compute one
                // from -- unchanged wording keeps every existing "Filters (N)" query passing.
                aria-label={activeFilterCount > 0 ? `Filters (${activeFilterCount})` : 'Filters'}
                onClick={() => setFiltersOpen((prev) => !prev)}
              >
                <FilterIcon className="h-4 w-4" aria-hidden="true" />
                {/* The "3 filters are on" signal the old button's own visible text used to carry
                    -- losing it when the button became icon-only would be a regression, so it
                    stays as a small badge pinned to the icon (aria-hidden: the label above
                    already says the same count to anyone not looking at it). */}
                {activeFilterCount > 0 ? (
                  <span
                    aria-hidden="true"
                    className="badge badge--accent absolute -right-1.5 -top-1.5 min-w-[1.125rem] justify-center"
                  >
                    {activeFilterCount}
                  </span>
                ) : null}
              </button>
              {/*
                Owner report (item 3): Field's own stacked shape (a label span above the
                control, see src/components/ui/form.tsx) made this the tallest thing on the
                row -- `items-center` above then centred the Filters button against that taller
                column, which is exactly the "icon floats above centre with a dead band around
                it" the owner screenshotted. A bare <input> is the fix, not a shorter Field: the
                visible "Search" label added nothing a placeholder this specific does not already
                say, so it is gone rather than shrunk, and `aria-label` carries the same wording
                to a screen reader now that there is no visible text to compute a name from.
                `min-h-11 sm:min-h-0` matches the Filters button's own `h-11 ... sm:h-8` floor
                (AUTO_SAVE_CONTROL's idiom elsewhere in this file), so the two sit at the same
                height on the same row instead of the input being shorter and off-centre.
              */}
              {/* F-07 (v1.31.0, owner's question: "Where is that $47.13 charge the bank called
                  about?"). No new control -- this box already learns to recognise money in
                  buildWhere (src/lib/transactions.ts), so the placeholder gains "or an amount"
                  rather than a second field beside it. */}
              <input
                name="q"
                placeholder="Search by merchant name, description, or an amount"
                aria-label="Search by merchant name, description, or an amount"
                className={`${inputClass} min-h-11 min-w-[12rem] flex-1 sm:min-h-0`}
              />
            </div>

            {/*
              v1.24.0 Lane A item 2 (owner report: "currently once i apply a trasnfer its hard to
              find that data again"). ALWAYS visible, never folded behind the Filters(N)
              disclosure the old two-state checkbox lived in. Burying it there is what made a
              mis-tagged transfer unreachable in the first place: REVIEW_WHERE
              (src/lib/categorize/engine.ts) excludes every transfer unconditionally, so once a
              row was flagged a transfer AND the checkbox's "hide transfers" default hid it from
              the ordinary list too, nothing on this page could ever show it again. "Transfers
              only" is that recovery path, and a recovery path that needs discovering through a
              collapsed disclosure first is not really one.

              v1.25.0 Lane R item R2: moved onto PillNav (src/components/ui/PillNav.tsx) -- the
              last hand-rolled `role="group"` instance of "a row of pill-shaped filter links, one
              marked active", per that component's own docblock. Two deliberate changes, both
              improvements: the wrapper is now a LABELLED `<nav>` LANDMARK instead of
              `role="group"` (PillNav's own docblock argues this at length -- `role="group"`
              cannot be jumped to by a screen-reader user, `<nav>` can), and this keeps PillNav's
              DEFAULT className -- the segmented-tab look Budgets' ScopePill and Dashboard's
              PersonPill already render, rather than overriding it back to the old loose Pill-chip
              row. That is a genuine visual change (an inactive option no longer carries its own
              grey pill background, only the active one gets the filled `bg-surface` treatment),
              chosen deliberately: PillNav's per-option classes are not independently overridable
              (only the group wrapper's `className` is), so keeping the OLD look exactly would
              have meant not adopting PillNav's item styling at all, just its `<nav>`/
              aria-current/44px-floor properties -- and this is a strict, mutually-exclusive
              3-way mode switch (All / Transfers only / No transfers), the same shape as the
              segmented controls it now matches, not an open multi-value picker like the category
              chips just below (which stay on Pill -- out of this task's scope). Consistency with
              the two existing segmented controls was preferred per this task's own brief, and
              nothing about this row's three short labels needs the looser chip treatment to fit.

              NOT rendered in review mode: the review queue is REVIEW_WHERE, which excludes
              transfers unconditionally regardless of this control, so offering a "transfers only"
              or "no transfers" choice there would be a lie about what the filtered list can ever
              return -- every option would either show nothing (transfers only, none) or the same
              rows (no transfers, redundant with REVIEW_WHERE's own exclusion). The review-mode
              queue chips (v1.25.0 Lane R item R1, just below) take this exact slot instead --
              `?queue=` composes with `?review=1` the same way `?transfers=` composes with the
              ordinary list, so the two controls never need to be visible at once.
            */}
            {/* Fix round (owner report, phone screenshot): folds below `sm` once its own filter is
                back at default, same as every row rowVisibility (above) covers -- see that
                helper's doc comment for why an unconditional fold was rejected. `reviewMode`'s own
                queue-chip branch and the ordinary transfer-view branch share one row, so one
                wrapper (rather than two) picks whichever branch's own active state applies.

                `flex-col`, and item M-4 is why. This is the ONE folded row that needed a brand-new
                wrapper -- the other four appended rowVisibility to a `<span>` that already existed
                around their pills, so their geometry did not move. `PillNav` renders a `<nav>` that
                is itself `flex flex-wrap ... rounded-full border ... p-1` and, as a direct child of
                this `flex flex-col` form, stretched to the full column width. Putting it inside a
                default (row) flex wrapper silently shrank the segmented bar to its content width at
                EVERY breakpoint, contradicting Task 3c's own "unchanged at `sm` and up" claim in a
                defects-only release. `flex-col` restores stretch, because a column flex container's
                items default to `align-items: stretch`.

                Rejected: the review's own suggested `w-full` on this wrapper, which is a no-op --
                the wrapper is already a stretched flex item of the column, so it was never the
                narrow element; the `<nav>` inside it was. Also rejected: passing the classes
                through `PillNav`'s `className`, which REPLACES rather than appends (by design), so
                both branches below would have had to restate the whole default chrome -- two more
                copies of one look, which is the defect this release is about. */}
            <div className={`${rowVisibility(reviewMode ? activeQueueChip !== '' : activeTransferView !== 'all')} flex-col`}>
              {reviewMode ? (
                <PillNav
                  groupLabel="Filter the review queue"
                  options={QUEUE_CHIP_OPTIONS.map(
                    (option): PillNavOption => ({
                      key: option.value === '' ? 'all' : option.value,
                      href: filterHref(currentQuery, 'queue', option.param),
                      label: option.label,
                      active: activeQueueChip === option.value,
                    }),
                  )}
                />
              ) : (
                <PillNav
                  groupLabel="Filter by transfer status"
                  options={TRANSFER_VIEW_OPTIONS.map(
                    (option): PillNavOption => ({
                      key: option.value,
                      href: filterHref(currentQuery, 'transfers', option.param),
                      label: option.label,
                      active: activeTransferView === option.value,
                    }),
                  )}
                />
              )}
            </div>

            {/*
              v1.26.0 Lane 3a items 1-3. The audit bar: how the list is grouped, how it is sorted,
              and which categorizer's decisions it shows. Each row carries a small visible label as
              well as PillNav's own `groupLabel`: three unlabelled pill rows stacked on one card is
              a puzzle, and the labels are what make "Set by: Rules" read as a sentence rather than
              as five more filter chips.

              Sort is offered in BOTH modes -- ordering a queue by amount is as reasonable as
              ordering the list by it. The other two are NOT offered in review mode, on the same
              honesty rule the transfer row above follows: REVIEW_WHERE (src/lib/categorize/
              engine.ts) is `category IS NULL OR source = 'bayes'`, so inside the queue every
              `?source=` option but Guesses selects nothing, and every cluster of a queue that is
              mostly uncategorized rows is the one Uncategorized cluster. Offering controls whose
              options are lies about what the filtered list can return is what this app declines to
              do; a hand-typed `?group=category&review=1` is still honoured (page.tsx never checks
              review mode for it), it just is not advertised.

              Fix round (owner report, phone screenshot): View/Sort/Set by each fold below `sm`
              once THEIR OWN filter is back at default (rowVisibility, above) -- three independent
              folds, not one shared with the row around them, because a phone screen showing "Set
              by: Rules" has no reason to also show an idle "View" row. The import-batch chip just
              below stays the one exception, unconditionally visible at every width: it is the
              filter a person arrives at without clicking a control for it (the import summary's
              audit link is `?import=<id>&source=rule&group=category`), so it must be visible and
              dismissible wherever they land, never behind a fold of any kind -- see rowVisibility's
              own doc comment for why folding it was considered and rejected.
            */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {reviewMode ? null : (
                <span className={`${rowVisibility(activeGroupView !== '')} flex-wrap items-center gap-1.5`}>
                  <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted">View</span>
                  <PillNav
                    groupLabel="How to show the transactions"
                    options={GROUP_VIEW_OPTIONS.map(
                      (option): PillNavOption => ({
                        key: option.value === '' ? 'list' : option.value,
                        href: filterHref(currentQuery, 'group', option.param),
                        label: option.label,
                        active: activeGroupView === option.value,
                      }),
                    )}
                  />
                </span>
              )}
              <span className={`${rowVisibility(activeSort !== '')} flex-wrap items-center gap-1.5`}>
                <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted">Sort</span>
                <PillNav
                  groupLabel="Sort the transactions"
                  options={SORT_OPTIONS.map(
                    (option): PillNavOption => ({
                      key: option.value === '' ? 'default' : option.value,
                      href: filterHref(currentQuery, 'sort', option.param),
                      label: option.label,
                      active: activeSort === option.value,
                    }),
                  )}
                />
                {/* Only once a sort is chosen: with none, the data layer ignores `dir` outright
                    (orderByFor returns the default branch before it reads direction), so a
                    direction control there would be two links that change nothing. The pair's
                    ORDER comes from DIRECTION_LABELS' own key order per field -- newest/largest
                    first for date and amount, A-Z first for category -- so the option a person
                    most likely wants is the leftmost one for that field rather than whichever
                    direction happens to be spelled first in the type. */}
                {activeSort !== '' ? (
                  <PillNav
                    groupLabel="Which way to sort"
                    options={(Object.keys(DIRECTION_LABELS[activeSort]) as SortDirection[]).map(
                      (direction): PillNavOption => ({
                        key: direction,
                        href: filterHref(currentQuery, 'dir', direction),
                        label: DIRECTION_LABELS[activeSort][direction],
                        active: activeDirection === direction,
                      }),
                    )}
                  />
                ) : null}
              </span>
              {reviewMode ? null : (
                <span className={`${rowVisibility(activeSource !== '')} flex-wrap items-center gap-1.5`}>
                  <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted">Set by</span>
                  <PillNav
                    groupLabel="Filter by what set the category"
                    options={SOURCE_FILTER_OPTIONS.map(
                      (option): PillNavOption => ({
                        key: option.value === '' ? 'all' : option.value,
                        href: filterHref(currentQuery, 'source', option.param),
                        label: option.label,
                        active: activeSource === option.value,
                      }),
                    )}
                  />
                </span>
              )}
              {/* The import batch, as a chip that clears itself -- the same badge-as-a-link idiom
                  the "Needs review (N)" control below already uses. This is the only filter on this
                  page a person can arrive at without having clicked a control for it, so it is also
                  the only one that has to say "you are inside a batch" out loud. */}
              {activeImportId !== null ? (
                <Link
                  href={filterHref(currentQuery, 'import', null)}
                  className="badge badge--accent min-h-11 items-center px-3 sm:min-h-0"
                >
                  {`Import #${activeImportId} — clear`}
                </Link>
              ) : null}
            </div>

            {/* Chip filters (ruling D6): TOP-LEVEL categories only, not folded behind the four-select
                disclosure the way account/person/dates/uncategorized stay, wrapping rather than
                scrolling, with a "+n" expander for the rest. Plain <Link>s, not a second form field
                named "category" -- the existing select further down keeps that name, so two
                controls submitting under it at once (and the browser sending TWO values for one
                querystring key) never arises. Each href is built from `currentQuery`
                (categoryChipHref above, page.tsx's own comment on that prop), so clicking one only
                ever changes `category` and leaves account/person/dates/search/uncat/transfers/review
                exactly as they were -- the same "just this one param" contract the existing "Needs
                review" link below already keeps for `review`.

                Fix round (owner report, phone screenshot): below `sm` this row now folds like every
                other row rowVisibility (above) covers, once no category chip is active -- see that
                helper's own doc comment for the reasoning. */}
            {topLevelChips.length > 0 ? (
              <div
                role="group"
                aria-label="Filter by category"
                className={`${rowVisibility(activeCategoryChip !== '')} flex-wrap items-center gap-2`}
              >
                <Link href={categoryChipHref(currentQuery, null)} className="inline-flex min-h-11 items-center sm:min-h-0">
                  <Pill tone={activeCategoryChip === '' ? 'accent' : 'neutral'}>All</Pill>
                </Link>
                {visibleChips.map((chip) => (
                  <Link
                    key={chip.id}
                    href={categoryChipHref(currentQuery, String(chip.id))}
                    className="inline-flex min-h-11 items-center sm:min-h-0"
                  >
                    <Pill tone={activeCategoryChip === String(chip.id) ? 'accent' : 'neutral'}>{chip.label}</Pill>
                  </Link>
                ))}
                {hiddenChipCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setChipsExpanded(true)}
                    className="inline-flex min-h-11 items-center sm:min-h-0"
                    aria-label={`Show ${hiddenChipCount} more categories`}
                  >
                    <Pill tone="neutral">{`+${hiddenChipCount}`}</Pill>
                  </button>
                ) : null}
              </div>
            ) : null}

            {/* The fields stay mounted in the DOM whether the disclosure is open or not (`hidden`
                below is a CSS class, never a conditional unmount), so what this form submits
                never depends on whether the icon above has been clicked. */}
            <div
              id="transactions-filter-fields"
              className={`${filtersOpen ? 'flex' : 'hidden'} flex-wrap items-end gap-3`}
            >
              <Field label="Account">
                <select name="account" className={selectClass}>
                  <option value="">All</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Category">
                <select name="category" className={selectClass}>
                  <option value="">All</option>
                  <option value="uncategorized">Uncategorized</option>
                  {groupedCategories.map((opt) => (
                    <option key={opt.id} value={opt.id}>{'\u00A0\u00A0'.repeat(opt.depth) + opt.label}</option>
                  ))}
                </select>
              </Field>
              {/* Ruling R2: for a self viewer the person filter is already forced to their own id
                  server-side (page.tsx's readFilter), so the pill that would let them ask for
                  somebody else is not rendered at all rather than shown-but-ineffective. */}
              {selfScoped ? null : (
                <Field label="Person">
                  <select name="person" className={selectClass}>
                    <option value="">Everyone</option>
                    <option value="unattributed">Household/unattributed</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </Field>
              )}
              <DateRangePicker
                allowAny
                value={range?.preset ?? ''}
                from={range?.from ?? ''}
                to={range?.to ?? ''}
                today={today}
              />
              <div className="flex flex-wrap items-center gap-4 py-2">
                <label className="flex items-center gap-2 text-sm text-muted">
                  <input type="checkbox" name="uncat" value="1" className="accent-accent" /> Uncategorized only
                </label>
                {/* v1.24.0 Lane A item 2: the "Hide transfers" checkbox that used to live here is
                    gone -- it's the always-visible transfer-view control above the search row now
                    (three states, not two; see that control's own comment for why burying it
                    behind this disclosure was the actual bug). */}
              </div>
              <button type="submit" className="btn btn--primary">Filter</button>
              {/* Inventory #3 / ruling R2: the review page's own "N waiting" eyebrow, repointed as
                  a filter chip on this page instead of a second page's header. Hidden entirely for
                  a self viewer -- the queue is household-wide by construction, and `reviewMode` is
                  already forced `false` for one server-side (page.tsx), so a self viewer clicking
                  this (were it shown) would just get their own ordinary list back, not a refusal.
                  Shown once in review mode too (even if reviewCount has since dropped to 0), so the
                  one control that got a person INTO the filter is also the one that gets them back
                  OUT of it. */}
              {!selfScoped && (reviewCount > 0 || reviewMode) ? (
                <Link
                  href={reviewMode ? '/transactions' : '/transactions?review=1'}
                  className={`badge ${reviewMode ? 'badge--amber' : 'badge--slate'} min-h-11 items-center px-3 sm:min-h-0`}
                >
                  Needs review ({reviewCount})
                </Link>
              ) : null}
            </div>
          </form>
        </CardBody>
      </Card>

      {selected.length > 0 ? (
        <div className="flex flex-wrap items-end gap-4 rounded-lg border border-accent-soft bg-accent-soft px-4 py-3">
          <span className="py-2 text-sm font-semibold text-accent-soft-fg">{selected.length} selected</span>
          {selectedSplitCount > 0 ? (
            <p className="w-full text-xs text-accent-soft-fg">
              {selectedSplitCount} of {selected.length} selected {selectedSplitCount === 1 ? 'is' : 'are'} split and will be
              skipped by Categorize and Mark transfer.
            </p>
          ) : null}
          {/* v1.25.0 Lane R item R3: one list, walked once -- bulkActions' own doc comment (above
              transactionCard's return) explains why this is no longer five hand-copied blocks. */}
          {bulkActions.map((action) => (
            <Fragment key={action.key}>{action.node}</Fragment>
          ))}
        </div>
      ) : null}

      {/* v1.26.0 Lane 3a item 2: the grouped view replaces the rows entirely, the same
          INSTEAD-not-as-well-as rule review mode has always followed one branch down. It comes
          first because it is the coarsest choice on the page: "am I looking at clusters or at
          rows" is decided before "table or cards" and before "queue or list". `groups !== null` is
          the one signal (page.tsx sets it only when `?group=category` was asked for), so the pill's
          active state and the view rendered cannot drift apart. */}
      {groups !== null ? (
        groupList(groups)
      ) : /* Ruling R5: review mode renders the card list INSTEAD of the table -- never both. This is
          still true after the single-card-renderer task: review mode is mode-gated (this
          conditional), not width-gated, so it never grows a second tree the way the plain
          Transactions branch below deliberately does (transactionCard's own docblock explains
          why that one DOES carry two trees, one hidden by width at a time). */
      reviewMode ? (
        page.rows.length === 0 ? (
          // Ruling S5(a): the reading-measure cap now lives once on ReviewWidth above (v1.16.0
          // Lane C item 3), not repeated on every element inside it -- this Card needs no width
          // class of its own to line up with everything else on this branch.
          <Card>
            <EmptyState
              icon={CheckIcon}
              title="Nothing to review. Everything is categorized."
              action={
                <>
                  <Link href="/transactions" className="btn btn--primary btn--sm">
                    See what was categorized
                  </Link>
                  <Link href="/import" className="btn btn--secondary btn--sm">
                    Bring in more
                  </Link>
                </>
              }
            >
              New imports land here whenever the categorizer is unsure.
            </EmptyState>
          </Card>
        ) : (
          <>
            {/* Ruling S5(a): the reading-measure cap lives once on ReviewWidth now (v1.16.0 Lane
                C item 3) -- on a laptop or a 27-inch monitor this list used to stretch to the
                shell's full width on its own, which left the amount marooned out at the far
                right of a card mostly empty space. A queue you work through top to bottom reads
                better narrow, at every width, which is exactly why ruling S5 keeps this a card
                list instead of migrating it to the responsive table treatment above. */}
            {/* v1.19.0 Lane 2 item 5: the confirm-progress bar and "Accept all suggestions".
                Session-local (queueCeiling's own comment above explains why this file tracks no
                persisted total), so it reads "0/N confirmed" fresh on every page load rather than
                a running lifetime count -- there is nowhere in scope (this task touches no
                src/lib file) to keep one, and a per-visit count of "how far through THIS sitting
                you've gotten" is what the reference's own progress bar is for regardless. */}
            <div className="flex flex-wrap items-center gap-3">
              <ProgressBar
                pct={queueConfirmedPct}
                tone="calm"
                label="Review queue confirmed"
                className="min-w-[8rem] flex-1"
              />
              <span className="whitespace-nowrap text-xs font-medium text-muted">
                {confirmedCount}/{queueCeiling} confirmed
              </span>
              {acceptAllIds.length > 0 ? (
                <form action={acceptAllAction}>
                  <input type="hidden" name="ids" value={acceptAllIds.join(',')} />
                  <SubmitButton variant="secondary" size="sm" className="w-fit">
                    <SuggestIcon className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                    {`Accept all suggestions (${acceptAllIds.length})`}
                  </SubmitButton>
                </form>
              ) : null}
            </div>
            {/* Refactor lane (2026-08-30): this used to carry the review queue's own, separately-
                written <li> markup. It now calls transactionCard(row) -- the SAME function the
                mobile Transactions view below calls -- so a feature added here (or there) can no
                longer silently miss the other; see that function's own docblock for the rule this
                keeps. */}
            <ul className="flex flex-col gap-3" data-transaction-cards>
              {page.rows.map((row, index) => (
                <Fragment key={row.id}>
                  {/* Date grouping (item 3): a plain <li>, not `.card` -- so `li.card` still
                      counts real transaction rows only, and every existing query that looks for
                      "the first li.card" keeps finding a real row rather than this header. */}
                  {startsNewDay(page.rows, index) ? (
                    <li className="px-1 pt-2 text-xs font-semibold uppercase tracking-wide text-subtle first:pt-0">
                      {formatDayHeader(row.date)}
                    </li>
                  ) : null}
                  {transactionCard(row)}
                </Fragment>
              ))}
            </ul>
            <p className="text-sm text-muted">{pageFooterWords(page)}</p>
          </>
        )
      ) : page.rows.length === 0 ? (
        <Card as="div">
          <EmptyState
            icon={TransactionsIcon}
            title="Nothing matches these filters"
            action={
              <Link href="/transactions" className="btn btn--secondary btn--sm">
                Clear filters
              </Link>
            }
          >
            Widen the date range or clear the search — or import a statement to get some transactions in here.
          </EmptyState>
        </Card>
      ) : (
      <>
        {/*
          Single-card-renderer task, item 1. Below `sm` this renders the exact same
          transactionCard(row) the review queue calls above -- not a second, Transactions-only
          card -- so a control added to one is never missing from the other (see that function's
          own docblock). `sm:hidden` keeps it out of the way at `sm` and up, where the table just
          below (`hidden` here, shown from `sm` up) is the wide browsing view a ledger scanned
          down a column needs. A real browser shows exactly one of the two: CSS `display:none`
          also removes the hidden one from the tab order and the accessibility tree, so neither a
          keyboard nor a screen-reader user ever meets the same row control twice.
        */}
        <ul className="flex flex-col gap-3 sm:hidden" data-transaction-cards>
          {page.rows.map((row, index) => (
            <Fragment key={row.id}>
              {startsNewDay(page.rows, index) ? (
                <li className="px-1 pt-2 text-xs font-semibold uppercase tracking-wide text-subtle first:pt-0">
                  {formatDayHeader(row.date)}
                </li>
              ) : null}
              {transactionCard(row)}
            </Fragment>
          ))}
        </ul>
        <p className="text-sm text-muted sm:hidden">{pageFooterWords(page)}</p>
      <div className="hidden sm:block">
      <Card as="div">
        {/* v1.26.0 Lane 1 item 4 (the owner's actual workflow: auditing fifty rows after an
            import, which per-row clicking does not scale to). One link flips `?bank=1` for the
            WHOLE table -- filterHref (this file's own generalization, see its docblock) keeps
            every other active filter on the querystring untouched, and the state lives in the
            URL, not React state or localStorage, so it survives a refresh the same way
            `transfers`/`queue`/`uncat` already do. Table-only (bankTextOn's own doc comment):
            the card list a few lines above already shows a rule-renamed row's bank text with no
            toggle needed at all. */}
        <div className="flex items-center justify-end border-b border-line px-4 py-2 sm:px-5">
          <Link href={filterHref(currentQuery, 'bank', bankTextOn ? null : '1')} className="btn btn--secondary btn--sm">
            {bankTextOn ? 'Hide bank text' : 'Show bank text'}
          </Link>
        </div>
        {/* minWidth is the colgroup's own total (3+7+9+15+7+13+11+3 = 68rem). Without it this
            table could not exceed its container, so the scroll container had nothing to scroll
            and the browser shrank every column instead -- see TableWrap's minWidth docblock.
            `responsive` (the data-table--stack phone reflow) is left wired exactly as it was --
            it is redundant now that the `hidden sm:block` wrapper above already keeps this whole
            table out of the DOM's visible flow below `sm` (the card list is what a phone sees
            instead), but ripping it and its cell-stack and data-label plumbing out is a bigger,
            separate change than this task's brief calls for, and leaving it costs nothing: it
            simply never gets a viewport narrow enough to apply itself in any more. */}
        <TableWrap bare fixed minWidth="68rem" responsive>
          <colgroup>
            {/* Just the checkbox, plus the 1rem of cell padding either side. */}
            <col style={{ width: '3rem' }} />
            {/* An ISO date in tabular figures, which is the same width on every row. */}
            <col style={{ width: '7rem' }} />
            {/* Wide enough to READ an account name -- a `title` is no answer on a phone. */}
            <col style={{ width: '9rem' }} />
            {/* An explicit width, NOT elastic: left unsized this collapsed to one character on
                a narrow screen and spelled merchant names vertically (v1.10.1). */}
            <col style={{ width: '15rem' }} />
            {/* A signed five-figure amount on one line. */}
            <col style={{ width: '7rem' }} />
            {/* The category select plus its 1rem status slot. It no longer carries a Save
                button, which is where part of this table's old width went. */}
            <col style={{ width: '13rem' }} />
            {/* Same shape, shorter values -- a person's name or "Household". */}
            <col style={{ width: '11rem' }} />
            {/* The kebab: one 2rem button plus padding. This column used to be 11rem of link,
                button and select, and it was the column that clipped at the card's edge. The
                menu itself is position:fixed, so it is not constrained by this width. */}
            <col style={{ width: '3rem' }} />
          </colgroup>
          <thead>
            <tr>
              {/* No width class on the header cells: the colgroup owns the widths now. */}
              <th scope="col" />
              <th scope="col">Date</th>
              <th scope="col">Account</th>
              <th scope="col">Description</th>
              <th scope="col" className="text-right">Amount</th>
              <th scope="col">Category</th>
              <th scope="col">Person</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row, index) => {
              return (
              <Fragment key={row.id}>
              {/* Date grouping (item 3, ruling D7): the table stays a table, so the day header is
                  a full-width <tr> inside it, not a card of its own -- a single `data-label=""`
                  <td> (the same idiom the note/newLoan/applyAll sub-rows below already use) is
                  already proven to survive `.data-table--stack`'s phone reflow (globals.css's own
                  `[colspan] { display: block }` rule), so this needed no new CSS. */}
              {startsNewDay(page.rows, index) ? (
                <tr>
                  <td
                    colSpan={COLUMN_COUNT}
                    data-label=""
                    className="bg-surface-2 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-subtle"
                  >
                    {formatDayHeader(row.date)}
                  </td>
                </tr>
              ) : null}
              <tr>
                {/* Ruling S3: the checkbox is the "lead" cell -- row 1, column 1 of the phone
                    card, placed there by `.cell-stack-lead` regardless of its DOM position. No
                    column header names a checkbox, so `data-label=""` (ruling S2) rather than
                    reprinting something like "Select". */}
                <td data-label="" className="cell-stack-lead">
                  <input
                    type="checkbox"
                    checked={selected.includes(row.id)}
                    onChange={() => toggle(row.id)}
                    aria-label={`Select transaction ${row.id}`}
                    className="accent-accent"
                  />
                </td>
                {/* NOT `cell-stack-hide`: unlike the account name below, a date is not identical
                    down the page and is the thing a person scans for first when hunting a charge,
                    so it stays visible on the phone card too -- `cell-stack-meta` (v1.16.0 Lane C
                    item 3) puts it on its own small muted line under the merchant instead of its
                    own labelled row, which is what it actually is: context for the headline, not
                    a second fact of equal weight. */}
                <td className="tabnum whitespace-nowrap text-muted cell-stack-meta" data-label="Date">{row.date}</td>
                {/* Wraps rather than clips, and keeps the title as a courtesy for a very long
                    name. An ellipsis here relied on hover to recover the value, which a phone
                    does not have. v1.16.0 Lane C item 3: this used to be `cell-stack-hide`,
                    dropping it from the phone card entirely on the reasoning that an account name
                    repeats identically down the column and is already the Account filter above --
                    but the owner asked for it back, so it now reads as `cell-stack-meta` context
                    under the merchant instead of vanishing outright. */}
                <td className="text-muted cell-stack-meta" title={row.accountName} data-label="Account">{row.accountName}</td>
                <td className="cell-stack-headline" data-label="Description">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {/* Renaming happens from the row menu now. The title stays: it is the only
                        place the bank's own text is visible once a row has been renamed. */}
                    <span
                      className="font-medium text-ink"
                      title={row.displayDescription ? `Bank text: ${row.rawDescription}` : undefined}
                    >
                      {row.displayDescription ?? row.rawDescription}
                    </span>
                    {/* v1.26.0 Lane 1 item 4: the `?bank=1` table-level toggle (this file's own
                        `bankTextOn`, see its doc comment) -- reveals every renamed row's bank
                        text inline, at once, for the "audit fifty rows after an import" workflow
                        a per-row click does not scale to. "Renamed" here is any row carrying a
                        display_source, the same test bankBadgeButton's badges below key off of. */}
                    {bankTextOn && row.displayDescription !== null ? (
                      <span className="text-muted">— {row.rawDescription}</span>
                    ) : null}
                    {noteIndicator(row)}
                    {/* v1.26.0 Lane 1 item 2: the "renamed"/"rule" badges are now buttons -- see
                        bankBadgeButton's own docblock (above noteIndicator's neighbour) for the
                        mechanics and why no new glyph was added instead. */}
                    {row.displaySource === 'manual' ? bankBadgeButton(row, 'renamed') : null}
                    {row.displaySource === 'rename' ? bankBadgeButton(row, 'rule') : null}
                    {row.isTransfer ? <span className="badge badge--slate">transfer</span> : null}
                    {/* v1.26.0 Lane 3a item 3: this replaced the amber `guess` badge that used to
                        be on this line -- see sourceBadge's own docblock for why one quiet badge
                        covering all four sources beats one loud badge covering one of them. */}
                    {sourceBadge(row)}
                    {/* Backlog CA: one badge per loan link, naming the loan. v1.26.0 Lane 1: the
                        SAME badge becomes the bank-text control when it is also what set this
                        row's display name (display_source = 'loan') -- see bankBadgeButton's own
                        docblock for why reusing this existing badge, rather than adding a fourth
                        text badge, is the "no new glyph" answer for the one display_source with
                        no badge of its own already. */}
                    {(loanLinks[row.id] ?? []).map((link) =>
                      row.displaySource === 'loan' ? (
                        bankBadgeButton(row, link.itemName, `loan-badge-${link.id}`)
                      ) : (
                        <span key={`loan-badge-${link.id}`} className="badge badge--blue">{link.itemName}</span>
                      ),
                    )}
                  </span>
                </td>
                <AmountCell className="whitespace-nowrap cell-stack-amount" data-label="Amount">
                  <Money cents={row.amountCents} />
                </AmountCell>
                <td data-label="Category">
                  {/* v1.7.0 Task 4: a split transaction has no ONE category -- its money is
                      divided across its parts -- so it shows a badge instead of a control.
                      Editing the parts happens through Split… in the row menu. */}
                  {(splits[row.id] ?? []).length > 0 ? (
                    <span className="badge badge--blue">{`Split · ${(splits[row.id] ?? []).length} parts`}</span>
                  ) : (
                    <AutoSaveSelect
                      name="categoryId"
                      defaultValue={row.categoryId === null ? '' : String(row.categoryId)}
                      /* Live categories grouped under their parent (backlog BZ), then the
                         ARCHIVED ones flat and disabled. That coverage is deliberate: a row whose
                         category was archived after the fact must still have a real <option>, or
                         the browser silently selects "Uncategorized" -- and with auto-save a
                         stray change would then clear (and untrain) a legitimate historical
                         categorization. */
                      options={[
                        { value: '', label: 'Uncategorized' },
                        ...categorySelectOptions,
                        ...categories
                          .filter((c) => c.isArchived)
                          .map((c) => ({ value: String(c.id), label: `${label(c.id)} (archived)`, disabled: true })),
                      ]}
                      fields={{ transactionId: String(row.id) }}
                      action={saveCategory}
                      ariaLabel={`Category for transaction ${row.id}`}
                    />
                  )}
                </td>
                <td data-label="Person">
                  {selfScoped ? (
                    // Item BO: plain text, not nothing -- the column keeps its width and the row
                    // keeps its meaning. The <AutoSaveSelect below stays in this file on purpose:
                    // it is a conditional render, and tests/ops/row-controls.test.ts counts the
                    // token.
                    <span className="text-muted">{row.attributedUserName ?? 'Household'}</span>
                  ) : (
                    <AutoSaveSelect
                      name="attributedUserId"
                      defaultValue={row.attributedUserId === null ? '' : String(row.attributedUserId)}
                      options={[
                        { value: '', label: 'Household' },
                        ...people.map((person) => ({ value: String(person.id), label: person.name })),
                      ]}
                      fields={{ ids: String(row.id) }}
                      action={saveAttribution}
                      ariaLabel={`Person for transaction ${row.id}`}
                    />
                  )}
                </td>
                {/* One menu instead of a link, a button and a select-with-button. The label
                    names the ROW, not the column: "Actions" repeated identically down a table
                    tells a screen reader nothing about which row it is on.
                    v1.13.1 (item M): the description alone was not enough either -- two identical
                    coffee-shop charges on one statement produced two buttons with the same name
                    and nothing else to tell them apart. Date AND amount, because the named
                    collision case is usually same-merchant AND same-date.
                    MUST-11.1/11.2: a purchase can carry a warranty, a transfer cannot.
                    MUST-11.3: the URL carries ONLY the id; the add page derives the rest.
                    MUST-14.8: a transfer never carries a loan control. MUST-14.10 stays
                    reachable because assign items are always offered alongside existing links,
                    never replaced by them. */}
                {/* The shared `rowMenu()` above -- byte-identical to what this cell used to
                    render inline, plus the transfer toggle (ruling R4) every row gets now.
                    `cell-stack-actions`: no label, hard right, same as the checkbox's
                    `cell-stack-lead` at the other end of the phone card's row 1. */}
                <td className="text-right cell-stack-actions" data-label="">{rowMenu(row)}</td>
              </tr>
              {/* Unify-the-editors task (2026-08-30): rename/note/assign-to-loan/apply-to-all used
                  to each render a SECOND time here, as their own `<tr><td colSpan>` sub-row --
                  the "Fix round (item CB)" this comment replaces exists in git history along with
                  the dead-editor bug that duplication caused whenever a control existed on only
                  one of the table/card branches. All four are dialogs now (renameDialog() and
                  friends, rendered once at the top of this component's return, alongside the
                  split dialog) -- there is nothing left to render per row here. */}
              </Fragment>
              );
            })}
          </tbody>
        </TableWrap>
        {/* No "Nothing matches these filters" check here any more -- that empty state is now
            hoisted above this whole card/table split (shared, not duplicated across two hidden
            trees), and this branch only ever renders once page.rows.length > 0 already. */}
        <CardFooter>{pageFooterWords(page)}</CardFooter>
      </Card>
      </div>
      </>
      )}
      </ReviewWidth>
    </div>
  );
}
