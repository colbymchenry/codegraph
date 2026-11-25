/**
 * JetBrains IDEs (GitHub Copilot plugin) target.
 *
 *   - MCP server entry to the plugin's user-level `mcp.json`, which
 *     lives under the shared `github-copilot` config dir (the same dir
 *     the Copilot ecosystem uses for `hosts.json`):
 *
 *       macOS/Linux: $XDG_CONFIG_HOME|~/.config/github-copilot/intellij/mcp.json
 *       Windows:     %LOCALAPPDATA%\github-copilot\intellij\mcp.json
 *
 *     `$XDG_CONFIG_HOME` is honored on every platform when set —
 *     matching the plugin family's own resolution (copilot.vim /
 *     copilot-language-server check it before the OS default).
 *   - Shape is VS Code-compatible: `{ "servers": { "<name>": { "type":
 *     "stdio", "command", "args" } } }` — the plugin documents mcp.json
 *     parity with `.vscode/mcp.json`.
 *   - **Global-only.** The plugin reads exactly one user-level file; a
 *     project-level mcp.json is an open feature request
 *     (microsoft/copilot-intellij-feedback#701, still open 2026-07).
 *     `supportsLocation('local')` returns false so the orchestrator
 *     skips local installs with a clear message (Codex pattern).
 *   - No `--path` injection: the config is user-global and the plugin
 *     documents no `${workspaceFolder}`-style variable expansion for
 *     this file, so we ship the plain entry and let the MCP server
 *     resolve the project from the client's roots/cwd as with other
 *     global installs.
 *   - No instructions file (MCP `initialize` instructions are the
 *     single source of truth, #529) and no permissions concept —
 *     `autoAllow` is silently ignored.
 *
 * The IDE opens this file in a JSON editor for hand-editing (Settings →
 * Tools → GitHub Copilot → MCP → Configure), so reads + writes go
 * through `jsonc-parser` — surgical edits that preserve sibling
 * servers, user comments, and formatting (same approach as the
 * copilot-vscode target).
 *
 * The plugin only re-reads mcp.json on IDE restart
 * (microsoft/copilot-intellij-feedback#1139) — hence the restart note.
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

/**
 * The `github-copilot` config root, resolved the way the Copilot
 * plugin family resolves it: `$XDG_CONFIG_HOME` first on every
 * platform, then `%LOCALAPPDATA%` on Windows, then `~/.config`.
 */
function copilotConfigRoot(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim().length > 0) {
    return path.join(xdg, 'github-copilot');
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA && process.env.LOCALAPPDATA.trim().length > 0
      ? process.env.LOCALAPPDATA
      : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'github-copilot');
  }
  return path.join(os.homedir(), '.config', 'github-copilot');
}

function intellijDir(): string {
  return path.join(copilotConfigRoot(), 'intellij');
}

function mcpJsonPath(): string {
  return path.join(intellijDir(), 'mcp.json');
}

/**
 * Best-effort "a JetBrains IDE exists here" heuristic for the
 * multiselect default — the per-OS dir every JetBrains IDE creates on
 * first launch. False positives (IDE without the Copilot plugin) are
 * acceptable per the `DetectionResult` contract.
 */
function jetbrainsConfigDirExists(): boolean {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return fs.existsSync(path.join(home, 'Library', 'Application Support', 'JetBrains'));
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA && process.env.APPDATA.trim().length > 0
      ? process.env.APPDATA
      : path.join(home, 'AppData', 'Roaming');
    return fs.existsSync(path.join(appData, 'JetBrains'));
  }
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(home, '.config');
  return fs.existsSync(path.join(xdg, 'JetBrains'));
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

class CopilotJetbrainsTarget implements AgentTarget {
  readonly id = 'copilot-jetbrains' as const;
  readonly displayName = 'JetBrains IDEs (Copilot plugin)';
  readonly docsUrl = 'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/extend-copilot-chat-with-mcp';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const file = mcpJsonPath();
    const config = parseConfig(readConfigText(file));
    const alreadyConfigured = !!config.servers?.codegraph;
    // The `intellij/` subdir is created by the Copilot plugin itself;
    // fall back to "some JetBrains IDE is installed" for first-time
    // plugin users.
    const installed = fs.existsSync(intellijDir()) || jetbrainsConfigDirExists();
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['The JetBrains Copilot plugin has no project-local MCP config — re-run with --location=global to install.'],
      };
    }
    return {
      files: [writeMcpEntry()],
      notes: ['Restart your JetBrains IDE — the Copilot plugin only reads mcp.json on startup.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    return { files: [removeMcpEntry()] };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# The JetBrains Copilot plugin has no project-local MCP config — use --location=global.\n';
    }
    const snippet = JSON.stringify({ servers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${mcpJsonPath()}\n# (Settings → Tools → GitHub Copilot → Model Context Protocol → Configure)\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    if (loc !== 'global') return [];
    return [mcpJsonPath()];
  }
}

function writeMcpEntry(): WriteResult['files'][number] {
  const file = mcpJsonPath();
  const existed = fs.existsSync(file);
  let text = readConfigText(file);
  if (!text.trim()) text = '{}\n';

  const config = parseConfig(text);
  const before = config.servers?.codegraph;
  const after = getMcpServerConfig();

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

function removeMcpEntry(): WriteResult['files'][number] {
  const file = mcpJsonPath();
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  const text = readConfigText(file);
  const config = parseConfig(text);
  if (!config.servers?.codegraph) return { path: file, action: 'not-found' };

  let edits = modify(text, ['servers', 'codegraph'], undefined, {
    formattingOptions: FORMATTING,
  });
  let updated = applyEdits(text, edits);

  // Drop an emptied `servers` wrapper; the file itself is left in
  // place — the plugin owns it and siblings may remain.
  const afterParsed = parseConfig(updated);
  if (afterParsed.servers && typeof afterParsed.servers === 'object' &&
      Object.keys(afterParsed.servers).length === 0) {
    edits = modify(updated, ['servers'], undefined, { formattingOptions: FORMATTING });
    updated = applyEdits(updated, edits);
  }

  atomicWriteFileSync(file, updated);
  return { path: file, action: 'removed' };
}

export const copilotJetbrainsTarget: AgentTarget = new CopilotJetbrainsTarget();
