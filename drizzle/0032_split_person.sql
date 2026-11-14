-- v1.63.0. A split part can belong to a different person than its transaction.
--
-- Hand-maintained like every migration since 0000 (see 0013's header): the journal entry and the
-- src/db/schema.ts mirror travel with this file, and the statement separator never appears inside
-- a comment. No foreign-key pragma here; openDatabase() handles that around the whole pass.
--
-- person_set = 0 means the part follows its transaction: it belongs to whoever the transaction
-- belongs to, now and after any later change of the transaction's person. person_set = 1 means the
-- part belongs to attributed_user_id, where NULL is Household, the meaning NULL already has on
-- transactions.attributed_user_id. Every existing part takes the DEFAULT, so it keeps following
-- its transaction and every figure reads exactly as before: no backfill. EFFECTIVE_PERSON in
-- src/lib/splits.ts is the one place that reads the pair.
ALTER TABLE `transaction_splits` ADD COLUMN `person_set` integer NOT NULL DEFAULT 0 CHECK (`person_set` IN (0, 1));
--> statement-breakpoint
ALTER TABLE `transaction_splits` ADD COLUMN `attributed_user_id` integer REFERENCES `users`(`id`);
--> statement-breakpoint
-- A person's rows include every transaction holding a part set to them (personRowClause's second
-- arm, src/lib/splits.ts). Only set parts carry a person of their own, so only they are indexed.
CREATE INDEX `transaction_splits_person_idx` ON `transaction_splits` (`attributed_user_id`) WHERE `person_set` = 1;
