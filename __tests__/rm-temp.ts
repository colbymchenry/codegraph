/**
 * Removing a temp tree whose last handle the OS releases late.
 *
 * The watcher suite's end-to-end test drives a real fs.watch. unwatch()
 * returns before Windows releases the directory handle, and a removal in that
 * window fails with EPERM, while POSIX unlinks regardless. There is no event to
 * wait on, so this retries the removal for a short while.
 *
 * Only use it for that kind of residue. A holder the test owns (a database
 * connection, a tracked child) should be closed or awaited where it is opened.
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
