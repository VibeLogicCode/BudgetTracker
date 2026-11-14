#!/usr/bin/env node
/**
 * Rescue tool: reset a user's password, clear their lockout, and (with
 * --clear-mfa) clear their two-factor enrollment.
 *
 * Run it inside the container; it asks for the new password without showing it:
 *   docker compose exec -it budget-tracker node --experimental-strip-types \
 *     scripts/reset-admin-password.ts <username> [--clear-mfa]
 *
 * v1.64.1: the new password comes from that prompt on a terminal, or from the first line of
 * standard input when it is piped, never from the command line. The person chooses their own
 * password at the next sign-in (must_change_password), and every run writes one audit_log row.
 *
 * This script is DELIBERATELY self-contained. The runtime image ships Next's
 * standalone output, which does not include the project's src/ tree, so the
 * "@/..." import alias cannot resolve in the container. It therefore talks to
 * better-sqlite3 and argon2 directly — both are already present in the image.
 *
 * tests/scripts/reset-admin-password.test.ts pins ARGON2_OPTIONS against
 * src/lib/auth/password.ts so the two can never drift apart unnoticed.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import argon2 from 'argon2';

/** Must stay identical to ARGON2_OPTIONS in src/lib/auth/password.ts. */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};

export const MIN_PASSWORD_LENGTH = 10;
/** Must stay identical to MAX_PASSWORD_LENGTH in src/lib/auth/password.ts. */
export const MAX_PASSWORD_LENGTH = 1024;

/** The audit_log row's detail; matches the 'reset_password' action src/lib/audit.ts names. */
const AUDIT_DETAIL = 'Reset from the server command line';

export function resolveDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BUDGET_DB_PATH;
  if (override && override.length > 0) return override;
  return path.join(env.DATA_DIR && env.DATA_DIR.length > 0 ? env.DATA_DIR : '/data', 'budget.db');
}

export interface ResetResult {
  userId: number;
  username: string;
  sessionsRevoked: number;
  attemptsCleared: number;
  /** true only when --clear-mfa was asked for AND the user actually had TOTP on. */
  mfaCleared: boolean;
  /** Rows deleted from totp_recovery_codes for this user (0 when --clear-mfa was not given). */
  recoveryCodesDeleted: number;
  /** true when the account still has TOTP enrollment after this run — the caller must say so. */
  mfaStillRequired: boolean;
  /** true when the account was deactivated before this run; the reset makes it active again. */
  reactivated: boolean;
  /** false for a person whose sign-in an admin withdrew: the reset does not grant it back. */
  canSignIn: boolean;
}

