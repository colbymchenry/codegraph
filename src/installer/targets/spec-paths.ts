/**
 * Path resolution for family-target specs.
 *
 * A spec's `configDir` can be:
 *   - a plain string — absolute or `~/`-prefixed, e.g. '~/.codex';
 *   - a **per-platform map** for agents whose config dir differs by OS
 *     (Qoder IDE, #1277: `Application Support` on macOS, `%APPDATA%` on
 *     Windows, XDG on Linux):
 *       { "darwin": "~/Library/Application Support/Qoder/SharedClientCache",
 *         "win32":  "${APPDATA}/Qoder/SharedClientCache",
 *         "linux":  "~/.config/Qoder/SharedClientCache" }
 *
 * Either form may start with a `${ENV_VAR}` token (needed on Windows,
 * which has no `~` for `%APPDATA%`-rooted dirs). Exactly one leading
 * token is expanded; anything else in the path is literal.
 *
 * Resolution can fail on a given machine (map has no entry for this
 * platform; the env var is unset). That returns `{dir: null, reason}` —
 * callers degrade to the not-installed / nothing-to-do shape rather
 * than throwing, mirroring how the installer treats every recoverable
 * condition.
 */

import * as path from 'path';
import * as os from 'os';

export type PlatformDirMap = Partial<Record<'darwin' | 'win32' | 'linux', string>>;
export type SpecDir = string | PlatformDirMap;

export function expandHomeDir(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

const ENV_TOKEN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/;

export function resolveSpecDir(d: SpecDir): { dir: string | null; reason?: string } {
  const raw = typeof d === 'string'
    ? d
    : d[process.platform as keyof PlatformDirMap];
  if (!raw) {
    return { dir: null, reason: `no config dir declared for platform "${process.platform}"` };
  }
  const m = ENV_TOKEN.exec(raw);
  if (m) {
    const value = process.env[m[1]!];
    if (!value || !value.trim()) {
      return { dir: null, reason: `environment variable ${m[1]} is not set` };
    }
    return { dir: path.join(value, raw.slice(m[0].length)) };
  }
  return { dir: expandHomeDir(raw) };
}
