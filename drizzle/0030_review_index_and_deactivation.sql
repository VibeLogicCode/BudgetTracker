-- v1.60.0. When an account was deactivated, and an index for the review count.
--
-- Deactivating an account used to be a bare is_active flag, so net worth over time dropped the
-- account from every month, past ones included: one click rewrote the household's history. The
-- date it stopped counting is what lets the months before it keep the account. Nullable: NULL on
-- every active account, and setAccountActive (src/lib/accounts.ts) stamps it on deactivation and
-- clears it on reactivation.
alter table accounts add column deactivated_at text;
--> statement-breakpoint
-- Accounts already inactive never recorded the day, so they take the day after their last
-- activity: the latest of their newest balance snapshot, their newest transaction and the day the
-- account was created. Multi-argument max() is NULL when any argument is, hence the '' stand-ins
-- for an account with no snapshots or no transactions (every date sorts after '').
-- Nothing ever recorded the deactivation itself: setAccountActive wrote no audit_log entry, so
-- there is no better day to read. A linked account kept syncing while inactive until v1.60.0 (the
-- sync now skips it), so its synced rows count as activity here: no row says which of them came
-- after the click. The day this gives can be after today; net worth caps it at today
-- (countsInMonthEnding, src/lib/networth.ts), so it never counts an inactive account in the
-- month still running.
update accounts set deactivated_at = date(max(
    coalesce((select max(s.date) from account_balance_snapshots s where s.account_id = accounts.id), ''),
    coalesce((select max(t.date) from transactions t where t.account_id = accounts.id), ''),
    substr(created_at, 1, 10)
  ), '+1 day')
where is_active = 0 and deactivated_at is null;
--> statement-breakpoint
-- The app layout counts the review queue (REVIEW_WHERE, src/lib/categorize/engine.ts) on every
-- page, and nothing indexed it, so each navigation scanned every transaction. Partial, so it holds
-- only the rows the queue can contain. REVIEW_WHERE states these same terms as literal SQL, so
-- the planner matches the index on the first plan rather than re-planning once values are bound.
create index transactions_review_idx on transactions (date) where is_transfer = 0 and (category_id is null or categorization_source = 'bayes');