export async function resetPassword(input: {
  dbPath: string;
  username: string;
  newPassword: string;
  /**
   * Clears TOTP enrollment as well. This is the SECRET_KEY-loss escape hatch:
   * a secret encrypted under a key nobody has anymore can never produce a
   * valid code again, so a password reset alone leaves the account
   * permanently unreachable.
   */
  clearMfa?: boolean;
}): Promise<ResetResult> {
  if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (input.newPassword.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`The new password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }

  const username = input.username.trim().toLowerCase();

  // better-sqlite3 CREATES a database when the file is missing. For a rescue tool that
  // is the worst possible default: a typo in DATA_DIR (or running outside the container)
  // silently produced an empty database, and the script then reported "No user named
  // alice. Known users: (none)" — which reads as "the account is gone" rather than
  // "you are looking at the wrong file". It also littered a stray budget.db on disk.
  let db: Database.Database;
  try {
    db = new Database(input.dbPath, { fileMustExist: true });
  } catch {
    throw new Error(
      `No database at "${input.dbPath}". Set BUDGET_DB_PATH or DATA_DIR to the right location, ` +
        'or run this inside the container (docker compose exec budget-tracker ...) where /data is mounted.',
    );
  }

  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    const user = db
      .prepare('select id, username, totp_enabled, is_active, can_sign_in from users where username = ?')
      .get(username) as { id: number; username: string; totp_enabled: number; is_active: number; can_sign_in: number } | undefined;
    if (!user) {
      const known = (db.prepare('select username from users order by username').all() as { username: string }[])
        .map((row) => row.username)
        .join(', ');
      throw new Error(`No user named "${username}". Known users: ${known || '(none)'}`);
    }

    const hash = await argon2.hash(input.newPassword, ARGON2_OPTIONS);
    const hadMfa = Number(user.totp_enabled) === 1;
    const reactivated = Number(user.is_active) !== 1;
    const mfaCleared = input.clearMfa === true && hadMfa;

    return db.transaction(() => {
      // The password set here is used once: the person chooses their own at the next sign-in.
      db.prepare('update users set password_hash = ?, is_active = 1, must_change_password = 1 where id = ?').run(hash, user.id);

      let recoveryCodesDeleted = 0;
      if (input.clearMfa === true) {
        // Mirrors clearTotpEnrollment() in src/lib/auth/totp.ts: disable the
        // flag, drop the (now undecryptable) secret, and delete the recovery
        // codes, which are SHA-256 hashes tied to the enrollment being removed.
        db.prepare('update users set totp_enabled = 0, totp_secret_encrypted = null where id = ?').run(user.id);
        recoveryCodesDeleted = Number(
          db.prepare('delete from totp_recovery_codes where user_id = ?').run(user.id).changes ?? 0,
        );
      }

      const sessions = db.prepare('delete from sessions where user_id = ?').run(user.id);
      const attempts = db.prepare('delete from login_attempts where username = ?').run(username);

      // One row per reset. audit_log needs a user, and no one is signed in here, so the row names the
      // reset account itself as both the actor and the entity.
      const detail = [AUDIT_DETAIL, mfaCleared ? 'two-factor cleared' : null, reactivated ? 'account reactivated' : null]
        .filter((part): part is string => part !== null)
        .join(', ');
      db.prepare(
        "insert into audit_log (at, user_id, action, entity, entity_id, detail) values (?, ?, 'reset_password', 'users', ?, ?)",
      ).run(new Date().toISOString(), user.id, user.id, detail);

      return {
        userId: user.id,
        username: user.username,
        sessionsRevoked: Number(sessions.changes ?? 0),
        attemptsCleared: Number(attempts.changes ?? 0),
        mfaCleared,
        recoveryCodesDeleted,
        mfaStillRequired: hadMfa && input.clearMfa !== true,
        reactivated,
        canSignIn: Number(user.can_sign_in) === 1,
      };
    })();
  } finally {
    db.close();
  }
}

function usage(): void {
  console.log(`Reset a Budget Tracker password and clear that account's lockout.

Usage:
  node --experimental-strip-types scripts/reset-admin-password.ts <username> [--clear-mfa]

Inside Docker, asked for the new password at a prompt that does not show it:
  docker compose exec -it budget-tracker node --experimental-strip-types \\
    scripts/reset-admin-password.ts alice

Or with the new password as the first line of standard input:
  docker compose exec -T budget-tracker node --experimental-strip-types \\
    scripts/reset-admin-password.ts alice < new-password.txt

The new password is never taken on the command line. It must be ${MIN_PASSWORD_LENGTH} to
${MAX_PASSWORD_LENGTH} characters, works for one sign-in, and the person then chooses their own.
The account is reactivated if it was deactivated, every one of its sessions is
signed out, its failed-login history is cleared so the lockout lifts immediately,
and the reset is recorded in the audit log. A person whose sign-in an admin
withdrew still needs an admin to allow sign-in again.

  --clear-mfa   Also turn off two-factor authentication for that user: clears
                totp_enabled, deletes the stored (encrypted) TOTP secret, and
                deletes their unused recovery codes. Use this when SECRET_KEY
                was lost or rotated — the stored secret is undecryptable then,
                so no authenticator app can ever produce an accepted code
                again. WITHOUT this flag the sign-in still asks for a
                two-factor code.

Database location: $BUDGET_DB_PATH, else $DATA_DIR/budget.db, else /data/budget.db.`);
}

/**
 * A prompt that does not show what is typed: the terminal is put in raw mode and each key handled
 * here. Enter finishes, Ctrl-C cancels, Backspace removes the last character.
 */
function promptHidden(question: string, input: NodeJS.ReadStream, output: NodeJS.WriteStream): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(question);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    let value = '';
    const finish = (error?: Error) => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    function onData(chunk: string) {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish();
        if (char === '\u0003') return finish(new Error('Cancelled.'));
        if (char === '\u007f' || char === '\b') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        // Past the maximum nothing more is kept; the length check then refuses it.
        if (value.length <= MAX_PASSWORD_LENGTH) value += char;
      }
    }
    input.on('data', onData);
  });
}

/** The first line of piped standard input, without its line ending. Stops reading past the maximum. */
async function readFirstLine(input: NodeJS.ReadableStream): Promise<string> {
  input.setEncoding('utf8');
  let buffered = '';
  for await (const chunk of input) {
    buffered += String(chunk);
    const end = buffered.indexOf('\n');
    if (end !== -1) {
      buffered = buffered.slice(0, end);
      break;
    }
    if (buffered.length > MAX_PASSWORD_LENGTH + 1) break;
  }
  return buffered.replace(/\r$/, '');
}

/** The new password: a no-echo prompt (asked twice) on a terminal, else the first line of standard input. */
export async function readNewPassword(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Promise<string> {
  if (!input.isTTY) return readFirstLine(input);
  const first = await promptHidden('New password: ', input, output);
  const again = await promptHidden('Type it again: ', input, output);
  if (first !== again) throw new Error('The two passwords did not match. Nothing was changed.');
  return first;
}

export async function main(argv: string[], readPassword: () => Promise<string> = () => readNewPassword()): Promise<number> {
  const raw = argv.slice(2);
  const clearMfa = raw.includes('--clear-mfa');
  const args = raw.filter((arg) => arg !== '--clear-mfa');
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    usage();
    return args.length === 0 ? 2 : 0;
  }
  if (args.length > 1) {
    console.error('error: give the new password at the prompt or on standard input, not on the command line.');
    console.error('Run it with only the username (and --clear-mfa if needed): it asks for the password, or reads the');
    console.error('first line of standard input when that is piped in. See --help.');
    return 2;
  }

  const dbPath = resolveDatabasePath();
  try {
    const newPassword = await readPassword();
    if (newPassword.length === 0) {
      throw new Error(
        'No new password was given. Run it in a terminal (docker compose exec -it) to be asked for one, or pipe it on standard input.',
      );
    }
    const result = await resetPassword({ dbPath, username: args[0], newPassword, clearMfa });
    console.log(
      `Password reset for "${result.username}" (id ${result.userId}). ` +
        `${result.sessionsRevoked} session(s) signed out, ${result.attemptsCleared} failed-login record(s) cleared.`,
    );
    console.log(result.reactivated ? 'The account was deactivated and is active again.' : 'The account was already active.');
    if (result.canSignIn) {
      console.log('They will choose their own password at the next sign-in; the one set here works only to get to that step.');
    } else {
      console.log(
        'Sign-in is withdrawn for this person, so an admin must allow sign-in under Settings → Users first. ' +
          'They will then choose their own password at the next sign-in.',
      );
    }
    if (clearMfa) {
      console.log(
        result.mfaCleared
          ? `Two-factor authentication cleared: TOTP is off and ${result.recoveryCodesDeleted} recovery code(s) were deleted. ` +
              'Sign-in no longer asks for a code, and a fresh authenticator can be set up from Settings → Profile.'
          : `Two-factor authentication was already off for this account; nothing to clear (${result.recoveryCodesDeleted} recovery code(s) deleted).`,
      );
      console.log('Nothing else was touched: transactions, budgets, goals and every other user are unchanged.');
    } else if (result.mfaStillRequired) {
      console.log(
        'Two-factor authentication is still ON for this account and was NOT touched — sign-in will ask for an ' +
          'authenticator code (or a recovery code) after the new password. If SECRET_KEY was lost or rotated, that ' +
          'code can never be accepted: re-run this with --clear-mfa.',
      );
    }
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`(database: ${dbPath})`);
    return 1;
  }
}

// Only run when invoked directly, so the test can import the functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  });
}
