import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { classifyNewRows, type ClassifyRow } from '@/lib/import/cross-source';
import { recordSetAside } from '@/lib/import/set-aside';
import type { RowOrigin } from '@/lib/import/origin';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
  const sam = insertTestUser(current.db, { name: 'Sam', username: 'sam' });
  const account = insertTestAccount(current.db, { name: 'Joint chequing', ownerUserId: alex });
  const other = insertTestAccount(current.db, { name: 'Sam Visa', type: 'credit', ownerUserId: sam });
  const t = current;
  /** One row already in an account, arrived by `origin`. */
  const existing = (over: {
    accountId?: number;
    date: string;
    amountCents?: number;
    origin: RowOrigin;
    description?: string;
    displayDescription?: string | null;
    person?: number | null;
  }) =>
    (
      t.sqlite
        .prepare(
          `insert into transactions (account_id, attributed_user_id, date, raw_description, display_description,
             normalized_merchant, amount_cents, origin, created_by, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z') returning id`,
        )
        .get(
          over.accountId ?? account,
          over.person === undefined ? alex : over.person,
          over.date,
          over.description ?? 'MAPLE GROCER',
          over.displayDescription ?? null,
          over.description ?? 'MAPLE GROCER',
          over.amountCents ?? -4217,
          over.origin,
          alex,
        ) as { id: number }
    ).id;
  return { alex, sam, account, other, existing };
}

const row = (key: string, date: string, amountCents = -4217, rowIndex = 0): ClassifyRow => ({ key, rowIndex, date, amountCents });

describe('classifyNewRows: a possible duplicate', () => {
  it('matches a CSV row against a hand-typed row 2 days earlier, and lists that row', () => {
    const { account, existing } = setup();
    const id = existing({ date: '2026-03-08', origin: 'manual', displayDescription: 'Maple Grocer' });
    const result = classifyNewRows({ accountId: account, origin: 'csv', rows: [row('h1', '2026-03-10')] });
    expect(result.get('h1')).toEqual({
      kind: 'possible_duplicate',
      defaultSkip: true,
      candidates: [{ id, date: '2026-03-08', description: 'Maple Grocer', amountCents: -4217, origin: 'manual', personName: 'Alex' }],
    });
  });

  it('does not match 4 days apart, or 1 cent off', () => {
    const { account, existing } = setup();
    existing({ date: '2026-03-06', origin: 'manual' });
    existing({ date: '2026-03-10', origin: 'manual', amountCents: -4216 });
    const result = classifyNewRows({ accountId: account, origin: 'csv', rows: [row('h1', '2026-03-10')] });
    expect(result.get('h1')).toEqual({ kind: 'new' });
  });

  it('never compares a CSV row with a CSV row', () => {
    const { account, existing } = setup();
    existing({ date: '2026-03-10', origin: 'csv' });
    expect(classifyNewRows({ accountId: account, origin: 'csv', rows: [row('h1', '2026-03-10')] }).get('h1')).toEqual({ kind: 'new' });
  });

  it('matches a QFX row against a SimpleFIN row', () => {
    const { account, existing } = setup();
    const id = existing({ date: '2026-03-11', origin: 'simplefin' });
    const result = classifyNewRows({ accountId: account, origin: 'ofx', rows: [row('FIT-1', '2026-03-10')] });
    expect(result.get('FIT-1')).toMatchObject({ kind: 'possible_duplicate', defaultSkip: true, candidates: [{ id, origin: 'simplefin' }] });
  });

  it('never looks at another account', () => {
    const { account, other, existing } = setup();
    existing({ accountId: other, date: '2026-03-10', origin: 'manual' });
    expect(classifyNewRows({ accountId: account, origin: 'csv', rows: [row('h1', '2026-03-10')] }).get('h1')).toEqual({ kind: 'new' });
  });
});

