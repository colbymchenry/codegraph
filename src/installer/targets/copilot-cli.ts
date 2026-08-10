/**
 * GitHub Copilot CLI target.
 *
 *   - MCP server entry to `~/.copilot/mcp-config.json` under the
 *     `mcpServers` key (same wrapper as Claude/Cursor). Entry shape per
 *     the GitHub docs: `{ "type": "stdio", "command", "args", "tools" }`
 *     — `type` accepts `"local"` or `"stdio"`; we write `"stdio"` (the
 *     standard MCP name, recommended by the docs for cross-client
 *     compatibility). `"tools": ["*"]` mirrors the docs' example and is
 *     the documented default.
 *   - The config dir is `~/.copilot` unless the user moved it via
 *     `COPILOT_HOME` (documented override) — we honor it so install and
 *     detect follow the CLI's own resolution.
 *
 * Copilot CLI as of 2026-07 has no project-local MCP config — per-repo
 * config (`.github/mcp.json`) is an open feature request
 * (github/copilot-cli#2528). `supportsLocation('local')` returns false;
 * the orchestrator skips this target for local installs with a clear
 * message (same pattern as Codex).
 *
 * The file is machine-written by the CLI's own `/mcp add` flow, so it's
 * plain JSON — no JSONC handling needed; surgical edits go through the
 * shared read/mutate/write helpers (Cursor pattern), preserving sibling
 * servers.
 *
 * No instructions file (MCP `initialize` instructions are the single
 * source of truth, #529) and no permissions concept — `autoAllow` is
 * silently ignored.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

function configDir(): string {
  const override = process.env.COPILOT_HOME;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), '.copilot');
}

function mcpConfigPath(): string {
  return path.join(configDir(), 'mcp-config.json');
}

/**
 * `~/.copilot` existing is NOT proof the CLI is installed: the VS Code
 * Copilot Chat extension drops MCP socket-handoff lock files into
 * `~/.copilot/ide/` on launch, so a machine with only the VS Code
 * extension still has the dir (with a lone `ide` entry). Count the dir
 * as a CLI footprint only when it holds anything besides `ide` — the
 * CLI writes `config.json` (and later `mcp-config.json`, history state)
 * on first run.
 */
function cliConfigDirPresent(): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(configDir());
  } catch {
    return false;
  }
  return entries.some((e) => e !== 'ide');
}

/**
 * Best-effort check that the `copilot` binary is reachable on PATH.
 * A plain fs scan (no shell-out) — cheap enough to run inside
 * `detectAll()` for the multiselect prompt.
 */
function copilotOnPath(): boolean {
  const pathVar = process.env.PATH || '';
  const exts = process.platform === 'win32'
    ? ['.exe', '.cmd', '.bat', '.ps1']
    : [''];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, 'copilot' + ext))) return true;
      } catch { /* ignore unreadable PATH entries */ }
    }
  }
  return false;
}

function buildCopilotMcpConfig(): { type: string; command: string; args: string[]; tools: string[] } {
  const base = getMcpServerConfig();
  return { ...base, tools: ['*'] };
}

class CopilotCliTarget implements AgentTarget {
  readonly id = 'copilot-cli' as const;
  readonly displayName = 'GitHub Copilot CLI';
  readonly docsUrl = 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const file = mcpConfigPath();
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed = cliConfigDirPresent() || copilotOnPath();
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Copilot CLI has no project-local config — re-run with --location=global to install.'],
      };
    }
    return {
      files: [writeMcpEntry()],
      notes: ['Restart any running Copilot CLI session to pick up the MCP server.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };

    const file = mcpConfigPath();
    if (!fs.existsSync(file)) {
      return { files: [{ path: file, action: 'not-found' }] };
    }
    const config = readJsonFile(file);
    if (!config.mcpServers?.codegraph) {
      return { files: [{ path: file, action: 'not-found' }] };
    }
    delete config.mcpServers.codegraph;
    if (Object.keys(config.mcpServers).length === 0) {
      delete config.mcpServers;
    }
    if (Object.keys(config).length === 0) {
      // Nothing left but the `{}` we'd write back — delete the file so
      // uninstall fully reverses a from-scratch install. A leftover
      // empty file would keep detect() reporting the CLI as installed.
      fs.unlinkSync(file);
    } else {
      writeJsonFile(file, config);
    }
    return { files: [{ path: file, action: 'removed' }] };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Copilot CLI has no project-local config — use --location=global.\n';
    }
    const snippet = JSON.stringify({ mcpServers: { codegraph: buildCopilotMcpConfig() } }, null, 2);
    return `# Add to ${mcpConfigPath()}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    if (loc !== 'global') return [];
    return [mcpConfigPath()];
  }
}

function writeMcpEntry(): WriteResult['files'][number] {
  const file = mcpConfigPath();
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = buildCopilotMcpConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const existed = fs.existsSync(file);
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action: existed ? 'updated' : 'created' };
}

export const copilotCliTarget: AgentTarget = new CopilotCliTarget();
