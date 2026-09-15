import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const BATCH_DETECT = 'src/app/api/import/batch/detect/route.ts';
const BATCH_COMMIT = 'src/app/api/import/batch/commit/route.ts';
const SINGLE_DETECT = 'src/app/api/import/detect/route.ts';
const BATCH_LIB = 'src/lib/import/batch.ts';

/**
 * 2026-09-15. The batch import screen is a NEW FRONT DOOR onto machinery that already existed, and
 * this file is what stops it quietly becoming a second implementation.
 *
 * Rulings B1, B2 and B9 of docs/superpowers/specs/2026-09-15-batch-import-design.md all say the
 * same thing from three directions: one detection path, one commit path, no second opinion. Each
 * is easy to hold on the day it is written and easy to lose later, because the obvious way to fix
 * a batch-only bug is to special-case it in the batch file -- at which point the list and the
 * wizard can disagree about the same statement, and the household has no way to tell which is
 * right.
 *
 * WHAT THIS DELIBERATELY DOES NOT CATCH: a copy that renames things. This is a text scan, so a
 * scorer reimplemented under a different name, or dedup logic rewritten inline, passes every check
 * here. It guards the specific drift that has an obvious shape -- calling the detectors or the
 * commit directly from the batch routes -- not dishonesty in general.
 */
describe('the batch routes reuse, rather than reimplement', () => {
  /** Ruling B2. Every file lands through the same call the single-file route makes. */
  it('commits through commitStagedImport, the one writer', () => {
    expect(read(BATCH_COMMIT)).toContain('commitStagedImport');
  });

  it('has no writer of its own', () => {
    const source = read(BATCH_COMMIT);
    for (const forbidden of ['commitImport(', 'computeRowHashes', 'runEngine', 'applyPaymentMatchers', 'reconcileAccount']) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  /**
   * Ruling B9. The detection body lives in one module and BOTH routes call it. The single-file
   * route holding its own copy again is the exact regression this asserts against -- it is where
   * the code came from, so it is where it would drift back to.
   */
  it('detects through the shared detectStagedFile, from both routes', () => {
    expect(read(BATCH_DETECT)).toContain('detectStagedFile');
    expect(read(SINGLE_DETECT)).toContain('detectStagedFile');
  });

  it('leaves the single-file route no detection body of its own', () => {
    const source = read(SINGLE_DETECT);
    expect(source).not.toContain('detectImportAccount(');
    expect(source).not.toContain('detectImportProfile(');
  });

  /**
   * Ruling B1, the one the owner stated twice. The batch route reads the detectors' verdicts and
   * classifies; it must not call a detector itself, because a second call site is a second chance
   * to pass different arguments than the wizard would.
   */
  it('forms no opinion of its own in the batch route', () => {
    const source = read(BATCH_DETECT);
    expect(source).not.toContain('detectImportAccount');
    expect(source).not.toContain('detectImportProfile');
  });

  /** The gate itself is allowed exactly the two fields it routes on, and no scoring. */
  it('classifies on confidence and counts, not on a scorer of its own', () => {
    const source = read(BATCH_LIB);
    expect(source).toContain("confidence !== 'certain'");
    expect(source).toContain('matchedRows');
    for (const forbidden of ['cleanRate', 'dedupHash', 'MINIMUM_CLEAN_RATE', 'CERTAIN_CLEAN_RATE']) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  /** Non-vacuity: the files this scans have to actually exist, or every check above is trivial. */
  it('is scanning real files', () => {
    for (const file of [BATCH_DETECT, BATCH_COMMIT, SINGLE_DETECT, BATCH_LIB]) {
      expect({ file, length: read(file).length > 500 }).toEqual({ file, length: true });
    }
  });
});
