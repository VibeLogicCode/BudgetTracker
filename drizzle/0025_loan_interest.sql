-- 2026-09-18. Interest on a loan, and a history of the figures a person confirmed.
--
-- The app stored an interest rate and did nothing with it: the form said so in as many words
-- ("Shown for reference only -- this app does no interest math"). This release computes interest,
-- and does it in a way that stays honest about being an estimate. Spec, with the rulings behind
-- every choice here: docs/superpowers/specs/2026-09-18-loan-interest-design.md
--
-- ADDITIVE, AND SILENT ON UPGRADE. One ADD COLUMN, one CREATE TABLE, one seeding INSERT. No table
-- is rebuilt and no existing row is rewritten. The basis column below is NULL for every row that
-- exists, and NULL means "nothing is computed" -- so a household that upgrades and opens a loan
-- sees exactly what it saw before, until a person says how the rate is charged.

-- WHY A BASIS COLUMN AT ALL (ruling I3). interest_rate_bps is a bare number: 549 could be 5.49% a
-- year or 5.49% a month, and the difference is a factor of twelve in either direction. Every rate
-- in the database today was typed under a promise that nothing would be calculated from it, so
-- guessing a period now would silently understate a monthly-quoted rate twelve-fold. The app has
-- to be told, once, per loan.
--
-- SIX VALUES, one per way a household loan is actually charged:
--   none                 interest-free. A positive claim, not an absence -- the screen says "every
--                        payment is principal" and the loan still has a payoff date. NULL says
--                        "we have not been told", which is a different and weaker thing.
--   apr_monthly          a yearly rate, one twelfth charged each month. Most loans.
--   apr_semiannual       compounded twice a year, charged monthly -- the Canadian mortgage
--                        convention, and about 1% a month BELOW rate/12. Folding it into
--                        apr_monthly would overstate a $300,000 mortgage by roughly $156 a year,
--                        which a statement-checker notices immediately.
--   per_month            a rate already quoted per month.
--   simple_on_principal  a yearly rate on the ORIGINAL amount, never compounding -- the family
--                        "5% a year on the $10,000". Modelling it as amortising misstates the
--                        interest by roughly half over two years.
--   apr_daily            accrued daily on the balance, for a line of credit, whose balance moves
--                        several times a month and in both directions.
--
-- The CHECK is forward-only and harmless because the column is new: no existing row can violate it.
-- Cross-column rules (a basis needs a rate unless it is 'none'; simple_on_principal needs a
-- principal; a non-loan item carries none of them) live in src/lib/warranty/items.ts beside the
-- asserts that are already there -- SQLite cannot add a CHECK to an existing table and have it
-- re-validate the rows already in it, which is the argument 0007 made for the same reason.
alter table warranty_items add column interest_rate_basis text
  check (interest_rate_basis is null or interest_rate_basis in
    ('none', 'apr_monthly', 'apr_semiannual', 'per_month', 'simple_on_principal', 'apr_daily'));
--> statement-breakpoint

