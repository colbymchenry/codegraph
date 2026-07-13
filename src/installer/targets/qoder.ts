/**
 * Qoder IDE target. Writes:
 *
 *   - MCP server entry to Qoder's shared `mcp.json`, at:
 *       macOS   — `~/Library/Application Support/Qoder/SharedClientCache/mcp.json`
 *       Linux   — `$XDG_CONFIG_HOME/Qoder/SharedClientCache/mcp.json`
 *                 (defaults to `~/.config/Qoder/…`)
 *       Windows — `%APPDATA%/Qoder/SharedClientCache/mcp.json`
 *
 * Same `mcpServers.<name>` JSON schema Claude / Cursor / Kiro use, so
 * the standard `shared.ts` merge helpers keep sibling MCP servers
 * intact through install / uninstall round-trips.
 *
 * Qoder has NO project-local MCP config (the in-project `.qoder/` dir
 * is a cache — no `mcp.json` there), so we only support `--location=global`.
 *
 * Two quirks force this file to look a bit different from Kiro / Claude:
 *
 * 1. **No `${workspaceFolder}` substitution.** Unlike VS Code, Cursor,
 *    and most VS Code forks, Qoder passes MCP `args` to the child
 *    process verbatim. A `--path "${workspaceFolder}"` therefore reaches
 *    codegraph as the literal 12-character string, `findNearestCodeGraphRoot`
 *    returns null, and the (pre-#964) empty `tools/list` gate leaves the
 *    agent with zero tools. Fix: install with NO `--path` at all —
 *    codegraph resolves the workspace via the MCP `roots/list` handshake
 *    (see `MCPSession.initFromRoots`) and falls back to `process.cwd()`.
 *
 * 2. **Launched from Dock / launchd → no nvm PATH.** Qoder is Electron;
 *    macOS launches it without the login shell's PATH, so a `command: "codegraph"`
 *    that resolves fine in a terminal fails inside Qoder when codegraph
 *    is installed under nvm. Same problem antigravity hits — same fix:
 *    resolve to an absolute path at install time, via the user's login shell.
 *
 * Docs: https://qoder.com/
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

/**
 * Directory Qoder stores its shared (across-project) settings under.
 * macOS uses the standard `~/Library/Application Support/Qoder`; other
 * platforms follow the Electron / VS-Code-fork convention (`$XDG_CONFIG_HOME`
 * on Linux, `%APPDATA%` on Windows) so a user with an existing Qoder
 * install has zero surprises.
 */
function qoderConfigDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Qoder');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Qoder');
  }
  // Linux / other POSIX
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'Qoder');
}

function mcpJsonPath(): string {
  return path.join(qoderConfigDir(), 'SharedClientCache', 'mcp.json');
}

/**
 * macOS Qoder is launched by launchd / Dock, which strips PATH of any
 * nvm-managed entries — so a bare `codegraph` command fails to launch
 * from inside the app even when it works in every terminal. Resolve to
 * the login shell's `codegraph` at install time; that's the shell PATH
 * the user actually uses.
 *
 * Non-darwin returns the bare name — Linux launchers inherit the user
 * PATH, and Windows installs codegraph to a global location on PATH.
 */
function resolveCodegraphCommand(): string {
  if (process.platform !== 'darwin') return 'codegraph';
  try {
    const resolved = execSync('command -v codegraph || which codegraph', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: '/bin/bash',
      windowsHide: true,
    }).trim();
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {
    /* fall through to bare name */
  }
  return 'codegraph';
}

/**
 * Build the codegraph MCP-server entry for Qoder. Deliberately NO
 * `--path` argument — see file header for why.
 */
function buildQoderEntry(): { type: string; command: string; args: string[] } {
  return {
    type: 'stdio',
    command: resolveCodegraphCommand(),
    args: ['serve', '--mcp'],
  };
}

class QoderTarget implements AgentTarget {
  readonly id = 'qoder' as const;
  readonly displayName = 'Qoder';
  readonly docsUrl = 'https://qoder.com/';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const file = mcpJsonPath();
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed =
      fs.existsSync(qoderConfigDir()) || fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Qoder has no project-local MCP config — re-run with --location=global.'],
      };
    }
    return {
      files: [writeMcpEntry()],
      notes: ['Restart Qoder for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };

    const file = mcpJsonPath();
    const config = readJsonFile(file);
    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(file, config);
      return { files: [{ path: file, action: 'removed' }] };
    }
    return { files: [{ path: file, action: 'not-found' }] };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Qoder has no project-local MCP config — use --location=global.\n';
    }
    const file = mcpJsonPath();
    const snippet = JSON.stringify({ mcpServers: { codegraph: buildQoderEntry() } }, null, 2);
    return `# Add to ${file}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return loc === 'global' ? [mcpJsonPath()] : [];
  }
}

function writeMcpEntry(): WriteResult['files'][number] {
  const file = mcpJsonPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = buildQoderEntry();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' =
    before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

export const qoderTarget: AgentTarget = new QoderTarget();
