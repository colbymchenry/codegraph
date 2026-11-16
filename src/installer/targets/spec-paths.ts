/**
 * Path resolution for the targets a spec describes (`./custom.ts` and the
 * family factories).
 *
 * A spec's config dir is one of:
 *   - a string: absolute, or `~` for the user's home, or one leading
 *     `${ENV_VAR}` token, as in `${APPDATA}/Zed`, because Windows has no `~`
 *     for a dir under `%APPDATA%`;
 *   - a map with one string for each platform the agent runs on, keyed
 *     `darwin`, `win32` and `linux`, for an agent whose config dir differs by
 *     OS: Claude Desktop keeps it under `Application Support` on macOS and
 *     under `%APPDATA%` on Windows.
 *
 * Exactly one leading token is expanded; the rest of the path is literal.
 * `~user` is not a home dir here and validation refuses it, so a spec can
 * never be written relative to the working directory by accident.
 *
 * Resolution can fail on a given machine: the map has no entry for this
 * platform, or the variable is unset. That returns `{ dir: null, reason }`,
 * and the target degrades to not installed, with a note instead of a throw,
 * as the installer treats every recoverable condition.
 */

import * as path from 'path';
import * as os from 'os';

export type PlatformKey = 'darwin' | 'win32' | 'linux';
export const PLATFORM_KEYS: readonly PlatformKey[] = ['darwin', 'win32', 'linux'];

export type PlatformDirMap = Partial<Record<PlatformKey, string>>;
export type SpecDir = string | PlatformDirMap;

const ENV_TOKEN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}(?=[\\/]|$)/;

function isHomeRooted(p: string): boolean {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\');
}

/** `~`, `~/x` and `~\x` start in the user's home. Anything else is returned as it is. */
export function expandHomeDir(p: string): string {
  if (p === '~') return os.homedir();
  if (isHomeRooted(p)) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Whether a config dir string is rooted somewhere that does not depend on
 * the working directory: absolute for `platform`, the user's home, or one
 * leading `${ENV}` token followed by a separator or the end.
 */
export function isRootedDir(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (isHomeRooted(p) || ENV_TOKEN.test(p)) return true;
  return (platform === 'win32' ? path.win32 : path.posix).isAbsolute(p);
}

/** Whether a path has a `..` segment, which would let a spec climb out of the dir it names. */
export function hasParentSegment(p: string): boolean {
  return p.split(/[\\/]/).some((segment) => segment === '..');
}

export interface ResolvedDir {
  dir: string | null;
  /** Why there is no dir on this machine, for the note the installer prints. */
  reason?: string;
}

export function resolveSpecDir(
  d: SpecDir,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDir {
  const raw = typeof d === 'string' ? d : d[platform as PlatformKey];
  if (!raw) {
    return { dir: null, reason: `no config dir is declared for this platform (${platform})` };
  }
  const token = ENV_TOKEN.exec(raw);
  if (token) {
    const value = env[token[1]!];
    if (!value || !value.trim()) {
      return { dir: null, reason: `the ${token[1]} environment variable is not set` };
    }
    return { dir: path.resolve(path.join(value, raw.slice(token[0].length))) };
  }
  return { dir: path.resolve(expandHomeDir(raw)) };
}