-- One row per figure a person confirmed about this loan (ruling A1).
--
-- WHY THIS TABLE IS THE WHOLE DESIGN. The app's interest figure will drift from the lender's --
-- different posting days, different rounding, fees, a rate that changed. The remedy is not more
-- accurate arithmetic, it is a way to correct the app from the statement and record what the drift
-- turned out to be. That makes every rate-derived figure "our estimate since your 1 Sep statement"
-- rather than a claim about what the lender charged, and it makes two figures sayable as FACT:
--   * the movement between two consecutive rows beyond the linked payments -- what the lender
--     actually added, fees included;
--   * stated_interest_cents, the interest figure the statement itself printed.
--
-- APPEND-ONLY, and no unique index on (item_id, as_of_date): correcting a statement is a SECOND
-- row, not an edit. Deleting a row would make the log lie about what was seen, which is the same
-- reasoning account_balance_snapshots follows. Ordering is (as_of_date, id) everywhere, the
-- bill_installments convention.
--
-- warranty_items.current_balance_cents / balance_updated_at become a CACHE of the newest row here.
-- They keep working exactly as they do today for every reader that has not been taught about this
-- table.
create table loan_anchors (
  id integer primary key autoincrement,
  item_id integer not null references warranty_items(id) on delete cascade,

  -- The date the figure is true as of: the statement's own date, not the day it was typed. This is
  -- what the old anchor could never say -- balance_updated_at is the TYPING time, so a statement
  -- dated the 1st and entered on the 18th moved the balance as though it were true on the 18th.
  -- LIKE, not GLOB: GLOB's wildcards are ? and *, and it treats _ as a literal underscore, so a
  -- GLOB of underscores would match nothing at all (0011's lesson).
  as_of_date text not null check (as_of_date like '____-__-__'),
  balance_cents integer not null check (balance_cents >= 0),

  -- Which code path wrote the row, never where the NUMBER came from (that is prefilled_from).
  --   migrated     carried over by this migration from the balance set before history existed
  --   form         the item form's balance field, which now only fills a loan's FIRST anchor
  --   first-entry  createLoanFromTransaction, as-of the day before the transaction
  --   reconcile    the Reconcile action -- all three intake routes converge on it
  source text not null check (source in ('migrated', 'form', 'first-entry', 'reconcile')),
  created_at text not null,
  -- SET NULL rather than CASCADE, the same choice 0024 made for attributed_user_id: deleting a
  -- person must not delete the household's record of what its loans were worth.
  created_by_user_id integer references users(id) on delete set null,
  note text,

  -- The rate in force FROM this date, snapshotted so a closed period keeps being estimated with the
  -- rate that actually applied to it (ruling R7). Editing the rate on the item therefore changes
  -- only the open period, and history is never silently rewritten -- which is what a variable-rate
  -- loan needs, and it is why v1 supports one without a second table.
  interest_rate_bps integer,
  interest_rate_basis text check (interest_rate_basis is null or interest_rate_basis in
    ('none', 'apr_monthly', 'apr_semiannual', 'per_month', 'simple_on_principal', 'apr_daily')),

  -- The comparison, computed at write time against the previous row. Signed in the loan's frame.
  payments_between_cents integer,
  -- Our estimate for the period this row closes. NULL when the period opened with no basis set.
  estimated_interest_cents integer,
  -- What the app believed the balance was on as_of_date, before this row corrected it.
  app_balance_cents integer,
  -- balance_cents - app_balance_cents. Arithmetic on two knowns, so a fact.
  difference_cents integer,

  -- THE ONE FIGURE THE APP NEVER HAS TO QUALIFY: the interest the statement itself printed. Summed
  -- across rows it answers "how much interest have I actually paid" with no rate, no convention and
  -- no estimating -- so it is worth its own column even though most rows will not carry one.
  stated_interest_cents integer check (stated_interest_cents is null or stated_interest_cents >= 0),

  -- Provenance, kept apart from `source` on purpose: these three answer "what was proposed, and did
  -- the person have to correct it", which over several statements is what says whether the
  -- extractor can be trusted for this lender. Folding them into `source` would collapse three
  -- separate facts into one.
  prefilled_from text check (prefilled_from is null or prefilled_from in ('pdf', 'csv')),
  prefill_balance_cents integer,
  -- The stored statement, when the person kept it. SET NULL so deleting the file leaves the figure
  -- and its provenance intact -- the row stays truthful without the document.
  receipt_id integer references warranty_receipts(id) on delete set null
);
--> statement-breakpoint

create index loan_anchors_item_idx on loan_anchors (item_id, as_of_date, id);
--> statement-breakpoint

-- THE SEED (ruling A3), and the property it has to hold: NO HOUSEHOLD'S BALANCE MOVES ON UPGRADE.
--
-- Every loan that already has a balance gets one anchor, recovered from what the ledger implies.
-- The stored balance today is "the figure a person typed, minus every payment linked since", so
-- adding those payments back recovers the figure they typed. Replaying the seeded row forward
-- through the same payments therefore reproduces current_balance_cents exactly -- which is the
-- whole point: this migration records what was already true, it does not restate it.
--
-- applied_cents is unsigned and its direction is recovered from the transaction's sign. The inner
-- sum below is the undo delta in the OWED frame -- byte-identical to the aggregation debtOverTime
-- has used since v1.14.0 (ruling P5) -- and the outer sign flip is what that function does in
-- memory with loanSignedDelta. Doing the flip here rather than inventing a second sign convention
-- keeps one rule: a lent loan's undo delta is exactly the negation of an owed loan's.
--
-- max(0, ...) because current_balance_cents has been clamped at zero on an unassign since the
-- NEW-1 fix-round, so a heavily-clamped ledger could imply a negative anchor. The column refuses
-- one, and a negative "balance you confirmed" would be meaningless anyway.
--
-- source = 'migrated' and created_by_user_id = NULL are honest: nobody confirmed this figure
-- against a statement. It is the ledger's own account of itself, and the staleness marker will be
-- asking for a real reconciliation from the day this ships -- which is also what corrects the
-- pre-existing double-subtraction quirk this migration deliberately does not touch.
insert into loan_anchors (
  item_id, as_of_date, balance_cents, source, created_at, created_by_user_id,
  note, interest_rate_bps, interest_rate_basis
)
select
  wi.id,
  substr(wi.balance_updated_at, 1, 10),
  max(0, wi.current_balance_cents
    + (case when wi.loan_direction = 'lent' then -1 else 1 end) * coalesce((
        select sum(case when t.amount_cents < 0 then lp.applied_cents else -lp.applied_cents end)
          from loan_payments lp
          join transactions t on t.id = lp.txn_id
         where lp.item_id = wi.id
           and t.date > substr(wi.balance_updated_at, 1, 10)
      ), 0)),
  'migrated',
  wi.balance_updated_at,
  null,
  'Carried over from the balance set before statement history existed.',
  wi.interest_rate_bps,
  null
from warranty_items wi
where wi.current_balance_cents is not null
  and wi.balance_updated_at is not null;
