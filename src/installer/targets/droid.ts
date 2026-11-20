/**
 * Factory Droid target (the `droid` CLI).
 *
 *   - MCP server entry under `mcpServers` in `~/.factory/mcp.json` (global) or
 *     `./.factory/mcp.json` (local). The project file is meant to be committed,
 *     so a local install says so; our stdio entry carries no secrets.
 *   - Instructions to `~/.factory/AGENTS.md` (global) or `./AGENTS.md` (local).
 *
 * Droid reloads when an `mcp.json` changes, so there is no restart note, and
 * it remembers MCP tool approvals per server instead of keeping an allowlist in
 * a file, so `autoAllow` is a no-op.
 *
 * Docs: https://docs.factory.com/cli/configuration/mcp
 *       https://docs.factory.com/cli/configuration/agents-md
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types';
import { hasCodegraphServer, removeCodegraphServer, upsertCodegraphServer } from './json-config';
import { getMcpServerConfig, removeInstructionsEntry, upsertInstructionsEntry } from './shared';

function configDir(loc: Location): string {
  return path.join(loc === 'global' ? os.homedir() : process.cwd(), '.factory');
}

function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp.json');
}

function instructionsPath(loc: Location): string {
  return loc === 'global' ? path.join(configDir('global'), 'AGENTS.md') : path.join(process.cwd(), 'AGENTS.md');
}

class DroidTarget implements AgentTarget {
  readonly id = 'droid' as const;
  readonly displayName = 'Factory Droid';
  readonly docsUrl = 'https://docs.factory.com/cli/configuration/mcp';

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
    const files = [
      upsertCodegraphServer(mcpJsonPath(loc), getMcpServerConfig()),
      upsertInstructionsEntry(instructionsPath(loc)),
    ];
    if (loc === 'global') return { files };
    return { files, notes: [`Droid shares ${mcpJsonPath('local')} with your team: it is meant to be committed.`] };
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
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${mcpJsonPath(loc)}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), instructionsPath(loc)];
  }
}

export const droidTarget: AgentTarget = new DroidTarget();
