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

  // `version` is on the 503 responses ONLY. "Which build is the one that is broken?" is exactly
  // the question being asked when this endpoint fails, and answering it is the reason it is here.
  //
  // v1.12.1 (item BG / SEC-11): it is NOT on the 200. The old comment argued the leak was nil
  // because the footer of every page shows the same string -- true, and beside the point: the
  // footer is behind a session and this route is deliberately not. Anyone who can reach the app,
  // which is anyone at all if it is reverse-proxied to the internet, could read the exact release
  // and match it to an advisory without signing in. The Docker healthcheck reads only `r.ok`
  // (Dockerfile), so it is unaffected.

  try {
    const row = getSqlite().prepare('select 1 as ok').get() as { ok: number };
    if (row.ok !== 1) throw new Error('unexpected result');
  } catch (error) {
    return Response.json(
      {
        status: 'error',
        db: 'error',
        dataDir: 'unknown',
        error: error instanceof Error ? error.message : 'unknown',
        version: APP_VERSION,
        time: time(),
      },
      { status: 503 },
    );
  }

  if (!isDataDirWritable()) {
    return Response.json(
      {
        status: 'error',
        db: 'ok',
        dataDir: 'error',
        error: 'data directory is not writable',
        version: APP_VERSION,
        time: time(),
      },
      { status: 503 },
    );
  }

  return Response.json({ status: 'ok', db: 'ok', dataDir: 'ok', time: time() }, { status: 200 });
}
