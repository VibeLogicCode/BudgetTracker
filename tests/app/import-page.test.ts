import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { writeStagedFile } from '@/lib/import/staging';

/**
 * v1.13.0 controller ruling: hiding Import from a self viewer's nav (micro-ruling M6) is not
 * enough on its own -- the account picker this page builds is household-wide unless the caller
 * scopes it, so the page itself must refuse a self viewer server-side.
 */
const currentUser = vi.hoisted(() => ({
  value: {
    id: 0,
    name: '',
    username: '',
    role: 'admin' as 'admin' | 'member',
    visibility: 'household' as 'household' | 'self',
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireUser: async () => currentUser.value,
}));

const redirected: string[] = [];
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    redirected.push(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  redirected.length = 0;
});

describe('ImportPage', () => {
  it('redirects a self-scoped viewer to /dashboard', async () => {
    current = createSeededTestDb();
    const kid = insertTestUser(current.db, { name: 'Kid', username: 'kid', role: 'member' });
    currentUser.value = { id: kid, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };

    const { default: ImportPage } = await import('@/app/(app)/import/page');
    await expect(ImportPage()).rejects.toThrow('NEXT_REDIRECT:/dashboard');
  });

  it('does not redirect a household viewer, and excludes asset accounts from the picker (ruling R10)', async () => {
    current = createSeededTestDb();
    const admin = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
    insertTestAccount(current.db, { name: 'Joint Chequing', type: 'chequing' });
    insertTestAccount(current.db, { name: 'The House', type: 'asset' });
    currentUser.value = { id: admin, name: 'Admin', username: 'admin', role: 'admin', visibility: 'household' };

    const { default: ImportPage } = await import('@/app/(app)/import/page');
    // 2026-09-08: the page now returns a fragment — the Close-month card sits above ImportClient
    // (src/components/CloseMonthCard.tsx) — so the client element is a child rather than the root.
    const rendered = (await ImportPage()) as { props: { children: unknown[] } };
    const element = (rendered.props.children as { props?: { accounts?: unknown } }[]).find(
      (child) => child?.props?.accounts !== undefined,
    ) as { props: { accounts: { name: string }[] } };
    expect(redirected).toEqual([]);
    const names = element.props.accounts.map((a) => a.name);
    expect(names).toContain('Joint Chequing');
    expect(names).not.toContain('The House');
  });
});

/**
 * v1.55.2. After "Add a bank" saves a profile for a file the import screen had staged, the wizard
 * links back to /import?stagingId=&filename=. The page reads that file again with the SAME
 * detection the batch list uses (now including the new profile) and opens it, so the person
 * finishes importing the file they started with instead of choosing it a second time.
 */
describe('ImportPage — reopening a staged file by id', () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-import-page-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function renderWith(params: Record<string, string>) {
    current = createSeededTestDb();
    const admin = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
    insertTestAccount(current.db, { name: 'Joint Chequing', type: 'chequing' });
    currentUser.value = { id: admin, name: 'Admin', username: 'admin', role: 'admin', visibility: 'household' };
    const { default: ImportPage } = await import('@/app/(app)/import/page');
    const rendered = (await ImportPage({ searchParams: Promise.resolve(params) })) as { props: { children: unknown[] } };
    return (rendered.props.children as { props?: Record<string, unknown> }[]).find(
      (child) => child?.props?.accounts !== undefined,
    ) as { props: { initialDetection?: Record<string, unknown> | null; initialNotice?: string | null } };
  }

  it('opens the held file, detected against the current profiles', async () => {
    const stagingId = writeStagedFile(fs.readFileSync(path.join(process.cwd(), 'fixtures', 'scotia.csv')));

    const batch = await renderWith({ stagingId, filename: 'scotia.csv' });

    expect(batch.props.initialDetection).toMatchObject({
      stagingId,
      filename: 'scotia.csv',
      profile: { name: 'Scotiabank Chequing/Debit' },
      source: 'csv',
    });
    expect(batch.props.initialNotice ?? null).toBeNull();
  });

  it('says the file is gone, rather than opening nothing, when the server no longer holds it', async () => {
    const batch = await renderWith({ stagingId: '00000000-0000-4000-8000-000000000000', filename: 'scotia.csv' });

    expect(batch.props.initialDetection ?? null).toBeNull();
    expect(batch.props.initialNotice).toBe('This file is no longer held on the server. Choose it again.');
  });

  it('ignores a malformed id instead of building a path from it', async () => {
    const batch = await renderWith({ stagingId: '../../budget.db', filename: 'x.csv' });

    expect(batch.props.initialDetection ?? null).toBeNull();
    expect(batch.props.initialNotice).toBe('This file is no longer held on the server. Choose it again.');
  });
});
