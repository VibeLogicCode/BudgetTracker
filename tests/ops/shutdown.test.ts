import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = fs.readFileSync(path.join(root, 'src/instrumentation-node.ts'), 'utf8');

/**
 * A source grep, not an import: importing this module boots the scheduler, opens the database and
 * registers process-level signal handlers. The same reasoning tests/ops/loan-invariants.test.ts
 * gives for grepping src/lib/loans.ts.
 */
describe('shutdown and boot failure (item AZ / UX-12)', () => {
  it('the signal handler closes the database before it exits', () => {
    const handler = source.slice(source.indexOf('function handleShutdownSignal'));
    const close = handler.indexOf('closeDb()');
    const exit = handler.indexOf('process.exit(0)');
    expect(close).toBeGreaterThan(-1);
    expect(exit).toBeGreaterThan(-1);
    // Order is the whole point: closing after exiting is not closing.
    expect(close).toBeLessThan(exit);
  });

  it('closeDb is actually imported, not merely mentioned in a comment', () => {
    expect(source).toMatch(/import \{[^}]*closeDb[^}]*\} from '@\/db\/client'/);
  });

  it('a wedged close cannot hang the container for ever', () => {
    const handler = source.slice(source.indexOf('function handleShutdownSignal'));
    expect(handler).toContain('setTimeout');
    expect(handler).toContain('unref');
  });

  it('a boot failure prints a framed message naming the rescue script', () => {
    // The bare getDb() at boot used to throw straight out of register(), so the container
    // restarted, the healthcheck kept failing, and the only record of WHY was a stack trace the
    // owner had to know to go and read.
    expect(source).toContain('restore-backup.ts');
    expect(source).toMatch(/try \{\s*getDb\(\);/);
  });
});
