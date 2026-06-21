/**
 * OpenClaw target.
 *
 *   - MCP server entry merged into `~/.openclaw/openclaw.json` under
 *     `mcp.servers.codegraph`. The orchestrator then loads it on next
 *     gateway restart; the same MCP surface is exposed to all agents
 *     (main + sub-agents).
 *   - No instructions file: OpenClaw's per-agent SOUL.md / AGENTS.md
 *     pattern is user-managed. The MCP server's own `initialize`
 *     response carries the tool guidance (see `server-instructions.ts`).
 *   - No permissions concept: OpenClaw does not gate tool calls beyond
 *     the channel's per-account allowlist.
 *
 * The `mcp.servers` shape is OpenClaw-native:
 *   {
 *     "mcp": {
 *       "servers": {
 *         "codegraph": {
 *           "command": "<absolute path to codegraph binary>",
 *           "args": ["serve", "--mcp", "--path", "<project>"],
 *           "env": { "CODEGRAPH_TELEMETRY": "0" },
 *           "cwd": "<project>"
 *         }
 *       }
 *     }
 *   }
 *
 * OpenClaw supports both stdio (this shape) and streamable-http
 * (`{ "type": "streamableHttp", "url": "..." }`) — we use stdio.
 *
 * Idempotency:
 *   - If a codegraph entry already exists with the same effective
 *     command/args/env/cwd, we leave the file alone (action: unchanged).
 *   - If it exists with different fields, we update it surgically and
 *     report (action: updated).
 *   - On uninstall we drop ONLY the `mcp.servers.codegraph` key and
 *     preserve all sibling servers (chrome-mcp, wordpress-deltabis,
 *     user-defined, etc.).
 *
 * `--path` is REQUIRED when the MCP server's CWD is not an indexed
 * project — without it, codegraph's `initialize` response says
 * "workspace not indexed" and exposes no tools. The installer
 * auto-detects the project root with the same heuristic as `codegraph
 * init`: walk up from cwd looking for a `.codegraph/` directory, falling
 * back to cwd.
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
import { atomicWriteFileSync, jsonDeepEqual } from './shared';

/**
 * OpenClaw is a single-user gateway with one global config dir
 * (XDG-style, like opencode). Local install is not supported — there
 * is no per-project config layer to write into.
 */
function openclawConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  // OpenClaw keeps its own dir at $XDG_CONFIG_HOME/openclaw OR $HOME/.openclaw;
  // the latter is the documented default and what 99% of users have.
  return fs.existsSync(path.join(os.homedir(), '.openclaw'))
    ? path.join(os.homedir(), '.openclaw')
    : path.join(xdg, 'openclaw');
}

function configPath(): string {
  return path.join(openclawConfigDir(), 'openclaw.json');
}

function readConfigText(file: string): string {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf-8');
}

function parseConfig(text: string): Record<string, any> {
  if (!text.trim()) return {};
  try {
    const result = JSON.parse(text);
    if (result == null || typeof result !== 'object' || Array.isArray(result)) {
      return {};
    }
    return result as Record<string, any>;
  } catch {
    return {};
  }
}

/**
 * Find the project root by walking up from cwd looking for an existing
 * `.codegraph/` directory. Falls back to cwd if none found. This
 * mirrors what `codegraph init` does for the auto-detected case.
 */
function detectProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.codegraph'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Resolve the codegraph binary path. Prefer the install location
 * populated by `install.sh` / `npm i -g`; fall back to `which codegraph`
 * via PATH; finally fall back to `codegraph` (PATH-resolved by OpenClaw).
 */
function codegraphBinaryPath(): string {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'codegraph'),
    path.join(home, '.codegraph', 'bin', 'codegraph'),
    '/usr/local/bin/codegraph',
    '/opt/homebrew/bin/codegraph',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'codegraph'; // PATH-resolved fallback
}

function buildServerEntry(): Record<string, any> {
  const project = detectProjectRoot();
  return {
    command: codegraphBinaryPath(),
    args: ['serve', '--mcp', '--path', project],
    env: { CODEGRAPH_TELEMETRY: '0' },
    cwd: project,
  };
}

class OpenclawTarget implements AgentTarget {
  readonly id = 'openclaw' as const;
  readonly displayName = 'OpenClaw';
  readonly docsUrl = 'https://github.com/openclaw/openclaw';

  supportsLocation(_loc: Location): boolean {
    // OpenClaw is global-only; it has no per-project config layer.
    return _loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') return { installed: false, alreadyConfigured: false };
    const file = configPath();
    const dir = openclawConfigDir();
    const installed = fs.existsSync(dir) && fs.existsSync(file);
    const config = parseConfig(readConfigText(file));
    const alreadyConfigured = !!config.mcp?.servers?.codegraph;
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['OpenClaw only supports global install (single gateway, no per-project config).'],
      };
    }
    return { files: [writeMcpEntry()] };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    return { files: [removeMcpEntry()] };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# OpenClaw only supports global install.\n';
    }
    const target = configPath();
    const snippet = JSON.stringify(
      { mcp: { servers: { codegraph: buildServerEntry() } } },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return loc === 'global' ? [configPath()] : [];
  }
}

function writeMcpEntry(): WriteResult['files'][number] {
  const file = configPath();
  const dir = path.dirname(file);
  const existed = fs.existsSync(file);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const text = readConfigText(file);
  const config = parseConfig(text);
  const before = config.mcp?.servers?.codegraph;
  const after = buildServerEntry();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  // Initialize nested mcp.servers.codegraph structure if absent
  if (!config.mcp || typeof config.mcp !== 'object') {
    config.mcp = {};
  }
  if (!config.mcp.servers || typeof config.mcp.servers !== 'object') {
    config.mcp.servers = {};
  }
  config.mcp.servers.codegraph = after;

  atomicWriteFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return { path: file, action: existed ? 'updated' : 'created' };
}

/**
 * Drop ONLY `mcp.servers.codegraph`; preserve every other server,
 * channel, agent, etc. If `mcp.servers` is empty afterwards, leave
 * the wrapper (OpenClaw schema tolerates an empty servers object).
 */
function removeMcpEntry(): WriteResult['files'][number] {
  const file = configPath();
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  const text = readConfigText(file);
  const config = parseConfig(text);
  if (!config.mcp?.servers?.codegraph) {
    return { path: file, action: 'not-found' };
  }

  delete config.mcp.servers.codegraph;
  atomicWriteFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return { path: file, action: 'removed' };
}

export const openclawTarget: AgentTarget = new OpenclawTarget();
