import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = fs.readFileSync(path.join(root, 'src/instrumentation-node.ts'), 'utf8');

/**
 * Same stripComments discipline as tests/ops/restore-seams.test.ts: the doc-comments above the
 * shutdown handler narrate the mechanism in prose and, doing so, mention call-shaped text like
 * 'closeDb()' and '.unref()' themselves -- a raw indexOf() against the full handler text (with
 * comments still in it) would find those PROSE mentions instead of the real call sites, which is
 * exactly the false pass fix round 1 flagged. Ordering assertions below run against the
 * comment-stripped code only.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * A source grep, not an import: importing this module boots the scheduler, opens the database and
 * registers process-level signal handlers. The same reasoning tests/ops/loan-invariants.test.ts
 * gives for grepping src/lib/loans.ts.
 */
describe('shutdown and boot failure (item AZ / UX-12)', () => {
  it('the signal handler closes the database before it exits', () => {
    const handler = source.slice(source.indexOf('function shutdown('));
    const close = handler.indexOf('closeDb()');
    // O-11 parameterised the exit code (0 for a signal, 1 for a crash), so the terminal call
    // is process.exit(code) now -- the ordering this test pins is unchanged.
    const exit = handler.indexOf('process.exit(code)');
    expect(close).toBeGreaterThan(-1);
    expect(exit).toBeGreaterThan(-1);
    // Order is the whole point: closing after exiting is not closing.
    expect(close).toBeLessThan(exit);
  });

  it('closeDb is actually imported, not merely mentioned in a comment', () => {
    expect(source).toMatch(/import \{[^}]*closeDb[^}]*\} from '@\/db\/client'/);
  });

  it('arms the hard-stop timer before the close attempt, unrefs it, and disarms it only after', () => {
    // Fix round 1: the original version of this test only checked that 'setTimeout' and 'unref'
    // appeared SOMEWHERE in the handler, which would still pass if the timer were armed after
    // closeDb() (too late to backstop anything) or if .unref() were dropped (which would keep
    // the process alive on its own). This pins the actual ordering the shutdown path depends on.
    const codeOnly = stripComments(source);
    const handler = codeOnly.slice(codeOnly.indexOf('function shutdown('));
    const setTimeoutAt = handler.indexOf('setTimeout(');
    const unrefAt = handler.indexOf('.unref()');
    const closeDbAt = handler.indexOf('closeDb()');
    // Whichever comes first after the close attempt: clearTimeout(...) disarming the backstop,
    // or -- if a future rewrite ever drops the explicit clearTimeout -- the handler's own
    // terminal process.exit(0) superseding it.
    const clearAt = handler.indexOf('clearTimeout(');
    const finalExitAt = handler.lastIndexOf('process.exit(code)');
    const disarmedAt = clearAt > -1 ? clearAt : finalExitAt;

    expect(setTimeoutAt).toBeGreaterThan(-1);
    expect(unrefAt).toBeGreaterThan(-1);
    expect(closeDbAt).toBeGreaterThan(-1);
    expect(disarmedAt).toBeGreaterThan(-1);

    // Armed and unref'd BEFORE the close is even attempted.
    expect(setTimeoutAt).toBeLessThan(closeDbAt);
    expect(unrefAt).toBeLessThan(closeDbAt);
    // Only disarmed (or superseded by the real exit) AFTER the close attempt returns.
    expect(closeDbAt).toBeLessThan(disarmedAt);
  });

  it('a boot failure prints a framed message naming the rescue script', () => {
    // The bare getDb() at boot used to throw straight out of register(), so the container
    // restarted, the healthcheck kept failing, and the only record of WHY was a stack trace the
    // owner had to know to go and read.
    expect(source).toContain('restore-backup.ts');
    expect(source).toMatch(/try \{\s*getDb\(\);/);
  });
});

/**
 * O-11 (2026-09-02 review, P1). Node has crashed the process on an unhandled rejection since v15,
 * and the SIGTERM handler above -- whose entire purpose is checkpointing the WAL and clearing the
 * OCR in-flight marker -- covers signals only. A stray rejection therefore died with the WAL
 * uncheckpointed and the marker uncleared, which is exactly the ambiguity reconcileOcrCrashOnBoot
 * cannot resolve: it could no longer tell a stray rejection from a real crash.
 *
 * Source greps, for the same reason every test above uses them: importing this module boots the
 * scheduler, opens the database and registers real process-level handlers.
 */
describe('O-11: a crash checkpoints the database like a signal does', () => {
  it('registers both crash listeners', () => {
    const codeOnly = stripComments(source);
    expect(codeOnly).toMatch(/process\.on\(\s*'unhandledRejection'/);
    expect(codeOnly).toMatch(/process\.on\(\s*'uncaughtException'/);
  });

  it('runs the same shutdown body a signal runs, rather than a second hand-copied one', () => {
    const codeOnly = stripComments(source);
    // One teardown, three entry points. A hand-copied body is how the OCR marker gets cleared on
    // SIGTERM and forgotten on a crash -- the drift this codebase keeps paying to avoid.
    const teardown = (codeOnly.match(/clearOcrInFlightMarkerOnShutdown\(\)/g) ?? []).length;
    expect(teardown).toBe(1);
    const closes = (codeOnly.match(/closeDb\(\)/g) ?? []).length;
    expect(closes).toBe(1);
  });

  it('exits NON-zero on a crash, unlike the clean signal path', () => {
    const codeOnly = stripComments(source);
    // A crash that exits 0 tells Docker the container stopped on purpose, so a restart policy of
    // on-failure never restarts it. The signal path must stay 0 for exactly the same reason
    // inverted: a deliberate stop is not a failure.
    expect(codeOnly).toMatch(/shutdown\('unhandled promise rejection',\s*1\)/);
    expect(codeOnly).toMatch(/shutdown\('uncaught exception',\s*1\)/);
    expect(codeOnly).toMatch(/shutdown\('received SIGTERM',\s*0\)/);
    expect(codeOnly).toMatch(/shutdown\('received SIGINT',\s*0\)/);
  });

  it('logs the crash with its own prefix before tearing down, naming which listener fired', () => {
    const codeOnly = stripComments(source);
    // Without the reason in the log, the only difference between a crash and a `docker stop` in
    // the container log is the exit code, which nobody reads after the fact.
    expect(codeOnly).toMatch(/\[crash\]/);
  });
});
