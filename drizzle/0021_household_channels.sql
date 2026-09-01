-- v1.28.0: household notification channels. One family Telegram and one family email for the
-- whole household, alongside everybody's personal ones.
--
-- THE DEFECT. notification_targets_user_channel_uq (0006) is (user_id, channel), so a person gets
-- exactly one Telegram and one email and there is nowhere to put a shared one. The household
-- reported it as "once i set my own channel i cannot add another channel for joint notifcations":
-- their bot posts into a group chat both partners are in, and the only way to reach that chat was
-- to point a PERSONAL target at it. Do that for both people and the group receives two of every
-- message, because enqueue() fans out per user (MUST-7.1) and each row is a separate delivery.
--
-- THE SHAPE. A scope column splits the table in two, and a PARTIAL unique index -- SQLite has
-- supported those since 3.8.0, and better-sqlite3 ships far newer -- makes a second household row
-- per channel impossible rather than merely discouraged:
--
--     CREATE UNIQUE INDEX ... ON notification_targets (channel) WHERE scope = 'household'
--
-- The old (user_id, channel) index stays and still governs personal rows. The two compose: a
-- household row carries user_id NULL, and SQLite treats NULLs as DISTINCT inside a unique index,
-- so (user_id, channel) alone would happily admit five household Telegrams. The partial index is
-- what actually enforces "exactly one", and it is the only thing that does.
--
-- WHY A HOUSEHOLD ROW HAS user_id NULL, AND WHAT REPLACES IT. user_id was NOT NULL REFERENCES
-- users(id) ON DELETE CASCADE. Left that way, the family channel would belong to whichever admin
-- typed it in, and deleting that admin would delete the household's shared Telegram along with
-- them -- a channel the OTHER member still depends on, vanishing because somebody else's account
-- was removed. Relaxing the FK to ON DELETE SET NULL instead is worse: the action is per column,
-- not per row, so every PERSONAL target would also survive its owner, as an orphan whose NULL
-- user_id is then indistinguishable from a household row.
--
-- So ownership is split from authorship:
--   * user_id      -- NULL for a household row, NOT NULL for a personal one, enforced by a CHECK
--                     against scope. Personal rows keep ON DELETE CASCADE, unchanged.
--   * created_by_user_id -- who set the family channel up, ON DELETE SET NULL. An audit trail
--                     that degrades to "we no longer know" instead of taking the channel with it.
-- Deleting the admin who created the family Telegram therefore nulls one audit column and leaves
-- the channel working. That is the behaviour the household needs and the reason for the rebuild:
-- SQLite cannot ALTER a column's NOT NULL, so the table is rebuilt in the 12-step shape 0011
-- already established here (foreign_keys is OFF for the whole migration pass -- see the docblock
-- in src/db/client.ts for why that is set there and cannot be set from inside this file).
--
-- EVERY EXISTING CHECK IS CARRIED OVER VERBATIM, in particular the channel/secret pairing rule: a
-- telegram row MUST carry a secret_encrypted and an email row MUST NOT. It applies to household
-- rows identically -- the family channel needs its own bot token, encrypted under the same
-- HKDF info 'notify-telegram-v1' (MUST-3.5/5.1), and is never handed the personal one.
--
-- THE OUTBOX. A household send is one row addressed to nobody, so notification_outbox.user_id is
-- relaxed the same way (NULL = the household channel, personal rows unchanged). That breaks its
-- dedup guard unless the index is rewritten, and the dedup guard IS the mechanism (MUST-3.9):
-- NULLs being distinct means a plain (user_id, channel, dedup_key) index would let the group chat
-- receive one copy per member per tick -- the exact defect this migration exists to fix. The fix
-- is the COALESCE expression index loan_matcher_rules_uq (0007) already uses in this schema for
-- the identical reason, and it is why that index is deliberately NOT mirrored in Drizzle: a
-- weaker index of the same name is worse than none.
--
--     CREATE UNIQUE INDEX notification_outbox_dedup_uq ON notification_outbox
--         (COALESCE(user_id, -1), channel, dedup_key)
--
-- -1 can never collide with a real user id: users.id is INTEGER PRIMARY KEY AUTOINCREMENT and
-- starts at 1.
--
-- ROUTING. notification_household_prefs is per-event, per-channel, admin-set, and DEFAULTS TO
-- ABSENT: nothing seeds it, and an absent row means "not routed", so upgrading changes no
-- delivery. It carries no user_id (the household decides once), no FK on event_id and no CHECK on
-- it -- MUST-3.6's rule, so adding an event stays one append to src/lib/notify/events.ts. Which
-- events may legally appear here is enforced in code against that registry's householdEligible
-- flag, at the write path and again at the send path, because a CHECK cannot see a TypeScript
-- array.
--
-- Objects that exist ONLY in SQL and have NO Drizzle representation, added by this migration:
--   * notification_targets_household_channel_uq's WHERE clause (the partial index)
--   * the scope/user_id pairing CHECK on notification_targets
--   * the COALESCE(user_id, -1) expression inside notification_outbox_dedup_uq
--   * every CHECK on notification_household_prefs, and its WITHOUT ROWID storage class
CREATE TABLE `__new_notification_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer REFERENCES `users`(`id`) ON DELETE CASCADE,
	`scope` text NOT NULL DEFAULT 'personal' CHECK (`scope` IN ('personal', 'household')),
	`created_by_user_id` integer REFERENCES `users`(`id`) ON DELETE SET NULL,
	`channel` text NOT NULL CHECK (`channel` IN ('telegram', 'email')),
	`destination` text NOT NULL,
	`secret_encrypted` text,
	`enabled` integer NOT NULL DEFAULT 1,
	`verified_at` text,
	`last_error` text,
	`last_error_at` text,
	`last_success_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CHECK (
		(`channel` = 'telegram' AND `secret_encrypted` IS NOT NULL)
		OR (`channel` = 'email' AND `secret_encrypted` IS NULL)
	),
	CHECK (
		(`scope` = 'personal' AND `user_id` IS NOT NULL)
		OR (`scope` = 'household' AND `user_id` IS NULL)
	)
);
--> statement-breakpoint
INSERT INTO `__new_notification_targets` (
	`id`, `user_id`, `scope`, `created_by_user_id`, `channel`, `destination`, `secret_encrypted`,
	`enabled`, `verified_at`, `last_error`, `last_error_at`, `last_success_at`, `created_at`, `updated_at`
)
	SELECT
		`id`, `user_id`, 'personal', `user_id`, `channel`, `destination`, `secret_encrypted`,
		`enabled`, `verified_at`, `last_error`, `last_error_at`, `last_success_at`, `created_at`, `updated_at`
	FROM `notification_targets`;