describe('classifyNewRows: one-to-one claiming', () => {
  it('two identical same-day incoming rows against one hand-typed row give one match and one new row', () => {
    const { account, existing } = setup();
    const id = existing({ date: '2026-03-10', origin: 'manual' });
    const result = classifyNewRows({
      accountId: account,
      origin: 'csv',
      rows: [row('h2', '2026-03-10', -4217, 1), row('h1', '2026-03-10', -4217, 0)],
    });
    // File order decides: row 0 claims the hand-typed copy.
    expect(result.get('h1')).toMatchObject({ kind: 'possible_duplicate', candidates: [{ id }] });
    expect(result.get('h2')).toEqual({ kind: 'new' });
  });

  it('two identical same-day rows with no other source are both new', () => {
    const { account } = setup();
    const result = classifyNewRows({
      accountId: account,
      origin: 'simplefin',
      rows: [row('sf-1', '2026-03-10', -4217, 0), row('sf-2', '2026-03-10', -4217, 1)],
    });
    expect([...result.values()]).toEqual([{ kind: 'new' }, { kind: 'new' }]);
  });

  it('two candidates: not ticked by default, both listed nearest first, and the nearer one is claimed', () => {
    const { account, existing } = setup();
    const far = existing({ date: '2026-03-07', origin: 'manual' });
    const near = existing({ date: '2026-03-09', origin: 'manual' });
    const result = classifyNewRows({
      accountId: account,
      origin: 'csv',
      rows: [row('h1', '2026-03-10', -4217, 0), row('h2', '2026-03-10', -4217, 1)],
    });
    const first = result.get('h1');
    expect(first).toMatchObject({ kind: 'possible_duplicate', defaultSkip: false });
    expect(first?.kind === 'possible_duplicate' ? first.candidates.map((c) => c.id) : []).toEqual([near, far]);
    // The second row cannot take the nearer copy again: it is left the farther one, alone.
    expect(result.get('h2')).toMatchObject({ kind: 'possible_duplicate', defaultSkip: true, candidates: [{ id: far }] });
  });

  it('breaks a distance tie by the lower id', () => {
    const { account, existing } = setup();
    const before = existing({ date: '2026-03-09', origin: 'manual' });
    existing({ date: '2026-03-11', origin: 'manual' });
    const result = classifyNewRows({ accountId: account, origin: 'csv', rows: [row('h1', '2026-03-10')] });
    expect(result.get('h1')).toMatchObject({ candidates: [{ id: before }, {}] });
  });
});

describe('classifyNewRows: set-aside records', () => {
  it('a set-aside key wins over a possible duplicate', () => {
    const { account, existing, alex } = setup();
    const candidate = existing({ date: '2026-03-10', origin: 'manual' });
    const id = recordSetAside({
      accountId: account,
      importId: null,
      state: 'dismissed',
      reason: 'possible_duplicate',
      origin: 'csv',
      date: '2026-03-10',
      amountCents: -4217,
      rawDescription: 'MAPLE GROCER',
      attributedUserId: alex,
      dedupHash: 'h1',
      externalId: null,
      hashVersion: 1,
      candidateTxnId: candidate,
      decidedBy: alex,
      at: new Date('2026-03-12T15:00:00.000Z'),
    });
    const result = classifyNewRows({ accountId: account, origin: 'csv', rows: [row('h1', '2026-03-10')] });
    expect(result.get('h1')).toEqual({
      kind: 'set_aside',
      id,
      state: 'dismissed',
      reason: 'possible_duplicate',
      decidedAt: '2026-03-12T15:00:00.000Z',
    });
  });

  it('finds a provider-id record by the same key', () => {
    const { account } = setup();
    const id = recordSetAside({
      accountId: account,
      importId: null,
      state: 'waiting',
      reason: 'possible_duplicate',
      origin: 'simplefin',
      date: '2026-03-10',
      amountCents: -4217,
      rawDescription: 'MAPLE GROCER',
      attributedUserId: null,
      dedupHash: '',
      externalId: 'sf-txn-1',
      hashVersion: 1,
      candidateTxnId: null,
      at: new Date('2026-03-10T15:00:00.000Z'),
    });
    expect(classifyNewRows({ accountId: account, origin: 'simplefin', rows: [row('sf-txn-1', '2026-03-10')] }).get('sf-txn-1')).toEqual({
      kind: 'set_aside',
      id,
      state: 'waiting',
      reason: 'possible_duplicate',
      decidedAt: null,
    });
  });
});
