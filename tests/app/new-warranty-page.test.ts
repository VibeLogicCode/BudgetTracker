import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { nowIso } from '@/lib/clock';

/**
 * v1.13.0 fix round 1 (controller ruling). `src/app/(app)/warranties/new/page.tsx` used to call
 * getTransaction(transactionId) with one argument; Task 3 made it viewer-scoped. This pins the
 * fix: a self-scoped viewer whose ?transactionId= query param names ANOTHER household member's
 * transaction gets null back from getTransaction (the same null an unknown id gets), and the page
 * must treat that as "no prefill" -- an empty form -- never a 404. A household viewer (or any
 * viewer looking at their own transaction) is unaffected and still gets the real prefill.
 */

let currentUser: { id: number; name: string; username: string; role: 'admin' | 'member'; visibility: 'household' | 'self' };

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => currentUser),
}));

import NewWarrantyPage from '@/app/(app)/warranties/new/page';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let ownerId: number;
let otherId: number;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-new-warranty-page-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  ownerId = insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'member' });
  otherId = insertTestUser(current.db, { name: 'Bob', username: 'bob', role: 'member' });
  currentUser = { id: ownerId, name: 'Alice', username: 'alice', role: 'member', visibility: 'household' };
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function insertTransaction(attributedUserId: number): number {
  const accountId = insertTestAccount(current!.db, { name: 'Joint Chequing' });
  const row = current!.db.get<{ id: number }>(sql`
    insert into transactions (account_id, attributed_user_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
    values (${accountId}, ${attributedUserId}, '2026-08-16', 'HOME DEPOT', 'HOME DEPOT', -129999, ${attributedUserId}, ${nowIso()}, ${nowIso()})
    returning id`);
  return row.id;
}

// Minimal shape of what NewWarrantyClient's props actually carry -- enough to read `prefill`
// back off the element the page returns, without rendering to a DOM.
interface NewWarrantyClientElement {
  props: { prefill: Record<string, unknown> };
}

describe('NewWarrantyPage prefill', () => {
  it('a self-scoped viewer prefilling from another household member transaction gets an empty form, not a 404', async () => {
    const txnId = insertTransaction(ownerId);
    currentUser = { id: otherId, name: 'Bob', username: 'bob', role: 'member', visibility: 'self' };

    const element = (await NewWarrantyPage({
      searchParams: Promise.resolve({ transactionId: String(txnId) }),
    })) as unknown as NewWarrantyClientElement;
    expect(element.props.prefill).toEqual({});
  });

  it('a household viewer still gets prefilled from any transaction id', async () => {
    const txnId = insertTransaction(otherId);
    currentUser = { id: ownerId, name: 'Alice', username: 'alice', role: 'member', visibility: 'household' };

    const element = (await NewWarrantyPage({
      searchParams: Promise.resolve({ transactionId: String(txnId) }),
    })) as unknown as NewWarrantyClientElement;
    expect(element.props.prefill).toMatchObject({ transactionId: txnId, priceCents: 129999 });
  });

  it('a viewer prefilling from their own transaction still gets it, even when self-scoped', async () => {
    const txnId = insertTransaction(otherId);
    currentUser = { id: otherId, name: 'Bob', username: 'bob', role: 'member', visibility: 'self' };

    const element = (await NewWarrantyPage({
      searchParams: Promise.resolve({ transactionId: String(txnId) }),
    })) as unknown as NewWarrantyClientElement;
    expect(element.props.prefill).toMatchObject({ transactionId: txnId });
  });

  it('an unknown transaction id also renders an empty prefill, not a 404 (unchanged behaviour)', async () => {
    const element = (await NewWarrantyPage({
      searchParams: Promise.resolve({ transactionId: '999999' }),
    })) as unknown as NewWarrantyClientElement;
    expect(element.props.prefill).toEqual({});
  });
});
