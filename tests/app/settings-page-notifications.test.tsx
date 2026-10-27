// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, cleanup, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
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

// v1.58.1 told an admin about the shared default update token in a banner above the card; v1.59.1
// makes it one quiet line inside the card, with a Fix helper. Updates stay allowed; this only warns.
describe('v1.59.1: the legacy update token line', () => {
  const LINE = 'Update token: shared default';
  const OLD_BANNER = /still the shared default from older compose files/;
  const WATCHTOWER_URL = 'http://watchtower:8080/v1/update';
  const originalToken = process.env.WATCHTOWER_TOKEN;
  const originalUrl = process.env.WATCHTOWER_URL;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.WATCHTOWER_TOKEN;
    else process.env.WATCHTOWER_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.WATCHTOWER_URL;
    else process.env.WATCHTOWER_URL = originalUrl;
  });

  async function renderAs(role: 'admin' | 'member', token: string) {
    const t = createTestDb();
    try {
      process.env.WATCHTOWER_URL = WATCHTOWER_URL;
      process.env.WATCHTOWER_TOKEN = token;
      currentUser.value.role = role;
      const { default: SettingsPage } = await import('@/app/(app)/settings/page');
      render(await SettingsPage());
    } finally {
      currentUser.value.role = 'member';
      t.cleanup();
    }
  }

  it('shows an admin one quiet line and a Fix for the old shared value, and no banner', async () => {
    const { LEGACY_WATCHTOWER_TOKEN } = await import('@/lib/update/watchtower');
    await renderAs('admin', LEGACY_WATCHTOWER_TOKEN);
    expect(screen.getByText(LINE)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fix' }).getAttribute('aria-haspopup')).toBe('dialog');
    // The old Notice's title is now only the closed Sheet's, and its body copy is gone.
    expect(screen.queryByText('Change the update token')).toBeNull();
    expect(screen.queryByText(OLD_BANNER)).toBeNull();
  });

  it('shows nothing for another value', async () => {
    await renderAs('admin', 'f3a9c1d27b8e4a6f90b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d');
    expect(screen.queryByText(LINE)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fix' })).toBeNull();
  });

  it('shows a member nothing, even for the old shared value', async () => {
    const { LEGACY_WATCHTOWER_TOKEN } = await import('@/lib/update/watchtower');
    await renderAs('member', LEGACY_WATCHTOWER_TOKEN);
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it('MUST-7.3: the card is told a boolean, and neither its props nor the markup carry the token', async () => {
    const { LEGACY_WATCHTOWER_TOKEN } = await import('@/lib/update/watchtower');
    const { UpdatesCard } = await import('@/app/(app)/settings/updates-card');
    const t = createTestDb();
    try {
      process.env.WATCHTOWER_URL = WATCHTOWER_URL;
      process.env.WATCHTOWER_TOKEN = LEGACY_WATCHTOWER_TOKEN;
      const card = UpdatesCard();
      const props = card.props as Record<string, unknown>;
      expect(props.legacyToken).toBe(true);
      expect(JSON.stringify(props)).not.toContain(LEGACY_WATCHTOWER_TOKEN);
      expect(JSON.stringify(props)).not.toContain(WATCHTOWER_URL);
      const html = renderToStaticMarkup(card);
      expect(html).toContain(LINE);
      expect(html).not.toContain(LEGACY_WATCHTOWER_TOKEN);
      expect(html).not.toContain(WATCHTOWER_URL);
    } finally {
      t.cleanup();
    }
  });
});
