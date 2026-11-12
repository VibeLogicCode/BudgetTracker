import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import type { Fetcher } from '@/lib/simplefin/client';
import { linkAccount, saveClaimedConnection } from '@/lib/simplefin/connection';
import { runSync } from '@/lib/simplefin/sync';
import { createAccount } from '@/lib/accounts';
import type { Viewer } from '@/lib/auth/viewer';
import { dismissSetAsideRow, listWaitingSetAside, releaseSetAsideRow, waitingSetAsideCount } from '@/lib/import/set-aside';
import { cashflowForRange } from '@/lib/reports';
import { createManualTransaction } from '@/lib/transactions';

/**
 * v1.61.0 item 4c, end to end through the bank sync (mocked bridge, explicit clock). A purchase
 * typed in by hand and then sent by the bank is held, counted once, and decided in Needs review;
 * the sync after the decision changes nothing either way.
 */
const ACCESS_URL = 'https://abc123:s3cr3t@bridge.example/simplefin';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-duplicates-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
  current?.cleanup();
  current = null;
});

function bridge(body: unknown): Fetcher {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }));
}

/** The bank's copy of the purchase: FUEL STOP 12, -61.30, posted on 2026-03-10. */
function bankPayload() {
  return {
    accounts: [
      {
        id: 'remote-1',
        name: 'Bridge Chequing',
        currency: 'CAD',
        balance: '1000.00',
        'balance-date': Math.floor(Date.parse('2026-03-10T15:00:00Z') / 1000),
        transactions: [
          {
            id: 'sf-fuel-1',
            posted: Math.floor(Date.parse('2026-03-10T15:00:00Z') / 1000),
            amount: '-61.30',
            description: 'FUEL STOP 12',
            pending: false,
          },
        ],
      },
    ],
    errlist: [],
  };
}

const MARCH = { from: '2026-03-01', to: '2026-03-31' };

function setup() {
  current = createSeededTestDb();
  const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex', role: 'admin' });
  const viewer: Viewer = { id: alex, role: 'admin', visibility: 'household' };
  const accountId = createAccount({ name: 'Joint chequing', institution: 'Bridge Bank', type: 'chequing', ownerUserId: alex });
  saveClaimedConnection(ACCESS_URL, new Date('2026-03-01T12:00:00.000Z'));
  linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD' });
  // Alex quick-adds the purchase the day it happens.
  createManualTransaction({
    accountId,
    date: '2026-03-09',
    description: 'FUEL STOP 12',
    amountCents: -6130,
    categoryId: null,
    attributedUserId: alex,
    userId: alex,
    actorRole: 'admin',
  });
  const t = current;
  const count = (query: string) => (t.sqlite.prepare(query).get() as { c: number }).c;
  const sync = (iso: string) => runSync({ userId: alex, now: new Date(iso), fetcher: bridge(bankPayload()) });
  return { t, alex, viewer, accountId, count, sync };
}

describe('possible duplicates, end to end through the bank sync', () => {
  it('holds the bank copy, counts the purchase once, and Delete this one keeps it out of the next sync', async () => {
    const s = setup();

    const first = await s.sync('2026-03-10T18:00:00.000Z');
    expect(first.totalAdded).toBe(0);
    expect(s.count('select count(*) as c from transactions')).toBe(1);
    expect(waitingSetAsideCount()).toBe(1);
    // While it is held the purchase counts once: the hand-typed row only.
    expect(cashflowForRange(MARCH, {}, s.viewer).spendCents).toBe(6130);

    const [held] = listWaitingSetAside(s.viewer);
    expect(held?.rawDescription).toBe('FUEL STOP 12');
    expect(held?.candidate?.origin).toBe('manual');
    expect(dismissSetAsideRow({ id: held!.id, userId: s.alex, viewer: s.viewer, at: new Date('2026-03-10T19:00:00.000Z') })).toEqual({
      ok: true,
    });
    expect(s.count('select count(*) as c from transactions')).toBe(1);

    const next = await s.sync('2026-03-11T18:00:00.000Z');
    expect(next.totalAdded).toBe(0);
    expect(s.count('select count(*) as c from transactions')).toBe(1);
    expect(waitingSetAsideCount()).toBe(0);
    expect(cashflowForRange(MARCH, {}, s.viewer).spendCents).toBe(6130);
  });

  it('Keep both leaves two rows, and the next sync adds nothing', async () => {
    const s = setup();

    await s.sync('2026-03-10T18:00:00.000Z');
    expect(cashflowForRange(MARCH, {}, s.viewer).spendCents).toBe(6130);
    const [held] = listWaitingSetAside(s.viewer);
    const kept = releaseSetAsideRow({ id: held!.id, userId: s.alex, viewer: s.viewer, at: new Date('2026-03-10T19:00:00.000Z') });
    expect(kept).toMatchObject({ ok: true });
    expect(s.count('select count(*) as c from transactions')).toBe(2);
    // Both copies count now: a person said they are two purchases.
    expect(cashflowForRange(MARCH, {}, s.viewer).spendCents).toBe(12260);

    const next = await s.sync('2026-03-11T18:00:00.000Z');
    expect(next.totalAdded).toBe(0);
    expect(s.count('select count(*) as c from transactions')).toBe(2);
    expect(waitingSetAsideCount()).toBe(0);
  });
});
