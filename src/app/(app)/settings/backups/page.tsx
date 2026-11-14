import { requireAdmin } from '@/lib/auth/session';
import { backupHealth, getBackupRetention, listBackups } from '@/lib/backup';
import { readRestoreState } from '@/lib/backup/restore';
import { RESTORE_UPLOAD_CHUNK_BYTES, RESTORE_UPLOAD_MAX_BYTES } from '@/lib/backup/restore-upload';
import { BackupsClient } from './backups-client';

export const dynamic = 'force-dynamic';

export default async function BackupsPage() {
  await requireAdmin();
  return (
    <BackupsClient
      backups={listBackups()}
      retention={getBackupRetention()}
      restore={readRestoreState()}
      health={backupHealth()}
      upload={{ maxBytes: RESTORE_UPLOAD_MAX_BYTES, chunkBytes: RESTORE_UPLOAD_CHUNK_BYTES }}
    />
  );
}
