/**
 * Pi (pi-coding-agent) target.
 *
 *   - MCP server entry under `mcpServers` in `mcp.json`: the agent directory
 *     when global (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`), `./.pi` when
 *     local. Pi reads a project's file only after the project is trusted, so a
 *     local install says so.
 *   - Instructions to `AGENTS.md`: in the agent directory when global, at the
 *     project root when local. Context files need no project trust.
 *
 * The entry carries `exposure: "direct"`. Pi's default, `codemode`, makes a
 * server's tools callable from scripts but never declares them to the model, so
 * `codegraph_explore` would be a name the model can't call as a tool. CodeGraph
 * lists one tool by default, which is what `direct` is for.
 *
 * `autoAllow` is a no-op: Pi has no allowlist file, and permission gates are
 * extensions.
 *
 * Docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md
 *       https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types';
import { hasCodegraphServer, removeCodegraphServer, upsertCodegraphServer } from './json-config';
import {
  configDirFromEnv,
  getStdioServerConfig,
  removeInstructionsEntry,
  upsertInstructionsEntry,
} from './shared';

function configDir(loc: Location): string {
  return loc === 'global'
    ? configDirFromEnv('PI_CODING_AGENT_DIR', path.join(os.homedir(), '.pi', 'agent'))
    : path.join(process.cwd(), '.pi');
}

function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp.json');
}

function instructionsPath(loc: Location): string {
  return loc === 'global' ? path.join(configDir('global'), 'AGENTS.md') : path.join(process.cwd(), 'AGENTS.md');
}

function buildPiEntry(): { command: string; args: string[]; exposure: string } {
  return { ...getStdioServerConfig(), exposure: 'direct' };
}

class PiTarget implements AgentTarget {
  readonly id = 'pi' as const;
  readonly displayName = 'Pi';
  readonly docsUrl = 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    return {
      installed: fs.existsSync(configDir(loc)),
      alreadyConfigured: hasCodegraphServer(file),
      configPath: file,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const notes = ['Run /reload in Pi, or restart it, to pick up the MCP server.'];
    if (loc === 'local') notes.push(`Pi reads ${mcpJsonPath('local')} only after you trust this project.`);
    return {
      files: [
        upsertCodegraphServer(mcpJsonPath(loc), buildPiEntry()),
        upsertInstructionsEntry(instructionsPath(loc)),
      ],
      notes,
    };
  }

  uninstall(loc: Location): WriteResult {
    return {
      files: [
        removeCodegraphServer(mcpJsonPath(loc)),
        removeInstructionsEntry(instructionsPath(loc)),
      ],
    };
  }

  printConfig(loc: Location): string {
    const snippet = JSON.stringify({ mcpServers: { codegraph: buildPiEntry() } }, null, 2);
    return `# Add to ${mcpJsonPath(loc)}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), instructionsPath(loc)];
  }
}

export const piTarget: AgentTarget = new PiTarget();
