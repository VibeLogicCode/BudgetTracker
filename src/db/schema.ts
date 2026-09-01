import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
    totpSecretEncrypted: text('totp_secret_encrypted'),
    totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    /**
     * Mirrors drizzle/0001_add_must_change_password.sql. Declared last because
     * ALTER TABLE ADD COLUMN appends physically. Keep this in the same order as
     * the DDL so the mirror stays readable against `pragma table_info(users)`.
     */
    mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
    /**
     * Mirrors drizzle/0012_totp_last_counter.sql. Declared last for the same reason
     * mustChangePassword is: ALTER TABLE ADD COLUMN appends physically, and this mirror has to
     * stay readable against `pragma table_info(users)`.
     *
     * The highest TOTP time-step counter this user has already spent (item BF / SEC-10). NULL
     * means nothing has been accepted yet -- correct for every pre-0012 row and for anyone who
     * has never enrolled. verifyTotpCounter derives the counter; consumeTotpCounter advances it
     * with a conditional UPDATE, the same single-use shape consumeRecoveryCode uses.
     */
    totpLastCounter: integer('totp_last_counter'),
    /**
     * v1.13.0 ruling R2, added by drizzle/0013_household_scope.sql. 'self' scopes every read this
     * person makes to rows they own. This is a READER boundary, not a role: role still gates actions.
     * Micro-ruling M1: 'self' and role 'admin' are mutually exclusive, enforced in
     * setUserVisibility()/createUserAction rather than as a SQL CHECK, because a cross-column CHECK
     * added by ALTER TABLE ADD COLUMN does not re-validate existing rows.
     */
    visibility: text('visibility', { enum: ['household', 'self'] }).notNull().default('household'),
    /**
     * v1.13.0 ruling R5. false = a person the money is attributed to who has no login: they appear in
     * every attribution picker and never on the login path. attemptLogin refuses them before the
     * password check, and validateSession refuses an existing session.
     */
    canSignIn: integer('can_sign_in', { mode: 'boolean' }).notNull().default(true),
    /**
     * v1.13.0 ruling R7 / micro-ruling M5: the account this person last posted a manual transaction
     * to, so quick-add can default to it. No onDelete clause -- NO ACTION matches imports.account_id
     * and account_card_people.account_id, and accounts are soft-deleted via is_active, never dropped.
     */
    // The return type is spelled out explicitly (AnySQLiteColumn) because this reference and
    // accounts.ownerUserId's reference back to users.id form a genuine cycle: without an
    // annotation here TS has to infer both tables' types from each other simultaneously and
    // fails with "implicitly has type 'any' ... referenced ... in its own initializer" (TS7022).
    lastAccountId: integer('last_account_id').references((): AnySQLiteColumn => accounts.id),
  },
  (t) => [uniqueIndex('users_username_uq').on(t.username)],
);

export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    parentId: integer('parent_id'),
    icon: text('icon'),
    color: text('color'),
    isIncome: integer('is_income', { mode: 'boolean' }).notNull().default(false),
    isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    /**
     * v1.7.0, added by drizzle/0009_finish_line.sql. Declared last because ALTER TABLE ADD
     * COLUMN appends physically -- same convention as users.mustChangePassword,
     * importProfiles.isActive and warrantyItems.typeId, so the mirror stays readable against
     * `pragma table_info(categories)`. Marks a category (parent or child) as relevant for
     * the tax-year report (Task 15); a flagged PARENT rolls its children's spend into the
     * report even when the children themselves are unflagged.
     */
    taxRelevant: integer('tax_relevant', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('categories_parent_idx').on(t.parentId)],
);

export const importProfiles = sqliteTable(
  'import_profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    institution: text('institution').notNull(),
    isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),
    mapping: text('mapping').notNull(),
    createdAt: text('created_at').notNull(),
    /**
     * v1.6.0, added by drizzle/0008_import_attribution.sql. Declared last because ALTER
     * TABLE ADD COLUMN appends physically -- same convention as users.mustChangePassword
     * and warrantyItems.typeId, so the mirror stays readable against
     * `pragma table_info(import_profiles)`. Hides a profile (built-in or custom) from the
     * import picker without deleting it; the managers page still lists it for reactivation.
     */
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [uniqueIndex('import_profiles_name_uq').on(t.name)],
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    institution: text('institution').notNull(),
    /**
     * v1.13.0 ruling R10: five values, up from three. This column has NEVER carried a SQL CHECK --
     * drizzle/0000_init.sql:59 declares it as plain `type` text NOT NULL -- so the enum is a
     * TypeScript-and-zod construct only and widening it needed no migration at all (micro-ruling M2).
     * Do not go looking for the rebuild; there isn't one. 'savings' behaves like 'chequing' but is
     * excluded from safe-to-spend; 'asset' carries a manually-typed balance and takes no transactions
     * and no imports (src/lib/accounts.ts, acceptsTransactions/countsTowardSafeToSpend).
     */
    type: text('type', { enum: ['chequing', 'credit', 'cash', 'savings', 'asset'] }).notNull(),
    ownerUserId: integer('owner_user_id').references(() => users.id),
    importProfileId: integer('import_profile_id').references(() => importProfiles.id),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('accounts_owner_idx').on(t.ownerUserId)],
);

export const imports = sqliteTable(
  'imports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull().references(() => accounts.id),
    profileId: integer('profile_id').references(() => importProfiles.id),
    filename: text('filename').notNull(),
    importedBy: integer('imported_by').notNull().references(() => users.id),
    rowsAdded: integer('rows_added').notNull().default(0),
    rowsDuplicate: integer('rows_duplicate').notNull().default(0),
    rowsError: integer('rows_error').notNull().default(0),
    createdAt: text('created_at').notNull(),
    /**
     * v1.26.0 Lane 2, added by drizzle/0019_import_audit.sql. Declared last because ALTER
     * TABLE ADD COLUMN appends physically -- same convention as importProfiles.isActive and
     * merchantRules.packOriginKey, so the mirror stays readable against
     * `pragma table_info(imports)`.
     *
     * When somebody looked at what the RULES did to this import. NULL means nobody has, which
     * is the state a fresh imports row carries with no write of its own (src/lib/import/flow.ts
     * deliberately sets nothing here -- see its own comment). Read by unreviewedRuleImports()
     * and written by markImportRulesReviewed(), both in src/lib/import/commit.ts.
     *
     * The marker is on the IMPORT, not on the transaction, and the read tests only for NULL.
     * Both calls are argued at length in the migration's own header; the short version is that
     * the thing being dismissed is a batch, that a fresh import must be unreviewed without
     * anybody remembering to write anything, that undoImport deletes this row and therefore
     * this marker along with it, and that transactions.updated_at moves for reasons
     * (bulkSetNotes, bulkSetAttribution, setTransactionSplits) that have nothing to do with
     * categorization, so comparing against it would un-dismiss an import because somebody
     * typed a note.
     */
    rulesReviewedAt: text('rules_reviewed_at'),
  },
  (t) => [index('imports_account_idx').on(t.accountId, t.createdAt)],
);

