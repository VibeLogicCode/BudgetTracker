import Link from 'next/link';
import type { BackupHealth } from '@/lib/backup';

function sentence(health: BackupHealth): string {
  switch (health.state) {
    case 'failed':
      return "Last night's backup failed";
    case 'none':
      return 'No backup yet';
    case 'stale': {
      const days = Math.floor((health.ageHours ?? 0) / 24);
      return days >= 2 ? `No backup for ${days} days` : 'No backup for over a day';
    }
    case 'ok': {
      const hours = health.ageHours ?? 0;
      if (hours < 1) return 'Last backup less than an hour ago';
      return `Last backup ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
    }
  }
}

/**
 * v1.60.0: one line on backup health, computed by backupHealth (src/lib/backup.ts). Muted while
 * the backups are fine; warning-toned, in words that say what is wrong, when the last one failed,
 * they have stopped, or there has never been one. Always links to Settings, Backups, where the
 * failure reason is shown. Admin-only at the call site.
 */
export function BackupHealthLine({ health }: { health: BackupHealth }) {
  const tone = health.state === 'ok' ? 'text-muted' : 'text-warning';
  return (
    <p data-testid="backup-health-line" className={`text-sm ${tone}`}>
      {sentence(health)} ·{' '}
      <Link href="/settings/backups" className="font-medium text-accent-text underline underline-offset-2">
        Settings, Backups
      </Link>
    </p>
  );
}
