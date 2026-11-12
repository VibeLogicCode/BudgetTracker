// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BackupHealthLine } from '@/components/BackupHealthLine';
import type { BackupHealth } from '@/lib/backup';

afterEach(() => cleanup());

function health(over: Partial<BackupHealth>): BackupHealth {
  return { lastBackupAt: '2026-11-12T08:00:00.000Z', ageHours: 7, state: 'ok', failureReason: null, ...over };
}

function line(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="backup-health-line"]') as HTMLElement;
}

/** v1.60.0 item 7d: one line, quiet when the backups are fine and warning-toned when they are not. */
describe('BackupHealthLine', () => {
  it('reads as one muted line when the last backup is recent', () => {
    const { container } = render(<BackupHealthLine health={health({ ageHours: 7 })} />);
    expect(screen.getByText(/Last backup 7 hours ago/)).toBeTruthy();
    expect(line(container).className).toContain('text-muted');
    expect(line(container).className).not.toContain('text-warning');
  });

  it('says one hour, and less than an hour, in words', () => {
    render(<BackupHealthLine health={health({ ageHours: 1 })} />);
    expect(screen.getByText(/Last backup 1 hour ago/)).toBeTruthy();
    cleanup();
    render(<BackupHealthLine health={health({ ageHours: 0 })} />);
    expect(screen.getByText(/Last backup less than an hour ago/)).toBeTruthy();
  });

  it('warns when the last backup failed', () => {
    const { container } = render(
      <BackupHealthLine health={health({ state: 'failed', failureReason: 'ENOSPC: no space left on device', ageHours: 31 })} />,
    );
    expect(screen.getByText(/Last night's backup failed/)).toBeTruthy();
    expect(line(container).className).toContain('text-warning');
  });

  it('warns with the age in days when backups have stopped', () => {
    const { container } = render(<BackupHealthLine health={health({ state: 'stale', ageHours: 80 })} />);
    expect(screen.getByText(/No backup for 3 days/)).toBeTruthy();
    expect(line(container).className).toContain('text-warning');
  });

  it('does not say "1 days" just past the stale edge', () => {
    render(<BackupHealthLine health={health({ state: 'stale', ageHours: 30 })} />);
    expect(screen.getByText(/No backup for over a day/)).toBeTruthy();
  });

  it('warns when there has never been a backup', () => {
    const { container } = render(<BackupHealthLine health={health({ state: 'none', lastBackupAt: null, ageHours: null })} />);
    expect(screen.getByText(/No backup yet/)).toBeTruthy();
    expect(line(container).className).toContain('text-warning');
  });

  for (const state of ['ok', 'failed', 'stale', 'none'] as const) {
    it(`links to Settings, Backups (${state})`, () => {
      render(<BackupHealthLine health={health({ state, ageHours: state === 'none' ? null : 80 })} />);
      expect(screen.getByRole('link', { name: 'Settings, Backups' }).getAttribute('href')).toBe('/settings/backups');
    });
  }
});
