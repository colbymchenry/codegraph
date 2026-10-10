/**
 * PiG target (https://github.com/MichaelKinsy/PiG).
 *
 * PiG reads user-level MCP servers from `<agent-dir>/mcp.json` under the
 * `mcpServers` key, the same shape Claude and Cursor use. We add:
 *
 *   mcpServers.codegraph -> `codegraph serve --mcp`, exposure `direct`
 *
 * `direct` keeps codegraph_explore on PiG's native tool list. PiG's default
 * `codemode` exposure would only make it callable from model-written scripts.
 *
 * The agent dir follows PiG's own resolution: PIG_CODING_AGENT_DIR, then
 * PIG_HOME/agent, then XDG_CONFIG_HOME/pig/agent, then ~/.pig/agent. The
 * project-level `.pig/mcp.json` is only read after the user trusts the
 * project, so this target writes only the global file.
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

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Mirrors PiG's `ConfigRoot()` + `AgentDir()` in internal/codingagent/paths.go. */
function agentDir(): string {
  const override = process.env.PIG_CODING_AGENT_DIR;
  if (override) return expandHome(override);
  const home = process.env.PIG_HOME;
  if (home) return path.join(expandHome(home), 'agent');
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(expandHome(xdg), 'pig', 'agent');
  return path.join(os.homedir(), '.pig', 'agent');
}

function mcpJsonPath(): string {
  return path.join(agentDir(), 'mcp.json');
}

function buildPigMcpConfig(): { command: string; args: string[]; exposure: string; description: string } {
  return {
    command: 'codegraph',
    args: ['serve', '--mcp'],
    exposure: 'direct',
    description: 'Pre-indexed code knowledge graph: symbol source, call paths and blast radius for projects that have a .codegraph/ index',
  };
}

class PigTarget implements AgentTarget {
  readonly id = 'pig' as const;
  readonly displayName = 'PiG';
  readonly docsUrl = 'https://github.com/MichaelKinsy/PiG';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const file = mcpJsonPath();
    const config = readJsonFile(file);
    return {
      installed: fs.existsSync(agentDir()),
      alreadyConfigured: !!config.mcpServers?.codegraph,
      configPath: file,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['PiG reads its MCP servers from the global agent dir; re-run with --location=global.'],
      };
    }
    return {
      files: [writeMcpEntry()],
      notes: ['Start a new PiG session (or run /reload) for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const file = mcpJsonPath();
    const config = readJsonFile(file);
    if (!config.mcpServers?.codegraph) {
      return { files: [{ path: file, action: 'not-found' }] };
    }
    delete config.mcpServers.codegraph;
    if (Object.keys(config.mcpServers).length === 0) {
      delete config.mcpServers;
    }
    writeJsonFile(file, config);
    return { files: [{ path: file, action: 'removed' }] };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') return '';
    const snippet = JSON.stringify({ mcpServers: { codegraph: buildPigMcpConfig() } }, null, 2);
    return `# Add to ${mcpJsonPath()}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return loc === 'global' ? [mcpJsonPath()] : [];
  }
}

function writeMcpEntry(): WriteResult['files'][number] {
  const file = mcpJsonPath();
  const existed = fs.existsSync(file);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = buildPigMcpConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action: existed ? 'updated' : 'created' };
}

export const pigTarget: AgentTarget = new PigTarget();