/**
 * Per-card attribution map (spec 2026-08-22, v1.6.0). Mirrors drizzle/0008_import_attribution.sql.
 * Maps a normalized card/cardholder value -- read from an optional mapping column the
 * import mapping schema may name (Task 2's `cardCol`) -- to the person a joint statement's
 * rows attributed to that value belong to. Created EMPTY by the migration; nothing writes
 * to it before Task 3.
 *
 * No onDelete on either foreign key (NO ACTION, matching the existing convention for direct
 * references to accounts/users -- accounts.ownerUserId, accounts.importProfileId and
 * imports.importedBy all carry none either): this project never hard-deletes a user or an
 * account, both are soft-deleted through their own is_active flag, so no app code path can
 * orphan a row here today. A future hard-delete of either would need to clear referencing
 * account_card_people rows first, the same way deleteProfile() in
 * src/lib/import/presets.ts already clears accounts/imports before deleting an
 * import_profiles row, rather than relying on a cascade that does not exist.
 */
export const accountCardPeople = sqliteTable(
  'account_card_people',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    cardValue: text('card_value').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('account_card_people_uq').on(t.accountId, t.cardValue)],
);

export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull().references(() => accounts.id),
    importId: integer('import_id').references(() => imports.id, { onDelete: 'set null' }),
    attributedUserId: integer('attributed_user_id').references(() => users.id),
    date: text('date').notNull(),
    // raw_description is immutable truth: dedup hashing and the categorizer read
    // only this and normalized_merchant. display_description is presentation only.
    rawDescription: text('raw_description').notNull(),
    displayDescription: text('display_description'),
    // v1.21.0 (item 13): 'loan' added, distinct from 'manual' and 'rename' -- set when a
    // transaction is (un)assigned to a loan (src/lib/loans.ts), so unlinking can tell "the loan
    // link set this" from "a rename rule did" and revert only its own. No CHECK constraint
    // backs this column (confirmed against drizzle/0000_init.sql: `display_source text`, no
    // constraint) -- the enum below is a TypeScript-only annotation, so widening it needs no
    // migration and no table rebuild.
    displaySource: text('display_source', { enum: ['manual', 'rename', 'loan'] }),
    normalizedMerchant: text('normalized_merchant').notNull(),
    // amount_cents is IMMUTABLE after insert -- no writer in src/ ever updates it (a signed
    // magnitude fixed at import/entry time). src/lib/loans.ts's sign-recovery reversal
    // (unassignTransactionFromLoan, reverseLoanLinksForTransactions) and debtOverTime()
    // both re-derive a loan_payments row's direction from THIS column at read time rather
    // than storing it a second time, which is only correct because it never changes.
    // tests/lib/loans/invariants.test.ts asserts by grep that nothing ever writes it again.
    amountCents: integer('amount_cents').notNull(),
    categoryId: integer('category_id').references(() => categories.id),
    categorizationSource: text('categorization_source', {
      enum: ['rule', 'bayes', 'manual', 'none'],
    })
      .notNull()
      .default('none'),
    confidence: real('confidence'),
    isTransfer: integer('is_transfer', { mode: 'boolean' }).notNull().default(false),
    notes: text('notes'),
    dedupHash: text('dedup_hash'),
    hashVersion: integer('hash_version').notNull().default(1),
    /** SimpleFIN provider transaction id (spec section 12). NULL for CSV and manual rows. */
    externalId: text('external_id'),
    createdBy: integer('created_by').notNull().references(() => users.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('transactions_dedup_uq')
      .on(t.accountId, t.dedupHash)
      .where(sql`${t.dedupHash} is not null`),
    uniqueIndex('transactions_external_id_uq')
      .on(t.accountId, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index('transactions_account_date_idx').on(t.accountId, t.date),
    index('transactions_date_idx').on(t.date),
    index('transactions_category_date_idx').on(t.categoryId, t.date),
    index('transactions_attributed_date_idx').on(t.attributedUserId, t.date),
    index('transactions_import_idx').on(t.importId),
    index('transactions_normalized_merchant_idx').on(t.normalizedMerchant),
  ],
);

export const transactionImports = sqliteTable(
  'transaction_imports',
  {
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    importId: integer('import_id')
      .notNull()
      .references(() => imports.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.transactionId, t.importId] }),
    index('transaction_imports_import_idx').on(t.importId),
  ],
);

/**
 * Transaction splits (spec 2026-08-22, v1.7.0, Task 1). Mirrors
 * drizzle/0009_finish_line.sql. Lets one transaction's amount be divided across more than
 * one category; a split's parts always sum exactly to the parent's amountCents, and
 * ownership/attribution stays whole-transaction (a split carries only category, amount and
 * note). transactions.amountCents is immutable after insert (see the comment on that
 * column), so a split ADDS rows here rather than ever rewriting the parent.
 *
 * NOT represented here; SQL only:
 *   - CHECK (amount_cents <> 0)
 *
 * The sum-of-parts == parent amountCents invariant is enforced in the app layer
 * (src/lib/splits.ts, the single writer), not by a CHECK: SQLite cannot express a
 * cross-row sum constraint.
 */
export const transactionSplits = sqliteTable(
  'transaction_splits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    txnId: integer('txn_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id),
    amountCents: integer('amount_cents').notNull(),
    note: text('note'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('transaction_splits_txn_idx').on(t.txnId),
    index('transaction_splits_category_idx').on(t.categoryId),
  ],
);

