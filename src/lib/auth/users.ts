import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { hashPassword, passwordSchema } from './password';

export interface UserRecord {
  id: number;
  name: string;
  username: string;
  role: 'admin' | 'member';
  totpEnabled: boolean;
  isActive: boolean;
  /** Spec v1.5: true until the user completes the forced /change-password step. */
  mustChangePassword: boolean;
  createdAt: string;
  /** v1.13.0 ruling R2. Admin-set on Settings -> Users. */
  visibility: 'household' | 'self';
  /** v1.13.0 ruling R5. false = attribution-only person, never on the login path. */
  canSignIn: boolean;
  /** v1.13.0 ruling R7: quick-add's default account for this person. */
  lastAccountId: number | null;
}

export interface UserWithSecrets extends UserRecord {
  passwordHash: string;
  totpSecretEncrypted: string | null;
}

export const usernameSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(3, 'Username must be at least 3 characters')
      .max(32, 'Username must be at most 32 characters')
      .regex(/^[a-z0-9._-]+$/, 'Username may contain only letters, digits, dot, underscore and hyphen'),
  );

export const createUserSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  username: usernameSchema,
  password: passwordSchema,
  role: z.enum(['admin', 'member']),
});

/** R5: no password, never admin, never a session. username is still required and still unique. */
export const createPersonSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  username: usernameSchema,
});

const PUBLIC_COLUMNS = {
  id: users.id,
  name: users.name,
  username: users.username,
  role: users.role,
  totpEnabled: users.totpEnabled,
  isActive: users.isActive,
  mustChangePassword: users.mustChangePassword,
  createdAt: users.createdAt,
  visibility: users.visibility,
  canSignIn: users.canSignIn,
  lastAccountId: users.lastAccountId,
} as const;

export function countUsers(): number {
  const row = getDb().select({ c: sql<number>`count(*)` }).from(users).get();
  return row?.c ?? 0;
}

export function countActiveAdmins(): number {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.isActive, true)))
    .get();
  return row?.c ?? 0;
}

export function listUsers(): UserRecord[] {
  return getDb().select(PUBLIC_COLUMNS).from(users).orderBy(users.id).all();
}

export function findUserById(id: number): UserRecord | null {
  return getDb().select(PUBLIC_COLUMNS).from(users).where(eq(users.id, id)).get() ?? null;
}

export function findUserByUsername(username: string): UserWithSecrets | null {
  const normalized = username.trim().toLowerCase();
  const row = getDb()
    .select({ ...PUBLIC_COLUMNS, passwordHash: users.passwordHash, totpSecretEncrypted: users.totpSecretEncrypted })
    .from(users)
    .where(eq(users.username, normalized))
    .get();
  return row ?? null;
}

export function usernameTaken(username: string): boolean {
  return findUserByUsername(username) !== null;
}

/**
 * `mustChangePassword` is an explicit argument rather than a default, because the two
 * callers want opposite things: the admin user manager hands out a password the admin
 * knows (so the new user must replace it — spec v1.5), while any programmatic caller
 * that already owns the password should not gate the account. It is deliberately NOT
 * part of createUserSchema: it is never read from a form field.
 */
export async function createUser(input: {
  name: string;
  username: string;
  password: string;
  role: 'admin' | 'member';
  mustChangePassword?: boolean;
}): Promise<UserRecord> {
  const parsed = createUserSchema.parse(input);
  if (usernameTaken(parsed.username)) {
    throw new Error(`Username "${parsed.username}" is already taken`);
  }
  const passwordHash = await hashPassword(parsed.password);
  const row = getDb()
    .insert(users)
    .values({
      name: parsed.name,
      username: parsed.username,
      passwordHash,
      role: parsed.role,
      totpSecretEncrypted: null,
      totpEnabled: false,
      isActive: true,
      mustChangePassword: input.mustChangePassword === true,
      visibility: 'household',
      canSignIn: true,
      lastAccountId: null,
      createdAt: nowIso(),
    })
    .returning(PUBLIC_COLUMNS)
    .get();
  return row;
}

/**
 * Atomic first-admin creation for /setup (fixes a TOCTOU: `hashPassword` is a real
 * await/yield point, so a plain "check isSetupRequired() then insert" split around
 * it lets two simultaneous first-run visitors both observe an empty table and both
 * become admin). The hash happens BEFORE the atomic section; the count-check and
 * the insert are then wrapped in a single synchronous db.transaction with no yield
 * point between them, so only the first caller to reach the transaction can ever
 * see count === 0 — every other caller sees the just-inserted row and throws.
 */
