/**
 * Qoder IDE target.
 *
 * Qoder is an AI-native IDE built on a VS Code fork. It supports MCP
 * servers through a JSON config file.
 *
 * ## Config paths
 *
 *   - **Global** (user scope): `~/.config/Qoder/SharedClientCache/mcp.json`
 *     on Linux, `~/Library/Application Support/Qoder/SharedClientCache/mcp.json`
 *     on macOS, `%APPDATA%/Qoder/SharedClientCache/mcp.json` on Windows.
 *   - **Local** (project scope): `./.qoder/mcp.json` — supported by the
 *     Qoder MCP ecosystem for per-project MCP server definitions.
 *
 * ## Entry shape
 *
 * Standard `mcpServers.codegraph` JSON object with `type`, `command`,
 * and `args` — same shape as Claude / Cursor / Gemini.
 *
 * ## macOS GUI PATH resolution
 *
 * Qoder is an Electron GUI app. On macOS, apps launched from Dock/Finder
 * receive a stripped PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so nvm-managed
 * Node tools may not resolve. We pre-resolve `codegraph` to its absolute
 * path on macOS at install time.
 *
 * ## No permissions / no instructions file
 *
 * Qoder gates MCP tool invocations through its own UI confirmation prompts
 * rather than an external allowlist. `autoAllow` is silently ignored.
 *
 * Issue #529: the installer no longer writes a separate instructions file;
 * usage guidance ships in the MCP server's `initialize` response.
 *
 * Docs: https://docs.qoder.com/user-guide/chat/model-context-protocol
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
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

/**
 * Resolve the Qoder config base directory, platform-aware.
 *
 * Qoder is a VS Code fork (Electron), so it follows Chromium's config
 * conventions rather than a simple dot-dir in $HOME.
 */
function qoderConfigDir(): string {
  const platform = process.platform;
  const home = os.homedir();
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Qoder');
  }
  if (platform === 'win32') {
    return path.join(process.env.APPDATA || home, 'Qoder');
  }
  // Linux / others — respect XDG_CONFIG_HOME when set.
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    'Qoder',
  );
}

function mcpJsonPath(loc: Location): string {
  return loc === 'global'
    ? path.join(qoderConfigDir(), 'SharedClientCache', 'mcp.json')
    : path.join(process.cwd(), '.qoder', 'mcp.json');
}

/**
 * Resolve the on-disk path of the `codegraph` binary so a macOS GUI app
 * launched from Dock/Finder (with a stripped PATH) can find it. Falls
 * back to the bare `codegraph` name when:
 *
 *   - we're not on macOS (Linux GUI apps inherit user PATH; Windows
 *     uses env PATH directly), OR
 *   - the lookup fails for any reason.
 *
 * Resolution prefers `command -v` (built-in, no PATH manipulation),
 * with `which` as a fallback. Both are read via the user's interactive
 * shell PATH at install time — that's the right PATH for finding
 * nvm-managed tools like ours.
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
 * Build the codegraph MCP-server config for Qoder. On macOS the command
 * is resolved to an absolute path so the Electron app can spawn it
 * regardless of its launch environment.
 */
function buildQoderMcpConfig(): { type: string; command: string; args: string[] } {
  const base = getMcpServerConfig();
  return { ...base, command: resolveCodegraphCommand() };
}

class QoderTarget implements AgentTarget {
  readonly id = 'qoder' as const;
  readonly displayName = 'Qoder';
  readonly docsUrl = 'https://docs.qoder.com/user-guide/chat/model-context-protocol';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    // "Installed" heuristic: for global, check the Qoder config dir or
    // the well-known ~/.qoder VS Code user-data dir. For local, check
    // whether the project already has a .qoder directory or mcp.json.
    const installed = loc === 'global'
      ? fs.existsSync(qoderConfigDir()) || fs.existsSync(path.join(os.homedir(), '.qoder'))
      : fs.existsSync(file) || fs.existsSync(path.join(process.cwd(), '.qoder'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));
    return {
      files,
      notes: ['Restart Qoder for MCP changes to take effect.'],
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
    const snippet = JSON.stringify(
      { mcpServers: { codegraph: buildQoderMcpConfig() } },
      null,
      2,
    );
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
  const after = buildQoderMcpConfig();

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
