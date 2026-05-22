/**
 * Watch Policy
 *
 * Decides whether the live file watcher should run for a given project.
 *
 * Native recursive `fs.watch` is pathologically slow on WSL2 `/mnt/*`
 * drives (NTFS exposed over the 9p/drvfs bridge): setting up the recursive
 * watch walks the directory tree, and every readdir/stat crosses the
 * Windows boundary. Inside an MCP server this stalls the event loop during
 * startup long enough to blow past host handshake timeouts (opencode's 30s),
 * so the tools never appear. See issue #199.
 *
 * This module centralizes the on/off decision so the watcher, the MCP
 * server (for diagnostics), and the installer all agree.
 */

import * as fs from 'fs';
import { normalizePath } from '../utils';

let wslChecked = false;
let wslValue = false;

/**
 * Detect whether the current process is running under WSL (Windows
 * Subsystem for Linux). Result is cached after the first call.
 *
 * Checks the WSL-specific env vars first (no I/O), then falls back to
 * `/proc/version`, which contains "microsoft" on WSL kernels.
 */
export function detectWsl(): boolean {
  if (wslChecked) return wslValue;
  wslChecked = true;

  if (process.platform !== 'linux') {
    wslValue = false;
    return wslValue;
  }
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    wslValue = true;
    return wslValue;
  }
  try {
    const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
    wslValue = version.includes('microsoft') || version.includes('wsl');
  } catch {
    wslValue = false;
  }
  return wslValue;
}

/**
 * True for WSL Windows-drive mounts like `/mnt/c` or `/mnt/d/project`.
 * Deliberately matches only single-letter drive mounts, so genuinely fast
 * Linux mounts such as `/mnt/wsl/...` are not flagged.
 */
function isWindowsDriveMount(projectRoot: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(normalizePath(projectRoot));
}

/**
 * Inputs that can be overridden in tests so the decision is deterministic
 * without touching real env vars or `/proc/version`.
 */
export interface WatchProbe {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `detectWsl()`. */
  isWsl?: boolean;
}

/**
 * Decide whether the file watcher should be disabled for a project, and why.
 *
 * Returns a short human-readable reason when watching should be skipped, or
 * `null` when it should run normally.
 *
 * Precedence (first match wins):
 *  1. `CODEGRAPH_NO_WATCH=1`    → off  (explicit opt-out always wins)
 *  2. `CODEGRAPH_FORCE_WATCH=1` → on   (overrides auto-detection)
 *  3. WSL2 + `/mnt/*` drive     → off  (recursive fs.watch is too slow; #199)
 */
export function watchDisabledReason(projectRoot: string, probe: WatchProbe = {}): string | null {
  const env = probe.env ?? process.env;

  if (env.CODEGRAPH_NO_WATCH === '1') {
    return 'CODEGRAPH_NO_WATCH=1 is set';
  }
  if (env.CODEGRAPH_FORCE_WATCH === '1') {
    return null;
  }

  const isWsl = probe.isWsl ?? detectWsl();
  if (isWsl && isWindowsDriveMount(projectRoot)) {
    return 'project is on a WSL2 /mnt/ drive, where recursive fs.watch is too slow to be reliable';
  }

  return null;
}

/** Test-only: reset the cached WSL detection. */
export function __resetWslCacheForTests(): void {
  wslChecked = false;
  wslValue = false;
}
