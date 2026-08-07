/**
 * GitHub Copilot CLI target. Writes:
 *
 *   - MCP server entry to `~/.copilot/mcp-config.json` (global) or
 *     `./.mcp.json` (local, shared with Claude Code). Copilot CLI
 *     auto-loads both paths and merges them.
 *
 * No permissions concept — Copilot CLI does not gate tool invocations
 * behind an external allowlist. `autoAllow` is silently ignored.
 * No instructions/steering file — the MCP server's `initialize`
 * response is the single source of truth for agent guidance.
 *
 * The config entry shape differs by location:
 *   - Global: `{ type: "local", command, args, tools: ["*"] }`
 *     Copilot CLI convention: `"local"` is its native name for stdio
 *     servers (though `"stdio"` also works). `tools: ["*"]` ensures
 *     compatibility with Copilot CLI versions before v0.0.404, which
 *     required this field.
 *   - Local: `{ type: "stdio", command, args }`
 *     Uses the standard MCP shape because `./.mcp.json` is shared
 *     with Claude Code, which expects `"stdio"`. Copilot CLI accepts
 *     `"stdio"` as an alias for `"local"`, so the entry works for
 *     both agents.
 *
 * Docs: https://docs.github.com/en/copilot/customizing-copilot/extending-copilot-chat-with-mcp
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

function mcpConfigPath(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.copilot', 'mcp-config.json')
    : path.join(process.cwd(), '.mcp.json');
}

/**
 * Build the codegraph MCP entry in Copilot CLI's preferred shape.
 *
 * Global: `{ type: "local", command, args, tools: ["*"] }`
 *   - `"local"` is Copilot CLI's native name for stdio transports
 *   - `tools: ["*"]` ensures pre-v0.0.404 compatibility
 *
 * Local: `{ type: "stdio", command, args }`
 *   - Standard MCP shape for the shared `.mcp.json` file
 *   - Copilot CLI accepts `"stdio"` as an alias for `"local"`
 */
function buildCopilotMcpConfig(loc: Location): Record<string, unknown> {
  if (loc === 'global') {
    return {
      type: 'local',
      command: 'codegraph',
      args: ['serve', '--mcp'],
      tools: ['*'],
    };
  }
  // Local: reuse the standard MCP shape for cross-agent compatibility
  // with Claude Code, which also reads `./.mcp.json`.
  return getMcpServerConfig() as Record<string, unknown>;
}

class CopilotTarget implements AgentTarget {
  readonly id = 'copilot' as const;
  readonly displayName = 'GitHub Copilot CLI';
  readonly docsUrl = 'https://docs.github.com/en/copilot/customizing-copilot/extending-copilot-chat-with-mcp';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpConfigPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed = loc === 'global'
      ? fs.existsSync(path.join(os.homedir(), '.copilot')) || fs.existsSync(file)
      : fs.existsSync(file);
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

    const file = mcpConfigPath(loc);
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
    const target = mcpConfigPath(loc);
    const snippet = JSON.stringify(
      { mcpServers: { codegraph: buildCopilotMcpConfig(loc) } },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpConfigPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpConfigPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = buildCopilotMcpConfig(loc);

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