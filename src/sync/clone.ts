/**
 * `codegraph clone`: seed a project — typically a fresh git worktree — with a
 * copy of another checkout's index, so it has code intelligence after a quick
 * `sync` instead of a full `init` (#1236).
 */

import * as fs from 'fs';
import { createDirectory, isInitialized, unsafeIndexRootReason } from '../directory';
import { getDatabasePath } from '../db';
import { snapshotDatabase } from '../db/snapshot';
import { stopDaemonAt, daemonStopFailureMessage } from '../mcp/daemon-registry';
import { tryAcquireWriterLock, releaseWriterLock, writerLockHeldMessage } from '../mcp/writer-lock';

/**
 * Copy `sourcePath`'s index into `targetPath`. Returns `'exists'` without
 * touching anything when the target has a `codegraph.db` and `force` is
 * unset; throws with a user-facing message when the copy can't be made,
 * leaving any index the target had in place.
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

  const unsafe = unsafeIndexRootReason(targetPath);
  if (unsafe && !options.force) {
    throw new Error(`Refusing to clone into ${targetPath} — it looks like ${unsafe}. Pass --force to override.`);
  }

  // Any codegraph.db counts as existing, not only a readable index: a damaged
  // or foreign file is the user's to discard, with --force.
  const targetDbPath = getDatabasePath(targetPath);
  if (!fs.existsSync(targetDbPath)) {
    createDirectory(targetPath);
    snapshotDatabase(getDatabasePath(sourcePath), targetDbPath);
    return 'cloned';
  }
  if (!options.force) return 'exists';

  // Replacing an index in use: hold the rebuild slot (so a reconnecting client
  // waits instead of opening the old file read-only), stop the daemon, and hold
  // the writer slot through the swap — as `codegraph index` does.
  const rebuild = tryAcquireWriterLock(targetPath, 'rebuild', 'rebuild.pid');
  if (rebuild.kind === 'taken') throw new Error('An index rebuild is already in progress in the target.');
  try {
    const realRoot = fs.realpathSync(targetPath);
    const daemonStop = await stopDaemonAt(realRoot, { preserveUnverified: true });
    if (daemonStop.outcome === 'unverified' || daemonStop.outcome === 'still-running') {
      throw new Error(await daemonStopFailureMessage(realRoot, daemonStop));
    }
    const writer = tryAcquireWriterLock(targetPath, 'clone');
    if (writer.kind === 'taken') throw new Error(writerLockHeldMessage(writer.existing, writer.pidPath));
    try {
      snapshotDatabase(getDatabasePath(sourcePath), targetDbPath);
    } finally {
      releaseWriterLock(targetPath);
    }
  } finally {
    releaseWriterLock(targetPath, 'rebuild.pid');
  }
  return 'cloned';
}
