/**
 * Rovo Dev target. Writes the codegraph MCP server entry to
 * `~/.rovodev/mcp.json` — the single file Rovo Dev CLI reads to
 * discover and launch MCP servers.
 *
 * Rovo Dev only supports a global install location (there is no
 * per-project MCP config concept in the CLI as of 2026-05). The
 * `local` location is therefore not supported and the installer will
 * skip it with a clear message.
 *
 * Config format reference:
 *   {
 *     "mcpServers": {
 *       "<name>": {
 *         "command": "<executable>",
 *         "args": ["<arg>", ...],
 *         "env": { "KEY": "value" }   // optional
 *       }
 *     }
 *   }
 *
 * The `type` field is omitted — Rovo Dev assumes stdio transport.
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

/** Path to Rovo Dev's MCP server registry. */
function mcpJsonPath(): string {
  return path.join(os.homedir(), '.rovodev', 'mcp.json');
}

/** Path to the Rovo Dev config directory — used for install detection. */
function rovodevConfigDir(): string {
  return path.join(os.homedir(), '.rovodev');
}

/**
 * The MCP server config block for Rovo Dev.
 *
 * Rovo Dev does not use the `type` field; the command + args are
 * sufficient to identify a stdio-based server.
 */
function getRovoDevMcpEntry(): { command: string; args: string[] } {
  return {
    command: 'codegraph',
    args: ['serve', '--mcp'],
  };
}

class RovoDevTarget implements AgentTarget {
  readonly id = 'rovodev' as const;
  readonly displayName = 'Rovo Dev';
  readonly docsUrl = 'https://www.atlassian.com/software/rovo';

  /** Rovo Dev only has a global config — no per-project MCP concept. */
  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const configPath = mcpJsonPath();
    const installed = fs.existsSync(rovodevConfigDir());
    const config = readJsonFile(configPath);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    return { installed, alreadyConfigured, configPath };
  }

  install(_loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry());
    const notes: string[] = ['Restart Rovo Dev (or reload MCP servers) to apply.'];
    return { files, notes };
  }

  uninstall(_loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    const configPath = mcpJsonPath();
    const config = readJsonFile(configPath);

    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(configPath, config);
      files.push({ path: configPath, action: 'removed' });
    } else {
      files.push({ path: configPath, action: 'not-found' });
    }

    return { files };
  }

  printConfig(_loc: Location): string {
    const target = mcpJsonPath();
    const snippet = JSON.stringify(
      { mcpServers: { codegraph: getRovoDevMcpEntry() } },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(_loc: Location): string[] {
    return [mcpJsonPath()];
  }
}

/**
 * Idempotent write of the codegraph MCP entry into ~/.rovodev/mcp.json.
 * Preserves any sibling MCP server entries already in the file.
 */
function writeMcpEntry(): WriteResult['files'][number] {
  const file = mcpJsonPath();
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getRovoDevMcpEntry();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  const action: 'created' | 'updated' =
    before ? 'updated' : fs.existsSync(file) ? 'updated' : 'created';

  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

export const rovodevTarget: AgentTarget = new RovoDevTarget();
