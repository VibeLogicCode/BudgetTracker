import { describe, it, expect } from 'vitest';
import { classifyDetection, fileCounts, type FileDetection } from '@/lib/import/batch';
import type { AccountDetection } from '@/lib/import/detect-account';
import type { ProfileDetection } from '@/lib/import/detect-profile';

/**
 * 2026-09-15, ruling B1: the DETECTION is not changing. `detectImportAccount` and
 * `detectImportProfile` run per file exactly as they run on the one-file page; this gate only
 * READS the `confidence` and `reason` they already return and decides which of four lists a file
 * belongs in. Every test below is therefore about routing, never about scoring.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER: whether the detectors are right. That is
 * detect-account.test.ts and detect-profile.test.ts, which predate this file and are untouched by
 * it. A wrong-but-confident detection classifies as `ready` here and should -- the bug would be in
 * the detector, and hiding it behind a second opinion in this file is exactly the drift ruling B1
 * exists to prevent.
 */
const account = (over: Partial<AccountDetection> = {}): AccountDetection => ({
  account: { id: 7, name: 'Joint Visa' },
  confidence: 'certain',
  reason: '12 of 40 rows in this file are already in Joint Visa.',
  scores: [{ accountId: 7, name: 'Joint Visa', matchedRows: 12 }],
  ...over,
});

const profile = (over: Partial<ProfileDetection> = {}): ProfileDetection => ({
  profile: { id: 3, name: 'RBC Visa CSV' },
  confidence: 'certain',
  reason: 'RBC Visa CSV read all 40 of 40 rows in this file.',
  source: 'csv',
  scores: [],
  ...over,
});

const detection = (over: Partial<FileDetection> = {}): FileDetection => ({
  stagingId: '11111111-1111-4111-8111-111111111111',
  filename: 'jan.csv',
  rowCount: 40,
  account: account(),
  profile: profile(),
  ...over,
});

describe('classifyDetection: ready', () => {
  it('routes a confident file straight to the go-group', () => {
    expect(classifyDetection(detection()).status).toBe('ready');
  });

  /**
   * Ruling B6, and the reasoning that decided it: account `certain` requires row OVERLAP
   * (detect-account.ts branch 1), so a clean monthly statement with no overlap can never be
   * `certain`. Gating on `certain` would leave the common case permanently amber.
   */
  it('accepts a likely account, because a clean statement can never be certain', () => {
    const d = detection({
      account: account({
        confidence: 'likely',
        reason: 'The last file called jan.csv was imported into Joint Visa.',
        scores: [{ accountId: 7, name: 'Joint Visa', matchedRows: 0 }],
      }),
    });
    expect(classifyDetection(d).status).toBe('ready');
  });

  /**
   * Ruling B7. detect-profile returns `certain` with a NULL profile for OFX, because the format
   * names its own columns. Reading the confidence rather than the profile id is what makes this
   * fall out with no special case of its own.
   */
  it('accepts an OFX file, which is certain precisely because it has no profile', () => {
    const d = detection({
      filename: 'statement.qfx',
      profile: profile({
        profile: null,
        confidence: 'certain',
        reason: 'This is an OFX/QFX file, which names its own columns - no import profile is needed.',
        source: 'ofx',
      }),
    });
    expect(classifyDetection(d).status).toBe('ready');
  });
});

describe('classifyDetection: needs you', () => {
  it('stops when the account could not be decided', () => {
    const d = detection({
      account: account({
        account: null,
        confidence: 'none',
        reason: 'Nothing in this file says which account it belongs to.',
      }),
    });
    expect(classifyDetection(d).status).toBe('needs-you');
  });

  /**
   * Ruling B5. detect-profile's own `likely` sentence ends "Check the preview before you commit."
   * The codebase decided which files need eyes before this gate existed; this is reading that
   * instruction rather than inventing a policy.
   */
  it('stops on a likely profile, because the detector itself says to check the preview', () => {
    const d = detection({
      profile: profile({
        confidence: 'likely',
        reason: 'RBC Visa CSV read 37 of 40 rows. Check the preview before you commit.',
      }),
    });
    expect(classifyDetection(d).status).toBe('needs-you');
  });

  it('stops when no profile could read the file at all', () => {
    const d = detection({
      profile: profile({
        profile: null,
        confidence: 'none',
        reason: 'None of your import profiles could read this file.',
      }),
    });
    expect(classifyDetection(d).status).toBe('needs-you');
  });

  /** The reason shown is the detector's own sentence, never a rewrite of it. */
  it('carries the detector own words through, so the screen and the wizard agree', () => {
    const words =
      'Rows from this file are already in more than one account (Joint Visa, Chequing), so nothing was pre-selected.';
    const d = detection({ account: account({ account: null, confidence: 'none', reason: words }) });
    expect(classifyDetection(d).reason).toBe(words);
  });
});

