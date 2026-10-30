/**
 * Consistent database snapshots, for `codegraph clone`.
 */

import * as fs from 'fs';
import { createDatabase } from './sqlite-adapter';
import { WAL_SIDECAR_SUFFIXES } from './index';

/**
 * Write one consistent snapshot of the database at `sourceDbPath` to
 * `targetDbPath`, replacing whatever database is there.
 *
 * A file copy of `codegraph.db` misses commits a live writer (the daemon) has
 * only in its `-wal`, and copying the db and its sidecars one after another
 * tears when a checkpoint runs in between. `VACUUM INTO` on a read-only
 * connection reads a single snapshot, WAL included, while the writer carries
 * on. The snapshot goes to a temp file first, so a failed one leaves an
 * existing target intact; the target's own `-wal`/`-shm` are removed before
 * the swap, because SQLite would replay a stale WAL over the new file.
 */
export function snapshotDatabase(sourceDbPath: string, targetDbPath: string): void {
  const tmpPath = `${targetDbPath}.snapshot-tmp`;
  fs.rmSync(tmpPath, { force: true });
  try {
    const { db } = createDatabase(sourceDbPath, { readOnly: true });
    try {
      db.prepare('VACUUM INTO ?').run(tmpPath);
    } finally {
      db.close();
    }
    for (const suffix of WAL_SIDECAR_SUFFIXES) fs.rmSync(targetDbPath + suffix, { force: true });
    fs.renameSync(tmpPath, targetDbPath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}
