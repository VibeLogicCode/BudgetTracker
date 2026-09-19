import fs from 'node:fs';
import path from 'node:path';
import { getSqlite } from '@/db/client';
import { readEnv } from '@/lib/env';
import { APP_VERSION } from '@/lib/version';

export const dynamic = 'force-dynamic';

/** Container healthcheck also verifies the data dir actually accepts writes (not just that it exists). */
function isDataDirWritable(): boolean {
  try {
    const dir = readEnv().dataDir;
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.health-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function GET(): Promise<Response> {
  // Unauthenticated by design: this is the container healthcheck.
  const time = () => new Date().toISOString();

  /*
    NOTHING BUT THE VERDICT LEAVES THIS ROUTE (review D9).

    v1.12.1 took the version off the 200 for the right reason -- the footer that shows the same
    string is behind a session and this route is not -- and then left it on the 503s, arguing that
    "which build is broken?" is the question being asked when it fails. But an unauthenticated
    caller decides when it fails only in the sense that they can keep asking; a database that is
    down is exactly when the version and a raw driver message are worth most to somebody probing,
    and they are worth nothing to the healthcheck, which reads only r.ok (Dockerfile).

    The operator loses nothing: the same two facts are logged server-side, where the person who can
    read the log is the person who can fix the app.
  */

  try {
    const row = getSqlite().prepare('select 1 as ok').get() as { ok: number };
    if (row.ok !== 1) throw new Error('unexpected result');
  } catch (error) {
    console.error('[health] database check failed on ' + APP_VERSION, error);
    return Response.json({ status: 'error', db: 'error', dataDir: 'unknown', time: time() }, { status: 503 });
  }

  if (!isDataDirWritable()) {
    console.error('[health] data directory is not writable on ' + APP_VERSION);
    return Response.json({ status: 'error', db: 'ok', dataDir: 'error', time: time() }, { status: 503 });
  }

  return Response.json({ status: 'ok', db: 'ok', dataDir: 'ok', time: time() }, { status: 200 });
}
