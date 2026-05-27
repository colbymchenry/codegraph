/**
 * Rovo Dev target. Writes:
 *
 *   - MCP server entry to `~/.rovodev/mcp.json` — the file Rovo Dev
 *     CLI reads to discover and launch MCP servers.
 *   - Instructions to `~/.rovodev/AGENTS.md` — Rovo Dev's global
 *     personal memory file, loaded into every session.
 *
 * Rovo Dev only supports a global install location (there is no
 * per-project MCP config concept in the CLI as of 2026-05). The
 * `local` location is therefore not supported and the installer will
 * skip it with a clear message.
 *
 * MCP config format reference:
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
  removeMarkedSection,
  replaceOrAppendMarkedSection,
  writeJsonFile,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
  INSTRUCTIONS_TEMPLATE,
} from '../instructions-template';

/** Path to Rovo Dev's MCP server registry. */
function mcpJsonPath(): string {
  return path.join(os.homedir(), '.rovodev', 'mcp.json');
}

/** Path to the Rovo Dev config directory — used for install detection. */
function rovodevConfigDir(): string {
  return path.join(os.homedir(), '.rovodev');
}

/** Path to Rovo Dev's global personal memory/instructions file. */
function instructionsPath(): string {
  return path.join(os.homedir(), '.rovodev', 'AGENTS.md');
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
  readonly docsUrl = 'https://developer.atlassian.com/cloud/rovo/rovo-dev/';

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

  install(loc: Location, _opts: InstallOptions): WriteResult {
    // Rovo Dev has no per-project MCP concept — only global is supported.
    // supportsLocation('local') returns false so the orchestrator will
    // never call install for local, but guard explicitly for safety.
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Rovo Dev has no project-local config — re-run with --location=global to install.'],
      };
    }
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry());
    files.push(writeInstructionsEntry());
    const notes: string[] = ['Restart Rovo Dev (or reload MCP servers) to apply.'];
    return { files, notes };
  }

  uninstall(_loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry
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

    // 2. Instructions
    const instr = instructionsPath();
    const action = removeMarkedSection(instr, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
    files.push({ path: instr, action });

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
    return [mcpJsonPath(), instructionsPath()];
  }
}

/**
 * Idempotent write of the codegraph instructions block into
 * ~/.rovodev/AGENTS.md. Uses marker-based section replacement so any
 * existing user content in the file is preserved verbatim.
 */
function writeInstructionsEntry(): WriteResult['files'][number] {
  const file = instructionsPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const action = replaceOrAppendMarkedSection(
    file,
    INSTRUCTIONS_TEMPLATE,
    CODEGRAPH_SECTION_START,
    CODEGRAPH_SECTION_END,
  );
  const mapped: 'created' | 'updated' | 'unchanged' =
    action === 'created' ? 'created'
      : action === 'unchanged' ? 'unchanged'
        : 'updated';
  return { path: file, action: mapped };
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
