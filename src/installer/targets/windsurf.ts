/**
 * Windsurf (Codeium / Cognition) target.
 *
 *   - MCP server entry to `~/.codeium/windsurf/mcp_config.json`. Standard
 *     `mcpServers.codegraph` shape, same container as Claude / Cursor / Kiro.
 *
 * Windsurf as of 2026-06 has NO project-local MCP config — it reads only the
 * single user-level `mcp_config.json` under `~/.codeium/windsurf/`, on macOS,
 * Linux, AND Windows alike (the path is `os.homedir()`-based on all three, so
 * there's no `%APPDATA%` special case — same as Kiro). `supportsLocation('local')`
 * returns false; the orchestrator skips Windsurf for a local install.
 *
 * The server entry is `{ command, args }` — NO `type` field. Windsurf's
 * documented stdio examples omit it (unlike Claude/Cursor which take
 * `type: "stdio"`), so we mirror the docs exactly to avoid a config the editor
 * might reject. Same shape Antigravity uses.
 *
 * No permissions concept — Windsurf gates MCP tools through its own UI, not an
 * external allowlist. `autoAllow` is silently ignored.
 *
 * No instructions file — per issue #529 the agent-facing usage guidance ships
 * in the MCP server's `initialize` response (the single source of truth), so
 * this target writes only the MCP entry.
 *
 * Docs: https://docs.windsurf.com/windsurf/cascade/mcp
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
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

function configDir(): string {
  return path.join(os.homedir(), '.codeium', 'windsurf');
}
function mcpConfigPath(): string {
  return path.join(configDir(), 'mcp_config.json');
}

/**
 * The codegraph MCP-server entry for Windsurf. Deliberately omits the `type`
 * field — Windsurf's documented stdio examples are `{ command, args }` only.
 */
function buildWindsurfEntry(): { command: string; args: string[] } {
  return {
    command: 'codegraph',
    args: ['serve', '--mcp'],
  };
}

class WindsurfTarget implements AgentTarget {
  readonly id = 'windsurf' as const;
  readonly displayName = 'Windsurf';
  readonly docsUrl = 'https://docs.windsurf.com/windsurf/cascade/mcp';

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
    // "Installed" heuristic: the ~/.codeium dir (Windsurf creates it on first
    // run) or the Windsurf config dir or the mcp_config.json itself exists.
    const installed =
      fs.existsSync(path.join(os.homedir(), '.codeium')) ||
      fs.existsSync(configDir()) ||
      fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Windsurf has no project-local config — re-run with --location=global.'],
      };
    }
    return {
      files: [writeMcpEntry()],
      // Load-bearing: a valid mcp_config.json is NOT picked up live. Windsurf
      // only (re)loads MCP servers when you open the MCP panel and hit Refresh
      // (or reload the window) — so without this note a user sees the entry on
      // disk but no codegraph tools and assumes the install failed.
      notes: ['In Windsurf, open Settings → MCP (or the Cascade MCP panel) and click "Refresh" to load codegraph.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    return { files: [removeCodegraphFromFile(mcpConfigPath())] };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Windsurf has no project-local config — use --location=global.\n';
    }
    const snippet = JSON.stringify({ mcpServers: { codegraph: buildWindsurfEntry() } }, null, 2);
    return `# Add to ${mcpConfigPath()}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    if (loc !== 'global') return [];
    return [mcpConfigPath()];
  }
}

function writeMcpEntry(): WriteResult['files'][number] {
  const file = mcpConfigPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = buildWindsurfEntry();

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

/**
 * Strip the codegraph entry from mcp_config.json. Surgical: only our
 * `codegraph` key is removed; sibling MCP servers survive. Drops an emptied
 * `mcpServers` wrapper too. Returns `not-found` when there was nothing to
 * remove (file absent or no codegraph entry) so uninstall is safe to call
 * when nothing was ever installed.
 */
function removeCodegraphFromFile(file: string): WriteResult['files'][number] {
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  const config = readJsonFile(file);
  if (!config.mcpServers?.codegraph) return { path: file, action: 'not-found' };
  delete config.mcpServers.codegraph;
  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }
  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

export const windsurfTarget: AgentTarget = new WindsurfTarget();