export async function createFirstAdmin(input: { name: string; username: string; password: string }): Promise<UserRecord> {
  const parsed = createUserSchema.parse({ ...input, role: 'admin' });
  const passwordHash = await hashPassword(parsed.password);
  return getDb().transaction((tx) => {
    const row = tx.select({ c: sql<number>`count(*)` }).from(users).get();
    if ((row?.c ?? 0) > 0) {
      throw new Error('Setup has already been completed');
    }
    return tx
      .insert(users)
      .values({
        name: parsed.name,
        username: parsed.username,
        passwordHash,
        role: 'admin',
        totpSecretEncrypted: null,
        totpEnabled: false,
        isActive: true,
        // The setup wizard's admin chose this password themselves — nobody else
        // knows it, so there is nothing for a forced change to protect against.
        mustChangePassword: false,
        visibility: 'household',
        canSignIn: true,
        lastAccountId: null,
        createdAt: nowIso(),
      })
      .returning(PUBLIC_COLUMNS)
      .get();
  });
}

/**
 * Writes the hash only. The must_change_password flag is deliberately untouched here:
 * an admin reset SETS it, a forced change CLEARS it, and a self-service change from
 * Settings leaves it alone — three different answers, so each caller states its own.
 */
export async function setUserPassword(userId: number, newPassword: string): Promise<void> {
  const password = passwordSchema.parse(newPassword);
  const passwordHash = await hashPassword(password);
  getDb().update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
}

/** Spec v1.5: raised by admin create / admin reset, lowered by the forced change form. */
export function setMustChangePassword(userId: number, value: boolean): void {
  getDb().update(users).set({ mustChangePassword: value }).where(eq(users.id, userId)).run();
}

export function mustChangePassword(userId: number): boolean {
  const row = getDb().select({ flag: users.mustChangePassword }).from(users).where(eq(users.id, userId)).get();
  return row?.flag === true;
}

/** Deactivate, never delete — attribution history must survive. */
export function setUserActive(userId: number, active: boolean): void {
  if (!active) {
    const target = findUserById(userId);
    if (target?.role === 'admin' && target.isActive && countActiveAdmins() <= 1) {
      throw new Error('Cannot deactivate the last active admin');
    }
  }
  getDb().update(users).set({ isActive: active }).where(eq(users.id, userId)).run();
}

/**
 * v1.13.0 ruling R5. A person the money is attributed to who has no login: a young child, a relative
 * living with the household, a housemate who does not want an account. They appear in every
 * attribution picker and never on the login path.
 *
 * password_hash is NOT NULL, so a row still needs one. It hashes 32 random bytes and throws them
 * away rather than storing a fixed sentinel: a sentinel would be the SAME value on every install, so
 * anybody who read this source could try it, and argon2 would happily verify it.
 */
export async function createPersonWithoutLogin(input: { name: string; username: string }): Promise<UserRecord> {
  const parsed = createPersonSchema.parse(input);
  if (usernameTaken(parsed.username)) throw new Error(`Username "${parsed.username}" is already taken`);
  const passwordHash = await hashPassword(randomBytes(32).toString('base64'));
  return getDb()
    .insert(users)
    .values({
      name: parsed.name,
      username: parsed.username,
      passwordHash,
      role: 'member',
      totpSecretEncrypted: null,
      totpEnabled: false,
      isActive: true,
      mustChangePassword: false,
      visibility: 'household',
      canSignIn: false,
      lastAccountId: null,
      createdAt: nowIso(),
    })
    .returning(PUBLIC_COLUMNS)
    .get();
}

/**
 * Micro-ruling M1: 'self' and role 'admin' are mutually exclusive. Enforced here and not as a SQL
 * CHECK, because it is a CROSS-COLUMN invariant and a CHECK added by ALTER TABLE ADD COLUMN does not
 * re-validate existing rows -- the same argument assertBalanceAnchorPairing makes in
 * src/lib/warranty/items.ts.
 */
export function setUserVisibility(userId: number, visibility: 'household' | 'self'): void {
  if (visibility === 'self' && findUserById(userId)?.role === 'admin') {
    throw new Error('An admin cannot be limited to their own records. Make them a member first.');
  }
  getDb().update(users).set({ visibility }).where(eq(users.id, userId)).run();
}

/** Ruling R5: an admin must always be able to sign in, so the flag can never be cleared on one. */
export function setUserCanSignIn(userId: number, canSignIn: boolean): void {
  if (!canSignIn && findUserById(userId)?.role === 'admin') {
    throw new Error('An admin must be able to sign in. Make them a member first.');
  }
  getDb().update(users).set({ canSignIn }).where(eq(users.id, userId)).run();
}

/** Ruling R7 / micro-ruling M5. Called by manualEntryAction after a successful write. */
export function setLastAccountId(userId: number, accountId: number | null): void {
  getDb().update(users).set({ lastAccountId: accountId }).where(eq(users.id, userId)).run();
}

/**
 * The ONE list every attribution picker reads (ruling R5). Active people, login or not -- which
 * resolves the pre-v1.13.0 inconsistency where transactions/page.tsx:69 listed deactivated members
 * and budgets/page.tsx:72 did not. listUsers() stays as-is for Settings -> Users, which must show
 * deactivated rows so they can be reactivated.
 */
export function listAttributablePeople(): UserRecord[] {
  return getDb().select(PUBLIC_COLUMNS).from(users).where(eq(users.isActive, true)).orderBy(users.id).all();
}
