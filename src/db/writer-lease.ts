import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../directory';
import { FileLock } from '../utils';

/**
 * Acquire the process-lifetime writer lease for a project database.
 *
 * MCP/watch holds this lease until shutdown. Maintenance commands hold it from
 * before opening/recreating SQLite until the command completes. The ordinary
 * per-operation `codegraph.lock` remains in place as a second line of defense.
 */
export function acquireDatabaseWriterLease(projectRoot: string): FileLock {
  const codegraphDir = getCodeGraphDir(path.resolve(projectRoot));
  fs.mkdirSync(codegraphDir, { recursive: true });
  const lease = new FileLock(path.join(codegraphDir, 'database-writer.lock'));
  lease.acquire();
  return lease;
}
