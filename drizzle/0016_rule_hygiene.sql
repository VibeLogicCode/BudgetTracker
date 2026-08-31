-- WARNING: this migration is hand-maintained, not drizzle-kit-generated.
-- Read the header of drizzle/0000_init.sql and the docblock in drizzle.config.ts before
-- adding another one: there is no 0000_snapshot.json, so `drizzle-kit generate` would
-- diff against an empty baseline and re-emit the whole schema. Hand-author the SQL,
-- append the matching entry to drizzle/meta/_journal.json, and mirror the tables in
-- src/db/schema.ts -- in that order.
--
-- NOTE ON SEPARATORS: drizzle's migrator splits this file on the breakpoint marker written
-- between each statement below, and on nothing else, and it does NOT skip comments. That
-- marker must therefore never appear inside a comment -- including this one, which is why
-- it is described here rather than quoted -- or the file is shredded into fragments that
-- will not parse.
--
-- Merchant rule hygiene (v1.21.0 backlog items 9 and 11).
--
-- THE FOREIGN-KEY PRAGMA IS NOT IN THIS FILE, ON PURPOSE -- see 0011's header. src/db/client.ts's
-- openDatabase() disables foreign keys around the whole migration pass and re-enables them (plus a
-- foreign_key_check) immediately after. Do not put a pragma here.
--
-- ============================================================================================
-- PART 1 -- item 11: disable, not delete. One nullable column, ADDITIVE ONLY.
-- ============================================================================================
ALTER TABLE `merchant_rules` ADD `disabled_at` text;
--> statement-breakpoint
-- The audit table PART 2 below writes into, created before anything is inserted into it.
-- NOT represented here -- SQL only:
--   - CHECK (dropped_match_type IN ('exact', 'contains'))
--   - CHECK (dropped_rule_kind IN ('category', 'transfer', 'rename', 'not_transfer'))
CREATE TABLE `merchant_rule_merges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kept_rule_id` integer NOT NULL REFERENCES `merchant_rules`(`id`),
	`dropped_pattern` text NOT NULL,
	`dropped_match_type` text NOT NULL CHECK (`dropped_match_type` IN ('exact', 'contains')),
	`dropped_rule_kind` text NOT NULL CHECK (`dropped_rule_kind` IN ('category', 'transfer', 'rename', 'not_transfer')),
	`dropped_hit_count` integer NOT NULL,
	`dropped_created_at` text NOT NULL,
	`merged_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `merchant_rule_merges_kept_idx` ON `merchant_rule_merges` (`kept_rule_id`);
--> statement-breakpoint
-- ============================================================================================
-- PART 2 -- item 9: normalized_merchant is always uppercase (normalizeMerchant() calls
-- .toUpperCase()); matchRule compares patterns with no case folding on either side; the save
-- path only ever trimmed. A rule saved as `walmart` was therefore accepted, listed, and dead
-- forever, with no error and no hit count to reveal it. Decision: uppercase the pattern on SAVE
-- (src/lib/categorize/rules.ts's upsertRuleFromCorrection now does this for every future write) --
-- this migration is the one-time catch-up for every row already sitting in the table.
--
-- THE HARD PART: uppercasing can collide. If a household already has both `walmart` and
-- `WALMART` as separate rows of the same match_type and rule_kind, uppercasing either one in
-- place would make merchant_rules_pattern_uq reject the write outright -- a naive
-- `UPDATE merchant_rules SET pattern = upper(pattern)` fails partway through the very first
-- household that needs it. So this MERGES every colliding group instead of touching each row in
-- isolation:
--
--   1. Group the table by (upper(pattern), match_type, rule_kind) -- the exact shape
--      merchant_rules_pattern_uq enforces, upper-cased. A group of size 1 has nothing to merge.
--   2. For every group of size > 1, pick ONE survivor: the row with the HIGHEST hit_count (the
--      strongest evidence this is the rule actually in use), tie-broken by the LOWEST id (the
--      one created first among equals) -- deterministic, and never the row a person is least
--      likely to recognise.
--   3. The survivor keeps its own category_id / rename_to / created_by / last_modified_by /
--      last_used_at untouched (whichever of the colliding rows "wins" also carries the more
--      credible metadata), but its hit_count becomes the MAX across the whole group and its
--      created_at becomes the MIN (the EARLIEST) across the whole group -- carrying forward
--      the strongest usage evidence and the true origin date even when neither belonged to the
--      row that happened to win survivor selection.
--   4. Every OTHER row in the group is recorded in merchant_rule_merges (dropped_pattern exactly
--      as it was stored, plus its own hit_count/created_at/match_type/rule_kind) and then
--      deleted -- so a household that had 109 rules and now has fewer can see exactly what
--      happened to each one, rather than just noticing a smaller number.
--   5. Finally, every remaining row (every row that was never part of a collision) is
--      uppercased in place -- safe by construction, since a group of size 1 cannot collide with
--      anything else after uppercasing (if it could, GROUP BY would already have put it in a
--      bigger group in step 1).
--
-- Cost at today's scale (this household: 109 rules) is trivial; the whole point of doing this
-- now is that merging is cheaper at 109 rows than it will ever be again.
--
-- A TEMP TABLE, not a view: it needs to be queried three times below (record the merge, delete
-- the losers, update the survivor) and must see a CONSISTENT snapshot of "who collides with
-- whom" across all three -- a view would recompute live and could disagree with itself if any
-- of the three statements had already mutated the rows it depends on. TEMP because none of this
-- needs to survive past this migration's own transaction; it is dropped at the end of this file.
CREATE TEMP TABLE `_rule_merge_group` AS
SELECT
	upper(`pattern`) AS `up_pattern`,
	`match_type`,
	`rule_kind`,
	(
		SELECT `id` FROM `merchant_rules` AS `m2`
		WHERE upper(`m2`.`pattern`) = upper(`m1`.`pattern`) AND `m2`.`match_type` = `m1`.`match_type` AND `m2`.`rule_kind` = `m1`.`rule_kind`
		ORDER BY `hit_count` DESC, `created_at` ASC, `id` ASC
		LIMIT 1
	) AS `survivor_id`,
	(
		SELECT max(`hit_count`) FROM `merchant_rules` AS `m2`
		WHERE upper(`m2`.`pattern`) = upper(`m1`.`pattern`) AND `m2`.`match_type` = `m1`.`match_type` AND `m2`.`rule_kind` = `m1`.`rule_kind`
	) AS `merged_hit_count`,
	(
		SELECT min(`created_at`) FROM `merchant_rules` AS `m2`
		WHERE upper(`m2`.`pattern`) = upper(`m1`.`pattern`) AND `m2`.`match_type` = `m1`.`match_type` AND `m2`.`rule_kind` = `m1`.`rule_kind`
	) AS `merged_created_at`
FROM `merchant_rules` AS `m1`
GROUP BY upper(`pattern`), `match_type`, `rule_kind`
HAVING count(*) > 1;
--> statement-breakpoint
-- Record every row this migration is about to remove, BEFORE removing it, naming which
-- survivor absorbed it -- the auditable trail item 9 asks for.
INSERT INTO `merchant_rule_merges` (`kept_rule_id`, `dropped_pattern`, `dropped_match_type`, `dropped_rule_kind`, `dropped_hit_count`, `dropped_created_at`, `merged_at`)
SELECT `g`.`survivor_id`, `m`.`pattern`, `m`.`match_type`, `m`.`rule_kind`, `m`.`hit_count`, `m`.`created_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `merchant_rules` AS `m`
JOIN `_rule_merge_group` AS `g`
	ON upper(`m`.`pattern`) = `g`.`up_pattern` AND `m`.`match_type` = `g`.`match_type` AND `m`.`rule_kind` = `g`.`rule_kind`