/**
 * Ruling B3, and the reported problem: the same file occasionally imported twice. No column is
 * added for this. `matchedRows` is already how many of the file's rows that account holds, and it
 * is already computed on every detect call -- when it equals the row count, every row is in, and
 * the file is a re-import.
 */
describe('classifyDetection: already imported', () => {
  it('recognises a file whose every row is already in the account', () => {
    const d = detection({
      rowCount: 40,
      account: account({
        reason: '40 of 40 rows in this file are already in Joint Visa.',
        scores: [{ accountId: 7, name: 'Joint Visa', matchedRows: 40 }],
      }),
    });
    expect(classifyDetection(d).status).toBe('already-imported');
  });

  /** One new row is a reason to import, not to skip. The boundary is exact on purpose. */
  it('does not claim a file is done when one row is new', () => {
    const d = detection({
      rowCount: 40,
      account: account({ scores: [{ accountId: 7, name: 'Joint Visa', matchedRows: 39 }] }),
    });
    expect(classifyDetection(d).status).toBe('ready');
  });

  /** An empty file has matchedRows === rowCount === 0, which is not the same claim at all. */
  it('does not call an empty file already imported', () => {
    const d = detection({
      rowCount: 0,
      account: account({ scores: [{ accountId: 7, name: 'Joint Visa', matchedRows: 0 }] }),
    });
    expect(classifyDetection(d).status).not.toBe('already-imported');
  });

  /** The count that matters is the DETECTED account's, not whichever account scored highest. */
  it('counts against the account that was actually detected', () => {
    const d = detection({
      rowCount: 40,
      account: account({
        account: { id: 7, name: 'Joint Visa' },
        scores: [
          { accountId: 9, name: 'Chequing', matchedRows: 40 },
          { accountId: 7, name: 'Joint Visa', matchedRows: 5 },
        ],
      }),
    });
    expect(classifyDetection(d).status).toBe('ready');
  });

  /** Nothing is auto-imported on the strength of a file we believe is already in. */
  it('is never in the go-group', () => {
    const d = detection({
      rowCount: 40,
      account: account({ scores: [{ accountId: 7, name: 'Joint Visa', matchedRows: 40 }] }),
    });
    expect(classifyDetection(d).status).not.toBe('ready');
  });
});

/**
 * 2026-09-15, reported after v1.44.1: "on first page it should show summary like
 * last screenshot showing how many duplicates and what it will import."
 *
 * The list said "7 rows", which reads as "about to add 7". It was about to add ONE -- six of the
 * seven were already in the account. The number that matters was the one number not on the screen.
 *
 * These come from `buildPreview`, the same call the preview screen itself makes, rather than from
 * arithmetic of this file's own. A count derived some other way could disagree with the screen
 * two clicks later, and a household with no way to tell which is right would be correct to trust
 * neither.
 */
describe('fileCounts', () => {
  it('reports what will actually import, not how many rows the file has', () => {
    expect(fileCounts({ totalRows: 7, duplicateCount: 6, errorCount: 0 })).toEqual({
      totalRows: 7,
      duplicateCount: 6,
      errorCount: 0,
      willImport: 1,
    });
  });

  /** The commit button's own arithmetic (import-client.tsx): total minus duplicates. */
  it('counts an errored row as one that will not arrive', () => {
    expect(fileCounts({ totalRows: 10, duplicateCount: 2, errorCount: 3 }).willImport).toBe(5);
  });

  it('never reports a negative', () => {
    expect(fileCounts({ totalRows: 3, duplicateCount: 3, errorCount: 2 }).willImport).toBe(0);
  });

  it('says nothing will import when everything is already here', () => {
    expect(fileCounts({ totalRows: 19, duplicateCount: 19, errorCount: 0 }).willImport).toBe(0);
  });
});
