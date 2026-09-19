-- A statement typed with the wrong year could not be undone.
--
-- The effective anchor is the newest by as_of_date, loan_anchors is append-only, and nothing in the
-- app deletes from it. So a statement dated 2027 instead of 2026 zeroed every payment through the
-- wall, broke the debt chart, and could not be corrected by entering the right one -- the right one
-- is older, so it never wins. The only route back was direct SQL.
--
-- A retracted row keeps the record (this app never forgets what a person entered) and stops
-- governing the balance. Both newest-anchor reads filter on it.
alter table loan_anchors add column retracted_at text;
--> statement-breakpoint
-- alreadyAnnounced() reads every outbox row for an event to rebuild what has been said. Covering,
-- so the scan never touches the row pages holding the message bodies. Measured 704us -> 466us at
-- six thousand rows.
create index notification_outbox_event_idx on notification_outbox (event_id, dedup_key);
--> statement-breakpoint
-- rolloverStartMonth runs once per category inside budgetProgress, which the dashboard calls two or
-- three times. The expression-unique index from 0009 cannot serve the coalesce(user_id, -1) shape
-- the ORM emits, so this was a full scan per category.
create index budget_rollover_scope_idx on budget_rollover (scope, user_id, category_id);
--> statement-breakpoint
-- ruleLinkedPayments runs on every dashboard load and had no index at all.
create index loan_payments_source_idx on loan_payments (source, created_at);
--> statement-breakpoint
-- The sweep and the loan notifiers both ask "which loans have a basis". Partial, because almost no
-- item is a loan with a rate.
create index warranty_items_basis_idx on warranty_items (interest_rate_basis) where interest_rate_basis is not null;
--> statement-breakpoint
-- An adjustment used to carry the day it was DISCOVERED as its period, and the anchor wall filtered
-- on period_end -- so a correction survived a statement dated before it and was counted twice on
-- top of that statement. The wall now selects by period_start, which names the period a row
-- BELONGS to, so each existing adjustment takes the start of the newest posting it was written
-- against.
--
-- Approximate, and deliberately so: v1.48.0 was live for hours rather than months, and the
-- alternative (guessing from the note text) would be worse. A household that sees a correction sit
-- oddly can withdraw the statement and re-enter it.
update loan_postings set period_start = coalesce(
  (select max(p.period_start)
     from loan_postings p
    where p.item_id = loan_postings.item_id
      and p.kind = 'posting'
      and p.period_end <= loan_postings.period_end),
  period_start)
where kind = 'adjustment';
