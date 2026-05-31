/**
 * GitHub Copilot CLI target.
 *
 * Copilot CLI reads MCP server definitions from:
 *
 *   - **User-level**: `~/.copilot/mcp-config.json` (since v0.0.340)
 *   - **Workspace-level**: `.mcp.json` in the project root (since v1.0.22)
 *
 * The JSON shape uses `"mcpServers"` as the top-level key — same as
 * Claude Code, Cursor, Kiro, and Gemini.
 *
 * ## Location
 *
 * - `global` writes to `~/.copilot/mcp-config.json` (user-level, all projects).
 * - `local` writes to `./.mcp.json` (workspace-level, shared with team).
 *
 * ## No permissions concept
 *
 * Copilot CLI gates tool invocations through its own UI prompts.
 * `autoAllow` is silently ignored.
 *
 * Docs: https://github.com/github/copilot-cli
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

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function globalMcpPath(): string {
  return path.join(os.homedir(), '.copilot', 'mcp-config.json');
}

function localMcpPath(): string {
  return path.join(process.cwd(), '.mcp.json');
}

function mcpPath(loc: Location): string {
  return loc === 'global' ? globalMcpPath() : localMcpPath();
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Best-effort heuristic for "Copilot CLI is installed."
 *
 * Global: check that `~/.copilot` exists or the mcp-config.json exists.
 * Local:  check that `~/.copilot` exists (Copilot CLI's user-level
 * directory).  We intentionally do NOT use `.mcp.json` as a local
 * detection signal because it is shared infrastructure — Claude Code
 * and Cursor also write to it for their local installs, so its mere
 * existence does not imply Copilot CLI is present.
 */
function detectInstalled(loc: Location): boolean {
  const copilotDir = path.join(os.homedir(), '.copilot');
  if (loc === 'global') {
    return fs.existsSync(copilotDir) || fs.existsSync(globalMcpPath());
  }
  return fs.existsSync(copilotDir);
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

class CopilotTarget implements AgentTarget {
  readonly id = 'copilot' as const;
  readonly displayName = 'GitHub Copilot CLI';
  readonly docsUrl = 'https://github.com/github/copilot-cli';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed = detectInstalled(loc);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));
    return {
      files,
      notes: ['Restart Copilot CLI for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    const file = mcpPath(loc);
    const config = readJsonFile(file);

    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(file, config);
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpPath(loc)];
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getMcpServerConfig();

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

export const copilotTarget: AgentTarget = new CopilotTarget();
