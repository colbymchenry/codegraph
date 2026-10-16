/**
 * Kimi Code CLI target. Writes:
 *
 *   - MCP server entry to `~/.kimi-code/mcp.json` (global) or
 *     `./.kimi-code/mcp.json` (local). Standard `mcpServers.codegraph`
 *     wrapper, same as Claude / Cursor / Gemini.
 *
 * Kimi Code infers the transport from the entry shape — an entry with a
 * `command` field is a stdio server — and its documented schema has no
 * `type` field, so the block is built without one rather than reusing
 * the shared `getMcpServerConfig()`.
 *
 * No instructions file and no permissions surface: usage guidance ships
 * in the MCP server's `initialize` response (issue #529), and Kimi Code
 * gates MCP tool calls through its own approval rules
 * (`[[permission.rules]]` in config.toml). `autoAllow` is a no-op.
 *
 * Paths are identical on macOS / Linux / Windows because Kimi Code
 * resolves its config root from `os.homedir()` on all three (Windows
 * `~` → `%USERPROFILE%\.kimi-code`).
 *
 * Docs: https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html
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

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.kimi-code')
    : path.join(process.cwd(), '.kimi-code');
}
function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp.json');
}

interface McpServerEntry {
  command: string;
  args: string[];
}

function mcpServerConfig(): McpServerEntry {
  return {
    command: 'codegraph',
    args: ['serve', '--mcp'],
  };
}

class KimiTarget implements AgentTarget {
  readonly id = 'kimi' as const;
  readonly displayName = 'Kimi Code';
  readonly docsUrl = 'https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed = loc === 'global'
      ? fs.existsSync(configDir('global')) || fs.existsSync(file)
      : fs.existsSync(file) || fs.existsSync(configDir('local'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));
    return {
      files,
      // Kimi Code only connects MCP servers at session start — a server
      // added mid-session joins later sessions, so a restart (or a new
      // session) is required for the tools to register.
      notes: [
        'Start a new Kimi Code session for the MCP server to be picked up (servers added mid-session only join later sessions).',
      ],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const file = mcpJsonPath(loc);
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
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: mcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = mcpServerConfig();

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

export const kimiTarget: AgentTarget = new KimiTarget();
