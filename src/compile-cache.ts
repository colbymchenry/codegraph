/**
 * Keeps V8's compiled code between runs (Node 22.1 and later), so a process and
 * each of its worker threads load their modules without recompiling them.
 * Import this first: the cache covers only what is compiled after it is on. The
 * cache is best-effort, and a folder it can't write costs nothing.
 *
 * A folder on a drive that doesn't exist does cost: on Windows Node's directory
 * creation then spins forever, so a temp folder on an unplugged disk or an
 * unmounted RAM drive hung every command at start, at 100% of a core.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

try {
  if (process.platform !== 'win32' || fs.existsSync(path.parse(os.tmpdir()).root)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('node:module') as { enableCompileCache?: () => void }).enableCompileCache?.();
  }
} catch { /* cache is best-effort */ }
