/**
 * Removing a temp tree that a detached daemon may still hold.
 *
 * The MCP suites spawn `codegraph serve --mcp`, which can start a DETACHED
 * daemon. A tracked child can be awaited on its `exit` event, and the suites do
 * that, but the daemon is not a child of this process: there is no handle to
 * close and no event to wait on, only the OS releasing its files once the
 * process is gone. Windows does that a beat late and fails the removal with
 * EPERM/EBUSY meanwhile, where POSIX unlinks regardless — which is why this is
 * invisible on CI and reproducible on a Windows contributor's machine.
 *
 * Retrying is the honest tool for that residue specifically. Everything with a
 * real holder — a database connection, a tracked child — is closed or awaited
 * at its own site rather than papered over here.
 */
import * as fs from 'node:fs';

export async function rmTempDir(dir: string, attempts = 40, delayMs = 50): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
