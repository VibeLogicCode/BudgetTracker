import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, type TestDb } from '../helpers/db';

const postAllDueInterest = vi.fn(() => ({ posted: 0, adjusted: 0, items: 0, failed: 0 }));
vi.mock('@/lib/loans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/loans')>()),
  postAllDueInterest: (...args: unknown[]) => (postAllDueInterest as (...a: unknown[]) => unknown)(...args),
}));

import { runNightlyJob } from '@/lib/backup';
import { runNotifyTick } from '@/lib/scheduler';

let current: TestDb | null = null;
let dataDir = '';
let originalDataDir: string | undefined;
let originalDbPath: string | undefined;
const AT = new Date('2026-08-15T06:00:00.000Z');

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-interest-'));
  originalDataDir = process.env.DATA_DIR;
  originalDbPath = process.env.BUDGET_DB_PATH;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  process.env.BUDGET_DB_PATH = current.path;
  postAllDueInterest.mockClear();
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalDbPath === undefined) delete process.env.BUDGET_DB_PATH;
  else process.env.BUDGET_DB_PATH = originalDbPath;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('interest posting while a restore is pending', () => {
  it('posts in the nightly job and at boot when nothing is staged', () => {
    runNightlyJob(AT);
    runNotifyTick(AT, { atBoot: true });
    expect(postAllDueInterest).toHaveBeenCalledTimes(2);
  });

  it('skips the nightly job posting while a restore is staged', () => {
    fs.mkdirSync(path.join(dataDir, 'restore-staged'), { recursive: true });
    runNightlyJob(AT);
    expect(postAllDueInterest).not.toHaveBeenCalled();
  });

  it('skips the boot catch-up posting while a restore is applying', () => {
    fs.mkdirSync(path.join(dataDir, 'restore-applying'), { recursive: true });
    runNotifyTick(AT, { atBoot: true });
    expect(postAllDueInterest).not.toHaveBeenCalled();
  });
});
