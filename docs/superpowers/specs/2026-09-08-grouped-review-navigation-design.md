# Grouped review view: navigation and inline preview

Date: 2026-09-08
Status: approved, implementing
Supersedes nothing. Extends the v1.26.0 Lane 3a grouped view, which shipped with no spec of its own —
this document is also the standing reference for how that view works, so a later session does not have
to re-read `transactions-client.tsx` (3,300 lines) to answer a question about it.

## 1. The screen

`/transactions?group=category` renders one row per category cluster instead of one row per
transaction. It exists to answer "what did the rules just do to that import" as a handful of clusters
somebody can scan, instead of 300 rows nobody will read. Its usual entry point is the import
summary's audit link, `?import=<id>&source=rule&group=category`.

## 2. Where the parts live

| Concern | Location |
| --- | --- |
| Cluster aggregate | `groupTransactionsByCategory` in `src/lib/transactions.ts` |
| Cluster types | `CategoryGroupRow`, `CategoryGroupPage` in `src/lib/transactions.ts` |
| View selection | `readGroupMode` / `readGroupPage` in `src/app/(app)/transactions/filter-params.ts` |
| Server wiring | `src/app/(app)/transactions/page.tsx` — `groups` prop is `null` unless `?group=category` |
| Rendering | `groupList` in `src/app/(app)/transactions/transactions-client.tsx` |
| Drill-down link | `groupDrillHref` in the same file |
| Every filter-preserving href | `filterHref` in the same file |
| Fold-below-`sm` helper | `rowVisibility` in the same file |
| Tests | `tests/app/transactions-client.test.tsx` (`renderGrouped` helper), `tests/lib/transactions.test.ts` |

## 3. Invariants that already hold, and must keep holding

1. **One `buildWhere`.** `groupTransactionsByCategory` and `listTransactions` share the filter
   builder, so the clusters can never describe a different set than the list they link into.
2. **Split-aware.** `EFFECTIVE_CATEGORY` / `EFFECTIVE_AMOUNT` over a `LEFT JOIN transaction_splits`.
   A split contributes each part to that part's own category at that part's own amount.
3. **`count` is `count(distinct transactions.id)`**, never `count(*)` — two split parts in one
   category are one transaction, not two.
4. **Pagination is by GROUP.** `?gpage=`, never `?page=`. `filter.page`/`filter.pageSize` are ignored
   by the group query. The footer says "Groups 1–25 of 40", never "Page 1 of 2".
5. **Grouping runs as one query with no `LIMIT`**, sliced in memory. The cluster count is bounded by
   the category tree (tens), so `groupCount` and the whole-set totals are free.
6. **`<details>`, not React state.** The page has no client-side router — every filter is a real
   navigation — so per-group open state in React would be wiped by the group pager. Native
   `<details>` also works on first paint with no JavaScript.
7. **`exact=1` on a parent's drill link is load-bearing.** A cluster keyed by a parent holds only
   money filed *directly* on that parent (which is why the label reads `<name> — not in a
   sub-category`). Without `exact` the link would land on a longer list than the header counted.

## 4. The defect this change fixes

The drill-down was a one-way door. There was no path back to the grouped view at any width.

1. `groupDrillHref` set `category=<id>&exact=1` and **deleted** `group`.
2. On the landed page `activeGroupView === ''`, so the View pill row is `hidden sm:flex` — invisible
   on a phone unless the filter drawer is opened.
3. Desktop was no better: the "Grouped by category" pill restores `group` but **keeps**
   `category=<id>&exact=1`, so it returns a grouped view of exactly one cluster, not the batch.
4. The category chip "All" clears `category` but never restores `group`.

Only the browser's own back button worked. Secondary complaint, same screen: the disclosure triangle
reveals three action *buttons*, not the cluster's rows, which is not what a triangle promises.

## 5. The design

### 5.1 A return path — `via=groups`

`groupDrillHref` additionally sets `via=groups`. `via` is **navigation provenance, not a filter**:

- It is not read by `readFilter` and never reaches `buildWhere`.
- It is **excluded** from the active-filter count behind the funnel badge. Counting it would make the
  badge claim a filter that filters nothing.
