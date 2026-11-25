/**
 * VS Code (GitHub Copilot Chat) target.
 *
 *   - MCP server entry to `.vscode/mcp.json` (local, workspace-scoped)
 *     or the user-level `mcp.json` in the VS Code User dir (global):
 *
 *       macOS:   ~/Library/Application Support/Code/User/mcp.json
 *       Windows: %APPDATA%\Code\User\mcp.json
 *       Linux:   $XDG_CONFIG_HOME|~/.config/Code/User/mcp.json
 *
 *     VS Code moved MCP config out of settings.json into this dedicated
 *     `mcp.json` (v1.102, "MCP: Open User Configuration"). Shape is
 *     `{ "servers": { "<name>": { "type": "stdio", "command", "args" } } }`
 *     — note `servers`, not the `mcpServers` wrapper Claude/Cursor use.
 *   - No instructions file: Copilot Chat consumes the MCP `initialize`
 *     instructions, the single source of truth (#529).
 *   - No permissions concept — `autoAllow` is silently ignored.
 *
 * ## Why `--path` only for local installs (NOT the Cursor pattern)
 *
 * Unlike Cursor, VS Code DOCUMENTS the launch cwd for stdio MCP
 * servers: "Working directory for the server command. Defaults to the
 * workspace folder when run in a workspace" (mcp-configuration
 * reference). The codegraph server resolves its project via the MCP
 * roots/list dance with a cwd fallback, so cwd alone is sufficient:
 *
 *   - `local`  install: absolute `--path` (known at install time) —
 *     deterministic, and free of variables.
 *   - `global` install: NO `--path`. Do not be tempted to pin it with
 *     `${workspaceFolder}`: VS Code refuses to start a user-level
 *     server whose entry uses that variable whenever a window has no
 *     folder open (loose files, welcome tab), surfacing an error toast
 *     "Variable workspaceFolder can not be resolved" in every such
 *     window — exactly the error-noise that teaches users to disable
 *     the server. With no `--path`, a folderless window still starts
 *     the server fine and it serves the "no project" guidance.
 *
 * ## JSONC
 *
 * VS Code parses its config files as JSONC (comments + trailing commas
 * allowed), so reads + writes go through `jsonc-parser` — surgical
 * edits that preserve sibling servers, user comments, and formatting
 * across install / re-install / uninstall (same approach as opencode).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  getMcpServerConfig,
  jsonDeepEqual,
} from './shared';

function vscodeUserDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA && process.env.APPDATA.trim().length > 0
      ? process.env.APPDATA
      : path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User');
  }
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(home, '.config');
  return path.join(xdg, 'Code', 'User');
}

function mcpJsonPath(loc: Location): string {
  return loc === 'global'
    ? path.join(vscodeUserDir(), 'mcp.json')
    : path.join(process.cwd(), '.vscode', 'mcp.json');
}

/**
 * Build the codegraph server entry for VS Code at the given location.
 * Local installs pin `--path`; global installs rely on VS Code's
 * documented workspace-folder cwd — see file header for why the global
 * entry must stay variable-free.
 */
function buildVscodeServerEntry(loc: Location): { type: string; command: string; args: string[] } {
  const base = getMcpServerConfig();
  if (loc === 'local') {
    return { ...base, args: [...base.args, '--path', process.cwd()] };
  }
  return { ...base, args: [...base.args] };
}

function readConfigText(file: string): string {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf-8');
}

function parseConfig(text: string): Record<string, any> {
  if (!text.trim()) return {};
  const errors: any[] = [];
  const result = parseJsonc(text, errors, { allowTrailingComma: true });
  if (result == null || typeof result !== 'object' || Array.isArray(result)) {
    return {};
  }
  return result as Record<string, any>;
}

const FORMATTING = { tabSize: 2, insertSpaces: true, eol: '\n' };

class CopilotVscodeTarget implements AgentTarget {
  readonly id = 'copilot-vscode' as const;
  readonly displayName = 'VS Code (Copilot Chat)';
  readonly docsUrl = 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const config = parseConfig(readConfigText(file));
    const alreadyConfigured = !!config.servers?.codegraph;
    // "Installed" heuristic: the VS Code User dir (created on first
    // launch) or ~/.vscode (extensions dir) for global; an existing
    // .vscode/ dir in the project for local.
    const installed = loc === 'global'
      ? fs.existsSync(vscodeUserDir()) || fs.existsSync(path.join(os.homedir(), '.vscode'))
      : fs.existsSync(path.join(process.cwd(), '.vscode'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntry(loc)],
      notes: ['Restart VS Code for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeMcpEntry(loc)] };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ servers: { codegraph: buildVscodeServerEntry(loc) } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existed = fs.existsSync(file);
  let text = readConfigText(file);
  if (!text.trim()) text = '{}\n';

  const config = parseConfig(text);
  const before = config.servers?.codegraph;
  const after = buildVscodeServerEntry(loc);

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  // Surgical edit — preserves comments, formatting, and sibling
  // servers ("servers" is created when missing).
  const edits = modify(text, ['servers', 'codegraph'], after, {
    formattingOptions: FORMATTING,
  });
  const updated = applyEdits(text, edits);
  atomicWriteFileSync(file, updated);

  return { path: file, action: existed ? 'updated' : 'created' };
}

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  const text = readConfigText(file);
  const config = parseConfig(text);
  if (!config.servers?.codegraph) return { path: file, action: 'not-found' };

  let edits = modify(text, ['servers', 'codegraph'], undefined, {
    formattingOptions: FORMATTING,
  });
  let updated = applyEdits(text, edits);

  // Drop an emptied `servers` wrapper; the file itself is left in
  // place — VS Code recreates/reads it and siblings like `inputs`
  // may remain.
  const afterParsed = parseConfig(updated);
  if (afterParsed.servers && typeof afterParsed.servers === 'object' &&
      Object.keys(afterParsed.servers).length === 0) {
    edits = modify(updated, ['servers'], undefined, { formattingOptions: FORMATTING });
    updated = applyEdits(updated, edits);
  }

  atomicWriteFileSync(file, updated);
  return { path: file, action: 'removed' };
}

export const copilotVscodeTarget: AgentTarget = new CopilotVscodeTarget();
