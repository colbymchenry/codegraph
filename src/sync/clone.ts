/**
 * `codegraph clone`: seed a project — typically a fresh git worktree — with a
 * copy of another checkout's index, so it has code intelligence after a quick
 * `sync` instead of a full `init` (#1236).
 */

import * as fs from 'fs';
import { createDirectory, isInitialized } from '../directory';
import { getDatabasePath } from '../db';
import { snapshotDatabase } from '../db/snapshot';
import { stopDaemonAt, daemonStopFailureMessage } from '../mcp/daemon-registry';
import { tryAcquireWriterLock, releaseWriterLock, writerLockHeldMessage } from '../mcp/writer-lock';

/**
 * Copy `sourcePath`'s index into `targetPath`. Returns `'exists'` without
 * touching anything when the target has an index and `force` is unset; throws
 * with a user-facing message when the copy can't be made, leaving any index
 * the target had in place.
 */
export async function cloneIndex(
  sourcePath: string,
  targetPath: string,
  options: { force?: boolean } = {},
): Promise<'cloned' | 'exists'> {
  if (!isInitialized(sourcePath)) throw new Error(`No CodeGraph index found in ${sourcePath}`);
  if (fs.existsSync(targetPath) && fs.realpathSync(sourcePath) === fs.realpathSync(targetPath)) {
    throw new Error('Source and target are the same project; nothing to clone.');
  }

  if (!isInitialized(targetPath)) {
    createDirectory(targetPath);
    snapshotDatabase(getDatabasePath(sourcePath), getDatabasePath(targetPath));
    return 'cloned';
  }
  if (!options.force) return 'exists';

  // Replacing a live index: stop its daemon and hold the writer slot, as
  // `codegraph index` does, so nothing has the old database open.
  const realRoot = fs.realpathSync(targetPath);
  const daemonStop = await stopDaemonAt(realRoot, { preserveUnverified: true });
  if (daemonStop.outcome === 'unverified' || daemonStop.outcome === 'still-running') {
    throw new Error(await daemonStopFailureMessage(realRoot, daemonStop));
  }
  const writer = tryAcquireWriterLock(targetPath, 'clone');
  if (writer.kind === 'taken') throw new Error(writerLockHeldMessage(writer.existing, writer.pidPath));
  try {
    snapshotDatabase(getDatabasePath(sourcePath), getDatabasePath(targetPath));
  } finally {
    releaseWriterLock(targetPath);
  }
  return 'cloned';
}