--> statement-breakpoint
DROP TABLE `notification_targets`;
--> statement-breakpoint
ALTER TABLE `__new_notification_targets` RENAME TO `notification_targets`;
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_targets_user_channel_uq` ON `notification_targets` (`user_id`, `channel`);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_targets_household_channel_uq` ON `notification_targets` (`channel`) WHERE `scope` = 'household';
--> statement-breakpoint
CREATE TABLE `notification_household_prefs` (
	`event_id` text NOT NULL,
	`channel` text NOT NULL CHECK (`channel` IN ('telegram', 'email')),
	`enabled` integer NOT NULL DEFAULT 0 CHECK (`enabled` IN (0, 1)),
	`updated_at` text NOT NULL,
	PRIMARY KEY (`event_id`, `channel`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `__new_notification_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer REFERENCES `users`(`id`) ON DELETE CASCADE,
	`channel` text NOT NULL CHECK (`channel` IN ('telegram', 'email')),
	`event_id` text NOT NULL,
	`dedup_key` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending', 'sent', 'failed')),
	`attempts` integer NOT NULL DEFAULT 0,
	`next_attempt_at` text NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
INSERT INTO `__new_notification_outbox` (
	`id`, `user_id`, `channel`, `event_id`, `dedup_key`, `subject`, `body`, `status`, `attempts`,
	`next_attempt_at`, `last_error`, `created_at`, `sent_at`
)
	SELECT
		`id`, `user_id`, `channel`, `event_id`, `dedup_key`, `subject`, `body`, `status`, `attempts`,
		`next_attempt_at`, `last_error`, `created_at`, `sent_at`
	FROM `notification_outbox`;
--> statement-breakpoint
DROP TABLE `notification_outbox`;
--> statement-breakpoint
ALTER TABLE `__new_notification_outbox` RENAME TO `notification_outbox`;
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_outbox_dedup_uq` ON `notification_outbox` (COALESCE(`user_id`, -1), `channel`, `dedup_key`);
--> statement-breakpoint
CREATE INDEX `notification_outbox_due_idx` ON `notification_outbox` (`status`, `next_attempt_at`);
--> statement-breakpoint
CREATE INDEX `notification_outbox_user_idx` ON `notification_outbox` (`user_id`, `id`);