export const merchantRules = sqliteTable(
  'merchant_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pattern: text('pattern').notNull(),
    /**
     * v1.25.0 (backlog item 16) added 'word' -- whole-token matching, so a short acronym like IGA
     * can stay broad (IGA MARCHE) without the substring collision that made `contains IGA` match
     * MICHIGAN. See the MatchType docblock in src/lib/categorize/rules.ts for the defect and
     * wordBoundaryTokens in src/lib/categorize/normalize.ts for what a boundary is.
     *
     * NO MIGRATION widened this column, and none was needed: drizzle/0000_init.sql declares it as
     * a bare `text NOT NULL` with no CHECK constraint, so the enum here has only ever been a
     * TypeScript-level claim. merchant_rules_pattern_uq below includes match_type, so a 'word'
     * rule is a DISTINCT ROW from a 'contains' rule on the same pattern -- intended: the two say
     * different things and a household may reasonably hold both.
     */
    matchType: text('match_type', { enum: ['exact', 'contains', 'word'] }).notNull(),
    ruleKind: text('rule_kind', { enum: ['category', 'transfer', 'rename', 'not_transfer'] }).notNull().default('category'),
    categoryId: integer('category_id').references(() => categories.id),
    /** Set only on rule_kind = 'rename'; NULL on category and transfer rules. */
    renameTo: text('rename_to'),
    createdBy: integer('created_by').references(() => users.id),
    hitCount: integer('hit_count').notNull().default(0),
    lastUsedAt: text('last_used_at'),
    createdAt: text('created_at').notNull(),
    /**
     * v1.13.0 ruling R4 (item AH / SEC-6). created_by is no longer overwritten on conflict; this
     * records who last changed the rule instead. NULL on every row written before v1.13.0 and on any
     * rule never edited since it was created.
     */
    lastModifiedBy: integer('last_modified_by').references(() => users.id),
    /**
     * v1.21.0 (item 11), added by drizzle/0016_rule_hygiene.sql. Declared last -- same
     * ALTER-TABLE-ADD-COLUMN convention as lastModifiedBy above. NULL means enabled -- every row
     * before v1.21.0, and every row nobody has ever disabled -- the same absence-is-off shape
     * budgetRollover already uses, chosen over a boolean so "when" is recorded for free instead of
     * needing a second column the moment anyone asks. A switch, not history: flipping it back to
     * NULL re-enables the rule outright rather than filing it away, which is the whole difference
     * between "disable" and "delete" (see the docblock on setRuleDisabled, src/lib/categorize/
     * engine.ts) -- "109 disabled typos is no better than 109 live ones" is why delete still
     * exists for a genuine mistake. matchRule (src/lib/categorize/rules.ts) skips any rule carrying
     * a non-NULL value here, so a disabled rule cannot match through any caller that forgets to
     * filter its input list -- the filter lives at the one place every match funnels through.
     */
    disabledAt: text('disabled_at'),
    /**
     * Installable preset packs (backlog item 17), added by drizzle/0017_pack_provenance.sql.
     * All three columns below are NULL together for a rule a person wrote, and set together for
     * one an installed pack wrote -- pack_source is the discriminator every reader checks first
     * (src/lib/categorize/rules.ts's upsertRuleFromCorrection is the one place that writes any of
     * them). See that migration's own header for why pack_version is deliberately NOT the same
     * number as the rules-pack file format version (RulesPack.version / PACK_VERSION in
     * src/lib/packs.ts).
     */
    packSource: text('pack_source'),
    /** The pack's own content version this row was last written by. NULL exactly when packSource is. */
    packVersion: integer('pack_version'),
    /** When this row was last written by the pack (install or a since-applied update). */
    installedAt: text('installed_at'),
    /**
     * v1.25.0 (backlog item 18), added by drizzle/0018_pack_origin_key.sql. Declared last -- same
     * ALTER-TABLE-ADD-COLUMN convention as the three above.
     *
     * WHERE THIS ROW CAME FROM, which is a different question from the three columns above and has
     * a different lifetime. Those are a LIVE CLAIM ("the pack owns this row right now") that the
     * household revokes by editing the rule; this is a HISTORICAL FACT ("this row started life as
     * the pack's X") that no later edit can falsify. It holds the pack rule's whole key --
     * `pattern|match_type|rule_kind`, exactly what keyOf() in src/lib/canadian-pack.ts builds and
     * exactly what merchant_rules_pattern_uq enforces -- not just its pattern, because match_type
     * is part of a rule's identity (a 'word' rule is a different rule from a 'contains' one on the
     * same pattern, per the matchType docblock above) and storing only the pattern would silently
     * reclassify item 16's twelve exact-to-word promotions as household edits.
     *
     * NULL means no recorded origin: every row a person wrote, every row that predates 0018 and
     * was not stamped when it ran, and every conflict-kept row an install refused to touch. A NULL
     * here is always read as "purely the household's".
     *
     * NOTHING PARSES THIS STRING -- it is only ever compared to a freshly built key -- so the '|'
     * separator carries no meaning a pattern containing a '|' could confuse.
     *
     * Written in exactly two places, NEITHER of them upsertRuleFromCorrection: the pack stamps its
     * own key on every row it writes (rememberPackOrigin, src/lib/canadian-pack.ts), and a form
     * save that re-keys a rule which already has an origin passes it to the new row
     * (planPackOriginCarry then applyPackOriginCarry, src/lib/packs.ts). Because the shared upsert names this column in
     * neither its INSERT values nor its onConflictDoUpdate set, SQLite leaves it alone on an
     * update and NULL on an insert -- so an ordinary form edit clears the stamp (as it must) and
     * preserves the origin (as it must) with no exception written into rules.ts at all. See
     * drizzle/0018_pack_origin_key.sql's header for the defect this exists to fix.
     */
    packOriginKey: text('pack_origin_key'),
  },
  (t) => [uniqueIndex('merchant_rules_pattern_uq').on(t.pattern, t.matchType, t.ruleKind)],
);

/**
 * v1.21.0 (item 9), added by drizzle/0016_rule_hygiene.sql. That migration uppercases every
 * merchant_rules.pattern (matchRule and normalized_merchant are both otherwise-uppercase; a
 * lowercase pattern silently never matched anything -- see the migration's own header for the
 * full defect). Uppercasing can collide with a row that was already stored uppercase, which
 * merchant_rules_pattern_uq then refuses as a duplicate write -- so the migration MERGES instead
 * of failing, and this table is where it records what it merged, so a household that had 109
 * rules can see what happened to them rather than just noticing a smaller number.
 *
 * One row per duplicate DROPPED (not per survivor): a 3-way collision produces two rows here, all
 * pointing at the same keptRuleId. No onDelete on the FK to merchant_rules -- if that survivor
 * row is later deleted by an admin, this stays as a historical record of the merge, which already
 * happened and is independent of what became of the row afterward.
 */
export const merchantRuleMerges = sqliteTable(
  'merchant_rule_merges',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    keptRuleId: integer('kept_rule_id').notNull().references(() => merchantRules.id),
    /** The pattern exactly as it was stored before this migration uppercased and merged it. */
    droppedPattern: text('dropped_pattern').notNull(),
    /**
     * Deliberately NOT widened with 'word' in v1.25.0 (item 16), unlike merchantRules.matchType
     * above. Two independent reasons, either sufficient:
     *
     *   1. NOTHING WRITES THIS TABLE AT RUNTIME. Its only writer is the one-time INSERT at the
     *      bottom of drizzle/0016_rule_hygiene.sql; no application code inserts here (verified by
     *      grep across src/ -- this schema declaration and the migration tests are the only
     *      references). It is a frozen historical audit of what that single migration merged.
     *   2. That migration ran before 'word' existed as a value anywhere, so every row this table
     *      can ever contain was dropped from a set of purely 'exact'/'contains' rules. A 'word'
     *      value here would be a record of something that never happened.
     *
     * drizzle/0016_rule_hygiene.sql:33 backs this column with a real
     * `CHECK (dropped_match_type IN ('exact','contains'))`. Widening it would need a full table
     * rebuild (SQLite cannot alter a CHECK) to admit a value no writer can produce -- so the CHECK
     * stays exactly as it is, and this enum stays narrower than MatchType on purpose. If a future
     * item ever gives this table a runtime writer, THAT is when it needs migration 0018.
     */
    droppedMatchType: text('dropped_match_type', { enum: ['exact', 'contains'] }).notNull(),
    droppedRuleKind: text('dropped_rule_kind', { enum: ['category', 'transfer', 'rename', 'not_transfer'] }).notNull(),
    droppedHitCount: integer('dropped_hit_count').notNull(),
    droppedCreatedAt: text('dropped_created_at').notNull(),
    mergedAt: text('merged_at').notNull(),
  },
  (t) => [index('merchant_rule_merges_kept_idx').on(t.keptRuleId)],
);

