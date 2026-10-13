/**
 * v1.55.2. A file the import screen has staged on the server ("held"), and the ways back to it.
 *
 * Pure on purpose -- no node:fs, no database -- so the 'use client' import screen, the wizard and
 * the server page can all share these exact strings (tests/ops/client-bundle.test.ts forbids a
 * client module value-importing a server one, and src/lib/import/staging.ts is one).
 */

/** The `code` beside a 410 when the staged bytes are gone: swept from DATA_DIR/tmp, or imported. */
export const STAGED_FILE_MISSING = 'staged_file_missing' as const;

/** Said wherever a staged file turns out to be gone, always beside a control to choose it again. */
export const STAGED_FILE_GONE_SENTENCE = 'This file is no longer held on the server. Choose it again.';

export interface HeldFile {
  stagingId: string;
  filename: string;
}

function withHeldFile(pathname: string, held: HeldFile): string {
  return `${pathname}?${new URLSearchParams({ stagingId: held.stagingId, filename: held.filename }).toString()}`;
}

/** "Add a bank", opened on the held file when there is one so the wizard reads its columns. */
export function addBankHref(held: HeldFile | null): string {
  return held === null ? '/import/wizard' : withHeldFile('/import/wizard', held);
}

/** Back to the import screen, which opens straight onto the held file. */
export function importHeldFileHref(held: HeldFile): string {
  return withHeldFile('/import', held);
}

/** The query a page receives, reduced to a held file, or null when it names none. */
export function heldFileFromParams(params: Record<string, string | string[] | undefined>): HeldFile | null {
  const stagingId = typeof params.stagingId === 'string' ? params.stagingId : null;
  if (stagingId === null || stagingId === '') return null;
  const filename = typeof params.filename === 'string' ? params.filename.trim().slice(0, 255) : '';
  return { stagingId, filename: filename === '' ? 'statement.csv' : filename };
}
