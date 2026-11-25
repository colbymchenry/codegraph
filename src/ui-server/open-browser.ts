/**
 * Opening the user's browser at the viewer URL.
 *
 * No dependency: the three platform openers are one-liners, and pulling in a
 * package to shell out to `open` would be the only runtime dependency the
 * viewer adds to a CLI that currently has ten.
 */

import { spawn } from 'child_process';
import { BROWSER_ENV } from './constants';

export { BROWSER_ENV };

const SUPPRESS_VALUES: ReadonlySet<string> = new Set(['', 'none', '0', 'false', 'off']);

export interface OpenCommand {
  command: string;
  args: string[];
}

/**
 * The command that would open `url`, or `null` when opening is suppressed.
 *
 * Split out from {@link openBrowser} so the platform mapping is testable
 * without launching anything.
 */
export function browserOpenCommand(
  url: string,
  platform: NodeJS.Platform,
  override?: string
): OpenCommand | null {
  if (override !== undefined) {
    const trimmed = override.trim();
    if (SUPPRESS_VALUES.has(trimmed.toLowerCase())) return null;
    // Windows: go through `cmd /c` rather than spawning the override directly.
    // `spawn` there is CreateProcess, which only ever launches a real .exe — a
    // `.cmd`/`.bat` browser shim (how most Windows wrappers are written) fails
    // outright, and an extension-less name only resolves because CreateProcess
    // appends `.exe`. Routing through cmd makes .exe, .cmd and .bat all work,
    // and node quotes each argument, so a path with spaces survives. Caught on
    // the Windows VM, where the direct spawn silently launched nothing.
    if (platform === 'win32') return { command: 'cmd', args: ['/c', trimmed, url] };
    return { command: trimmed, args: [url] };
  }
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    // `start` is a cmd builtin, not an executable. The empty string is the
    // window title — without it `start` treats a quoted URL as the title and
    // opens a blank console instead.
    return { command: 'cmd', args: ['/c', 'start', '', url] };
  }
  return { command: 'xdg-open', args: [url] };
}

/**
 * Open `url` in the user's default browser, best effort.
 *
 * Never throws and never keeps the CLI alive: the child is detached and
 * unref'd, and a missing opener (a headless Linux box with no `xdg-open`) is
 * swallowed — the URL is already printed, which is the part that matters.
 *
 * @returns `true` if a launch was attempted.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const open = browserOpenCommand(url, platform, process.env[BROWSER_ENV]);
  if (!open) return false;
  try {
    const child = spawn(open.command, open.args, {
      detached: true,
      stdio: 'ignore',
      // `start` is a shell builtin reached through `cmd /c`, so no shell here.
      shell: false,
    });
    child.on('error', () => {
      /* no opener installed — the printed URL is the fallback */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
