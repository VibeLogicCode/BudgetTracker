import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSplitPersonFixture, type SplitPersonFixture } from '../helpers/split-person-fixture';
import type { SessionUser } from '@/lib/auth/session';
import { getSplits } from '@/lib/splits';
import { personSpendSplit } from '@/lib/reports';
import { budgetProgress } from '@/lib/budgets';
import { getTransactionShare, bulkSetAttribution } from '@/lib/transactions';
import { captureBulkBefore, recordBulkUndo, undoLastBulkAction } from '@/lib/bulk-undo';

/**
 * v1.63.0 (plan 2026-11-12, D5). Alex splits MAPLE GROCER so three parts belong to three people, and
 * every figure that reads a part's person agrees; then a bulk Set person and its Undo.
 */
let currentUser: SessionUser = { id: 1, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
vi.mock('@/lib/auth/session', () => ({ requireUser: vi.fn(async () => currentUser) }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { saveSplitsAction } from '@/app/(app)/transactions/actions';

let f: SplitPersonFixture | null = null;
afterEach(() => {
  f?.t.cleanup();
  f = null;
});

const MARCH = { from: '2026-03-01', to: '2026-03-31' };

async function alexSplitsMaple(fx: SplitPersonFixture) {
  currentUser = { id: fx.alex, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
  const result = await saveSplitsAction(
    {},
    (() => {
      const fd = new FormData();
      fd.set('txnId', String(fx.maple));
      fd.set(
        'parts',
        JSON.stringify([
          { categoryId: fx.groceries, amountCents: -8000, person: 'follow' },
          { categoryId: fx.dining, amountCents: -4000, person: fx.sam },
          { categoryId: fx.supplies, amountCents: -3000, person: 'household' },
        ]),
      );
      return fd;
    })(),
  );
  expect(result.error).toBeUndefined();
}

describe('split person, end to end (v1.63.0)', () => {
  it('Alex splits through the action; reports, Sam budget and Sam share all follow the parts', async () => {
    f = buildSplitPersonFixture({ allFollow: true });
    await alexSplitsMaple(f);

    const split = personSpendSplit(MARCH, f.admin);
    const by = (id: number | null) => split.find((row) => row.userId === id)?.spentCents;
    expect([by(f.alex), by(f.sam), by(null)]).toEqual([8000, 10130, 3000]);

    const dining = budgetProgress('2026-03', 'personal', f.sam).find((row) => row.categoryId === f!.dining);
    expect(dining?.spentCents).toBe(4000);

    const share = getTransactionShare(f.maple, f.self(f.sam));
    expect(share).toMatchObject({ amountCents: -4000, partial: true, parentAmountCents: null });
  });

  it('bulk Set person moves the part that follows and leaves the set parts; Undo puts it back', async () => {
    f = buildSplitPersonFixture({ allFollow: true });
    await alexSplitsMaple(f);
    const written = () => getSplits(f!.maple).map((p) => [p.personSet, p.attributedUserId]);
    const first = written();

    const before = captureBulkBefore({ ids: [f.maple] });
    bulkSetAttribution([f.maple], f.sam);
    recordBulkUndo({ userId: f.alex, kind: 'person', label: 'Set Sam on 1 transaction.', before, at: new Date('2026-03-14T15:00:00.000Z') });
    // The Groceries part follows Sam now; Dining stays Sam's and Household supplies stays Household.
    const moved = personSpendSplit(MARCH, f.admin);
    expect(moved.find((r) => r.userId === f!.sam)?.spentCents).toBe(8000 + 4000 + 6130);
    expect(moved.find((r) => r.userId === null)?.spentCents).toBe(3000);
    expect(written()).toEqual(first);

    undoLastBulkAction({ viewer: f.admin, now: new Date('2026-03-14T15:05:00.000Z') });
    const back = personSpendSplit(MARCH, f.admin);
    expect(back.find((r) => r.userId === f!.alex)?.spentCents).toBe(8000);
    expect(back.find((r) => r.userId === f!.sam)?.spentCents).toBe(10130);
  });
});