export const bayesTokens = sqliteTable(
  'bayes_tokens',
  {
    token: text('token').notNull(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.token, t.categoryId] }), index('bayes_tokens_token_idx').on(t.token)],
);

export const bayesCategoryTotals = sqliteTable('bayes_category_totals', {
  categoryId: integer('category_id')
    .primaryKey()
    .references(() => categories.id, { onDelete: 'cascade' }),
  docCount: integer('doc_count').notNull().default(0),
  tokenTotal: integer('token_total').notNull().default(0),
});

export const budgets = sqliteTable(
  'budgets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scope: text('scope', { enum: ['household', 'personal'] }).notNull(),
    userId: integer('user_id').references(() => users.id),
    categoryId: integer('category_id').notNull().references(() => categories.id),
    amountCents: integer('amount_cents'),
    effectiveMonth: text('effective_month').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('budgets_lookup_idx').on(t.categoryId, t.effectiveMonth)],
  // budgets_scope_user_category_month_uq is an expression index; see drizzle/0000_init.sql
);

/**
 * Rollover preference per (scope, user, category) (spec 2026-08-22, v1.7.0, Task 1).
 * Mirrors drizzle/0009_finish_line.sql. A row's EXISTENCE means rollover is ON for that
 * category; DELETING the row turns it off again -- the same absence-is-off pattern the
 * settings table already uses for feature toggles elsewhere in this app. There is
 * deliberately no `enabled` column here: existence already carries the on/off meaning, so a
 * second flag could only ever drift out of sync with it, for no cheaper a read than checking
 * whether the row exists.
 *
 * NOT represented here; SQL only:
 *   - CHECK (scope IN ('household','personal'))
 *   - CHECK ((scope = 'personal') = (user_id IS NOT NULL)) -- a household row must carry a
 *     NULL user_id and a personal row must carry a non-NULL one; the two can never mismatch.
 *   - the coalesce(user_id, -1) EXPRESSION inside budget_rollover_uq, the same
 *     expression-unique trick loan_matcher_rules_uq (0007) uses on account_id, which is what
 *     makes "the same household rollover rule twice" impossible: a plain uniqueIndex() on
 *     (scope, userId, categoryId) would let two NULL-user_id rows through, so it is
 *     deliberately NOT declared below -- a weaker index with the same name is worse than
 *     none, because a future drizzle-kit push could use it to replace the real one.
 */
export const budgetRollover = sqliteTable('budget_rollover', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scope: text('scope', { enum: ['household', 'personal'] }).notNull(),
  userId: integer('user_id').references(() => users.id),
  categoryId: integer('category_id')
    .notNull()
    .references(() => categories.id),
  startMonth: text('start_month').notNull(),
  createdAt: text('created_at').notNull(),
});
// budget_rollover_uq is an expression index; see drizzle/0009_finish_line.sql

/**
 * One household savings target per month (spec
 * docs/superpowers/plans/2026-08-30-savings-targets.md, rulings T2/T3/T4, v1.17.0). Mirrors
 * drizzle/0015_savings_targets.sql. `month` is the PRIMARY KEY -- ruling T3 (household scope
 * only, no per-person target in this release) and ruling T4 (one row per month, seeded by
 * copy-forward, the same idiom budgets/budgetRollover already use) together mean there is
 * exactly one row per month, never a second dimension to key on.
 *
 * `mode` decides what `value` means -- 'percent' (a whole percent of that month's income) or
 * 'amount' (a fixed number of cents) -- and the two are mutually exclusive by construction:
 * there is deliberately only one value column, so a stored row can never disagree with itself
 * about which one is live (ruling T2's "no whichever-is-greater" rule). See
 * src/lib/savings-target.ts for the resolution math.
 *
 * NOT represented here; SQL only:
 *   - CHECK (mode IN ('percent', 'amount'))
 *   - CHECK ((mode = 'percent' AND value BETWEEN 1 AND 100) OR (mode = 'amount' AND value >= 0))
 */
