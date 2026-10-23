/**
 * What the OS says a running process is, for judging a lock file that names it
 * (#2770).
 *
 * A pid in `.codegraph/daemon.pid` proves nothing once the OS has given that
 * number to another process, and a daemon that does not answer its socket hello
 * cannot vouch for itself (#1553). The process's command line is the evidence
 * left: every CodeGraph daemon runs `<runtime> … codegraph.js serve --mcp --path
 * <root>`. A lock whose live holder runs anything else is as stale as one whose
 * holder has exited. When the OS withholds the command line (another user's or
 * an elevated process), the executable's name can still rule out a holder that
 * is no JavaScript runtime at all.
 *
 * Lookups are bounded and best-effort. What the OS won't say is `null`, and
 * `null` is never evidence either way: such a holder stays `unknown`, and its
 * lock is kept.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface ProcessDescription {
  /** The executable's file name, such as `node.exe` or `node`; null when the OS won't say. */
  name: string | null;
  /** The whole command line; null when the OS won't say. */
  commandLine: string | null;
}

/**
 * A live lock holder is a CodeGraph MCP server (`codegraph-server`), provably
 * something else (`other`), or a process the OS won't describe (`unknown`).
 */
export type LockHolderKind = 'codegraph-server' | 'other' | 'unknown';

const LOOKUP_TIMEOUT_MS = 5_000;

/**
 * How long one OS query may run: 5 s, unless `CODEGRAPH_PROCESS_LOOKUP_TIMEOUT_MS`
 * says otherwise. Tests set it: on a loaded machine PowerShell can take longer
 * than 5 s to start, and a Windows lookup that runs out falls back to tasklist,
 * which has no command line to show.
 */
function lookupTimeoutMs(): number {
  const fromEnv = Number(process.env.CODEGRAPH_PROCESS_LOOKUP_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : LOOKUP_TIMEOUT_MS;
}

/** Runs a short OS query and resolves its stdout, or null when it fails or times out. */
function query(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { encoding: 'utf8', timeout: lookupTimeoutMs(), windowsHide: true, maxBuffer: 1 << 20 },
        (error, stdout) => resolve(error ? null : stdout));
    } catch {
      resolve(null);
    }
  });
}

function windowsTool(...parts: string[]): string {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', ...parts);
}

async function describeWindowsProcess(pid: number): Promise<ProcessDescription> {
  // Win32_Process has the command line; tasklist, the fallback when PowerShell
  // can't run, has only the image name.
  const script =
    "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
    'if ($p) { [Console]::Out.Write((ConvertTo-Json -Compress @{ name = $p.Name; commandLine = $p.CommandLine })) }';
  const json = await query(windowsTool('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script]);
  if (json?.trim()) {
    try {
      const found = JSON.parse(json) as { name?: unknown; commandLine?: unknown };
      return {
        name: typeof found.name === 'string' && found.name ? found.name : null,
        commandLine: typeof found.commandLine === 'string' && found.commandLine.trim() ? found.commandLine : null,
      };
    } catch { /* fall back to tasklist */ }
  }
  const csv = await query(windowsTool('tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  for (const line of csv?.split(/\r?\n/) ?? []) {
    const fields = /^"([^"]*)","(\d+)"/.exec(line);
    if (fields && Number(fields[2]) === pid) return { name: fields[1] || null, commandLine: null };
  }
  return { name: null, commandLine: null };
}

function describeLinuxProcess(pid: number): ProcessDescription {
  let commandLine: string | null = null;
  let name: string | null = null;
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    if (args.length > 0) commandLine = args.join(' ');
  } catch { /* gone, or hidden (hidepid) */ }
  try {
    name = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || null;
  } catch { /* gone, or hidden */ }
  return { name, commandLine };
}

async function describePsProcess(pid: number): Promise<ProcessDescription> {
  const [args, comm] = await Promise.all([
    query('ps', ['-ww', '-o', 'args=', '-p', String(pid)]),
    query('ps', ['-o', 'comm=', '-p', String(pid)]),
  ]);
  return { name: comm?.trim() || null, commandLine: args?.trim() || null };
}

/** What the OS says process `pid` is running. Never throws. */
export async function describeProcess(pid: number): Promise<ProcessDescription> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { name: null, commandLine: null };
  if (process.platform === 'win32') return describeWindowsProcess(pid);
  if (process.platform === 'linux') return describeLinuxProcess(pid);
  return describePsProcess(pid);
}

/**
 * Whether a command line is a CodeGraph MCP server's, the only kind of process
 * that writes `daemon.pid`: it names CodeGraph and has `serve` and `--mcp` as
 * arguments.
 */
export function isCodeGraphServerCommandLine(commandLine: string): boolean {
  const args = commandLine.replace(/["']/g, ' ').split(/\s+/);
  return /codegraph/i.test(commandLine) && args.includes('serve') && args.some((a) => a === '--mcp' || a.startsWith('--mcp='));
}

/** Whether an executable could be a JavaScript runtime that runs CodeGraph. */
function mayRunCodeGraph(name: string): boolean {
  const base = path.basename(name.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  return /node|codegraph|bun|deno/.test(base);
}

/**
 * What a live lock holder is. The command line decides when the OS gives it;
 * otherwise only an executable that is no JavaScript runtime counts as `other`.
 */
export function classifyLockHolder(description: ProcessDescription): LockHolderKind {
  if (description.commandLine !== null) {
    return isCodeGraphServerCommandLine(description.commandLine) ? 'codegraph-server' : 'other';
  }
  if (description.name !== null && !mayRunCodeGraph(description.name)) return 'other';
  return 'unknown';
}
