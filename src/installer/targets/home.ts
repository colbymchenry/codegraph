/**
 * Env-aware homedir resolver.
 *
 * Bun caches `os.homedir()` at runtime startup and does not re-read
 * `process.env.HOME` after it changes. Node re-reads it on every call.
 * The installer tests mutate HOME to point at a tmpdir, so we honour
 * `HOME` (POSIX) and `USERPROFILE` (Windows) before falling back to
 * `os.homedir()`. Behavior under Node is unchanged because the env
 * vars match what `os.homedir()` would return anyway.
 */

import * as os from 'os';

export function homedir(): string {
  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE;
    if (userProfile && userProfile.length > 0) return userProfile;
  } else {
    const home = process.env.HOME;
    if (home && home.length > 0) return home;
  }
  return os.homedir();
}
