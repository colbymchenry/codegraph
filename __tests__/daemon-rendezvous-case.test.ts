/**
 * One project must map to ONE daemon rendezvous key, however its root is
 * spelled — the regression behind "the MCP server starts but never shares the
 * daemon".
 *
 * The daemon's named pipe (Windows) / tmpdir socket (POSIX) is
 * `…codegraph-<sha256(canonical index directory)>.slice(0,16)`, and the lockfile is shared
 * while the SOCKET NAME is derived independently by each process. So the moment
 * two processes hash the same directory differently they stop meeting: the
 * proxy's probe finds nothing, it spawns a redundant daemon, and that daemon
 * exits on the lock the first one holds
 * (`Another daemon (pid N) already holds the lock; exiting.`) — the session then
 * serves in-process, without the shared watcher or auto-sync.
 *
 * That is reachable on Windows because the root arrives two ways: a cwd-derived
 * root is the on-disk casing (`D:\work\codegraph`), while a client-supplied
 * `rootUri`/`workspaceFolders` path arrives as `file:///d%3A/…` → `d:\…`, and
 * `path.resolve` preserves whichever it got (NTFS is case-insensitive, so both
 * name one directory). Pinned here at the level that actually broke: the key,
 * not the filename.
 *
 * The real-filesystem assertions are Windows-gated — on POSIX the two spellings
 * are genuinely different directories, so only the Windows case has a
 * case-insensitive filesystem to converge on.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalProjectRoot } from '../src/directory';
import { getDaemonSocketPath } from '../src/mcp/daemon-paths';
import { acquireProject } from '../src/mcp/project-lifecycle';
import type CodeGraph from '../src/index';

const tmpDirs: string[] = [];
function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rendezvous-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    try {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/** The same drive letter, forced to one case. No-op on a path without a drive. */
function withDriveCase(p: string, upper: boolean): string {
  return p.replace(/^[a-z]:/i, (drive) => (upper ? drive.toUpperCase() : drive.toLowerCase()));
}

describe('daemon rendezvous key', () => {
  it('collapses redundant path segments to one socket name', () => {
    const root = makeDir();
    const indirect = path.join(root, 'a', '..', 'b', '.');
    const direct = path.join(root, 'b');
    // `.`, `..` and a trailing separator all name the same directory, so both
    // spellings must resolve to the same socket — otherwise `--path` with a
    // stray separator is enough to miss a running daemon.
    expect(getDaemonSocketPath(indirect)).toBe(getDaemonSocketPath(direct));
  });

  it.runIf(process.platform === 'win32')(
    'maps both drive-letter cases of one directory onto one pipe',
    () => {
      const root = makeDir();
      const upper = withDriveCase(root, true);
      const lower = withDriveCase(root, false);

      expect(canonicalProjectRoot(upper)).toBe(canonicalProjectRoot(lower));
      expect(getDaemonSocketPath(upper)).toBe(getDaemonSocketPath(lower));
      // …and the converged key is the on-disk casing, lowercased, so it does not
      // depend on which of the two the caller happened to hold.
      expect(canonicalProjectRoot(upper)).toBe(fs.realpathSync.native(root).toLowerCase());
    },
  );

  it.runIf(process.platform === 'win32')(
    'converges case variants even when the root cannot be realpath’d',
    () => {
      // The `.codegraph/` root normally exists, so this is the fallback arm —
      // but a divergence there would fail identically, so pin it.
      const missing = path.join(os.tmpdir(), 'cg-rendezvous-absent', 'nested');
      expect(canonicalProjectRoot(missing)).toBe(canonicalProjectRoot(missing.toUpperCase()));
    },
  );
});

/** True when the temp filesystem ignores case (default macOS APFS, NTFS). */
function caseInsensitiveTmp(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-CaseProbe-'));
  try {
    return fs.existsSync(dir.replace('cg-CaseProbe-', 'cg-caseprobe-'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('in-process project sharing (#2278)', () => {
  it.runIf(caseInsensitiveTmp())('opens one graph for two casings of one root', async () => {
    const root = path.join(makeDir(), 'Repo');
    fs.mkdirSync(root);
    let opened = 0;
    const open = () => {
      opened++;
      return { close() {}, isIndexing: () => false } as unknown as CodeGraph;
    };
    const a = acquireProject(root, open, {});
    const b = acquireProject(path.join(path.dirname(root), 'REPO'), open, {});
    try {
      expect(opened).toBe(1);
      expect(b.cg).toBe(a.cg);
    } finally {
      await a.release();
      await b.release();
    }
  });
});
