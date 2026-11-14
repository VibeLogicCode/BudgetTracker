import { closeDb } from '@/db/client';
import { RESTART_DELAY_MS, RESTART_EXIT_CODE } from '@/lib/backup/restore';
import { stopScheduler } from '@/lib/scheduler';

/**
 * MUST-20.28. Armed only AFTER the caller has its return value ready -- the caller arms this and
 * then returns, so the exit can never pre-empt the HTTP response. unref()'d: the listening HTTP
 * server keeps the event loop alive on its own, so an unref'd timer still fires; and if the
 * process were already exiting for some other reason, being unref'd is exactly what stops this
 * timer from delaying that.
 *
 * v1.63.0: moved out of settings/backups/actions.ts (a 'use server' file may export only server
 * actions) so the restore-upload route arms the same restart the listed restore does.
 */
export function armRestart(): void {
  setTimeout(() => {
    stopScheduler();
    // MUST-20.29: checkpoints and removes the WAL, so the safety copy the boot hook takes is
    // one self-contained file rather than a database plus a log that must travel with it.
    closeDb();
    process.exit(RESTART_EXIT_CODE);
  }, RESTART_DELAY_MS).unref();
}
