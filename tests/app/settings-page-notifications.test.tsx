// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, cleanup, screen } from '@testing-library/react';
import { createTestDb } from '../helpers/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const settingsPage = fs.readFileSync(path.join(root, 'src/app/(app)/settings/page.tsx'), 'utf8');

const currentUser = vi.hoisted(() => ({
  value: { id: 1, name: 'Sam', username: 'sam', role: 'member' as 'admin' | 'member' },
}));

vi.mock('@/lib/auth/session', () => ({
  requireUser: async () => currentUser.value,
  // F-09: unrelated to what this file tests (the notifications entry point and the
  // admin-only Updates card) -- an empty session list and no "current device" match keep
  // page.tsx's new Sessions card rendering without pulling a real database session into
  // every test in this file.
  listSessionsForUser: () => [],
  getCurrentSessionId: async () => null,
}));
vi.mock('@/lib/auth/users', () => ({
  findUserByUsername: () => null,
}));
vi.mock('@/lib/auth/totp', () => ({
  countUnusedRecoveryCodes: () => 0,
}));

afterEach(cleanup);

describe('MUST-11.1: the Settings entry point', () => {
  it('links to /settings/notifications with the specified blurb', () => {
    expect(settingsPage).toContain('/settings/notifications');
    // Review fix (LOW): case-insensitive — the copy reads better capitalized ("Where...") as a
    // sentence-style CardHeader description; the wording itself is what's pinned here, not casing.
    expect(settingsPage).toMatch(/where the app messages you, and about what/i);
  });

  it('is a PERSONAL card, not an ADMIN_LINKS entry — every member configures their own', () => {
    const adminBlock = settingsPage.slice(settingsPage.indexOf('ADMIN_LINKS'), settingsPage.indexOf('export default'));
    expect(adminBlock).not.toContain('/settings/notifications');
  });

  it('uses the new BellIcon', () => {
    expect(settingsPage).toContain('BellIcon');
    expect(fs.readFileSync(path.join(root, 'src/components/icons.tsx'), 'utf8')).toContain('export function BellIcon');
  });

  it('MUST-9.4 precursor: the notifications directory contains no fetch call', () => {
    const dir = path.join(root, 'src/app/(app)/settings/notifications');
    for (const entry of fs.readdirSync(dir)) {
      if (!/\.tsx?$/.test(entry)) continue;
      expect(fs.readFileSync(path.join(dir, entry), 'utf8')).not.toMatch(/\bfetch\s*\(/);
    }
  });
});

describe('MUST-9.1: the Updates card', () => {
  // The database is not optional here, even though this test asserts an ABSENCE. SettingsPage
  // reads a setting while it renders (readOcrEngineState -> getSetting -> getDb), so without a
  // temp data directory of its own this test only passes when some other file in the same vitest
  // worker happened to leave one behind first -- which it did, until v1.19.0 added test files and
  // shifted the ordering. It then failed in CI with "Cannot open database because the directory
  // does not exist" while still passing locally, because worker assignment differs between the
  // two. Owning the database, the way the admin test below already does, is what makes this test
  // independent of what runs beside it.
  it('a member sees no Updates card', async () => {
    const t = createTestDb();
    try {
      currentUser.value.role = 'member';
      const { default: SettingsPage } = await import('@/app/(app)/settings/page');
      render(await SettingsPage());
      expect(screen.queryByText('Updates')).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  // Review fix (LOW): the positive mirror of the test above — without it, deleting
  // <UpdatesCard /> from page.tsx would leave every test in this file green.
  it('an admin sees the Updates card', async () => {
    const t = createTestDb();
    try {
      currentUser.value.role = 'admin';
      const { default: SettingsPage } = await import('@/app/(app)/settings/page');
      render(await SettingsPage());
      expect(screen.getByText('Updates')).toBeTruthy();
    } finally {
      currentUser.value.role = 'member';
      t.cleanup();
    }
  });
});

/**
 * Backlog item 17 / Part 4: the preset-pack update line lives inside the SAME admin-only card
 * (MUST-9.1), so proving the card itself is admin-only (above) already covers it structurally --
 * these two tests pin the actual TEXT, with a real pending update in the database, so deleting
 * canadianPackState()'s wiring into UpdatesCard would fail here even if the card's own title
 * still rendered.
 */
describe('backlog item 17 / Part 4: the Updates card carries the preset-pack line for an admin only', () => {
  function installStalePackRow(t: ReturnType<typeof createTestDb>): void {
    t.sqlite
      .prepare(
        `insert into merchant_rules
           (pattern, match_type, rule_kind, category_id, rename_to, hit_count, created_at, pack_source, pack_version, installed_at)
         values ('OLD PATTERN', 'exact', 'rename', null, 'Old Pattern', 0, '2026-01-01T00:00:00.000Z', 'canadian-merchants', 0, '2026-01-01T00:00:00.000Z')`,
      )
      .run();
  }

  it('an admin sees the pack-update line when the installed version is behind the bundled one', async () => {
    const t = createTestDb();
    try {
      installStalePackRow(t);
      currentUser.value.role = 'admin';
      const { default: SettingsPage } = await import('@/app/(app)/settings/page');
      render(await SettingsPage());
      expect(screen.getByText('Preset rules: an update is available')).toBeTruthy();
    } finally {
      currentUser.value.role = 'member';
      t.cleanup();
    }
  });

  it('a member sees neither the Updates card nor the pack-update line', async () => {
    const t = createTestDb();
    try {
      installStalePackRow(t);
      currentUser.value.role = 'member';
      const { default: SettingsPage } = await import('@/app/(app)/settings/page');
      render(await SettingsPage());
      expect(screen.queryByText('Updates')).toBeNull();
      expect(screen.queryByText('Preset rules: an update is available')).toBeNull();
    } finally {
      t.cleanup();
    }
  });
});
