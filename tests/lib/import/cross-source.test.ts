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

  it('two candidates on other dates: the nearer is listed first and the row is left for the person (owner decision 4)', () => {
    const { account, existing } = setup();
    const far = existing({ date: '2026-03-07', origin: 'manual' });
    const near = existing({ date: '2026-03-09', origin: 'manual' });
    const result = classifyNewRows({ accountId: account, origin: 'csv', rows: [row('h1', '2026-03-10')] });
    const first = result.get('h1');
    expect(first).toMatchObject({ kind: 'possible_duplicate', defaultSkip: false });
    expect(first?.kind === 'possible_duplicate' ? first.candidates.map((c) => c.id) : []).toEqual([near, far]);
  });

  it('a copy on the same date is certain even with another copy nearby', () => {
    const { account, existing } = setup();
    const same = existing({ date: '2026-03-10', origin: 'manual' });
    const other = existing({ date: '2026-03-11', origin: 'manual' });
    const result = classifyNewRows({ accountId: account, origin: 'csv', rows: [row('h1', '2026-03-10')] });
    const first = result.get('h1');
    expect(first).toMatchObject({ kind: 'possible_duplicate', defaultSkip: true });
    expect(first?.kind === 'possible_duplicate' ? first.candidates.map((c) => c.id) : []).toEqual([same, other]);
  });

  it('two rows against two copies pair one-to-one, both ticked, each listing only its own copy', () => {
    const { account, existing } = setup();
    const far = existing({ date: '2026-03-07', origin: 'manual' });
    const near = existing({ date: '2026-03-09', origin: 'manual' });
    const result = classifyNewRows({
      accountId: account,
      origin: 'csv',
      rows: [row('h1', '2026-03-10', -4217, 0), row('h2', '2026-03-10', -4217, 1)],
    });
    expect(result.get('h1')).toEqual({ kind: 'possible_duplicate', defaultSkip: true, candidates: [expect.objectContaining({ id: near })] });
    // The second row cannot take the nearer copy again: it is left the farther one, alone.
    expect(result.get('h2')).toEqual({ kind: 'possible_duplicate', defaultSkip: true, candidates: [expect.objectContaining({ id: far })] });
  });

  it('breaks a distance tie by the lower id', () => {
    const { account, existing } = setup();
    const before = existing({ date: '2026-03-09', origin: 'manual' });
    existing({ date: '2026-03-11', origin: 'manual' });
    const result = classifyNewRows({ accountId: account, origin: 'csv', rows: [row('h1', '2026-03-10')] });
    expect(result.get('h1')).toMatchObject({ candidates: [{ id: before }, {}] });
  });
});

/**
 * Fix round. Ambiguity is judged after every row has claimed, and only a tie on two DIFFERENT dates
 * is ambiguous: copies that share a date and amount are interchangeable.
 */
describe('classifyNewRows: when Leave out starts ticked', () => {
  const COFFEE = -450;

  it('a CSV with two identical coffees against a QFX with the same two ticks both', () => {
    const { account, existing } = setup();
    const first = existing({ date: '2026-03-09', origin: 'ofx', amountCents: COFFEE, description: 'CORNER COFFEE' });
    const second = existing({ date: '2026-03-09', origin: 'ofx', amountCents: COFFEE, description: 'CORNER COFFEE' });
    const result = classifyNewRows({
      accountId: account,
      origin: 'csv',
      rows: [row('c1', '2026-03-09', COFFEE, 0), row('c2', '2026-03-09', COFFEE, 1)],
    });
    expect(result.get('c1')).toEqual({ kind: 'possible_duplicate', defaultSkip: true, candidates: [expect.objectContaining({ id: first })] });
    expect(result.get('c2')).toEqual({ kind: 'possible_duplicate', defaultSkip: true, candidates: [expect.objectContaining({ id: second })] });
  });

  it('one coffee against two identical copies on one day is ticked: they are interchangeable', () => {
    const { account, existing } = setup();
    existing({ date: '2026-03-09', origin: 'ofx', amountCents: COFFEE });
    existing({ date: '2026-03-09', origin: 'ofx', amountCents: COFFEE });
    const result = classifyNewRows({ accountId: account, origin: 'csv', rows: [row('c1', '2026-03-09', COFFEE)] });
    expect(result.get('c1')).toMatchObject({ kind: 'possible_duplicate', defaultSkip: true });
  });

  it('a week of daily coffees from a CSV after the same week from a QFX ticks every row', () => {
    const { account, existing } = setup();
    const days = ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15'];
    const ids = days.map((date) => existing({ date, origin: 'ofx', amountCents: COFFEE, description: 'CORNER COFFEE' }));
    const result = classifyNewRows({
      accountId: account,
      origin: 'csv',
      rows: days.map((date, index) => row(`c${index}`, date, COFFEE, index)),
    });
    days.forEach((_, index) => {
      expect(result.get(`c${index}`)).toEqual({
        kind: 'possible_duplicate',
        defaultSkip: true,
        candidates: [expect.objectContaining({ id: ids[index] })],
      });
    });
  });

  it('a row between a copy the day before and a copy the day after stays unticked', () => {
    const { account, existing } = setup();
    const before = existing({ date: '2026-03-09', origin: 'manual', amountCents: COFFEE });
    const after = existing({ date: '2026-03-11', origin: 'manual', amountCents: COFFEE });
    const result = classifyNewRows({ accountId: account, origin: 'csv', rows: [row('c1', '2026-03-10', COFFEE)] });
    const verdict = result.get('c1');
    expect(verdict).toMatchObject({ kind: 'possible_duplicate', defaultSkip: false });
    expect(verdict?.kind === 'possible_duplicate' ? verdict.candidates.map((c) => c.id) : []).toEqual([before, after]);
  });

  it('a tie stops being one when another row of the file claims one side', () => {
    const { account, existing } = setup();
    const before = existing({ date: '2026-03-09', origin: 'ofx', amountCents: COFFEE });
    const after = existing({ date: '2026-03-11', origin: 'ofx', amountCents: COFFEE });
    const result = classifyNewRows({
      accountId: account,
      origin: 'csv',
      rows: [row('c1', '2026-03-10', COFFEE, 0), row('c2', '2026-03-11', COFFEE, 1)],
    });
    expect(result.get('c1')).toEqual({ kind: 'possible_duplicate', defaultSkip: true, candidates: [expect.objectContaining({ id: before })] });
    expect(result.get('c2')).toEqual({ kind: 'possible_duplicate', defaultSkip: true, candidates: [expect.objectContaining({ id: after })] });
  });
});