- It is preserved by the account form's hidden inputs, next to the existing hidden `group` input, for
  the same reason that one exists: a form post that silently drops it would strand the person again.

When the client sees `via=groups` and is **not** in grouped mode, it renders a breadcrumb directly
above the list:

```
← All categories   ·   Shopping — not in a sub-category
```

The link clears `category`, `exact` and `via`, and sets `group=category`, built through `filterHref`
so every other active filter (`import`, `source`, dates, account, person) survives and both pagers
reset. The trailing label is static text naming where you are — it is not a second link.

**Named `via`, never `from`.** `?from=` is already this page's date-range start (`readFilter`, and the
`range || from || to` clause in the active-filter count). The first cut of this change used `from` and
handed the date parser the string `groups` while lighting the funnel badge with a filter nobody could
find. A future param on this page needs checking against `filter-params.ts` before it is named.

**Visible at every width, never folded.** This is the same unconditional exception the import-batch
chip already takes: a person who arrives here did not click a control to get here, so the way out
must not be behind a fold.

### 5.2 Inline preview rows

`CategoryGroupRow` gains `preview: CategoryPreviewRow[]` — the cluster's most recent rows, capped at
5. `CategoryPreviewRow` is `{ id, date, description, amountCents }`, where `description` is
`coalesce(display_description, raw_description)` and `amountCents` is the **effective** amount, so a
split part previews at the part's own amount, matching the subtotal above it.

**One query for the whole page of clusters, not one per cluster.** The preview query runs *after* the
in-memory slice, over only the ≤25 visible clusters, using a window function
(`row_number() over (partition by <effective category> order by date desc, id desc)`) in a subquery
filtered to `rn <= 5`. `better-sqlite3` supports window functions. The uncategorized cluster is
matched by `<effective category> is null`, not by an `in` list, because `in` never matches null.

This answers the original expand-vs-link objection on its own terms: the reason inline rows were
rejected was "N row queries on every render". One windowed query is not N queries. The second
objection — two counts on one screen that can disagree — is answered by wording. Inside a disclosure:

```
▼ Shopping — not in a sub-category          2 transactions   -$274.80
    2026-09-03   COSTCO WHOLESALE #1234              -$212.30
    2026-09-01   WINNERS 0421                         -$62.50
    Showing 2 of 2
    [See all 2 in the list]  [These are all correct]  [Recategorize the group…]
```

The "Showing X of N" line states the relationship explicitly, so the two figures read as one fact
rather than as a contradiction. It is rendered on **every** cluster, including the ones where `X === N`
and it is arguably redundant: a person scanning ten clusters should not have to work out which ones
were truncated by comparing two numbers themselves, and a line that appears only on truncated clusters
is a line whose absence has to be noticed to be read.

The action buttons keep their current copy and position, below the rows.

### 5.3 What is deliberately NOT built

- **Per-group row pagination.** Two pagers on one screen, and rows fetched per open cluster. The
  disclosure previews; "See all N in the list" is still how you read the whole cluster.
- **Lazy fetch on expand.** Needs client fetching on a page with no client router, and the open state
  would not survive the group pager. Server-rendering 5 rows per visible cluster is cheaper than the
  machinery to avoid it.

## 6. Testing

`tests/lib/transactions.test.ts`:
- preview holds at most 5, newest first
- a split transaction previews under each part's category at the part's own amount
- the uncategorized cluster gets its preview (the `is null` branch, not `in`)
- preview honours the same filter as the cluster it sits under
- preview covers only the clusters on the requested `gpage`

`tests/app/transactions-client.test.tsx`:
- a disclosure renders its preview rows and its action buttons
- "Showing X of N" states both figures
- `groupDrillHref` carries `via=groups`
- with `via=groups` and no `group`, the breadcrumb renders; its href sets `group=category` and drops
  `category`, `exact` and `from` while keeping every other filter
- without `via=groups`, no breadcrumb
- the breadcrumb carries no `rowVisibility` fold class
- `from` does not increment the funnel badge's active-filter count
