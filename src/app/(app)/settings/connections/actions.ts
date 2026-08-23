'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import { getAccount } from '@/lib/accounts';
import {
  AUTO_SYNC_INTERVALS,
  SETTING_AUTO_SYNC,
  SETTING_AUTO_SYNC_USER_ID,
  type AutoSyncInterval,
  deleteConnection,
  listLinks,
} from '@/lib/simplefin/connection';
import { deleteSetting, setSetting } from '@/lib/settings';

export interface ConnectionsState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

export async function forgetConnectionAction(): Promise<ConnectionsState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();

  // Capture the affected account names BEFORE deleting: deleteConnection()
  // also clears every account link (they revert to CSV-managed), so this is
  // the last point the mapping is still readable.
  const affectedNames = listLinks()
    .map((link) => getAccount(link.accountId)?.name)
    .filter((name): name is string => Boolean(name));

  deleteConnection();
  revalidatePath('/settings/connections');
  revalidatePath('/import');

  return {
    message:
      affectedNames.length > 0
        ? `Connection removed. ${affectedNames.join(', ')} ${affectedNames.length === 1 ? 'reverts' : 'revert'} to CSV import.`
        : 'Connection removed. The stored access URL was deleted.',
  };
}

/** 'off' plus the same four keys the scheduler and the <select> both read from AUTO_SYNC_INTERVALS. */
const AUTO_SYNC_KEYS = Object.keys(AUTO_SYNC_INTERVALS) as [AutoSyncInterval, ...AutoSyncInterval[]];
const autoSyncValueSchema = z.union([z.literal('off'), z.enum(AUTO_SYNC_KEYS)]);

/**
 * Task 8: writes (or, for 'off', deletes) BOTH settings keys together, so the scheduler never
 * finds an interval with no user id or a user id with no interval. Same guard order as
 * forgetConnectionAction above: cross-origin first, then requireAdmin.
 */
export async function setSimplefinAutoSyncAction(value: string): Promise<ConnectionsState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const admin = await requireAdmin();

  const parsed = autoSyncValueSchema.safeParse(value);
  if (!parsed.success) return { error: 'That is not a valid automatic sync interval.' };

  if (parsed.data === 'off') {
    deleteSetting(SETTING_AUTO_SYNC);
    deleteSetting(SETTING_AUTO_SYNC_USER_ID);
    revalidatePath('/settings/connections');
    return { message: 'Automatic sync is off.' };
  }

  setSetting(SETTING_AUTO_SYNC, parsed.data);
  setSetting(SETTING_AUTO_SYNC_USER_ID, String(admin.id));
  revalidatePath('/settings/connections');
  return { message: `Automatic sync is on: ${AUTO_SYNC_INTERVALS[parsed.data].label.toLowerCase()}.` };
}
