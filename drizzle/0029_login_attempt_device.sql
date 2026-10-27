-- v1.58.1. Sign-in lockout buckets for browsers that have signed in before.
--
-- A browser that completed a sign-in as a user carries a signed known-device cookie; failures from it
-- are counted against that device id instead of the username-wide bucket. Nullable: NULL means the
-- browser was not recognised, which is every row written before this migration.
alter table login_attempts add column device_id text;
--> statement-breakpoint
create index login_attempts_device_idx on login_attempts (username, device_id, created_at);
