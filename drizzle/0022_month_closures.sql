-- 2026-09-08. Which months the household has declared complete, so last month's summary can wait
-- for last month's data instead of firing on a calendar date and reporting a partial month.
--
-- Owner report: "what happens if 1 of the accounts doesnt have any entry for 15 days in next month
-- and there is nothing to import ... because we have simplefin too transactions can auto come in
-- too using logic we have now is not reliable."
--
-- That is why this is a RECORDED FACT rather than an inference. A quiet savings account has nothing
-- to import, so no import-timing rule can tell "the data is complete" from "there was nothing to
-- fetch". Only a person knows whether their export ran to the present. SimpleFIN-linked accounts
-- are the one exception -- a successful sync IS a reliable statement about currency -- and a
-- household with only linked accounts never has to press anything (closed_by is null there).
create table month_closures (
  -- 'YYYY-MM'. The month being declared complete, not the month it was declared in.
  month text primary key not null,
  -- Who said so. NULL means the app closed it automatically because every account is SimpleFIN
  -- linked and synced past the month end -- the same "no person was involved" convention
  -- notification_outbox.user_id already uses for the family channel.
  closed_by integer references users(id),
  closed_at text not null,
  -- Whether the monthly summary for this month has been enqueued yet. Separate from the closure
  -- itself: closing is the household's statement, sending is the app's job, and a send that fails
  -- must not un-close the month.
  summary_sent_at text
);
