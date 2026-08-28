import { describe, it, expect, afterEach } from 'vitest';
import type { Viewer } from '@/lib/auth/viewer';
import { getWarrantyItem } from '@/lib/warranty/items';
import { searchWarrantyItems } from '@/lib/warranty/search';
import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function typeOfKind(kind: string, name: string): number {
  const row = current!.sqlite
    .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values (?, ?, ?, ?) returning id`)
    .get(name, kind === 'subscription' ? 1 : 0, kind, '2026-08-27T00:00:00.000Z') as { id: number };
  return row.id;
}

function makeItem(over: { name: string; ownerUserId: number; typeId: number | null }): number {
  const row = current!.sqlite
    .prepare(
      `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
       values (?, '2024-01-15', 0, ?, ?, ?, ?) returning id`,
    )
    .get(over.name, over.ownerUserId, over.typeId, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z') as {
    id: number;
  };
  return row.id;
}

describe('ruling R2 + R3: warranty reads take a viewer', () => {
  let adultId = 0;
  let childId = 0;
  let adultItem = 0;
  let childItem = 0;

  function seed(): void {
    current = createTestDb();
    adultId = insertTestUser(current.db, { name: 'Person One', username: 'user-1', role: 'admin' });
    childId = insertTestUser(current.db, { name: 'Person Two', username: 'user-2', role: 'member' });
    // 0003 seeds a default type row already named 'Appliance' -- a distinct name avoids colliding
    // with it under the table's COLLATE NOCASE unique index.
    const typeId = typeOfKind('warranty', 'Visibility Test Appliance');
    adultItem = makeItem({ name: 'Dishwasher', ownerUserId: adultId, typeId });
    childItem = makeItem({ name: 'Bicycle', ownerUserId: childId, typeId });
  }

  const child = (): Viewer => ({ id: childId, role: 'member', visibility: 'self' });
  const adult = (): Viewer => ({ id: adultId, role: 'admin', visibility: 'household' });

  it('getWarrantyItem returns null for another owner id -- this is what makes /warranties/[id] 404', () => {
    seed();
    expect(getWarrantyItem(adultItem, child())).toBeNull();
    expect(getWarrantyItem(childItem, child())?.id).toBe(childItem);
    expect(getWarrantyItem(adultItem, adult())?.id).toBe(adultItem);
  });

  it('searchWarrantyItems lists only the viewer own items for a self viewer', () => {
    seed();
    expect(searchWarrantyItems({}, child()).rows.map((row) => row.id)).toEqual([childItem]);
    expect(searchWarrantyItems({}, adult()).total).toBe(2);
  });

  it('a self viewer asking for another owner gets nothing, not that owner rows', () => {
    seed();
    expect(searchWarrantyItems({ ownerUserId: adultId }, child()).rows).toEqual([]);
  });
});
