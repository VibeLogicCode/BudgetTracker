-- 2026-09-13. A rule can now be about an AMOUNT as well as a merchant, and can name a PERSON.
--
-- Owner report: "insurance is with same company but different amount but imported categorizes the
-- last setting i do so everything goes to home or auto. can i set in rule vendor + amount rule?"
-- and, separately: "think about person too so its not just on vendor rule, even sets household, or
-- individual person."
--
-- Two policies with one insurer differ only by premium. A rule that matches on merchant text alone
-- cannot tell them apart, so whichever category was saved last claimed every charge from that
-- company. Spec, with the rulings behind every choice here:
-- docs/superpowers/specs/2026-09-13-vendor-amount-person-rules-design.md
--
-- THE RANGE, not an exact amount and not a tolerance. Exact cents stops matching at the first
-- renewal and says nothing about why. A tolerance is a centre plus a percentage whose effective
-- range is hidden from the table -- two numbers that must be recomputed to be read. A range is what
-- a tolerance computes to anyway, stores as two plain integers, and prints honestly on the rules
-- page ("$125.00 - $155.00"). The authoring dialog still asks in tolerance terms and fills these in.
--
-- Both NULL is "this rule is about the merchant, whatever the amount" -- which is every row that
-- exists today, so no stored rule changes behaviour when this runs.
alter table merchant_rules add column amount_min_cents integer;
--> statement-breakpoint
alter table merchant_rules add column amount_max_cents integer;

-- The person a rule assigns a transaction to. NULL on an 'attribution' rule means Household, which
-- is what NULL already means in transactions.attributed_user_id -- there is no third state to
-- confuse it with. ON DELETE SET NULL rather than CASCADE: deleting a person must not silently
-- delete the household's rules, and a rule left pointing at Household is a safe resting state.
--> statement-breakpoint
alter table merchant_rules add column attributed_user_id integer references users(id) on delete set null;
--> statement-breakpoint

-- WHY THE UNIQUE INDEX HAS TO CHANGE, and why coalesce() is load-bearing.
--
-- merchant_rules_pattern_uq was (pattern, match_type, rule_kind). That is exactly what makes two
-- rules for one merchant impossible, which is the whole defect above. The bounds have to join the
-- key.
--
-- They cannot join it as bare columns. SQLite treats NULLs in a UNIQUE index as DISTINCT from each
-- other, so (pattern, match_type, rule_kind, amount_min_cents, amount_max_cents) would happily
-- accept two rows that are both unbounded -- and every upsert in the app uses this index as its
-- conflict target, so the duplicate would not merely exist, it would break the write path that was
-- meant to update the existing row. coalesce(..., -1) maps "unbounded" to a real value, so two
-- unbounded rules collide exactly as they always have. -1 is safe as the sentinel: the bounds are
-- compared against abs(amount_cents) and a negative bound is meaningless, which the CHECK below
-- also enforces.
--
-- SAME NAME on purpose. tests/db/schema.test.ts asserts this index exists by name, and a rename
-- would leave that guard passing against nothing. The drizzle declaration in src/db/schema.ts is
-- REMOVED rather than left as a weaker three-column copy -- the precedent is loan_matcher_rules_uq,
-- whose docblock says it plainly: a weaker index with the same name is worse than none, because a
-- future drizzle-kit push could use it to replace the real one.
drop index if exists `merchant_rules_pattern_uq`;
--> statement-breakpoint
create unique index `merchant_rules_pattern_uq` on `merchant_rules` (
  `pattern`,
  `match_type`,
  `rule_kind`,
  coalesce(`amount_min_cents`, -1),
  coalesce(`amount_max_cents`, -1)
);
--> statement-breakpoint

-- A range whose minimum is above its maximum matches nothing, for ever, silently. It is never what
-- anybody meant, so it is refused at the table rather than left to be discovered months later by a
-- rule whose Affects count drifts to zero. Negative bounds are refused for the same reason: the
-- comparison is against abs(amount_cents), so a negative bound could never match either.
--
-- SQLite cannot ADD a CHECK constraint to an existing table, and rebuilding merchant_rules to get
-- one would mean recreating every index and re-pointing pack_origin_key's semantics for no gain.
-- The same rule is enforced at the one write choke point instead (upsertRuleFromCorrection, which
-- every path goes through), and by this trigger, so a hand-written INSERT cannot get past it either.
create trigger if not exists `merchant_rules_bounds_check_insert`
before insert on `merchant_rules`
when (new.`amount_min_cents` is not null and new.`amount_min_cents` < 0)
  or (new.`amount_max_cents` is not null and new.`amount_max_cents` < 0)
  or (new.`amount_min_cents` is not null and new.`amount_max_cents` is not null
      and new.`amount_min_cents` > new.`amount_max_cents`)
begin
  select raise(abort, 'CHECK constraint failed: merchant_rules amount bounds');
end;
--> statement-breakpoint

create trigger if not exists `merchant_rules_bounds_check_update`
before update on `merchant_rules`
when (new.`amount_min_cents` is not null and new.`amount_min_cents` < 0)
  or (new.`amount_max_cents` is not null and new.`amount_max_cents` < 0)
  or (new.`amount_min_cents` is not null and new.`amount_max_cents` is not null
      and new.`amount_min_cents` > new.`amount_max_cents`)
begin
  select raise(abort, 'CHECK constraint failed: merchant_rules amount bounds');
end;
