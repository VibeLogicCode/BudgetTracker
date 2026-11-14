import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listAudit } from '@/lib/audit';
import { drainAiQueue, resetAiQueueForTests } from '@/lib/ai/queue';
import { recordMerchantFailure } from '@/lib/ai/suggestions';
import { getSetting } from '@/lib/settings';
import { modelServerHandler, startFakeModelServer, type FakeModelServer } from '../helpers/fake-model-server';
import { buildAiFixture, type AiFixture } from '../helpers/ai-fixture';

/** v1.64.0 Lane B (plan 2026-11-12, B1). Fake model server, March 2026, nothing real. */
const MODEL = 'test-model:1b';

const session = vi.hoisted(() => ({ user: { id: 1, name: 'Alex', username: 'alex', role: 'admin' as 'admin' | 'member' } }));
let requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });

vi.mock('@/lib/auth/session', () => ({
  requireAdmin: vi.fn(async () => {
    if (session.user.role !== 'admin') throw new Error('Admin only');
    return session.user;
  }),
}));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  forgetAiSuggestionsAction,
  saveLocalAiAction,
  testLocalAiAction,
  turnOffLocalAiAction,
} from '@/app/(app)/settings/connections/ai-actions';

let fx: AiFixture | null = null;
let server: FakeModelServer | null = null;

beforeEach(async () => {
  requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
  fx = buildAiFixture();
  session.user = { id: fx.alex, name: 'Alex', username: 'alex', role: 'admin' };
  server = await startFakeModelServer(
    modelServerHandler({ answer: () => ({ category: null, merchant: null }) }),
  );
});

afterEach(async () => {
  await drainAiQueue();
  resetAiQueueForTests();
  await server?.close();
  server = null;
  fx?.t.cleanup();
  fx = null;
});

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}
const fields = () => form({ baseUrl: server!.baseUrl, model: MODEL });

describe('saveLocalAiAction', () => {
  it('writes the three keys and appends one audit row', async () => {
    const result = await saveLocalAiAction({}, fields());

    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/^Local AI is on: test-model:1b at 127\.0\.0\.1:\d+\. Suggestions start shortly\.$/);
    expect(getSetting('local_ai_enabled')).toBe('1');
    expect(getSetting('local_ai_base_url')).toBe(server!.baseUrl);
    expect(getSetting('local_ai_model')).toBe(MODEL);
    const audit = listAudit().filter((row) => row.action === 'set_local_ai');
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).not.toContain('://');
  });

  it('refuses a public address with the library sentence and writes and audits nothing', async () => {
    const result = await saveLocalAiAction({}, form({ baseUrl: 'http://8.8.8.8:11434', model: MODEL }));

    expect(result.error).toMatch(/only an address on your own network/i);
    expect(getSetting('local_ai_enabled')).toBeNull();
    expect(getSetting('local_ai_base_url')).toBeNull();
    expect(listAudit()).toHaveLength(0);
  });

  it('refuses a member', async () => {
    session.user = { id: fx!.sam, name: 'Sam', username: 'sam', role: 'member' };

    await expect(saveLocalAiAction({}, fields())).rejects.toThrow('Admin only');
    expect(getSetting('local_ai_enabled')).toBeNull();
    expect(listAudit()).toHaveLength(0);
  });

  it('refuses a cross-origin request before anything else, even a member', async () => {
    requestHeaders = new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' });
    session.user = { id: fx!.sam, name: 'Sam', username: 'sam', role: 'member' };

    const result = await saveLocalAiAction({}, fields());

    expect(result.error).toBe('Cross-origin request rejected');
    expect(getSetting('local_ai_enabled')).toBeNull();
  });
});

describe('testLocalAiAction', () => {
  it('succeeds against the fake server, lists its models, and writes no setting, state or audit row', async () => {
    const result = await testLocalAiAction({}, fields());

    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/test-model:1b answered in/);
    expect(result.models).toEqual([MODEL]);
    expect(getSetting('local_ai_enabled')).toBeNull();
    expect(getSetting('local_ai_base_url')).toBeNull();
    expect(getSetting('local_ai_last_ok_at')).toBeNull();
    expect(listAudit()).toHaveLength(0);
  });

  it('refuses a public address without contacting anything', async () => {
    const result = await testLocalAiAction({}, form({ baseUrl: 'http://8.8.8.8', model: MODEL }));

    expect(result.error).toMatch(/own network/i);
    expect(server!.requests).toHaveLength(0);
  });
});

describe('turnOffLocalAiAction and forgetAiSuggestionsAction', () => {
  it('turns off, keeps the address and model, and audits the change once', async () => {
    await saveLocalAiAction({}, fields());

    const result = await turnOffLocalAiAction({}, new FormData());

    expect(result.message).toBe('Local AI is off. Review and receipts work as before; suggestions already made are hidden.');
    expect(getSetting('local_ai_enabled')).toBeNull();
    expect(getSetting('local_ai_model')).toBe(MODEL);
    expect(listAudit().filter((row) => row.action === 'set_local_ai')).toHaveLength(2);
  });

  it('forgets only with the confirm box, says how many, and audits once', async () => {
    recordMerchantFailure({ merchant: 'MAPLE GROCER', model: MODEL, reason: 'unreadable', at: new Date('2026-03-10T09:00:00.000Z') });

    const refused = await forgetAiSuggestionsAction({}, new FormData());
    expect(refused.error).toMatch(/tick the box/i);
    expect(listAudit()).toHaveLength(0);

    const result = await forgetAiSuggestionsAction({}, form({ confirm: '1' }));
    expect(result.message).toBe('Forgot 1 AI suggestion. Rows are unchanged.');
    const audit = listAudit().filter((row) => row.action === 'forget_ai_suggestions');
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toBe('Forgot 1 AI suggestion');
  });
});
