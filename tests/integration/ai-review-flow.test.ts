import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveLocalAiConfig, turnOffLocalAi } from '@/lib/ai/config';
import { drainAiQueue, resetAiQueueForTests, sweepAiWork } from '@/lib/ai/queue';
import { runEngine } from '@/lib/categorize/engine';
import { commitImport } from '@/lib/import/commit';
import { computeRowHashes } from '@/lib/import/dedup';
import { chatBody, modelServerHandler, startFakeModelServer, type CapturedRequest, type FakeModelServer } from '../helpers/fake-model-server';
import { buildAiFixture, type AiFixture } from '../helpers/ai-fixture';

/**
 * v1.64.0 (plan lane C5). The local AI from the queue to Review, end to end through the real
 * actions and the real page: fake model server, explicit clock (Date only), invented household.
 */
const user = vi.hoisted(() => ({
  value: { id: 0, name: 'Alex', username: 'alex', role: 'admin' as 'admin' | 'member', visibility: 'household' as 'household' | 'self' },
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: vi.fn(async () => user.value) }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { acceptAiSuggestionAction } from '@/app/(app)/transactions/ai-actions';

const AT = new Date('2026-03-10T09:00:00.000Z');
const MODEL = 'test-model:1b';
const GOOD = { category: 'Food > Groceries', merchant: 'Maple Grocer' };

let fx: AiFixture | null = null;
let server: FakeModelServer | null = null;
let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AT);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ai-review-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  await drainAiQueue();
  resetAiQueueForTests();
  await server?.close();
  server = null;
  fx?.t.cleanup();
  fx = null;
  vi.useRealTimers();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const userText = (request: CapturedRequest) => chatBody(request).messages[1].content;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function setup() {
  fx = buildAiFixture();
  user.value = { id: fx.alex, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
  // A second uncategorized merchant, so each request can be told apart.
  fx.t.sqlite
    .prepare(
      `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
       values (?, '2026-03-01', 'BOOK NOOK 0815', 'BOOK NOOK', -1000, ?, '2026-03-10T12:00:00.000Z', '2026-03-10T12:00:00.000Z')`,
    )
    .run(fx.joint, fx.alex);
  server = await startFakeModelServer(modelServerHandler({ answer: (request) => (/MAPLE GROCER/.test(userText(request)) ? GOOD : { category: null, merchant: null }) }));
  saveLocalAiConfig({ baseUrl: server.baseUrl, model: MODEL, userId: fx.alex, at: AT });
  expect(sweepAiWork(AT)).toBe(2);
  await drainAiQueue();
  return { fx, server };
}

/** What the real page hands the client for Review, without rendering it. */
async function reviewProps(): Promise<Record<string, unknown>> {
  const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
  const element = (await TransactionsPage({ searchParams: Promise.resolve({ review: '1' }) })) as { props: Record<string, unknown> };
  return element.props;
}

describe('local AI to Review, end to end (v1.64.0 C5)', () => {
  it('Review shows Groceries and Maple Grocer for MAPLE GROCER, one merchant per request, and nothing of FUEL STOP 12', async () => {
    const { fx: f, server: s } = await setup();
    expect(s.requests).toHaveLength(2);
    for (const request of s.requests) {
      const text = userText(request);
      expect(text.match(/Description: (.*)/)?.[1]).toMatch(/^(MAPLE GROCER 0042|BOOK NOOK 0815)$/);
      expect(text).not.toContain('FUEL STOP 12');
    }
    expect(s.requests.map((request) => /Description: (.*)/.exec(userText(request))?.[1]).sort()).toEqual(['BOOK NOOK 0815', 'MAPLE GROCER 0042']);

    const props = await reviewProps();
    expect(props.aiSuggestions).toEqual({
      'MAPLE GROCER': { categoryId: f.groceries, categoryLabel: 'Food › Groceries', cleanName: 'Maple Grocer' },
    });
  });

  it('Use with Remember files the row, and the next import of MAPLE GROCER files by rule and is never asked about', async () => {
    const { fx: f, server: s } = await setup();
    const used = await acceptAiSuggestionAction({}, form({ transactionId: String(f.rows.mapleNewest), part: 'category', remember: '1' }));
    expect(used.error).toBeUndefined();
    const filed = f.t.sqlite.prepare('select category_id as category, categorization_source as source from transactions where id = ?').get(f.rows.mapleNewest);
    expect(filed).toEqual({ category: f.groceries, source: 'manual' });

    const committed = commitImport({
      accountId: f.joint,
      profileId: null,
      filename: 'march-2.csv',
      importedBy: f.alex,
      rows: computeRowHashes(f.joint, [
        { rowIndex: 0, rawDate: '2026-03-16', date: '2026-03-16', rawDescription: 'MAPLE GROCER', amountCents: -2875, balanceCents: null, cells: [] },
      ]),
      errors: [],
      origin: 'csv',
      at: AT,
    });
    runEngine(committed.insertedTransactionIds);
    const next = f.t.sqlite
      .prepare('select category_id as category, categorization_source as source from transactions where id = ?')
      .get(committed.insertedTransactionIds[0]);
    expect(next).toEqual({ category: f.groceries, source: 'rule' });

    expect(sweepAiWork(AT)).toBe(0);
    await drainAiQueue();
    expect(s.requests).toHaveLength(2);
  });

  it('with AI off, the review page props equal the same fixture with no suggestions', async () => {
    const { fx: f } = await setup();
    const on = await reviewProps();
    turnOffLocalAi({ userId: f.alex, at: AT });
    const off = await reviewProps();

    expect(off.aiSuggestions).toEqual({});
    expect(on.aiSuggestions).not.toEqual({});
    const rest = (props: Record<string, unknown>) => {
      const { aiSuggestions: _omitted, ...others } = props;
      void _omitted;
      return others;
    };
    expect(rest(off)).toEqual(rest(on));
  });
});