WHERE `m`.`id` <> `g`.`survivor_id`;
--> statement-breakpoint
DELETE FROM `merchant_rules`
WHERE `id` IN (
	SELECT `m`.`id` FROM `merchant_rules` AS `m`
	JOIN `_rule_merge_group` AS `g`
		ON upper(`m`.`pattern`) = `g`.`up_pattern` AND `m`.`match_type` = `g`.`match_type` AND `m`.`rule_kind` = `g`.`rule_kind`
	WHERE `m`.`id` <> `g`.`survivor_id`
);
--> statement-breakpoint
-- The survivor's own pattern is uppercased here too (not left for the catch-all UPDATE below):
-- this WHERE clause is keyed off `_rule_merge_group`, which was computed once, before any of
-- these statements ran, so it stays correct even though the losing rows referenced in it no
-- longer exist by this point.
UPDATE `merchant_rules`
SET
	`pattern` = upper(`pattern`),
	`hit_count` = (SELECT `merged_hit_count` FROM `_rule_merge_group` AS `g` WHERE `g`.`survivor_id` = `merchant_rules`.`id`),
	`created_at` = (SELECT `merged_created_at` FROM `_rule_merge_group` AS `g` WHERE `g`.`survivor_id` = `merchant_rules`.`id`)
WHERE `id` IN (SELECT `survivor_id` FROM `_rule_merge_group`);
--> statement-breakpoint
-- Every row that was never part of a collision: safe to uppercase in place, because a group of
-- size 1 in step 1 above cannot, by construction, collide with anything else after uppercasing.
UPDATE `merchant_rules`
SET `pattern` = upper(`pattern`)
WHERE `id` NOT IN (SELECT `survivor_id` FROM `_rule_merge_group`)
	AND `pattern` <> upper(`pattern`);
--> statement-breakpoint
DROP TABLE `_rule_merge_group`;