/**
 * Fix round. A transaction a row from the incoming road was already set aside against is that
 * row's copy; a later row from the same road cannot be listed against it again.
 */
describe('classifyNewRows: copies already decided by an earlier import', () => {
  const COFFEE = -450;
  function setAsideAgainst(input: {
    account: number;
    alex: number;
    candidate: number;
    origin: 'csv' | 'ofx' | 'simplefin';
    key: string;
    state?: 'waiting' | 'dismissed';
  }) {
    return recordSetAside({
      accountId: input.account,
      importId: null,
      state: input.state ?? 'dismissed',
      reason: 'possible_duplicate',
      origin: input.origin,
      date: '2026-03-09',
      amountCents: COFFEE,
      rawDescription: 'CORNER COFFEE',
      attributedUserId: input.alex,
      dedupHash: input.origin === 'csv' ? input.key : null,
      externalId: input.origin === 'csv' ? null : input.key,
      hashVersion: 1,
      candidateTxnId: input.candidate,
      decidedBy: input.alex,
      at: new Date('2026-03-12T15:00:00.000Z'),
    });
  }

  it('a second CSV does not list the hand-typed coffee an earlier CSV row was left out against', () => {
    const { account, alex, existing } = setup();
    const typed = existing({ date: '2026-03-09', origin: 'manual', amountCents: COFFEE, description: 'COFFEE' });
    setAsideAgainst({ account, alex, candidate: typed, origin: 'csv', key: 'csv1-coffee-0309' });
    // CSV #2 carries the genuine second coffee, three days later.
    const result = classifyNewRows({ accountId: account, origin: 'csv', rows: [row('csv2-coffee-0312', '2026-03-12', COFFEE)] });
    expect(result.get('csv2-coffee-0312')).toEqual({ kind: 'new' });
  });

  it('a row still waiting in Needs review holds its copy too', () => {
    const { account, alex, existing } = setup();
    const typed = existing({ date: '2026-03-09', origin: 'manual', amountCents: COFFEE });
    setAsideAgainst({ account, alex, candidate: typed, origin: 'simplefin', key: 'sf-1', state: 'waiting' });
    expect(classifyNewRows({ accountId: account, origin: 'simplefin', rows: [row('sf-2', '2026-03-10', COFFEE)] }).get('sf-2')).toEqual({
      kind: 'new',
    });
  });

  it('a record from another road leaves the copy in: SimpleFIN still matches the CSV row a QFX copy was left out against', () => {
    const { account, alex, existing } = setup();
    const csvRow = existing({ date: '2026-03-09', origin: 'csv', amountCents: COFFEE, description: 'CORNER COFFEE' });
    setAsideAgainst({ account, alex, candidate: csvRow, origin: 'ofx', key: 'FIT-0309' });
    const result = classifyNewRows({ accountId: account, origin: 'simplefin', rows: [row('sf-0309', '2026-03-09', COFFEE)] });
    expect(result.get('sf-0309')).toEqual({ kind: 'possible_duplicate', defaultSkip: true, candidates: [expect.objectContaining({ id: csvRow })] });
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
