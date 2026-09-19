-- Posted interest becomes a stored fact (ledger spec P1).
--
-- Until now interest was derived on every read, which made undo free but left nothing to point at:
-- no record of what was charged when, at which rate, on what balance. A lender posts interest once
-- a cycle and never restates it, and a household checking last August against a statement needs the
-- figure the app believed in August, not a figure recomputed today under a rate that has since
-- changed. So a closed period is written down once and left alone.
--
-- A correction is a SECOND row of kind 'adjustment', dated the day it was discovered (K2), never an
-- update to the first. The partial unique index below is what makes that possible: one posting per
-- period is the invariant, and adjustments sit deliberately outside it because several can land on
-- one day.
create table loan_postings (
  id integer primary key autoincrement,
  item_id integer not null references warranty_items(id) on delete cascade,
  kind text not null check (kind in ('posting', 'adjustment')),

  -- LIKE, not GLOB: GLOB's wildcards are ? and *, and it treats _ as a literal underscore, so a
  -- GLOB of underscores would match nothing at all (0011's lesson, restated by 0025).
  period_start text not null check (period_start like '____-__-__'),
  -- The posting date. For an adjustment, the day the correction was recorded, so both dates are the
  -- same and the row sorts where it belongs on the ledger.
  period_end text not null check (period_end like '____-__-__'),

  opening_cents integer not null,
  -- Signed. A posting is never negative; an adjustment usually is, because a payment discovered
  -- late means the period was charged on too high a balance.
  interest_cents integer not null,
  payments_cents integer not null default 0,
  advances_cents integer not null default 0,
  closing_cents integer not null,

  -- The rate that actually applied to this period, snapshotted for the same reason loan_anchors
  -- snapshots one: editing the rate must change the open period and nothing that is already closed.
  rate_bps integer,
  basis text check (basis is null or basis in
    ('none', 'apr_monthly', 'apr_semiannual', 'per_month', 'simple_on_principal', 'apr_daily')),
  -- What the charge was worked out on. Kept so a figure can be checked by hand against a statement
  -- without re-deriving the whole period: rate, this number and the day count are the whole sum.
  average_daily_balance_cents integer,

  note text,
  created_at text not null,
  -- SET NULL rather than CASCADE, as 0024 and 0025 both chose: deleting a person must not delete
  -- the household's record of what its loans cost.
  created_by_user_id integer references users(id) on delete set null
);
--> statement-breakpoint
create unique index loan_postings_item_period_uq on loan_postings (item_id, period_end) where kind = 'posting';
--> statement-breakpoint
create index loan_postings_item_idx on loan_postings (item_id, period_end, id);
--> statement-breakpoint
-- The rate in force from a date (R1).
--
-- warranty_items keeps holding the CURRENT rate and basis, so every reader written before this
-- migration stays correct and nothing has to be rewritten to find out what a loan charges today.
-- This table exists for the other question -- what did it charge in March -- which a variable-rate
-- mortgage makes a real one, and which one column cannot answer.
create table loan_rate_history (
  id integer primary key autoincrement,
  item_id integer not null references warranty_items(id) on delete cascade,
  effective_from text not null check (effective_from like '____-__-__'),
  rate_bps integer not null,
  basis text not null check (basis in
    ('none', 'apr_monthly', 'apr_semiannual', 'per_month', 'simple_on_principal', 'apr_daily')),
  created_at text not null,
  created_by_user_id integer references users(id) on delete set null
);
--> statement-breakpoint
create index loan_rate_history_item_idx on loan_rate_history (item_id, effective_from, id);
--> statement-breakpoint
-- The day of the month interest posts (C1). NULL means the borrowed date's own day, which is what
-- a loan agreement almost always says, so almost every loan leaves this alone.
alter table warranty_items add column posting_day integer check (posting_day is null or (posting_day between 1 and 31));
--> statement-breakpoint
-- The confirmed CSV column mapping for this loan's statements (S3), as JSON {date, balance, interest}.
-- Remembered per loan because a lender's export keeps its shape month to month, and re-picking the
-- same three columns every statement is the kind of small friction that stops a habit forming.
alter table warranty_items add column statement_csv_columns text;
--> statement-breakpoint
-- One rate-history row per loan that already says how its rate is charged, dated at the newest
-- figure a person confirmed -- or at the borrowed date when there is no anchor at all.
--
-- Loans WITHOUT a basis get nothing, and that is the point: their rate was typed under a promise
-- that nothing would be computed from it, so this migration still assumes nothing about it (D2).
-- No balance moves here either. The postings that bring a loan up to date are written in code, by
-- the first posting sweep after the upgrade (M3) -- a migration cannot run the interest engine.
insert into loan_rate_history (item_id, effective_from, rate_bps, basis, created_at)
select i.id,
       coalesce(
         (select a.as_of_date from loan_anchors a where a.item_id = i.id order by a.as_of_date desc, a.id desc limit 1),
         i.purchase_date
       ),
       i.interest_rate_bps,
       i.interest_rate_basis,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  from warranty_items i
 where i.interest_rate_basis is not null
   and i.interest_rate_bps is not null;