export const savingsTargets = sqliteTable('savings_targets', {
  month: text('month').primaryKey(),
  mode: text('mode', { enum: ['percent', 'amount'] }).notNull(),
  value: integer('value').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const goals = sqliteTable('goals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  ownerUserId: integer('owner_user_id').references(() => users.id),
  targetCents: integer('target_cents').notNull(),
  targetDate: text('target_date'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
});

export const goalContributions = sqliteTable(
  'goal_contributions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    goalId: integer('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    userId: integer('user_id').notNull().references(() => users.id),
    amountCents: integer('amount_cents').notNull(),
    date: text('date').notNull(),
    note: text('note'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('goal_contributions_goal_idx').on(t.goalId, t.date)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const loginAttempts = sqliteTable(
  'login_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    ip: text('ip').notNull(),
    success: integer('success', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('login_attempts_username_idx').on(t.username, t.createdAt),
    index('login_attempts_ip_idx').on(t.ip, t.createdAt),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** SimpleFIN (spec section 12). Stays empty until an admin claims a setup token. */
export const simplefinConnections = sqliteTable('simplefin_connections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** base64(iv || tag || ciphertext), AES-256-GCM under HKDF info 'simplefin-v1'. */
  accessUrlEncrypted: text('access_url_encrypted').notNull(),
  claimedAt: text('claimed_at').notNull(),
  lastSyncAt: text('last_sync_at'),
  requestsToday: integer('requests_today').notNull().default(0),
  requestsDate: text('requests_date').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
});

export const simplefinAccountLinks = sqliteTable(
  'simplefin_account_links',
  {
    /** The provider's account id is the PK: a remote account links to at most one local account. */
    simplefinAccountId: text('simplefin_account_id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    currency: text('currency').notNull(),
    lastBalanceCents: integer('last_balance_cents'),
    lastBalanceDate: text('last_balance_date'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('simplefin_links_account_idx').on(t.accountId)],
);

/**
 * Balance snapshots for net worth history (spec 2026-08-22, v1.7.0, Task 1). Mirrors
 * drizzle/0009_finish_line.sql. One row per account per day; a later write for the same day
 * REPLACES the balance rather than adding a second row -- the upsert-on-(accountId, date)
 * behaviour lives in the app layer (src/lib/networth.ts), not in SQL, so this table carries
 * no ON CONFLICT clause of its own.
 *
 * NOT represented here; SQL only:
 *   - CHECK (source IN ('simplefin','manual','csv'))   -- widened by 0010_balances
 *
 * The three sources rank in authority as simplefin > csv > manual (ruling R3, v1.8.0 spec):
 * a bank's own figure outranks a hand-typed one for the same date. 'csv' is deliberately
 * distinct from 'manual' so that ordering is expressible at all -- see
 * src/lib/import/mapping.ts's balanceCol, which produces it.
 */
export const accountBalanceSnapshots = sqliteTable(
  'account_balance_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    balanceCents: integer('balance_cents').notNull(),
    source: text('source', { enum: ['simplefin', 'manual', 'csv'] }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('account_balance_snapshots_uq').on(t.accountId, t.date)],
);

export const totpRecoveryCodes = sqliteTable(
  'totp_recovery_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: text('used_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('totp_recovery_codes_user_idx').on(t.userId),
    uniqueIndex('totp_recovery_codes_hash_uq').on(t.userId, t.codeHash),
  ],
);

/**
 * Warranty tracker (spec 2026-08-16 §3). Mirrors drizzle/0002_warranty_tracker.sql.
 *
 * NOT represented here; these objects exist ONLY in that raw SQL file (MUST-3.4):
 *   - every CHECK constraint on both tables,
 *   - the `warranty_search` FTS5 contentless virtual table
 *     (contentless_delete=1, tokenize='unicode61 remove_diacritics 2', rowid = warranty_items.id),
 *   - its six triggers (warranty_search_item_ai / _au / _ad and
 *     warranty_search_receipt_ai / _au / _ad), which are the index's ONLY writer.
 * Application code must never INSERT, UPDATE or DELETE `warranty_search` directly (MUST-3.12).
 */
export const warrantyItems = sqliteTable(
  'warranty_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    vendor: text('vendor'),
    model: text('model'),
    serial: text('serial'),
    purchaseDate: text('purchase_date').notNull(),
    warrantyMonths: integer('warranty_months'),
    isLifetime: integer('is_lifetime', { mode: 'boolean' }).notNull().default(false),
    /** Computed at write time by addMonthsClamped(); never derived on read (MUST-3.6). */
    expiryDate: text('expiry_date'),
    /** Positive magnitude, unlike transactions.amount_cents (MUST-3.2 / §17.26). */
    priceCents: integer('price_cents'),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => users.id),
    /** ON DELETE SET NULL: an import undo must not take the receipt evidence with it (MUST-3.7). */
    transactionId: integer('transaction_id').references(() => transactions.id, { onDelete: 'set null' }),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    /**
     * Spec section 19.3, added by drizzle/0003_warranty_item_types.sql. Declared last
     * because ALTER TABLE ADD COLUMN appends physically -- same convention as
     * users.mustChangePassword, so the mirror stays readable against
     * `pragma table_info(warranty_items)`. Nullable: a type is optional, and NULL means
     * "unclassified" (there is no Uncategorised row). No onDelete clause on purpose --
     * deleting a type that is in use is blocked in the app layer (MUST-19.5/19.6).
     */
    typeId: integer('type_id').references(() => warrantyItemTypes.id),
    /**
     * v1.2.4, added by drizzle/0005_billing_cycle.sql. Declared last -- same
     * ALTER-TABLE-ADD-COLUMN convention as typeId above. Both nullable: an item carries a
     * non-NULL value here only if its TYPE has a kind OTHER than 'warranty', and that rule is
     * enforced in the app layer (src/lib/warranty/items.ts, billingAllowedForKind), never
     * derived on read -- a CHECK on this table cannot see across to warranty_item_types.kind.
     *
     * This said "only 'subscription' or 'contract'" until v1.10.2. That was written in v1.2.4
     * and went stale in v1.3.1, when loans arrived and got their own row in BILLING_WORDING: a
     * loan has a monthly payment, so billing applies to it too. The gate has allowed loans
     * ever since, which made this docblock describe an invariant the code does not hold --
     * the kind of note that gets trusted and then propagated.
     */
    billingCycle: text('billing_cycle', { enum: ['monthly', 'annual'] }),
    billingAmountCents: integer('billing_amount_cents'),
    /**
     * v1.3.1, added by drizzle/0007_loans.sql. Declared last -- same
     * ALTER-TABLE-ADD-COLUMN convention as typeId and the billing pair above. All four
     * nullable, and only an item whose TYPE has kind 'loan' ever carries a non-NULL value.
     *
     * NOT represented here -- SQL only:
     *   - CHECK (principal_cents IS NULL OR principal_cents >= 0)
     *   - CHECK (interest_rate_bps IS NULL OR (>= 0 AND <= 1000000))
     *   - CHECK (current_balance_cents IS NULL OR current_balance_cents >= 0)
     *
     * MUST-13.1: interest_rate_bps is DISPLAY ONLY. Basis points, so 5.49% is 549. No code
     * path multiplies, accrues, projects or amortises with it, and a grep invariant in
     * tests/ops/loan-invariants.test.ts keeps it that way.
     *
     * MUST-11.7/MUST-11.8: current_balance_cents and balance_updated_at are both set or
     * both NULL -- a CROSS-COLUMN rule, enforced in src/lib/warranty/items.ts rather than
     * by a CHECK, because ALTER TABLE ADD COLUMN does not re-validate existing rows against
     * a CHECK added that way. balance_updated_at is the HUMAN anchor: it is written only
     * when a person types a balance, never by a matched payment, which is exactly what
     * makes the debt reconstruction in src/lib/loans.ts well-defined.
     */
    principalCents: integer('principal_cents'),
    interestRateBps: integer('interest_rate_bps'),
    currentBalanceCents: integer('current_balance_cents'),
    balanceUpdatedAt: text('balance_updated_at'),
    /**
     * v1.13.0 ruling R11 (item AQ), micro-ruling M9. Bill-kind items only: the budget category this
     * bill accumulates against, so the budgets row can say what it is saving toward. A read-side link
     * and nothing else -- it changes no limit, no rollover and no total. NULL means "not linked",
     * which is every row before v1.13.0.
     */
    budgetCategoryId: integer('budget_category_id').references(() => categories.id),
    /**
     * v1.14.0, added by drizzle/0014_loan_direction.sql (spec
     * docs/superpowers/specs/2026-08-28-loans-lent-direction-design.md, item BU). Which way a
     * loan points. 'owed' is a debt the household owes -- every row before v1.14.0, and every
     * non-loan row forever. 'lent' is money someone owes the household, and it FLIPS the sign
     * convention: money OUT raises the balance, money IN lowers it.
     *
     * NOT NULL with a default, like users.visibility (0013) and unlike the four money columns
     * above: there is no third state, and 'owed' is the honest value for an item that is not a
     * loan at all. The rule that only a kind='loan' item may carry 'lent' is a CROSS-TABLE rule
     * a CHECK cannot see, so it lives in src/lib/warranty/items.ts beside
     * assertLoanFieldsMatchKind (planner ruling P3).
     *
     * NOT represented here -- SQL only:
     *   - CHECK (loan_direction IN ('owed','lent'))
     */
    loanDirection: text('loan_direction', { enum: ['owed', 'lent'] }).notNull().default('owed'),
  },
  (t) => [
    index('warranty_items_expiry_idx').on(t.expiryDate),
    index('warranty_items_owner_idx').on(t.ownerUserId),
    index('warranty_items_transaction_idx').on(t.transactionId),
    index('warranty_items_type_idx').on(t.typeId),
  ],
);

export const warrantyReceipts = sqliteTable(
  'warranty_receipts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    warrantyItemId: integer('warranty_item_id')
      .notNull()
      .references(() => warrantyItems.id, { onDelete: 'cascade' }),
    /** Display only: never a path component, never rendered as HTML (MUST-3.8). */
    originalFilename: text('original_filename').notNull(),
    /** Server-generated `${randomUUID()}.${sniffedExt}` (MUST-4.2). */
    storedFilename: text('stored_filename').notNull(),
    mime: text('mime', { enum: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    ocrText: text('ocr_text'),
    /** Exactly three values; there is deliberately no 'running' state (§7.5). */
    ocrStatus: text('ocr_status', { enum: ['pending', 'done', 'failed'] }).notNull().default('pending'),
    ocrError: text('ocr_error'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('warranty_receipts_stored_uq').on(t.storedFilename),
    index('warranty_receipts_item_idx').on(t.warrantyItemId),
    index('warranty_receipts_ocr_idx').on(t.ocrStatus),
  ],
);

/**
 * Admin-maintained item types (spec section 19.2, amended v1.2.2 section 19 -- kinds).
 * Mirrors drizzle/0003_warranty_item_types.sql, drizzle/0004_item_type_kinds.sql and
 * drizzle/0020_bill_item_type.sql (which seeds the 'Bill' row 0011 forgot when it widened
 * `kind` to admit 'bill' -- the feature shipped complete but unreachable without creating the
 * type by hand).
 *
 * NOT represented here -- these exist ONLY in those raw SQL files (MUST-3.4 / MUST-19.3):
 *   - CHECK (is_subscription IN (0,1)) and CHECK (length(trim(name)) BETWEEN 1 AND 60)  (0003)
 *   - the COLLATE NOCASE collation on warranty_item_types_name_uq, which is what makes
 *     'Laptop' and 'laptop' the same type (ASCII-only folding -- accepted, section 19.2) (0003)
 *   - CHECK (kind IN ('warranty','subscription','contract','loan','bill'))               (0004, widened by 0011)
 *
 * `kind` (0004) is now the classifier: warranty / subscription / contract / loan / bill. It
 * arrives by ALTER TABLE ADD COLUMN, so -- same convention as users.mustChangePassword and
 * warrantyItems.typeId -- it is declared LAST here, physically the last column.
 * `is_subscription` is KEPT for old readers (append-only discipline) and is maintained by
 * src/lib/warranty/types.ts as `kind === 'subscription'` on every write, so it never drifts
 * out of sync with `kind`. The period start, length and end are still
 * warranty_items.purchase_date / warranty_months / expiry_date reused verbatim (MUST-19.8).
 * The kind changes wording only, never derivation (MUST-19.12).
 *
 * v1.12.0: `kind` gains a fifth value, 'bill'. SQLite cannot ALTER a CHECK, so
 * drizzle/0011_bill_installments.sql REBUILT this table -- the second time a shipped table in
 * this schema has been recreated, and the first time one carrying data nobody can regenerate
 * has been. Unlike 0010's drop-and-recreate, 0011 does the full INSERT ... SELECT rebuild and a
 * test asserts every row survives, because a hand-typed item type exists nowhere else and
 * warranty_items.type_id points at it.
 */
export const warrantyItemTypes = sqliteTable(
  'warranty_item_types',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    isSubscription: integer('is_subscription', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    kind: text('kind', { enum: ['warranty', 'subscription', 'contract', 'loan', 'bill'] }).notNull().default('warranty'),
  },
  (t) => [uniqueIndex('warranty_item_types_name_uq').on(t.name)],
);

/**
 * Notifications (spec 2026-08-17 §3.2). Mirrors drizzle/0006_notifications.sql.
 *
 * NOT represented here; these exist ONLY in that raw SQL file (MUST-3.4 / MUST-3.15):
 *   - CHECK (id = 1), the SQL-enforced singleton (§3.2, decision 19)
 *   - CHECK (preset IN ('brevo','smtp2go','gmail','custom'))
 *   - CHECK (port BETWEEN 1 AND 65535)
 *   - CHECK (security IN ('tls','starttls','none'))
 *
 * `password_encrypted` is base64(iv ‖ tag ‖ ciphertext), AES-256-GCM under HKDF info
 * 'notify-smtp-v1' (MUST-5.1/5.2). It is never selected into a page prop (MUST-5.3).
 */
export const notificationSmtp = sqliteTable('notification_smtp', {
  id: integer('id').primaryKey(),
  preset: text('preset', { enum: ['brevo', 'smtp2go', 'gmail', 'custom'] }).notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  security: text('security', { enum: ['tls', 'starttls', 'none'] }).notNull(),
  username: text('username').notNull(),
  passwordEncrypted: text('password_encrypted').notNull(),
  fromEmail: text('from_email').notNull(),
  fromName: text('from_name').notNull().default('Budget Tracker'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastError: text('last_error'),
  lastErrorAt: text('last_error_at'),
  lastSuccessAt: text('last_success_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Where one person -- or, since v1.28.0, the whole household -- is reached on one channel
 * (spec §3.3). Mirrors drizzle/0006_notifications.sql as amended by drizzle/0021.
 *
 * NOT represented here; SQL only:
 *   - CHECK (channel IN ('telegram','email'))
 *   - the channel/secret_encrypted pairing CHECK: a telegram row MUST carry a secret and
 *     an email row MUST NOT. A misconfiguration is loud rather than silent.
 *   - CHECK (scope IN ('personal','household'))
 *   - the scope/user_id pairing CHECK: a personal row MUST carry a user_id and a household
 *     row MUST NOT.
 *   - notification_targets_household_channel_uq, the PARTIAL unique index
 *     `(channel) WHERE scope = 'household'`. It is what makes a second family Telegram
 *     impossible, and it is deliberately not declared here: Drizzle would emit an
 *     unconditional unique index of the same name, which would forbid every PERSONAL row
 *     past the first per channel -- the loan_matcher_rules_uq hazard exactly (see that
 *     table's docblock), a weaker index of the same name being worse than none.
 *
 * `secret_encrypted` is the bot token under HKDF info 'notify-telegram-v1' (MUST-3.5:
 * each user supplies their OWN token, so one blocked bot cannot silence the household).
 * The household row carries its own token under the same info, never a member's.
 *
 * v1.28.0: `user_id` is NULL on a household row and `created_by_user_id` records the admin
 * who set it up, ON DELETE SET NULL. Deleting that admin must NOT take the family channel
 * with them -- the other member still depends on it -- so ownership (cascade) and
 * authorship (audit) are separate columns. drizzle/0021's header argues it at length.
 */
export const notificationTargets = sqliteTable(
  'notification_targets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** NULL on a household row: the family channel belongs to nobody in particular. */
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['personal', 'household'] })
      .notNull()
      .default('personal'),
    /** Audit only, ON DELETE SET NULL. Never used to resolve or authorise a send. */
    createdByUserId: integer('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    channel: text('channel', { enum: ['telegram', 'email'] }).notNull(),
    destination: text('destination').notNull(),
    secretEncrypted: text('secret_encrypted'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** Set by a SUCCESSFUL Send test only; the UI badges an unverified channel. */
    verifiedAt: text('verified_at'),
    lastError: text('last_error'),
    lastErrorAt: text('last_error_at'),
    lastSuccessAt: text('last_success_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('notification_targets_user_channel_uq').on(t.userId, t.channel)],
);

/**
 * v1.28.0: which events an admin has routed to a family channel (§3.4's shape, one
 * household-wide row set instead of one per user).
 *
 * NOT represented here; SQL only:
 *   - CHECK (channel IN ('telegram','email'))
 *   - CHECK (enabled IN (0,1))
 *   - the WITHOUT ROWID storage class (the composite PK IS the row)
 *
 * MUST-3.6 applies unchanged: `event_id` carries NO CHECK and NO foreign key, so adding an
 * event stays one append to src/lib/notify/events.ts. Which ids may legally appear here is
 * the registry's `householdEligible` flag, enforced in code at the write path
 * (setHouseholdEventPref) and again at the send path (buildRequest), because a CHECK
 * cannot see a TypeScript array and a hand-edited database is exactly the case that guard
 * exists for.
 *
 * Sparse, like notification_prefs: nothing seeds this table and an ABSENT row means "not
 * routed". Upgrading therefore changes no delivery until an admin says so.
 */
export const notificationHouseholdPrefs = sqliteTable(
  'notification_household_prefs',
  {
    eventId: text('event_id').notNull(),
    channel: text('channel', { enum: ['telegram', 'email'] }).notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.channel] })],
);

/**
 * The sparse per-event, per-channel toggle matrix (spec §3.4).
 *
 * NOT represented here; SQL only:
 *   - CHECK (channel IN ('telegram','email'))
 *   - the WITHOUT ROWID storage class (the composite PK IS the row)
 *
 * MUST-3.6: `event_id` deliberately carries NO CHECK and NO foreign key. That is what
 * makes MUST-4.4 true: a future event type is one appended entry in
 * src/lib/notify/events.ts and nothing else. Unknown ids are ignored on read, never
 * deleted, so a downgrade-then-upgrade restores the user's choice.
 *
 * MUST-3.7: a row exists ONLY where a user actively changed a toggle. Nothing seeds this
 * table. The effective value is `row?.enabled ?? registryDefault(event_id)`.
 */
export const notificationPrefs = sqliteTable(
  'notification_prefs',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    channel: text('channel', { enum: ['telegram', 'email'] }).notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.eventId, t.channel] })],
);

/**
 * Per-user knobs (spec §3.5). One row per user, created lazily on first save. An ABSENT
 * row means every default applies, so a user who never opens the page still behaves
 * correctly.
 *
 * NOT represented here; SQL only: the six range CHECKs. MUST-3.8: these are typed
 * columns rather than a JSON blob because every one is read inside a query predicate or a
 * loop condition, and a CHECK is the cheapest defence against a stored 0 that would make
 * the scheduler nag every tick.
 */
export const notificationUserSettings = sqliteTable('notification_user_settings', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  comingDueDays: integer('coming_due_days').notNull().default(14),
  /** Capped at 99 on purpose: 100 is the OTHER event (§3.5). */
  budgetThresholdPct: integer('budget_threshold_pct').notNull().default(80),
  staleImportWeeks: integer('stale_import_weeks').notNull().default(3),
  dailyHour: integer('daily_hour').notNull().default(8),
  /** 0 = Sunday .. 6 = Saturday. */
  digestWeekday: integer('digest_weekday').notNull().default(1),
  digestHour: integer('digest_hour').notNull().default(8),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * The delivery queue AND the dedup guard (spec §3.6).
 *
 * NOT represented here; SQL only:
 *   - CHECK (channel IN ('telegram','email'))
 *   - CHECK (status IN ('pending','sent','failed'))
 *
 * MUST-3.9: `notification_outbox_dedup_uq` IS the dedup mechanism. Every enqueue is an
 * INSERT ... ON CONFLICT DO NOTHING and `changes === 0` means "already fired". There is no
 * separate dedup table, so the guard cannot drift from reality and a crash between
 * "decide to send" and "record that we sent" is impossible: they are one statement.
 *
 * v1.28.0: that index is now `(COALESCE(user_id, -1), channel, dedup_key)` and exists ONLY
 * in drizzle/0021_household_channels.sql. A household send is one row addressed to nobody,
 * so `user_id` is NULL on it -- and SQLite treats NULLs as DISTINCT inside a unique index,
 * so a plain (user_id, channel, dedup_key) index would let the family group chat receive
 * one copy per member per tick, which is the whole defect the feature exists to fix. It is
 * deliberately NOT declared below for the reason loan_matcher_rules_uq is not: a weaker
 * index with the same name is worse than none, because a future drizzle-kit push could use
 * it to replace the real one. -1 can never collide with a real user id (users.id is
 * AUTOINCREMENT, starting at 1).
 *
 * MUST-7.2: `subject` and `body` are rendered at ENQUEUE time, not send time.
 * MUST-3.10: sent/failed rows are retained as the "Recent deliveries" list and the dedup
 * memory; only runMaintenanceSweep()'s 400-day purge removes them.
 */
export const notificationOutbox = sqliteTable(
  'notification_outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** NULL means the household channel: one send, addressed to the family room. */
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: ['telegram', 'email'] }).notNull(),
    eventId: text('event_id').notNull(),
    dedupKey: text('dedup_key').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    status: text('status', { enum: ['pending', 'sent', 'failed'] }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: text('next_attempt_at').notNull(),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    sentAt: text('sent_at'),
  },
  (t) => [
    index('notification_outbox_due_idx').on(t.status, t.nextAttemptAt),
    index('notification_outbox_user_idx').on(t.userId, t.id),
  ],
);

/**
 * Loan payment matching (spec 2026-08-17 §11.4). Mirrors drizzle/0007_loans.sql.
 *
 * NOT represented here; SQL only:
 *   - CHECK (length(trim(merchant_contains)) >= 3)
 *   - the coalesce(account_id, -1) EXPRESSION inside loan_matcher_rules_uq, which is what
 *     makes "the same rule twice" impossible in the account-agnostic case too. A plain
 *     uniqueIndex() on (itemId, merchantContains, accountId) would let two NULLs through,
 *     so it is deliberately NOT declared below: a weaker index with the same name is worse
 *     than none, because a future drizzle-kit push could use it to replace the real one.
 *
 * MUST-11.10: the three-character minimum is a real guard, not tidiness. A one- or
 * two-character substring matches most merchant strings in a household's history, and the
 * first import after such a rule was saved would assign every transaction to a loan. It is
 * enforced in SQL and again in zod.
 *
 * MUST-11.11: merchant_contains is compared against transactions.normalized_merchant, which
 * normalizeMerchant() UPPERCASES. The stored value is uppercased on write and compared with
 * instr(...) > 0 against the uppercased parameter, with no lower() wrapper on either side.
 *
 * v1.12.0: this table now also carries rules for BILL-kind items, whose matched transactions
 * mark an installment paid instead of moving a balance. The name is historical and stays: the
 * rule row's shape did not change by one column, and renaming a shipped table for accuracy is a
 * migration with a cost and no benefit. The FUNCTION that reads it was renamed
 * (applyLoanMatchers -> applyPaymentMatchers) because a function name is free to change and a
 * table name is not.
 */
export const loanMatcherRules = sqliteTable(
  'loan_matcher_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => warrantyItems.id, { onDelete: 'cascade' }),
    merchantContains: text('merchant_contains').notNull(),
    /** NULL means "any account". */
    accountId: integer('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('loan_matcher_rules_item_idx').on(t.itemId)],
);

/**
 * The link row between a transaction and a loan (spec 2026-08-17 §11.5). Mirrors
 * drizzle/0007_loans.sql.
 *
 * NOT represented here; SQL only:
 *   - CHECK (amount_cents > 0)
 *   - CHECK (applied_cents >= 0 AND applied_cents <= amount_cents)
 *   - CHECK (source IN ('rule','manual'))
 *
 * MUST-11.14: TWO amount columns, deliberately. amount_cents is the honest record of the
 * payment; applied_cents is what the balance actually moved by, which differs whenever the
 * decrement clamped at zero. A reversal adds back applied_cents, so it restores the balance
 * exactly, with no drift, in every clamping case.
 *
 * MUST-11.15: loan_payments_txn_item_uq IS the idempotency guard, the same shape
 * notification_outbox_dedup_uq takes. Every link insert is INSERT ... ON CONFLICT DO
 * NOTHING and `changes === 0` means "already linked, do not decrement"; the decrement runs
 * in the same transaction, conditional on changes > 0, so a crash between "decide to apply"
 * and "record that we applied" is impossible: they are one statement.
 *
 * MUST-11.16: (txn_id, item_id), not (txn_id): one transaction may legitimately fund two
 * loans. The rule path never exploits this (MUST-13.4); only a person can create the second.
 */
export const loanPayments = sqliteTable(
  'loan_payments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    txnId: integer('txn_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    itemId: integer('item_id')
      .notNull()
      .references(() => warrantyItems.id, { onDelete: 'cascade' }),
    amountCents: integer('amount_cents').notNull(),
    appliedCents: integer('applied_cents').notNull(),
    source: text('source', { enum: ['rule', 'manual'] }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('loan_payments_txn_item_uq').on(t.txnId, t.itemId),
    index('loan_payments_item_idx').on(t.itemId, t.id),
    index('loan_payments_txn_idx').on(t.txnId),
  ],
);

/**
 * A bill's explicit schedule (spec 2026-08-24, ruling C3). Mirrors
 * drizzle/0011_bill_installments.sql.
 *
 * NOT represented here; SQL only:
 *   - CHECK (due_date LIKE '____-__-__') -- LIKE, not GLOB: GLOB's wildcards are ? and *, and
 *     treats _ as a literal underscore, so a GLOB pattern of underscores would only ever match
 *     a due_date that is literally four dashes and eight underscores. LIKE is the one whose
 *     wildcards are % and _, which is what this pattern actually needs.
 *   - CHECK (amount_cents > 0)
 *   - CHECK (paid_txn_id IS NULL OR paid_at IS NOT NULL)
 *
 * Named after the FEATURE that owns it, not after its parent table (ruling B3) -- the same way
 * loan_matcher_rules and loan_payments both hang off warranty_items and neither is called
 * warranty_item_*.
 *
 * bill_installments_txn_uq IS the idempotency guard (ruling B12), the same shape
 * loan_payments_txn_item_uq takes. SQLite treats NULLs as distinct in a unique index, so the
 * many hand-marked rows need no partial index, and a matched transaction can mark at most one
 * installment, for ever, whatever re-runs.
 *
 * There is deliberately NO unique index on (item_id, due_date): two parcels can fall due on the
 * same day for one bill at different amounts. Ordering is due_date ASC, id ASC everywhere, so
 * "the earliest unpaid installment" is total and deterministic even then.
 */
export const billInstallments = sqliteTable(
  'bill_installments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => warrantyItems.id, { onDelete: 'cascade' }),
    /** ISO YYYY-MM-DD. The municipality's date, typed by a person. */
    dueDate: text('due_date').notNull(),
    amountCents: integer('amount_cents').notNull(),
    /** ISO timestamp, or NULL for unpaid. The one field every reader filters on. */
    paidAt: text('paid_at'),
    /** NULL means a PERSON marked this paid (ruling B13). Non-NULL means a rule matched. There
     *  is deliberately no `source` column: this link column already answers the question, and a
     *  second column that must agree with it is a second column that can disagree with it. */
    paidTxnId: integer('paid_txn_id').references(() => transactions.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull(),
    /**
     * Mirrors drizzle/0012_totp_last_counter.sql, appended last for the same physical reason.
     *
     * ISO timestamp stamped when a PERSON un-marks an installment a payment rule had marked paid
     * (item BA / MON-3). paid_txn_id used to be the only record that a transaction had ever been
     * consumed by a bill, and this table's third CHECK forbids keeping it on an unpaid row -- so
     * an un-mark erased the evidence and the matcher re-marked the row on its next pass. The
     * suppression lives here instead: markMatchingUnpaid (src/lib/loans.ts) skips a row carrying
     * this, and markInstallmentPaid CLEARS it, because a hand mark is the deliberate act the
     * suppression exists to protect.
     */
    unlinkedAt: text('unlinked_at'),
  },
  (t) => [
    uniqueIndex('bill_installments_txn_uq').on(t.paidTxnId),
    index('bill_installments_item_idx').on(t.itemId, t.dueDate),
    index('bill_installments_due_idx').on(t.paidAt, t.dueDate),
  ],
);

/**
 * v1.13.0 ruling R3. Append-only. Nothing in src/ updates or deletes a row here; the only writer is
 * appendAudit() in src/lib/audit.ts and the only reader is the admin page at /settings/audit.
 * `action` and `entity` carry a LENGTH check in SQL and never a value enum, so a future audited
 * operation is a code change and not a migration.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** ISO timestamp from nowIso(). */
    at: text('at').notNull(),
    userId: integer('user_id').notNull().references(() => users.id),
    /** 'delete_item' | 'delete_receipt' | 'undo_import' today. Free text by design. */
    action: text('action').notNull(),
    /** The table entity_id belongs to: 'warranty_items' | 'warranty_receipts' | 'imports'. */
    entity: text('entity').notNull(),
    entityId: integer('entity_id').notNull(),
    /** One short human sentence, or NULL. Never a payload dump and never a secret. */
    detail: text('detail'),
  },
  (t) => [index('audit_log_at_idx').on(t.at), index('audit_log_entity_idx').on(t.entity, t.entityId)],
);
