-- v1.64.1. A sign-in index and the allowed roles.
--
-- Hand-maintained like every migration since 0000 (see 0013's header): the journal entry and the
-- src/db/schema.ts mirror travel with this file, and the statement separator never appears inside
-- a comment. No foreign-key pragma here; openDatabase() handles that around the whole pass.
--
-- login_attempts_created_idx serves the two reads keyed on created_at alone: the household-wide
-- count of failed sign-ins from unrecognised browsers (src/lib/auth/ratelimit.ts) and the nightly
-- purge of old attempts.
--
-- users.role has no CHECK, and SQLite cannot add one without rebuilding the table, so two triggers
-- refuse an insert, or an update of role, that sets anything other than admin or member. Rows
-- already stored are not touched.
CREATE INDEX `login_attempts_created_idx` ON `login_attempts` (`created_at`);
--> statement-breakpoint
CREATE TRIGGER `users_role_allowed_insert` BEFORE INSERT ON `users`
WHEN new.`role` NOT IN ('admin', 'member')
BEGIN
	SELECT RAISE(ABORT, 'users.role must be admin or member');
END;
--> statement-breakpoint
CREATE TRIGGER `users_role_allowed_update` BEFORE UPDATE OF `role` ON `users`
WHEN new.`role` NOT IN ('admin', 'member')
BEGIN
	SELECT RAISE(ABORT, 'users.role must be admin or member');
END;
